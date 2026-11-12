/** Source Files stay in the official model and renderers through one exact Remote adapter. */
import { Context, type Fiber } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import { remoteErrorOf, type RemoteResult, type TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import { isSourceSessionId, parseSourceSessionId } from '../remote/protocol.ts';
import type { SourceWorkspaceApi } from '../workspace/source-api.ts';
import type { WorkspaceAccess, WorkspaceServices } from '../workspace/service-types.ts';
import type { SourceFileOwner } from './source-file-mutation-journal.ts';
import type {} from './source-workspace-client.ts';

export interface SourceFileContext { readonly owner: SourceFileOwner; readonly services: WorkspaceServices }
/** Bound to one actual Host graph by the application, using its authenticated storage scope. */
export interface SourceFileClient {
    resolve(sessionId: string, signal: AbortSignal): Promise<SourceFileContext>;
}
export function sourceFileAccess(owner: SourceFileOwner, signal: AbortSignal): WorkspaceAccess {
    return { scope: owner.scope, signal, assertAllowed(target) {
        if (target.hostId !== owner.binding.target.hostId || target.sessionId !== owner.binding.target.sessionId) {
            throw new Error('The file operation belongs to another source session.');
        }
    } };
}
type FilesRemote = TypertRemoteNamespaceMap['workspaceFiles'];
export function sourceWorkspaceFilesRemote(ordinary: FilesRemote, source: SourceWorkspaceApi, client?: SourceFileClient): FilesRemote {
    const call = async <T>(sessionId: string, signal: AbortSignal | undefined, run: (context: SourceFileContext, access: WorkspaceAccess) => Promise<T>): Promise<RemoteResult<T>> => {
        const active = signal ?? new AbortController().signal;
        try {
            const context = await client!.resolve(sessionId, active); active.throwIfAborted();
            const value = await run(context, sourceFileAccess(context.owner, active)); active.throwIfAborted();
            return { ok: true, value };
        } catch (error) {
            active.throwIfAborted();
            // Services throw typed failures; the official Remote face returns
            // them as frames, including an old path disappearing after rename.
            const failure = remoteErrorOf(error);
            if (failure) return { ok: false, error: failure };
            throw error;
        }
    };
    const guarded: FilesRemote = {
        read: (id, path, range, signal) => call(id, signal, (ctx, access) => ctx.services.files.read(path, range, access)),
        readBytes: (id, path, options, signal) => call(id, signal, async (ctx, access) => {
            const value = await ctx.services.files.readBytes(path, options, access); return { ...value, data: new Uint8Array(value.data) };
        }),
        stat: (id, path, signal) => call(id, signal, (ctx, access) => ctx.services.files.stat(path, access)),
        list: (id, path, signal) => call(id, signal, (ctx, access) => ctx.services.files.list(path, access)),
        changes(id, path, signal) {
            const lifetime = new AbortController(), active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
            return { async *[Symbol.asyncIterator]() {
                try {
                    const ctx = await client!.resolve(id, active); active.throwIfAborted();
                    for await (const frame of ctx.services.files.changes(path, sourceFileAccess(ctx.owner, active))) { active.throwIfAborted(); yield frame; }
                } finally { lifetime.abort(); }
            }, send() { throw new Error('A read-only source file watch has no input.'); }, end() {}, dispose() { lifetime.abort(); } };
        },
    };
    const route = (sessionId: string): FilesRemote => {
        if (!isSourceSessionId(sessionId)) return ordinary;
        parseSourceSessionId(sessionId); return client ? guarded : source;
    };
    return {
        read: (id, path, range, signal) => route(id).read(id, path, range, signal),
        readBytes: (id, path, options, signal) => route(id).readBytes(id, path, options, signal),
        stat: (id, path, signal) => route(id).stat(id, path, signal),
        list: (id, path, signal) => route(id).list(id, path, signal),
        changes: (id, path, signal) => route(id).changes(id, path, signal),
    };
}

export const SOURCE_WORKSPACE_FILES_CONSUMER = '@deepseek-ai/dsh-api-workspace-files';
/** These pinned Client entries call the namespace directly, including the
 * directory watch and document body; the resource metadata owner alone is not enough. */
export const SOURCE_WORKSPACE_FILES_CONSUMERS: ReadonlySet<string> = new Set([
    SOURCE_WORKSPACE_FILES_CONSUMER,
    '@deepseek-ai/dsh-client-ui-sidebar-files',
    '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    '@deepseek-ai/dsh-client-ui-file-actions',
    '@deepseek-ai/dsh-client-ui-open-in-app',
]);
export const SOURCE_WORKSPACE_FILES_REALM = 'hhpi:source-workspace-files';
const service = 'remote.workspaceFiles', realm = SOURCE_WORKSPACE_FILES_REALM;
/** Mount Remote contributions first, then await this adapter before installing the Files consumers. */
export async function installSourceWorkspaceFilesProvider(ctx: Context): Promise<() => Promise<void>> {
    const providers = new Map<symbol, Fiber>(), prior = new Map<Entry, Record<string, true | string> | null>();
    let stopped = false;
    const isolate = (entry: Entry): void => {
        if (entry.options.isolate?.[service] === realm) return;
        if (!prior.has(entry)) prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null);
        entry.options.isolate = { ...entry.options.isolate, [service]: realm };
    };
    const provide = (entry: Entry): void => {
        const symbol = entry.context[Context.isolate][service];
        if (stopped || !symbol || providers.has(symbol)) return;
        providers.set(symbol, ctx.inject(['remote', service, 'remote.sourceWorkspace', 'sourceFiles'], async owner => {
            const adapter = sourceWorkspaceFilesRemote(owner.remote.workspaceFiles, owner.remote.sourceWorkspace, owner.sourceFiles);
            const provider = owner.isolate(service, symbol).plugin({ name: 'hhpi-workspace-files-remote', apply(scope: Context) {
                scope.reflect.provide(service, adapter);
            } });
            await provider; return async () => { await provider.dispose(); };
        }));
    };
    const hook = ctx.on('loader/patch-context', (entry, next) => {
        if (!SOURCE_WORKSPACE_FILES_CONSUMERS.has(entry.options.name)) { next(); return; }
        isolate(entry); next(); provide(entry);
    }, { prepend: true });
    const stop = async (): Promise<void> => {
        if (stopped) return; stopped = true; hook();
        await Promise.all([...providers.values()].map(value => value.dispose()));
        const current = new Set(ctx.loader.entries());
        for (const [entry, isolation] of prior) {
            if (!current.has(entry) || entry.options.isolate?.[service] !== realm) continue;
            if (!entry.fiber) { if (isolation) entry.options.isolate = isolation; else delete entry.options.isolate; }
            else await entry.update({ isolate: isolation && Object.keys(isolation).length ? isolation : null });
        }
    };
    try {
        for (const entry of ctx.loader.entries()) {
            if (!SOURCE_WORKSPACE_FILES_CONSUMERS.has(entry.options.name)) continue;
            if (!entry.fiber) { isolate(entry); continue; }
            if (entry.options.isolate?.[service] !== realm) {
                prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null);
                await entry.update({ isolate: { ...entry.options.isolate, [service]: realm } });
            }
            provide(entry);
        }
        return stop;
    } catch (error) { await stop(); throw error; }
}
