import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TerminalController } from '@deepseek-ai/dsh-api-terminal-controller'
import { TYPERT } from '@deepseek-ai/dsh-api-terminal-controller/typert'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { RemoteError, remoteMethods, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { TerminalFrame, TerminalInput, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { NativeMachineTerminals, type MachineTerminalChannel, type MachineTerminalCommand, type MachineTerminalConnector, type MachineTerminalEvent, type MachineTerminalInfo } from '../src/hapi/machine-terminals.ts'
import NativeAwareTerminalController from '../src/hapi/terminal-controller.ts'
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts'
import type { NativeWorkbench } from '../src/hapi/workbench.ts'
import type { WorkbenchSource } from '../src/workbench-types.ts'
import { officialDelegateFixture } from './official-provider-fixture.ts'

const source = { sourceSessionId: 'original-source', sourceHubId: 'fixture-hub', machineId: 'owning-runner' }
const id = 'original-terminal' as WebTerminalId
const request = { id, cols: 80, rows: 24 }
const signal = (): AbortSignal => new AbortController().signal
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const config = { ...TerminalController.Config(), unattendedTimeoutMs: 0 }
const session: HapiSession = { id: source.sourceSessionId, active: false, thinking: false, activeAt: 1, updatedAt: 1, metadataVersion: 1, agentStateVersion: 1,
  metadata: { path: '/source/project', machineId: source.machineId }, namespace: 'fixture', seq: 1, createdAt: 1, thinkingAt: 0, agentState: null }

/** Source protocol fixture only; these tests never claim to run an actual native PTY. */
function machineFixture() {
  const terminals = new Map<string, MachineTerminalInfo>()
  const channels = new Set<{ listeners: Set<(machine: string, event: MachineTerminalEvent) => void>; subscriptions: Set<string>; close(): void }>()
  const commands: Array<{ machineId: string; command: MachineTerminalCommand }> = []
  const input: string[] = []
  let failInput = false, failTerminate = false
  let inputGate: Promise<void> | undefined
  let createGate: { started: () => void; wait: Promise<void> } | undefined
  const publish = (event: MachineTerminalEvent, machineId = source.machineId) => {
    for (const channel of channels) {
      if (event.type === 'output' && !channel.subscriptions.has(event.terminalId)) continue
      for (const listener of channel.listeners) listener(machineId, structuredClone(event))
    }
  }
  const connect: MachineTerminalConnector = async () => {
    const listeners = new Set<(machineId: string, event: MachineTerminalEvent) => void>(), subscriptions = new Set<string>(), held = new Set<string>()
    let disconnected = false
    const channel: MachineTerminalChannel & { listeners: typeof listeners; subscriptions: typeof subscriptions } = {
      listeners, subscriptions,
      async request(machineId, command) {
        if (disconnected) throw new HapiRequestError('Not sent', 'rejected', undefined, 'terminal_not_sent')
        assert.equal(machineId, source.machineId)
        commands.push({ machineId, command: structuredClone(command) })
        if (command.type === 'list') return [...terminals.values()].map(value => structuredClone(value))
        if (command.type === 'create') {
          createGate?.started(); await createGate?.wait
          const previous = terminals.get(command.terminalId)
          if (previous) return structuredClone(previous)
          const info: MachineTerminalInfo = { terminalId: command.terminalId, title: command.title, cwd: command.cwd, cols: command.cols, rows: command.rows,
            pid: 12345, createdAt: 1, endedAt: null, status: 'running', exitCode: null, seq: 0, controllerId: null, controlVersion: 0 }
          terminals.set(info.terminalId, info); return structuredClone(info)
        }
        const info = terminals.get(command.terminalId)
        if (!info) throw new HapiRequestError('Terminal not found', 'rejected')
        if (command.type === 'attach') { subscriptions.add(info.terminalId); return { terminal: structuredClone(info), reset: true, seq: info.seq, data: 'original screen\r\n' } }
        if (command.type === 'claim') {
          info.controllerId = command.controllerId; info.controlVersion++; held.add(command.controllerId)
          publish({ type: 'state', terminal: info }); return structuredClone(info)
        }
        if (command.type === 'input' || command.type === 'resize') {
          if (!held.has(command.controllerId) || info.controllerId !== command.controllerId || info.controlVersion !== command.controlVersion) throw new HapiRequestError('Control changed', 'rejected')
          if (command.type === 'input') {
            input.push(command.data); await inputGate
            if (failInput) throw new HapiRequestError('ACK was lost after dispatch', 'indeterminate', undefined, 'terminal_ack_unknown')
            return null
          }
          info.cols = command.cols; info.rows = command.rows; publish({ type: 'state', terminal: info }); return structuredClone(info)
        }
        if (command.type === 'rename') { info.title = command.title; publish({ type: 'state', terminal: info }); return structuredClone(info) }
        if (command.type === 'terminate') {
          if (failTerminate) throw new HapiRequestError('Terminate outcome unknown', 'indeterminate')
          if (info.status !== 'lost') { info.status = 'exited'; info.exitCode = 0; info.endedAt = 2; info.controllerId = null; info.controlVersion++; publish({ type: 'state', terminal: info }) }
          return structuredClone(info)
        }
        return null
      },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      close() {
        if (disconnected) return
        disconnected = true; channels.delete(channel); listeners.clear()
        for (const info of terminals.values()) if (info.controllerId && held.has(info.controllerId)) {
          info.controllerId = null; info.controlVersion++; publish({ type: 'state', terminal: info })
        }
      },
    }
    channels.add(channel)
    return channel
  }
  return { connect, terminals, commands, input, channels, publish,
    setFailInput: (value: boolean) => { failInput = value }, setFailTerminate: (value: boolean) => { failTerminate = value },
    gateInput: (value: Promise<void> | undefined) => { inputGate = value },
    gateCreate: (value: typeof createGate) => { createGate = value } }
}
function uplink<T>() {
  let controller!: ReadableStreamDefaultController<T>
  const stream = new ReadableStream<T>({ start(value) { controller = value } }), reader = stream.getReader()
  const source: AsyncIterable<T> = { [Symbol.asyncIterator]: () => ({
    async next(): Promise<IteratorResult<T>> { const value = await reader.read(); return value.done ? { done: true, value: undefined } : { done: false, value: value.value } },
    async return(): Promise<IteratorResult<T>> { await reader.cancel(); return { done: true, value: undefined } },
  }) }
  return { source, push: (value: T) => { controller.enqueue(value) } }
}
async function fixture(overrides: Partial<typeof config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-machine-terminal-'))
  const stateFile = join(directory, 'closed.json'), machine = machineFixture()
  const workbench: Pick<NativeWorkbench, 'resolveTerminalSource'> = { resolveTerminalSource: async (bound: WorkbenchSource) => {
    if (bound.sourceHubId !== source.sourceHubId || bound.machineId !== source.machineId || bound.sourceSessionId !== source.sourceSessionId) throw new HapiRequestError('Wrong source ownership', 'rejected')
    return structuredClone(session)
  } }
  const authenticate = async () => ({ url: 'http://fixture.invalid', path: '/socket.io/', token: 'fixture-only' })
  const create = () => new NativeMachineTerminals(authenticate, workbench, { ...config, ...overrides }, { stateFile, connect: machine.connect })
  const adapter = create()
  return { machine, adapter, workbench, authenticate, stateFile, create, close: async () => { adapter.dispose(); await rm(directory, { recursive: true, force: true }) } }
}
async function nextMatching(iterator: AsyncIterator<TerminalFrame>, type: TerminalFrame['type']): Promise<TerminalFrame> {
  for (let count = 0; count < 30; count++) {
    const value = await iterator.next()
    assert.equal(value.done, false)
    if (value.value?.type === type) return value.value
  }
  throw new Error(`Expected terminal ${type}`)
}

test('source machine terminal creation is idempotent, session-bound, and continues with an inactive chat', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.adapter.environment(source, signal())).cwd, '/source/project')
    assert.deepEqual(await f.adapter.shells(source, signal()), [])
    const created = await f.adapter.create(source, request, signal())
    assert.equal(created.id, id); assert.equal(created.shell.path, ''); assert.equal(created.cwd, '/source/project')
    await f.adapter.create(source, request, signal())
    assert.equal(f.machine.commands.filter(row => row.command.type === 'create').length, 1)
    assert.match([...f.machine.terminals.keys()][0]!, /^hapi-dsh-[0-9a-f]{32}-original-terminal$/)
    assert.equal((await f.adapter.list(source, signal())).length, 1)
    await assert.rejects(f.adapter.create(source, { ...request, shellPath: '/bin/guessed' }, signal()), /configured default/)
    await assert.rejects(f.adapter.environment({ ...source, machineId: 'another-machine' }, signal()), /Wrong source/)
  } finally { await f.close() }
})

test('concurrent creation respects the source session limit while the first allocation is awaiting its ACK', async () => {
  const f = await fixture({ maxTerminals: 1 }), started = deferred<void>(), release = deferred<void>()
  try {
    f.machine.gateCreate({ started: () => { started.resolve() }, wait: release.promise })
    const first = f.adapter.create(source, request, signal())
    await started.promise
    const second = f.adapter.create(source, { ...request, id: 'second-terminal' as WebTerminalId }, signal())
    const rejected = assert.rejects(second, /terminal limit/)
    release.resolve()
    await first; await rejected
    assert.equal(f.machine.commands.filter(row => row.command.type === 'create').length, 1)
  } finally { release.resolve(); await f.close() }
})

test('an explicit close queued during creation terminates that same allocation before allowing another create', async () => {
  const f = await fixture(), started = deferred<void>(), release = deferred<void>()
  try {
    f.machine.gateCreate({ started: () => { started.resolve() }, wait: release.promise })
    const pending = f.adapter.create(source, request, signal())
    await started.promise
    const closing = f.adapter.closeTerminal(source, id, signal())
    release.resolve(); await pending; await closing
    await assert.rejects(f.adapter.create(source, request, signal()), /explicitly closed/)
    assert.equal(f.machine.commands.filter(row => row.command.type === 'create').length, 1)
    assert.equal(f.machine.terminals.values().next().value?.status, 'exited')
    assert.deepEqual(await f.adapter.list(source, signal()), [])
  } finally { release.resolve(); await f.close() }
})

test('official terminal frames use the actual source snapshot and only acknowledge input after source acceptance', async () => {
  const f = await fixture(), abort = new AbortController(), input = uplink<TerminalInput>()
  try {
    await f.adapter.create(source, request, signal())
    const frames = f.adapter.attach(source, id, input.source, abort.signal, { maxBytes: 4096, frameOverheadBytes: 8 })[Symbol.asyncIterator]()
    const snapshot = await frames.next()
    assert.deepEqual(snapshot.value && { type: snapshot.value.type, ...(snapshot.value.type === 'snapshot' ? { screen: snapshot.value.screen, writable: snapshot.value.writable, sequence: snapshot.value.sequence, inputWindow: snapshot.value.inputWindow } : {}) },
      { type: 'snapshot', screen: 'original screen\r\n', writable: true, sequence: 0, inputWindow: { maxBytes: 4096, frameOverheadBytes: 8 } })
    const gate = deferred<void>(); f.machine.gateInput(gate.promise)
    input.push({ type: 'write', sequence: 1, data: 'echo accepted\r' })
    let acknowledged = false
    const ack = nextMatching(frames, 'ack').then(value => { acknowledged = true; return value })
    await new Promise(resolve => setImmediate(resolve)); assert.equal(acknowledged, false)
    gate.resolve(); assert.deepEqual(await ack, { type: 'ack', sequence: 1 })
    const rawId = [...f.machine.terminals.keys()][0]!
    f.machine.publish({ type: 'output', terminalId: rawId, seq: 1, data: 'accepted\r\n' }, 'wrong-machine')
    f.machine.publish({ type: 'output', terminalId: rawId, seq: 1, data: 'accepted\r\n' })
    assert.deepEqual(await nextMatching(frames, 'output'), { type: 'output', sequence: 1, data: 'accepted\r\n' })
    abort.abort(); await frames.return?.()
    assert.equal(f.machine.commands.filter(row => row.command.type === 'terminate').length, 0)
    assert.deepEqual(f.machine.input, ['echo accepted\r'])
  } finally { abort.abort(); await f.close() }
})

test('a newer attachment revokes the earlier view even while an old ownership event is queued', async () => {
  const f = await fixture(), firstAbort = new AbortController(), secondAbort = new AbortController()
  const firstInput = uplink<TerminalInput>(), secondInput = uplink<TerminalInput>()
  try {
    await f.adapter.create(source, request, signal())
    const first = f.adapter.attach(source, id, firstInput.source, firstAbort.signal)[Symbol.asyncIterator]()
    // Leave the original claim event queued. Reading it after takeover must
    // never restore that old lease or send a source command under it.
    await first.next()
    const second = f.adapter.attach(source, id, secondInput.source, secondAbort.signal)[Symbol.asyncIterator]()
    await second.next()
    const state = await nextMatching(first, 'state'); assert.equal(state.type === 'state' && state.writable, false)
    firstInput.push({ type: 'write', sequence: 1, data: 'must not execute' })
    assert.deepEqual(await nextMatching(first, 'ack'), { type: 'ack', sequence: 1, refusal: 'read-only' })
    secondInput.push({ type: 'write', sequence: 1, data: 'new controller' })
    assert.deepEqual(await nextMatching(second, 'ack'), { type: 'ack', sequence: 1 })
    assert.deepEqual(f.machine.input, ['new controller'])
    assert.equal(f.machine.commands.filter(row => row.command.type === 'input').length, 1)
    firstAbort.abort(); secondAbort.abort(); await first.return?.(); await second.return?.()
  } finally { firstAbort.abort(); secondAbort.abort(); await f.close() }
})

test('lost source input acknowledgement ends the attachment and never replays the keystroke', async () => {
  const f = await fixture(), abort = new AbortController(), input = uplink<TerminalInput>()
  try {
    await f.adapter.create(source, request, signal())
    const frames = f.adapter.attach(source, id, input.source, abort.signal)[Symbol.asyncIterator]()
    await frames.next(); f.machine.setFailInput(true)
    input.push({ type: 'write', sequence: 1, data: 'one dispatch' })
    await assert.rejects(nextMatching(frames, 'ack'), /ACK was lost/)
    assert.deepEqual(f.machine.input, ['one dispatch'])
    assert.equal(f.machine.commands.filter(row => row.command.type === 'input').length, 1)
    assert.equal(f.machine.commands.filter(row => row.command.type === 'terminate').length, 0)
  } finally { abort.abort(); await f.close() }
})

test('explicit terminal close persists intent, waits for real exit confirmation, and never recreates a closed identity', async () => {
  const f = await fixture()
  try {
    await f.adapter.create(source, request, signal())
    f.machine.setFailTerminate(true)
    await assert.rejects(f.adapter.closeTerminal(source, id, signal()), /outcome unknown/)
    const state = JSON.parse(await readFile(f.stateFile, 'utf8')) as { terminals: Record<string, string> }
    assert.deepEqual(Object.values(state.terminals), ['requested'])
    if (process.platform !== 'win32') assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600)
    const restored = f.create()
    try {
      assert.equal((await restored.list(source, signal()))[0]?.state, 'failed')
      assert.equal(f.machine.commands.filter(row => row.command.type === 'terminate').length, 1)
      await assert.rejects(restored.create(source, request, signal()), /explicitly closed/)
      f.machine.setFailTerminate(false)
      await restored.closeTerminal(source, id, signal())
      assert.deepEqual(await restored.list(source, signal()), [])
      await restored.closeTerminal(source, id, signal())
      assert.equal(f.machine.commands.filter(row => row.command.type === 'terminate').length, 2)
    } finally { restored.dispose() }
  } finally { await f.close() }
})

test('lost source process remains lost and cannot be reported as confirmed termination or replaced by attach', async () => {
  const f = await fixture()
  try {
    await f.adapter.create(source, request, signal())
    f.machine.terminals.values().next().value!.status = 'lost'
    const existing = await f.adapter.create(source, request, signal())
    assert.equal(existing.state, 'failed')
    await assert.rejects(f.adapter.closeTerminal(source, id, signal()), /not confirmed/)
    assert.equal(f.machine.commands.filter(row => row.command.type === 'create').length, 1)
  } finally { await f.close() }
})

test('public terminal composition preserves the real Gateway, native authorization, and ordinary Invocation uplink', async () => {
  const f = await fixture(), ctx = new Context(), abort = new AbortController()
  const output = new PassThrough(), done = deferred<{ exitCode: number; signal: null }>()
  const writes: string[] = []; let spawned = 0, terminated = 0
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(TypertRegistry)
    new RemoteAccessService(ctx)
    ctx.provide('sandboxPolicy', { workspaceRoot: '/ordinary', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/ordinary' }) } as never)
    ctx.provide('workingDirectory', { get: () => '/ordinary', ensure: async () => '/ordinary' } as never)
    ctx.provide('subprocess', { terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/fixture' }), resolveExecutable: async (path: string) => path,
      spawnTerminal: async () => { spawned++; return { pid: 22, output, done: done.promise, write: async (text: string) => { writes.push(text) }, resize: async () => {}, inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
        inspectForeground: async () => undefined, signalForeground: async () => 22, terminate: async () => { terminated++; output.end(); done.resolve({ exitCode: 0, signal: null }) } } } } as never)
    const nativeId = SessionId(`hapi-codex-${'c'.repeat(32)}`), ordinaryId = SessionId('ordinary-agent')
    ctx.provide('hapi', { nativeWorkbench: f.workbench, nativeTerminalAuthentication: f.authenticate, nativeTerminalStateFile: f.stateFile,
      workbenchSource: (value: string) => { if (value === nativeId) return source; if (value.startsWith('hapi-codex-')) throw new RemoteError('hapi/request', 'Unknown native source', { outcome: 'rejected' }); return undefined } } as unknown as Context['hapi'])
    new TerminalController(officialDelegateFixture(ctx, 'terminal-controller', config), config)
    ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-terminal-controller', TYPERT))
    await ctx.plugin({ inject: NativeAwareTerminalController.inject, apply(scope: Context) {
      new NativeAwareTerminalController(scope, TerminalController.Config(), { connect: f.machine.connect })
    } })
    const controller = ctx.get('terminalController') as unknown as NativeAwareTerminalController
    const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
    for (const sid of [nativeId, ordinaryId]) {
      const session = ctx.sessions.create(sid, { meta: { cwd: sid === nativeId ? '/source/project' : '/ordinary' } })
      const agent = { id: sid, ctx: ctx.extend(), session, status: 'idle' } as unknown as Agent
      ctx.agents.enter(agent, undefined)
    }
    const peer: PeerScope = { id: 'terminal-fixture' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal: abort.signal, dispose: async () => {} }
    const invoke = (method: string, args: Record<string, unknown>) => gateway.invoke({ peer, namespace: 'terminal', method, args })
    const ungranted = { ...peer, principal: { kind: 'fixture-ungranted' } } as unknown as PeerScope
    await assert.rejects(gateway.invoke({ peer: ungranted, namespace: 'terminal', method: 'create', args: { agentId: nativeId, request } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied')
    assert.equal(f.machine.commands.length, 0)
    const sourceCreated = await invoke('create', { agentId: nativeId, request }) as { id: string }
    assert.equal(sourceCreated.id, id); assert.equal(spawned, 0)
    await assert.rejects(invoke('environment', { agentId: `${nativeId}-r1` }))
    const ordinaryCreated = await invoke('create', { agentId: ordinaryId, request }) as { shell: { path: string } }
    assert.equal(ordinaryCreated.shell.path, '/bin/fixture'); assert.equal(spawned, 1)
    const uplinkInput = uplink<TerminalInput>()
    const stream = await gateway.stream({ peer, namespace: 'terminal', method: 'attach', args: { agentId: ordinaryId, id }, signal: abort.signal, uplink: uplinkInput.source })
    const frames = stream[Symbol.asyncIterator]() as AsyncIterator<TerminalFrame>
    assert.equal((await frames.next()).value?.type, 'snapshot')
    uplinkInput.push({ type: 'write', sequence: 1, data: 'ordinary input' })
    assert.deepEqual(await nextMatching(frames, 'ack'), { type: 'ack', sequence: 1 })
    assert.deepEqual(writes, ['ordinary input'])
    abort.abort(); await frames.return?.()
    assert.equal(terminated, 0)
    const comparison = new Context(), original = new TerminalController(comparison, config)
    assert.deepEqual(remoteMethods(controller), remoteMethods(original))
    assert.ok(ctx.typert.getPackage('@deepseek-ai/dsh-api-terminal-controller', 'host'))
    await comparison.fiber.dispose()
  } finally { abort.abort(); await ctx.fiber.dispose(); await f.close() }
})
