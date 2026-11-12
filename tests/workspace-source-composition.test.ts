/** Installed official Gateway/registry, real source filesystem and subprocess owner; native catalog is a fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccess, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import type { PeerScope, PeerId } from '@deepseek-ai/dsh-typert-protocol';
import { parseConfig } from '../src/cli/config.ts';
import { parseRunnerConfig } from '../src/runner/config.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import { registerSourceContract, SourceWorkspaceService, HhpiSourceService } from '../src/remote/service.ts';
import { SourceTerminalService } from '../src/workspace/source-terminal-service.ts';
import { installLocalSourceWorkspaces } from '../src/workspace/local-source.ts';
import { sourceSessionId, type SourceAdapter, type SourceSession } from '../src/remote/protocol.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { TerminalInput, TerminalFrame, TerminalShell, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types';

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'composition-reader': { kind: 'composition-reader' } } }

const config = { version: 1, dsh: { home: '/source-home', profile: 'hhpi' }, server: { host: '127.0.0.1', port: 0 },
    sources: [{ id: 'source', machineId: 'machine', engine: 'codex' }] };
test('source OS access requires explicit local-system config and survives Runner validation', () => {
    assert.equal(parseConfig(config).sourceWorkspaces, undefined);
    const sourceWorkspaces = [{ sourceId: 'source', provider: 'local-system' }];
    assert.deepEqual(parseConfig({ ...config, sourceWorkspaces }).sourceWorkspaces, sourceWorkspaces);
    for (const entries of [[{ sourceId: 'missing', provider: 'local-system' }], [...sourceWorkspaces, ...sourceWorkspaces], [{ sourceId: 'source', provider: 'auto' }]]) {
        assert.throws(() => parseConfig({ ...config, sourceWorkspaces: entries }));
    }
    const runner = parseRunnerConfig({ ...config, sourceWorkspaces, machine: { id: 'machine', name: 'Source' }, hub: { url: 'https://hub.invalid', tokenEnv: 'SOURCE_PAIR_TOKEN' } });
    assert.deepEqual(runner.sourceWorkspaces, sourceWorkspaces);
});

test('combined source face reads the real selected workspace without an Agent and leaves unregistered sources unavailable', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-source-composition-');
    const workspace = join(directory, 'workspace'); await mkdir(workspace); await writeFile(join(workspace, 'note.txt'), 'source-owned');
    const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread' };
    const session: SourceSession = { ...identity, id: sourceSessionId(identity), cwd: workspace, title: 'Synthetic', updatedAt: 1, status: 'idle', activeTurnId: null,
        capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] };
    const adapter: SourceAdapter = { id: identity.sourceId, machineId: identity.machineId, engine: identity.engine, async list() { return [session]; },
        async resolve() { return session; }, async read() { throw new Error('No transcript read'); }, async *changes() {}, async operate() { throw new Error('No native writes'); }, dispose() {} };
    const ctx = new Context(), source = new SourceGateway([adapter]);
    const lifetime = new AbortController();
    try {
        await ctx.plugin(TypertRegistry); const access = new RemoteAccess(ctx);
        registerSourceContract(ctx);
        new HhpiSourceService(ctx, source, directory);
        new SourceWorkspaceService(ctx, source, { localHostId: 'local', scopeId: directory });
        new SourceTerminalService(ctx, source, { localHostId: 'local', scopeId: directory });
        const gateway = new Gateway(ctx, Gateway.Config({}));
        const peer: PeerScope = { id: 'composition' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal: lifetime.signal, async dispose() {} };
        const invoke = (namespace: string, method: string, args: Record<string, unknown>) => gateway.invoke({ peer, namespace, method, args });
        await assert.rejects(invoke('sourceWorkspace', 'resolve', { request: { sessionId: session.id } }), /not registered/);
        installLocalSourceWorkspaces(ctx, source, parseConfig(config).sources!, [{ sourceId: 'source', provider: 'local-system' }], directory);
        const resolved = await invoke('sourceWorkspace', 'resolve', { request: { sessionId: session.id } }) as { binding: { root: string }; registered: { terminals: boolean; mutations: boolean } };
        assert.equal(resolved.binding.root, workspace);
        assert.equal(resolved.registered.terminals, true); assert.equal(resolved.registered.mutations, true);
        const read = await invoke('sourceWorkspace', 'read', { workspaceFileScopeId: session.id, path: 'note.txt', range: {} }) as { text: string };
        assert.match(read.text, /source-owned/);
        const grants: RemoteAccessBinding[] = [{ resource: { kind: 'session', id: SessionId(session.id) },
            role: { name: 'Reader', resource: 'session', actions: ['sourceWorkspace/openDocument'] } }];
        access.registerPolicy('composition-reader', { bindings: () => grants });
        const readDocument = () => gateway.invoke({ peer: { ...peer, principal: { kind: 'composition-reader' } }, namespace: 'sourceWorkspace',
            method: 'openDocument', args: { request: { sessionId: session.id, document: { kind: 'file', path: 'note.txt' } } } }) as Promise<{ writable: boolean }>;
        assert.equal((await readDocument()).writable, false, 'a read grant must not advertise Save');
        grants.push({ resource: { kind: 'session', id: SessionId(session.id) }, role: { name: 'Writer', resource: 'session', actions: ['sourceWorkspace/save'] } });
        assert.equal((await readDocument()).writable, true);
        grants.pop();
        assert.equal((await readDocument()).writable, false, 'revoking Save is reflected on the next open');
        const environment = await invoke('sourceTerminal', 'environment', { sessionId: session.id }) as { cwd: string };
        assert.equal(environment.cwd, workspace);
        const terminalId = 'composition-shell';
        // This fixture sends POSIX commands; select its declared shell rather
        // than inheriting the developer's default shell and startup plugins.
        const shells = await invoke('sourceTerminal', 'shells', { sessionId: session.id }) as TerminalShell[];
        const bash = shells.find(shell => shell.name === 'bash'); assert.ok(bash);
        const shell = await invoke('sourceTerminal', 'create', { sessionId: session.id, request: { id: terminalId, cols: 80, rows: 24, shellPath: bash.path } }) as WebTerminalInfo;
        assert.equal(shell.cwd, workspace); assert.equal(shell.state, 'running');
        const firstInput = inputChannel(), firstLife = new AbortController();
        const first = (await gateway.stream({ peer, namespace: 'sourceTerminal', method: 'attach', args: { sessionId: session.id, id: terminalId },
            signal: firstLife.signal, uplink: firstInput.source }))[Symbol.asyncIterator]();
        assert.equal(((await first.next()).value as TerminalFrame).type, 'snapshot');
        firstInput.push({ type: 'write', sequence: 1, data: "printf '%s' \"$$\" > shell.pid; printf 'once\\n' >> commands.txt\r" });
        while (((await first.next()).value as TerminalFrame).type !== 'ack') { /* Consume real PTY output until its input acknowledgement. */ }
        const pid = Number(await waitForFile(join(workspace, 'shell.pid')));
        assert.ok(pid > 0); process.kill(pid, 0);
        firstLife.abort(); await first.return?.(); await firstInput.source.return?.();
        assert.equal((await invoke('sourceTerminal', 'list', { sessionId: session.id }) as WebTerminalInfo[])[0]?.state, 'running');
        process.kill(pid, 0);
        const secondInput = inputChannel(), secondLife = new AbortController();
        const second = (await gateway.stream({ peer, namespace: 'sourceTerminal', method: 'attach', args: { sessionId: session.id, id: terminalId },
            signal: secondLife.signal, uplink: secondInput.source }))[Symbol.asyncIterator]();
        assert.equal(((await second.next()).value as TerminalFrame).type, 'snapshot');
        secondInput.push({ type: 'write', sequence: 1, data: "printf '%s' \"$$\" > resumed.pid\r" });
        while (((await second.next()).value as TerminalFrame).type !== 'ack') { /* Read the new attachment's own acknowledgement. */ }
        assert.equal(Number(await waitForFile(join(workspace, 'resumed.pid'))), pid);
        assert.equal(await readFile(join(workspace, 'commands.txt'), 'utf8'), 'once\n', 'reattach cannot replay previous input');
        secondLife.abort(); await second.return?.(); await secondInput.source.return?.();
        await invoke('sourceTerminal', 'close', { sessionId: session.id, id: terminalId });
        assert.deepEqual(await invoke('sourceTerminal', 'list', { sessionId: session.id }), []);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        assert.equal(ctx.get('agent'), undefined); assert.equal(ctx.get('subprocess'), undefined);
    } finally { lifetime.abort(); await source.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

function inputChannel() {
    const queue: TerminalInput[] = [];
    let next: ReturnType<typeof Promise.withResolvers<IteratorResult<TerminalInput>>> | undefined, ended = false;
    const source: AsyncIterableIterator<TerminalInput> = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
            if (queue.length) return { done: false, value: queue.shift()! };
            if (ended) return { done: true, value: undefined };
            next = Promise.withResolvers(); return next.promise;
        },
        async return() { ended = true; next?.resolve({ done: true, value: undefined }); return { done: true, value: undefined }; },
    };
    return { source, push(value: TerminalInput) { if (next) { next.resolve({ done: false, value }); next = undefined; } else queue.push(value); } };
}
async function waitForFile(path: string): Promise<string> {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
        try { const text = await readFile(path, 'utf8'); if (text) return text; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The synthetic shell did not produce its expected file');
}
