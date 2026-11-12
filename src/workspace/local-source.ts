/** Explicit source-side composition. A forwarded Codex endpoint does not imply local OS ownership. */
import { Context } from '@deepseek-ai/cordis';
import TerminalController from '@deepseek-ai/dsh-api-terminal-controller';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import { stat } from 'node:fs/promises';
import { SourceAttachments } from './source-attachments.ts';
import { SourceUploads } from './source-uploads.ts';
import { join } from 'node:path';
import type { SourceWorkspaceConfig } from '../remote/config.ts';
import type { SourceGateway } from '../remote/gateway.ts';
import type { DirectSourceConfig } from '../remote/protocol.ts';
import { LocalSourceFileOwner } from './source-files.ts';
import { SourceTerminalOwners } from './source-terminal-service.ts';

export function installLocalSourceWorkspaces(ctx: Context, gateway: SourceGateway, sources: readonly DirectSourceConfig[],
    configured: readonly SourceWorkspaceConfig[], directory: string, uploadReceipts: ReadonlyMap<string, string> = new Map()): void {
    for (const entry of configured) {
        const source = sources.find(source => source.id === entry.sourceId);
        if (!source || source.engine !== 'codex') throw new Error('The configured source workspace has no native Codex owner');
        const lifetime = new AbortController();
        // Keep source subprocess ownership separate from the display Host's
        // default Agent services, including their sandbox and lifecycle.
        const scope = new Context();
        const subprocess = new LocalSubprocessRuntime(scope);
        const terminals = new SourceTerminalOwners(scope, { subprocess,
            async ensureDirectory(root, signal) {
                signal.throwIfAborted();
                const entry = await stat(root);
                signal.throwIfAborted();
                if (!entry.isDirectory()) throw new Error('The source workspace directory is unavailable');
            },
        }, TerminalController.Config());
        const files = new LocalSourceFileOwner({ database: join(directory, 'workspaces', source.id, 'receipts.sqlite'), signal: lifetime.signal });
        const attachmentReceipts = uploadReceipts.get(source.id);
        const attachments = new SourceAttachments(scope, {
            directory: join(directory, 'workspaces', source.id, 'attachments'), receipts: attachmentReceipts,
            async generated(binding, id, access) {
                const path = id.startsWith('attachment:') ? id : `attachment:${id}`;
                await access.assertAllowed(binding.target, 'read'); access.signal.throwIfAborted();
                const result = await gateway.resource({ sessionId: binding.target.sessionId, path },
                    resource => resource.kind === 'session' && resource.id === binding.target.sessionId, access.signal);
                await access.assertAllowed(binding.target, 'read'); access.signal.throwIfAborted();
                if (!result.attachment) throw new Error('This source did not admit a generated-media reference. Its original reference is kept.');
                return { data: Buffer.from(result.content, 'base64'), name: result.attachment.name ?? 'Generated image',
                    mimeType: result.mimeType, version: result.attachment.attachmentId };
            },
        });
        const uploads = new SourceUploads({ directory: join(directory, 'workspaces', source.id, 'uploads'), signal: lifetime.signal,
            async receipt(binding, request, access) {
                if (request.destination.kind === 'attachment') return attachments.receipt(binding, request, access);
                const result = await files.workspace(binding).mutations!.receipt(request.operationId, access);
                return result?.status === 'applied' ? { ...result, value: { kind: 'file',
                    resource: { target: binding.target, document: { kind: 'file', path: request.destination.path } },
                    file: result.value as Awaited<ReturnType<ReturnType<typeof files.workspace>['files']['stat']>> } } : result;
            },
            async commit(binding, request, path, access) {
                if (request.destination.kind === 'file') {
                    const result = await files.commitUpload(binding, request, path, access);
                    return result.status === 'applied' ? { ...result, value: { kind: 'file',
                        resource: { target: binding.target, document: { kind: 'file', path: request.destination.path } }, file: result.value } } : result;
                }
                if (!attachmentReceipts) return { status: 'rejected', operationId: request.operationId, code: 'unsupported', message: 'This source has no registered attachment owner.' };
                return attachments.commit(binding, request, path, access);
            },
        });
        const unregister = gateway.registerWorkspace({
            source: { sourceId: source.id, machineId: source.machineId, engine: source.engine },
            workspaceId: `local-system:${source.id}`, pathStyle: process.platform === 'win32' ? 'win32' : 'posix', signal: lifetime.signal,
            async create(binding, owner) { const workspace = files.workspace(binding); return { ...workspace, documents: attachments.documents(binding, workspace.documents), uploads: uploads.workspace(binding), terminals: await terminals.forWorkspace(binding, owner) }; },
            async dispose() {
                lifetime.abort();
                await uploads.close();
                const results = await Promise.allSettled([files.close(), scope.fiber.dispose()]);
                const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
                if (errors.length) throw new AggregateError(errors.map(value => value.reason), 'Source workspace cleanup failed');
            },
        });
        ctx.effect(() => unregister, 'hhpi: configured source OS workspace');
    }
}
