/** Published official Files resource provider and actual Cordis Loader; only Remote/storage are fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client';
import { RemoteError, type TypertRemoteNamespaceMap, type RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types';
import type { SourceWorkspaceApi } from '../src/workspace/source-api.ts';
import { installSourceWorkspaceFilesProvider, sourceWorkspaceFilesRemote, SOURCE_WORKSPACE_FILES_CONSUMER, SOURCE_WORKSPACE_FILES_CONSUMERS, SOURCE_WORKSPACE_FILES_REALM } from '../src/client/source-workspace-provider.ts';
import { fileContext, fileOwner } from './source-file-context-fixture.ts';

const require = createRequire(import.meta.url);
let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-api-workspace-files/client') } | undefined;
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-api-workspace-files/client'), 'utf8'))({ __ModuleLoader__: { load(value: typeof published) { published = value; } } });
assert.ok(published); const official = published.factory(require);
const sourceId = 'hhpi:machine:source:codex:thread' as SessionId;
function hold(signal?: AbortSignal, listen?: (push: (frame: WorkspaceFileWatchFrame) => void) => void): RemoteStreamHandle<WorkspaceFileWatchFrame, never> {
    let ended = false, wake: (() => void) | undefined;
    const pending: WorkspaceFileWatchFrame[] = [{ kind: 'ready' }];
    listen?.(frame => { pending.push(frame); wake?.(); });
    const dispose = () => { ended = true; wake?.(); };
    signal?.addEventListener('abort', dispose, { once: true });
    return { async *[Symbol.asyncIterator]() {
        try { while (!ended && !signal?.aborted) { if (pending.length) yield pending.shift()!;
            else await new Promise<void>(resolve => { wake = resolve; }); } }
        finally { signal?.removeEventListener('abort', dispose); }
    }, send() { throw new Error('This read-only stream has no input'); }, end() {}, dispose };
}

test('the public Loader connects the published Files provider to the source namespace and keeps ordinary DSH on its original face', async () => {
    const ctx = new Context(); await ctx.plugin(Loader);
    const connection = { generation: createSnapshotStore({}) } as unknown as Pick<ConnectionHandle, 'generation'>;
    ctx.provide('connection', connection);
    class Remote extends Service {
        constructor(scope: Context) { super(scope, 'remote'); }
        $stream<T>(options: RemoteStreamOptions<T>) { return new RemoteStream(connection, options); }
    }
    await ctx.plugin(Remote);
    const providers = new Set<ResourceProvider<'file'>>(), calls: string[] = [];
    ctx.reflect.provide('resources', { register(provider: ResourceProvider<'file'>) { providers.add(provider); return () => providers.delete(provider); } });
    const api = (kind: string): TypertRemoteNamespaceMap['workspaceFiles'] => ({
        async stat() { calls.push(`${kind}:stat`); return { ok: true, value: { absolutePath: '/source/file.txt', version: kind, bytes: 1 } }; },
        changes(_id, _path, signal) { calls.push(`${kind}:changes`); return hold(signal); },
        async read() { throw new Error('The resource provider requests metadata only'); }, async readBytes() { throw new Error('No document body requested'); },
        async list() { throw new Error('No directory view requested'); },
    });
    const ordinary = api('ordinary'), source = api('source');
    ctx.reflect.provide('remote.workspaceFiles', ordinary); ctx.reflect.provide('remote.sourceWorkspace', source);
    ctx.reflect.provide('sourceFiles', { async resolve(id: string) {
        const context = fileContext(fileOwner());
        context.owner.binding.target.sessionId = id;
        context.services.files.stat = async (path, access) => { const result = await source.stat(id as SessionId, path, access.signal); if (!result.ok) throw result.error; return result.value; };
        context.services.files.changes = (path, access) => source.changes(id as SessionId, path, access.signal);
        return context;
    } });
    const directReaders: Context[] = [];
    ctx.loader.internal = { version: 'client', import: (name: string) => name === SOURCE_WORKSPACE_FILES_CONSUMER ? official
        : { inject: ['remote', 'remote.workspaceFiles'], apply(owner: Context) { directReaders.push(owner); } } } as unknown as NonNullable<Loader['internal']>;
    const stop = await installSourceWorkspaceFilesProvider(ctx);
    try {
        const entry = ctx.loader.resolve(await ctx.loader.create({ name: SOURCE_WORKSPACE_FILES_CONSUMER })); await entry.fiber;
        assert.equal(entry.options.isolate?.['remote.workspaceFiles'], SOURCE_WORKSPACE_FILES_REALM); assert.equal(providers.size, 1);
        const read = async (id: string, version: string) => {
            const controller = new AbortController(), provider = [...providers][0]!;
            const iterator = provider.open(`dsh-resource://file/session/${encodeURIComponent(id)}/file.txt`, { signal: controller.signal })[Symbol.asyncIterator]();
            try { assert.deepEqual((await iterator.next()).value, { ok: true, value: { absolutePath: '/source/file.txt', version, bytes: 1 } }); }
            finally { controller.abort(); await iterator.return?.(); }
        };
        await read(sourceId, 'source'); await read('ordinary-dsh', 'ordinary');
        assert.deepEqual(calls, ['source:changes', 'source:stat', 'ordinary:changes', 'ordinary:stat']);
        // Files watches and Document reads call Remote directly instead of
        // going through the resource metadata provider exercised above.
        for (const name of SOURCE_WORKSPACE_FILES_CONSUMERS) if (name !== SOURCE_WORKSPACE_FILES_CONSUMER) {
            const direct = ctx.loader.resolve(await ctx.loader.create({ name })); await direct.fiber;
            const owner = directReaders.at(-1)!;
            await owner.remote.workspaceFiles.stat(sourceId, '/source/file.txt');
            assert.equal(calls.at(-1), 'source:stat', name);
            await owner.remote.workspaceFiles.stat('ordinary-dsh' as SessionId, '/source/file.txt');
            assert.equal(calls.at(-1), 'ordinary:stat', name);
        }
        await entry.update({ config: {} }); await entry.fiber; assert.equal(providers.size, 1);
        await ctx.remote.workspaceFiles.stat('ordinary-still' as SessionId, '/source/file.txt'); assert.equal(calls.at(-1), 'ordinary:stat');
    } finally { await stop(); await ctx.fiber.dispose(); }
});

test('the published file provider keeps a renamed-away path unavailable and recovers through the same watch', async () => {
    const ctx = new Context(), connection = { generation: createSnapshotStore({}) } as unknown as Pick<ConnectionHandle, 'generation'>;
    class Remote extends Service {
        constructor(scope: Context) { super(scope, 'remote'); }
        $stream<T>(options: RemoteStreamOptions<T>) { return new RemoteStream(connection, options); }
    }
    await ctx.plugin(Remote);
    let provider: ResourceProvider<'file'> | undefined, push!: (frame: WorkspaceFileWatchFrame) => void;
    ctx.reflect.provide('resources', { register(value: ResourceProvider<'file'>) { provider = value; return () => { provider = undefined; }; } });
    const context = fileContext(fileOwner()), initial = { absolutePath: '/source/file.txt', version: 'initial', bytes: 1 };
    let failure: RemoteError | undefined, version = initial.version;
    const missing = new RemoteError('workspace-file/not-found', 'The original path was renamed.', { path: initial.absolutePath });
    context.services.files.stat = async () => { if (failure) throw failure; return { ...initial, version }; };
    context.services.files.changes = (_path, access) => hold(access.signal, publish => { push = publish; });
    ctx.reflect.provide('remote.workspaceFiles', sourceWorkspaceFilesRemote({} as never, {} as SourceWorkspaceApi, { resolve: async () => context }));
    const plugin = ctx.plugin(official); await plugin;
    const controller = new AbortController();
    const iterator = provider!.open(`dsh-resource://file/session/${encodeURIComponent(sourceId)}/file.txt`, { signal: controller.signal })[Symbol.asyncIterator]();
    try {
        assert.deepEqual((await iterator.next()).value, { ok: true, value: initial });
        failure = missing;
        const gone = iterator.next(); push({ kind: 'change', change: { absolutePath: initial.absolutePath, absent: true } });
        assert.deepEqual((await gone).value, { ok: false, error: missing });
        failure = undefined; version = 'restored';
        const restored = iterator.next(); push({ kind: 'change', change: { absolutePath: initial.absolutePath, version } });
        assert.deepEqual((await restored).value, { ok: true, value: { ...initial, version } });
    } finally { controller.abort(); await iterator.return?.(); await ctx.fiber.dispose(); }
});

test('the Files Remote boundary preserves typed denials without swallowing cancellation or programming errors', async () => {
    const context = fileContext(fileOwner()), denied = new RemoteError('remote-access/denied', 'Revoked', { action: 'sourceWorkspace/stat', reason: 'no-allow' });
    let error: unknown = denied;
    context.services.files.stat = async () => { throw error; };
    const adapter = sourceWorkspaceFilesRemote({} as never, {} as SourceWorkspaceApi, { resolve: async () => context });
    assert.deepEqual(await adapter.stat(sourceId, 'file.txt'), { ok: false, error: denied });
    error = new Error('Broken file implementation');
    await assert.rejects(adapter.stat(sourceId, 'file.txt'), value => value === error);
    const controller = new AbortController(), reason = new Error('Caller left the view'); controller.abort(reason);
    await assert.rejects(adapter.stat(sourceId, 'file.txt', controller.signal), value => value === reason);
});

test('malformed and failed HHPI file calls never execute the ordinary Host namespace', async () => {
    let ordinary = 0, source = 0;
    const api = (kind: 'ordinary' | 'source') => ({ async stat() { if (kind === 'ordinary') ordinary++; else source++; return { ok: false, error: new Error('Source unavailable') }; } });
    const adapter = sourceWorkspaceFilesRemote(api('ordinary') as never, api('source') as unknown as SourceWorkspaceApi);
    assert.throws(() => adapter.stat('hhpi:malformed' as SessionId, 'file'), /canonical|malformed|Invalid/);
    assert.equal((await adapter.stat(sourceId, 'file')).ok, false); assert.equal(ordinary, 0); assert.equal(source, 1);
});
