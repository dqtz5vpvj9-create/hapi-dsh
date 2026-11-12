/** Installed official providers, Cordis isolates and Gateway are real; PTY execution is an explicit seat. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { TYPERT as FILES } from '@deepseek-ai/dsh-api-workspace-files/typert'
import LocalFileReferenceService from '@deepseek-ai/dsh-file-reference-local'
import { TerminalController } from '@deepseek-ai/dsh-api-terminal-controller'
import { TYPERT as TERMINAL } from '@deepseek-ai/dsh-api-terminal-controller/typert'
import type { TerminalFrame, TerminalInput, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { RemoteError, remoteMethods, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import OrdinaryWorkspaceFiles from '../src/workspace/ordinary-workspace-files.ts'
import fileReferences, { OrdinaryFileReferences } from '../src/workspace/ordinary-file-references.ts'
import OrdinaryTerminalController from '../src/workspace/ordinary-terminal-controller.ts'
import { officialDelegateFixture } from './official-provider-fixture.ts'

const rejected = ['hhpi:machine:source:codex:thread', 'hhpi:invalid', `hapi-codex-${'a'.repeat(32)}`, `hapi-observed-${'b'.repeat(32)}-r2`, 'hapi-codex-unknown']
const signal = () => new AbortController().signal
async function fixture() {
    const ctx = new Context(), directory = await mkdtemp('/mnt/cache/data-cache/hhpi-ordinary-resources-')
    await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentRegistry); await ctx.plugin(TypertRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: directory }); new RemoteAccessService(ctx)
    ctx.provide('sandboxPolicy', { workspaceRoot: directory, resolve: () => ({ mode: 'danger-full-access', workspaceRoot: directory }) } as never)
    ctx.provide('workingDirectory', { get: () => directory, ensure: async () => directory } as never)
    const session = (ctx.sessions as unknown as SessionStore).create(SessionId('ordinary-session'), { meta: { cwd: directory } })
    const agent = { id: session.id, session, ctx: ctx.extend(), status: 'idle' } as unknown as Agent; ctx.agents.enter(agent, undefined)
    const abort = new AbortController(), peer: PeerScope = { id: 'ordinary-resources' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal: abort.signal, dispose: async () => {} }
    return { ctx, directory, agent, peer, abort, close: async () => { abort.abort(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

test('ordinary file reads keep the installed limits, namespace and original scope; sources never use the Host filesystem', async () => {
    const f = await fixture()
    try {
        await writeFile(join(f.directory, 'original.txt'), 'first\nsecond\n')
        const config = { ...WorkspaceFiles.Config(), maxLines: 1 }
        const original = new WorkspaceFiles(officialDelegateFixture(f.ctx, 'workspace-files', config), config)
        f.ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-workspace-files', FILES))
        await f.ctx.plugin(OrdinaryWorkspaceFiles, WorkspaceFiles.Config())
        const service = f.ctx.get('workspaceFiles') as unknown as OrdinaryWorkspaceFiles
        assert.deepEqual(remoteMethods(service), remoteMethods(original)); assert.equal(OrdinaryWorkspaceFiles.Config, WorkspaceFiles.Config)
        const gateway = new TypertGatewayService(f.ctx, TypertGatewayService.Config({}))
        const request = { workspaceFileScopeId: f.agent.id, path: 'original.txt', range: { offset: 2, limit: 1 } }
        assert.equal((await gateway.invoke({ peer: f.peer, namespace: 'workspaceFiles', method: 'read', args: request }) as { text: string }).text, 'second')
        await assert.rejects(gateway.invoke({ peer: f.peer, namespace: 'workspaceFiles', method: 'read', args: { ...request, range: { limit: 2 } } }), /line|limit/i)
        const deniedPeer = { ...f.peer, principal: { kind: 'ungranted' } } as unknown as PeerScope
        await assert.rejects(gateway.invoke({ peer: deniedPeer, namespace: 'workspaceFiles', method: 'read', args: request }), (e: unknown) => e instanceof RemoteError && e.code === 'remote-access/denied')
        for (const sessionId of rejected) {
            const scope = { sessionId: SessionId(sessionId), workspaceRoot: f.directory }
            for (const call of [() => service.read(scope, 'original.txt', {}, signal()), () => service.readBytes(scope, 'original.txt', {}, signal()),
                () => service.stat(scope, 'original.txt', signal()), () => service.list(scope, '.', signal()), () => service.changes(scope, '.', signal())]) {
                assert.throws(call, /exact native source|retired source/)
            }
        }
    } finally { await f.close() }
})

test('ordinary file-reference registration waits for the isolated official provider and keeps its search configuration', async () => {
    const f = await fixture()
    try {
        await writeFile(join(f.directory, 'original.txt'), 'searchable ordinary file')
        const config = { maxResults: 1 }, isolated = officialDelegateFixture(f.ctx, 'file-reference-local', config)
        await f.ctx.plugin(fileReferences)
        assert.equal(f.ctx.get('fileReferences'), undefined)
        await isolated.plugin(LocalFileReferenceService, config)
        const service = f.ctx.get('fileReferences') as OrdinaryFileReferences
        assert.ok(service instanceof OrdinaryFileReferences)
        assert.deepEqual(await service.list(f.agent, '', signal()), [{ path: 'original.txt', kind: 'file' }])
        for (const id of rejected) assert.throws(() => service.list({ ...f.agent, id: SessionId(id) } as Agent, '', signal()), /exact native source|retired source/)
    } finally { await f.close() }
})

function uplink() {
    let input!: ReadableStreamDefaultController<TerminalInput>
    const reader = new ReadableStream<TerminalInput>({ start(value) { input = value } }).getReader()
    return { push: (value: TerminalInput) => input.enqueue(value), source: { [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<TerminalInput>> { const value = await reader.read(); return value.done ? { done: true, value: undefined } : { done: false, value: value.value } },
        async return(): Promise<IteratorResult<TerminalInput>> { await reader.cancel(); return { done: true, value: undefined } },
    }) } }
}

test('ordinary terminal Gateway attachment preserves its actual Invocation, ACK and owner when a viewer closes', async () => {
    const f = await fixture(), output = new PassThrough(), done = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const writes: string[] = []; let spawned = 0, terminated = 0
    try {
        f.ctx.provide('subprocess', { terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/fixture' }), resolveExecutable: async (path: string) => path,
            spawnTerminal: async () => { spawned++; return { pid: 22, output, done: done.promise, write: async (text: string) => { writes.push(text) }, resize: async () => {},
                inspectActivity: async () => ({ state: 'unknown', revision: 0 }), inspectForeground: async () => undefined, signalForeground: async () => 22,
                terminate: async () => { terminated++; output.end(); done.resolve({ exitCode: 0, signal: null }) } } } } as never)
        const config = { ...TerminalController.Config(), unattendedTimeoutMs: 0 }
        const original = new TerminalController(officialDelegateFixture(f.ctx, 'terminal-controller', config), config)
        f.ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-terminal-controller', TERMINAL))
        await f.ctx.plugin(OrdinaryTerminalController, config)
        const service = f.ctx.get('terminalController') as unknown as OrdinaryTerminalController
        assert.deepEqual(remoteMethods(service), remoteMethods(original))
        const gateway = new TypertGatewayService(f.ctx, TypertGatewayService.Config({})), id = 'original-terminal' as WebTerminalId, request = { id, cols: 80, rows: 24 }
        const created = await gateway.invoke({ peer: f.peer, namespace: 'terminal', method: 'create', args: { agentId: f.agent.id, request } }) as { id: string }
        assert.equal(created.id, id); assert.equal(spawned, 1)
        const input = uplink(), stream = await gateway.stream({ peer: f.peer, namespace: 'terminal', method: 'attach', args: { agentId: f.agent.id, id }, signal: f.abort.signal, uplink: input.source })
        const frames = stream[Symbol.asyncIterator]() as AsyncIterator<TerminalFrame>
        assert.equal((await frames.next()).value?.type, 'snapshot')
        input.push({ type: 'write', sequence: 1, data: 'ordinary input' })
        let frame: IteratorResult<TerminalFrame>
        do { frame = await frames.next() } while (!frame.done && frame.value.type !== 'ack')
        assert.deepEqual(frame.value, { type: 'ack', sequence: 1 }); assert.deepEqual(writes, ['ordinary input'])
        f.abort.abort(); await frames.return?.(); assert.equal(terminated, 0)
        for (const sourceId of rejected) {
            const agent = { ...f.agent, id: SessionId(sourceId) } as Agent
            await assert.rejects(service.environment(agent, signal()), /exact native source|retired source/)
            assert.throws(() => service.shells(agent, signal()), /exact native source|retired source/)
            await assert.rejects(service.list(agent.id), /exact native source|retired source/)
            for (const call of [() => service.create(agent, request, signal()), () => service.retain(agent.id, id, signal()), () => service.attach(agent, id, signal())]) {
                assert.throws(call, /exact native source|retired source/)
            }
            await assert.rejects(service.rename(agent, id, 'retired'), /exact native source|retired source/)
            await assert.rejects(service.close(agent, id), /exact native source|retired source/)
        }
        assert.equal(spawned, 1)
    } finally { await f.close() }
})
