/** Real Gateway/policy and public terminal factory; only the source process provider is a fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access';
import TypertGatewayService, { type InvokeRemoteRequest } from '@deepseek-ai/dsh-api-gateway';
import { TerminalController } from '@deepseek-ai/dsh-api-terminal-controller';
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec, type SubprocessTerminalHandle, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError, type PeerId, type PeerScope, type RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT_REMOTE as ORIGINAL_REMOTE } from '@deepseek-ai/dsh-api-terminal-controller/remote';
import type { TerminalRemote } from '@deepseek-ai/dsh-api-terminal-controller/client';
import type { TerminalFrame, TerminalInput, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types';
import { SourceGateway } from '../src/remote/gateway.ts';
import { sourceSessionId, type SourceAdapter, type SourceSession } from '../src/remote/protocol.ts';
import { SourceTerminalOwners, SourceTerminalService, registerSourceTerminalContract } from '../src/workspace/source-terminal-service.ts';
import { SOURCE_TERMINAL_REMOTE } from '../src/workspace/terminal-api.ts';
import { sourceTerminalRemote } from '../src/client/source-terminal-provider.ts';
import type { WorkspaceBinding, WorkspaceServices } from '../src/workspace/service-types.ts';
import type {} from '../src/client-api.ts';

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'source-terminal-fixture': { kind: 'source-terminal-fixture' } } }
const identity = { machineId: 'source-machine', sourceId: 'source-terminal-fixture', engine: 'codex', nativeId: 'thread-one' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'source', cwd: '/source/workspace', updatedAt: 1, status: 'idle', activeTurnId: null,
    capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] };
const terminalId = 'source-shell' as WebTerminalId;
function terminalHandle() {
    const output = new PassThrough(), done = Promise.withResolvers<{ exitCode: number; signal: null }>();
    const writes: string[] = []; let terminations = 0;
    return { pid: 123, output, done: done.promise, writes,
        async write(data: string) { writes.push(data); }, async resize() {},
        async inspectActivity() { return { state: 'unknown' as const, revision: 0 }; }, async inspectForeground() { return undefined; }, async signalForeground() { return 123; },
        async terminate() { terminations++; output.end(); done.resolve({ exitCode: 0, signal: null }); },
        get terminations() { return terminations; },
    } satisfies SubprocessTerminalHandle & { readonly writes: string[]; readonly terminations: number };
}
class SourceProcesses extends SubprocessRuntime {
    readonly specs: SubprocessTerminalSpawnSpec[] = [];
    readonly handles: ReturnType<typeof terminalHandle>[] = [];
    async resolveExecutable(command: string) { return command; }
    async terminalEnvironment() { return { platform: 'posix' as const, defaultShell: '/bin/sh' }; }
    spawn(_spec: SubprocessSpawnSpec): SubprocessHandle { throw new Error('No Agent commands belong to this fixture'); }
    async spawnTerminal(spec: SubprocessTerminalSpawnSpec) { this.specs.push(spec); const handle = terminalHandle(); this.handles.push(handle); return handle; }
}
function inputChannel() {
    const queue: TerminalInput[] = []; let waiting: ReturnType<typeof Promise.withResolvers<IteratorResult<TerminalInput>>> | undefined;
    let ended = false;
    const iterator: AsyncIterableIterator<TerminalInput> = {
        [Symbol.asyncIterator]() { return this; },
        async next() { if (queue.length) return { done: false, value: queue.shift()! }; if (ended) return { done: true, value: undefined }; waiting = Promise.withResolvers(); return waiting.promise; },
        async return() { ended = true; waiting?.resolve({ done: true, value: undefined }); waiting = undefined; return { done: true, value: undefined }; },
    };
    return { source: iterator, push(value: TerminalInput) { if (waiting) { const next = waiting; waiting = undefined; next.resolve({ done: false, value }); } else queue.push(value); } };
}
function baseServices(binding: WorkspaceBinding): Omit<WorkspaceServices, 'terminals'> {
    const unavailable = async (): Promise<never> => { throw new Error('No file operation belongs to this terminal fixture'); };
    return { binding, files: { read: unavailable, readBytes: unavailable, stat: unavailable, list: unavailable, async *changes() {} },
        documents: { open: unavailable, bytes: unavailable, inspect: unavailable, search: unavailable, git: unavailable } };
}
async function mount() {
    const ctx = new Context(); await ctx.plugin(TypertRegistry); const remoteAccess = new RemoteAccessService(ctx);
    const processes = new SourceProcesses(ctx), sourceLifetime = new AbortController(), peerLifetime = new AbortController();
    const checked: string[] = [];
    const owners = new SourceTerminalOwners(ctx, { subprocess: processes, async ensureDirectory(root) { checked.push(root); } },
        { ...TerminalController.Config(), unattendedTimeoutMs: 0 });
    const adapter: SourceAdapter = { id: identity.sourceId, machineId: identity.machineId, engine: identity.engine,
        async list() { return [session]; }, async resolve(id) { if (id !== session.id) throw new Error('Unknown source'); return session; },
        async read() { throw new Error('No Agent history is needed'); }, async *changes() {}, async operate() { throw new Error('No Agent operation is needed'); }, dispose() {} };
    const gateway = new SourceGateway([adapter]);
    const unregister = gateway.registerWorkspace({ source: identity, workspaceId: 'source-os', pathStyle: 'posix', signal: sourceLifetime.signal,
        async create(binding, owner) { return { ...baseServices(binding), terminals: await owners.forWorkspace(binding, owner) }; }, dispose: () => owners.dispose() });
    new SourceTerminalService(ctx, gateway, { localHostId: 'source-host', scopeId: '/source-installation' }); registerSourceTerminalContract(ctx);
    const carrier = new TypertGatewayService(ctx, TypertGatewayService.Config({})), grants: RemoteAccessBinding[] = [];
    remoteAccess.registerPolicy('source-terminal-fixture', { bindings: () => grants });
    const peer: PeerScope = { id: 'source-terminal-peer' as PeerId, ctx, principal: { kind: 'source-terminal-fixture' }, interactions: 'answer', signal: peerLifetime.signal, async dispose() {} };
    const request = (method: string, args: Readonly<Record<string, unknown>>, extra: Partial<InvokeRemoteRequest> = {}) => ({ peer, namespace: 'sourceTerminal', method, args, ...extra });
    return { ctx, gateway, owners, processes, checked, grants, sourceLifetime, unregister, remoteAccess,
        invoke: (method: string, args: Readonly<Record<string, unknown>>) => carrier.invoke(request(method, args)),
        stream: (method: string, args: Readonly<Record<string, unknown>>, extra: Partial<InvokeRemoteRequest> = {}) => carrier.stream(request(method, args, extra)),
        allow(methods: string[]) { grants.push({ role: { name: 'Selected source terminals', resource: 'session', actions: methods.map(method => `sourceTerminal/${method}` as const) }, resource: { kind: 'session', id: SessionId(session.id) } }); },
        async close() { peerLifetime.abort(); await gateway.dispose(); await ctx.fiber.dispose(); } };
}
const denied = (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied';
const create = { sessionId: session.id, request: { id: terminalId, cols: 80, rows: 24 } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('source terminal codecs preserve official results/uplink but never use Agent lookup', () => {
    assert.equal(SOURCE_TERMINAL_REMOTE.descriptors.length, 8);
    for (const descriptor of SOURCE_TERMINAL_REMOTE.descriptors) {
        const original = ORIGINAL_REMOTE.descriptors.find(item => item.method === descriptor.method)!;
        assert.equal(descriptor.parameters[0]?.source, 'json');
        assert.equal(descriptor.parameters[0]?.name, 'sessionId');
        assert.equal(descriptor.result, original.result); assert.equal(descriptor.uplink, original.uplink);
        assert.equal(descriptor.parameters[0]?.codec, original.parameters[0]?.codec);
    }
});

test('the real Gateway grants only the exact source session and allocates on its source resources', async () => {
    const app = await mount();
    try {
        assert.equal(app.ctx.get('agents'), undefined); assert.equal(app.ctx.get('sandboxPolicy'), undefined);
        await assert.rejects(app.invoke('create', create), denied); assert.equal(app.processes.specs.length, 0);
        app.allow(['environment', 'create', 'list', 'close']);
        assert.equal((await app.invoke('environment', { sessionId: session.id }) as { cwd: string }).cwd, session.cwd);
        await app.invoke('create', create); await app.invoke('create', create);
        assert.equal(app.processes.specs.length, 1); assert.deepEqual(app.checked, [session.cwd]);
        assert.equal(app.processes.specs[0]?.cwd, session.cwd); assert.equal(app.processes.specs[0]?.env?.DSH_SESSION_ID, session.id);
        const other = sourceSessionId({ ...identity, nativeId: 'private-thread' });
        await assert.rejects(app.invoke('list', { sessionId: other }), denied);
        await assert.rejects(app.invoke('list', { sessionId: 'hhpi:malformed' }));
        assert.equal(app.processes.specs.length, 1);
        await app.invoke('close', { sessionId: session.id, id: terminalId }); assert.equal(app.processes.handles[0]?.terminations, 1);
    } finally { await app.close(); }
});

test('view detach and hold cancellation retain the same owner process; source unregister disposes it', { timeout: 5000 }, async () => {
    const app = await mount(), firstInput = inputChannel(), secondInput = inputChannel();
    try {
        app.allow(['create', 'retain', 'attach', 'list']); await app.invoke('create', create);
        const holdSignal = new AbortController(), firstSignal = new AbortController();
        const hold = (await app.stream('retain', { sessionId: session.id, id: terminalId }, { signal: holdSignal.signal }))[Symbol.asyncIterator]();
        assert.deepEqual((await hold.next()).value, { type: 'retained' });
        const first = (await app.stream('attach', { sessionId: session.id, id: terminalId }, { signal: firstSignal.signal, uplink: firstInput.source,
            uplinkWindow: { maxBytes: 4096, frameOverheadBytes: 7 } }))[Symbol.asyncIterator]();
        assert.deepEqual(((await first.next()).value as TerminalFrame & { type: 'snapshot' }).inputWindow, { maxBytes: 4096, frameOverheadBytes: 7 });
        firstInput.push({ type: 'write', sequence: 1, data: 'one' });
        let frame: TerminalFrame; do { frame = (await first.next()).value as TerminalFrame; } while (frame.type !== 'ack');
        assert.deepEqual(app.processes.handles[0]?.writes, ['one']);
        firstSignal.abort(); holdSignal.abort(); await first.return?.(); await hold.return?.();
        assert.equal(app.processes.handles[0]?.terminations, 0);
        const secondSignal = new AbortController();
        const second = (await app.stream('attach', { sessionId: session.id, id: terminalId }, { signal: secondSignal.signal, uplink: secondInput.source }))[Symbol.asyncIterator]();
        assert.equal(((await second.next()).value as TerminalFrame).type, 'snapshot');
        assert.equal(app.processes.specs.length, 1); assert.deepEqual(app.processes.handles[0]?.writes, ['one']);
        secondSignal.abort(); await second.return?.(); await app.unregister();
        assert.equal(app.processes.handles[0]?.terminations, 1);
    } finally { await firstInput.source.return?.(); await secondInput.source.return?.(); await app.close(); }
});

test('revoking grants ends an idle source attachment and prevents later input without closing the owner', { timeout: 5000 }, async () => {
    const app = await mount(), input = inputChannel();
    try {
        app.allow(['create', 'attach', 'list']); await app.invoke('create', create);
        const iterator = (await app.stream('attach', { sessionId: session.id, id: terminalId }, { uplink: input.source }))[Symbol.asyncIterator]();
        assert.equal(((await iterator.next()).value as TerminalFrame).type, 'snapshot');
        const ended = iterator.next(); app.grants.length = 0; app.remoteAccess.invalidate();
        await assert.rejects(ended, denied);
        input.push({ type: 'write', sequence: 1, data: 'must-not-run' }); await tick();
        assert.deepEqual(app.processes.handles[0]?.writes, []); assert.equal(app.processes.handles[0]?.terminations, 0);
        app.allow(['list']); assert.equal((await app.invoke('list', { sessionId: session.id }) as WebTerminalInfo[]).length, 1);
    } finally { await input.source.return?.(); await app.close(); }
});

test('client routing preserves exact stream handles, uses the ordinary provider for DSH and never falls back', async () => {
    const calls: string[] = [], handle: RemoteStreamHandle<TerminalFrame, TerminalInput> = {
        async *[Symbol.asyncIterator]() {}, send() {}, end() {}, dispose() {},
    };
    const api = (kind: string): TerminalRemote => ({
        environment: async () => { calls.push(`${kind}:environment`); throw new Error('offline'); },
        shells: async () => { calls.push(`${kind}:shells`); throw new Error('offline'); },
        list: async () => { calls.push(`${kind}:list`); return { ok: true, value: [] }; },
        create: async () => { calls.push(`${kind}:create`); throw new Error('offline'); },
        retain: () => { calls.push(`${kind}:retain`); return handle as RemoteStreamHandle<never, never>; },
        attach: () => { calls.push(`${kind}:attach`); return handle; },
        rename: async () => { calls.push(`${kind}:rename`); return { ok: true, value: undefined }; },
        close: async () => { calls.push(`${kind}:close`); return { ok: true, value: undefined }; },
    });
    const remote = sourceTerminalRemote(api('ordinary'), api('source'));
    assert.equal(remote.attach(SessionId(session.id), terminalId), handle);
    await remote.list(SessionId('dsh-session'));
    await assert.rejects(remote.environment(SessionId(session.id)), /offline/);
    assert.deepEqual(calls, ['source:attach', 'ordinary:list', 'source:environment']);
});
