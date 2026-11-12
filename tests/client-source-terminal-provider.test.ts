/** Actual published ClientTerminals and public Cordis Loader isolation; transport replies are explicit fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { TerminalRemote } from '@deepseek-ai/dsh-api-terminal-controller/client';
import type { TerminalRetentionFrame, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol';
import { sourceSessionId } from '../src/remote/protocol.ts';
import { installSourceTerminalProvider, SOURCE_TERMINAL_CONSUMER, SOURCE_TERMINAL_REALM } from '../src/client/source-terminal-provider.ts';

const require = createRequire(import.meta.url);
let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-api-terminal-controller/client') } | undefined;
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-api-terminal-controller/client'), 'utf8'))({ __ModuleLoader__: { load(value: typeof published) { published = value; } } });
assert.ok(published);
const official = published.factory(require);
const sessionId = sourceSessionId({ machineId: 'source', sourceId: 'codex', engine: 'codex', nativeId: 'thread' }) as SessionId;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> { for (let attempt = 0; attempt < 100 && !check(); attempt++) await tick(); assert.ok(check()); }
const environment = { cwd: '/source/workspace', maxInputBytes: 1024, maxBufferedBytes: 8192, maxCols: 300, maxRows: 200, scrollback: 1000 };

function hold(signal?: AbortSignal): RemoteStreamHandle<TerminalRetentionFrame, never> {
    let first = true, ended = false, waiting: (() => void) | undefined;
    const dispose = (): void => { ended = true; waiting?.(); waiting = undefined; };
    signal?.addEventListener('abort', dispose, { once: true });
    if (signal?.aborted) dispose();
    const iterator: AsyncIterableIterator<TerminalRetentionFrame> = {
        [Symbol.asyncIterator]() { return this; },
        async next() { if (first) { first = false; return { done: false, value: { type: 'retained' } }; }
            if (!ended) await new Promise<void>(resolve => { waiting = resolve; }); return { done: true, value: undefined }; },
        async return() { dispose(); signal?.removeEventListener('abort', dispose); return { done: true, value: undefined }; },
    };
    return { [Symbol.asyncIterator]: () => iterator, send() { throw new Error('Hold has no input'); }, end() {}, dispose };
}
test('public Loader injects the source adapter into the original model and leaves the original namespace available', async () => {
    const ctx = new Context(); await ctx.plugin(Loader);
    const connection = { generation: createSnapshotStore({}) } as unknown as Pick<ConnectionHandle, 'generation'>;
    ctx.provide('connection', connection);
    class Remote extends Service {
        constructor(scope: Context) { super(scope, 'remote'); }
        $stream<T>(options: RemoteStreamOptions<T>) { return new RemoteStream(connection, options); }
    }
    await ctx.plugin(Remote);
    const calls: string[] = [], inventory: WebTerminalInfo[] = [];
    const api = (kind: string): TerminalRemote => ({
        environment: async () => { calls.push(`${kind}:environment`); return { ok: true, value: environment }; },
        shells: async () => ({ ok: true, value: [{ path: '/bin/sh', args: [], name: 'sh' }] }),
        list: async () => { calls.push(`${kind}:list`); return { ok: true, value: [...inventory] }; },
        create: async (_session, request) => { calls.push(`${kind}:create`); const info: WebTerminalInfo = {
            id: request.id, title: 'sh', shell: { path: '/bin/sh', args: [], name: 'sh' }, cwd: environment.cwd, cols: request.cols, rows: request.rows, state: 'running', exitCode: null };
            inventory.push(info); return { ok: true, value: info }; },
        retain: (_session, _id, signal) => { calls.push(`${kind}:retain`); return hold(signal); },
        attach: () => { throw new Error('This model composition case does not mount a screen'); },
        rename: async () => ({ ok: true, value: undefined }),
        close: async () => { calls.push(`${kind}:close`); return { ok: true, value: undefined }; },
    });
    const ordinary = api('ordinary'), source = api('source');
    ctx.reflect.provide('remote.terminal', ordinary); ctx.reflect.provide('remote.sourceTerminal', source);
    ctx.loader.internal = { version: 'client', import: () => official } as unknown as NonNullable<Loader['internal']>;
    const stop = await installSourceTerminalProvider(ctx);
    try {
        const entry = ctx.loader.resolve(await ctx.loader.create({ name: SOURCE_TERMINAL_CONSUMER })); await entry.fiber;
        assert.equal(entry.options.isolate?.['remote.terminal'], SOURCE_TERMINAL_REALM);
        const models = ctx.webTerminals;
        assert.ok(models instanceof official.ClientTerminals); assert.equal(entry.context.get('webTerminals')?.closeFailures, models.closeFailures);
        await models.recover(sessionId); await models.recover('ordinary-dsh' as SessionId);
        assert.deepEqual(calls, ['source:list', 'ordinary:list']);
        const missing = models.view(sessionId, 'restored', 'saved-content', 'missing-shell' as WebTerminalInfo['id']);
        await missing.refresh(); assert.equal(missing.state.getSnapshot().issue, 'missingTerminal');
        assert.equal(calls.filter(value => value.endsWith(':create')).length, 0, 'A restored missing process is never replaced');
        const fresh = models.view(sessionId, 'new', 'new-content'); await fresh.refresh();
        await until(() => calls.includes('source:retain'));
        assert.equal(calls.filter(value => value === 'source:create').length, 1);
        await fresh.close(); assert.equal(calls.filter(value => value === 'source:close').length, 1);
        await entry.update({ config: {} }); await entry.fiber;
        assert.ok(ctx.webTerminals instanceof official.ClientTerminals);
        assert.notEqual(ctx.webTerminals, models, 'The Loader retires the old official model before recreating it');
        await ctx.remote.terminal.list('still-ordinary' as SessionId);
        assert.equal(calls.at(-1), 'ordinary:list');
    } finally { await stop(); await ctx.fiber.dispose(); }
});
