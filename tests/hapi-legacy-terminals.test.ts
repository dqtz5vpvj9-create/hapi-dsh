import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TerminalController } from '@deepseek-ai/dsh-api-terminal-controller'
import { TYPERT } from '@deepseek-ai/dsh-api-terminal-controller/typert'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { RemoteError, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { TerminalFrame, TerminalInput, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { HapiSession } from '../src/codex/contracts.ts'
import { LegacySessionTerminals, type LegacyTerminalLimits } from '../src/hapi/legacy-terminals.ts'
import { LegacyTerminalFrames } from '../src/hapi/legacy-terminal-frames.ts'
import type { NativeTerminalSocket } from '../src/hapi/terminal.ts'
import NativeAwareTerminalController from '../src/hapi/terminal-controller.ts'
import { legacyTerminalStateSchema, type LegacyTerminalState } from '../src/legacy-terminal-types.ts'
import { legacyTerminalTextSnapshotSchema } from '../src/legacy-terminal-text-types.ts'
import type { TerminalOutputCursor } from '../src/workbench-types.ts'
import { officialDelegateFixture } from './official-provider-fixture.ts'

const source = { sourceSessionId: 'original-session', sourceHubId: 'fixture-hub', machineId: 'original-runner' }
const sessionId = SessionId(`hapi-codex-${'e'.repeat(32)}`)
const request = { sessionId, source, terminalId: 'saved-pty', cols: 80, rows: 24 }
const session: HapiSession = { id: source.sourceSessionId, active: true, thinking: false, activeAt: 1, updatedAt: 1,
  metadataVersion: 1, agentStateVersion: 1, metadata: { path: '/original/project', machineId: source.machineId },
  namespace: 'fixture', seq: 1, createdAt: 1, thinkingAt: 0, agentState: null }
const freshSignal = (): AbortSignal => new AbortController().signal
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for original terminal protocol fixture'); await delay(2) }
}
function uplink<T>() {
  let controller!: ReadableStreamDefaultController<T>
  const reader = new ReadableStream<T>({ start(value) { controller = value } }).getReader()
  return { push: (value: T) => { controller.enqueue(value) }, source: { [Symbol.asyncIterator]: () => ({
    async next(): Promise<IteratorResult<T>> { const value = await reader.read(); return value.done ? { done: true, value: undefined } : { done: false, value: value.value } },
    async return(): Promise<IteratorResult<T>> { await reader.cancel(); return { done: true, value: undefined } },
  }) } satisfies AsyncIterable<T> }
}
class OriginalSocket implements NativeTerminalSocket {
  connected = false
  writableTransport = true
  failInput = false
  readonly sent: Array<{ event: string; payload: unknown }> = []
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  constructor(private readonly opened: (socket: OriginalSocket, payload: unknown) => void) {}
  writable(): boolean { return this.connected && this.writableTransport }
  on(event: string, listener: (...args: unknown[]) => void): void { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]) }
  emit(event: string, payload: unknown): void { this.sent.push({ event, payload: structuredClone(payload) }); if (event === 'terminal:create') this.opened(this, payload) }
  emitInput(event: string, payload: unknown): void { assert.equal(this.writable(), true); this.emit(event, payload); if (this.failInput) throw new Error('Fixture lost local transport admission') }
  connect(): void { this.connected = true; this.trigger('connect') }
  disconnect(): void { this.connected = false; this.listeners.clear() }
  lose(): void { this.connected = false; this.trigger('disconnect') }
  trigger(event: string, value?: unknown): void { for (const listener of [...this.listeners.get(event) ?? []]) listener(value) }
}

/** Exact source event fixture + real xterm headless decoder; no real PTY is claimed. */
function fixture(options: { limits?: Partial<LegacyTerminalLimits>; autoReady?: boolean; initial?: string; handoffMs?: number; openTimeoutMs?: number; truncated?: boolean } = {}) {
  const sockets: OriginalSocket[] = [], requests: Array<{ terminalId: string; sessionId: string; outputCursor?: TerminalOutputCursor }> = []
  const buffers = new Map<string, string>(), viewers: Array<{ abort: AbortController; frames: AsyncIterator<TerminalFrame> }> = []
  let autoReady = options.autoReady ?? true, epoch = 'source-epoch', authenticationCalls = 0, resolutions = 0
  const limits = { ...TerminalController.Config(), ...options.limits }
  const ready = (socket: OriginalSocket, raw = requests.at(-1)!): void => {
    const data = buffers.get(raw.terminalId) ?? options.initial ?? 'original output\r\n'
    buffers.set(raw.terminalId, data)
    const mismatch = raw.outputCursor && raw.outputCursor.epoch !== epoch
    const start = raw.outputCursor && !mismatch ? raw.outputCursor.offset : 0
    socket.trigger('terminal:output', { terminalId: raw.terminalId, sessionId: raw.sessionId, data: mismatch ? '' : data.slice(start),
      stream: { version: 1, epoch, startOffset: start, endOffset: data.length, replay: true,
        ...(options.truncated ? { truncated: true } : {}), ...(mismatch ? { gap: 'epoch-changed' } : {}) } })
    socket.trigger('terminal:ready', { terminalId: raw.terminalId, sessionId: raw.sessionId, replayProtocol: 1 })
  }
  const manager = new LegacySessionTerminals({
    authenticate: async () => { authenticationCalls++; return { url: 'https://fixture-source.invalid', path: '/fixture/socket.io/', token: 'fixture-private-only' } },
    workbench: { resolveSource: async bound => { resolutions++; assert.deepEqual(bound, source); return structuredClone(session) } },
    getLimits: () => limits, handoffMs: options.handoffMs ?? 100, openTimeoutMs: options.openTimeoutMs ?? 2_000,
    createSocket: authentication => {
      assert.equal(authentication.token, 'fixture-private-only')
      const socket = new OriginalSocket((current, payload) => {
        const raw = payload as { terminalId: string; sessionId: string; outputCursor?: TerminalOutputCursor }
        assert.equal(raw.sessionId, source.sourceSessionId); requests.push(structuredClone(raw))
        if (autoReady) ready(current, raw)
      }); sockets.push(socket); return socket
    },
  })
  const state = (id: WebTerminalId) => manager.read({ sessionId, id }, source)!
  const open = (terminalId = request.terminalId, signal = freshSignal()) => manager.open({ ...request, terminalId }, source, signal)
  const append = (data: string, terminalId = request.terminalId): void => {
    const previous = buffers.get(terminalId) ?? '', next = previous + data; buffers.set(terminalId, next)
    for (const socket of sockets) if (socket.connected && socket.sent.some(row => row.event === 'terminal:create' && (row.payload as { terminalId: string }).terminalId === terminalId)) {
      socket.trigger('terminal:output', { terminalId, sessionId: source.sourceSessionId, data,
        stream: { version: 1, epoch, startOffset: previous.length, endOffset: next.length, replay: false } })
    }
  }
  const view = (value: LegacyTerminalState) => {
    const abort = new AbortController(), input = uplink<TerminalInput>()
    const frames = manager.attach(sessionId, source, value.id, input.source, abort.signal, { maxBytes: 4096, frameOverheadBytes: 8 })[Symbol.asyncIterator]()
    viewers.push({ abort, frames }); return { abort, frames, input }
  }
  return { manager, sockets, requests, buffers, open, state, ready, append, view,
    setReady: (value: boolean) => { autoReady = value }, setEpoch: (value: string) => { epoch = value },
    authenticationCalls: () => authenticationCalls, resolutions: () => resolutions,
    close: async () => { for (const viewer of viewers) viewer.abort.abort(); for (const viewer of viewers) await viewer.frames.return?.(); await manager.dispose() } }
}
async function nextFrame<T extends TerminalFrame['type']>(frames: AsyncIterator<TerminalFrame>, type: T): Promise<Extract<TerminalFrame, { type: T }>> {
  for (let count = 0; count < 30; count++) {
    const next = await frames.next(); assert.equal(next.done, false)
    if (next.value?.type === type) return next.value as Extract<TerminalFrame, { type: T }>
  }
  throw new Error(`Expected ${type}`)
}

test('legacy source identities, real decoded snapshot, 10000-row policy and local admission survive official view detach', async () => {
  const f = fixture({ initial: '\u001b[31mred\u001b[0m\r\nemoji 😀\r\n' }), openSignal = new AbortController()
  try {
    assert.deepEqual(f.manager.list({ sessionId }, source), [])
    assert.equal(f.authenticationCalls(), 0)
    const state = await f.open(request.terminalId, openSignal.signal)
    openSignal.abort()
    assert.equal(f.sockets[0]!.connected, true, 'returning/cancelling the completed Open does not own the service socket')
    assert.equal(legacyTerminalStateSchema.parse(state).environment?.scrollback, 10_000)
    assert.equal(state.environment?.cwd, '/original/project')
    assert.equal(state.info?.cwd, ''); assert.equal(state.info?.shell.path, '')
    assert.equal(state.facts.initialCwd.kind, 'unreported')
    assert.equal(state.compatibility.inputAcknowledgement, 'adapter-transport')
    assert.equal(JSON.stringify(state).includes('fixture-private-only'), false)
    const viewer = f.view(state), snapshot = await nextFrame(viewer.frames, 'snapshot')
    assert.match(snapshot.screen, /red/); assert.match(snapshot.screen, /emoji 😀/)
    assert.equal(snapshot.writable, true); assert.deepEqual(snapshot.inputWindow, { maxBytes: 4096, frameOverheadBytes: 8 })
    viewer.input.push({ type: 'write', sequence: 1, data: 'pwd\r' })
    assert.deepEqual(await nextFrame(viewer.frames, 'ack'), { type: 'ack', sequence: 1 })
    viewer.input.push({ type: 'resize', sequence: 2, cols: 90, rows: 30 })
    assert.deepEqual(await nextFrame(viewer.frames, 'ack'), { type: 'ack', sequence: 2 })
    assert.equal(f.state(state.id).facts.dimensions?.basis, 'adapter-resize-admission')
    assert.equal(f.state(state.id).delivery.adapterAccepted, 2)
    const copy = legacyTerminalTextSnapshotSchema.parse(await f.manager.readText({ sessionId, id: state.id }, source))
    assert.deepEqual(copy.lines, ['red', 'emoji 😀'])
    assert.equal(copy.provenance, 'adapter-observed'); assert.equal(copy.sequence, snapshot.sequence)
    assert.equal(f.requests.length, 1)
    viewer.abort.abort(); await viewer.frames.return?.()
    assert.equal(f.sockets[0]!.connected, false)
    assert.equal(f.sockets[0]!.sent.some(row => /close|abort|stop/u.test(row.event)), false)
    assert.equal((await f.manager.readText({ sessionId, id: state.id }, source)).sequence, copy.sequence)
    assert.equal(f.requests.length, 1, 'copying detached retained output never opens a source terminal')
  } finally { await f.close() }
})

test('a second official view baseline is atomic with pending headless output and never replays pre-baseline frames', async () => {
  const f = fixture()
  try {
    const state = await f.open(), first = f.view(state); await first.frames.next()
    const before = f.state(state.id).replay.sequence
    f.append(`pending ${'x'.repeat(32_000)}\r\n`)
    const second = f.view(state), snapshot = await nextFrame(second.frames, 'snapshot')
    assert.equal(snapshot.sequence, before + 1)
    const next = nextFrame(second.frames, 'output'); f.append('after baseline\r\n')
    assert.deepEqual(await next, { type: 'output', sequence: snapshot.sequence + 1, data: 'after baseline\r\n' })
    assert.equal(f.requests.length, 1)
  } finally { await f.close() }
})

test('the newest view alone accepts input; an earlier view stays read-only after it closes', async () => {
  const f = fixture()
  try {
    const state = await f.open(), first = f.view(state); await first.frames.next()
    const second = f.view(state); await second.frames.next()
    assert.equal((await nextFrame(first.frames, 'state')).writable, false)
    first.input.push({ type: 'write', sequence: 1, data: 'must-not-run' })
    assert.equal((await nextFrame(first.frames, 'ack')).refusal, 'read-only')
    second.input.push({ type: 'write', sequence: 1, data: 'one accepted write' })
    assert.equal((await nextFrame(second.frames, 'ack')).refusal, undefined)
    second.abort.abort(); await second.frames.return?.()
    first.input.push({ type: 'write', sequence: 2, data: 'no implicit takeover' })
    assert.equal((await nextFrame(first.frames, 'ack')).refusal, 'read-only')
    assert.deepEqual(f.sockets[0]!.sent.filter(row => row.event === 'terminal:write').map(row => row.payload), [{ terminalId: request.terminalId, data: 'one accepted write' }])
  } finally { await f.close() }
})

test('cancelled Open waits do not cancel another caller and ownerless handoff is bounded without source termination', async () => {
  const f = fixture({ autoReady: false, handoffMs: 15 }), firstAbort = new AbortController()
  try {
    const first = f.open(request.terminalId, firstAbort.signal), rejection = assert.rejects(first, /cancelled by fixture/u)
    const second = f.open()
    await until(() => f.sockets.length === 1 && f.requests.length === 1)
    firstAbort.abort(new Error('cancelled by fixture')); await rejection
    f.ready(f.sockets[0]!); const state = await second
    assert.equal(state.phase, 'ready'); assert.equal(f.sockets[0]!.connected, true)
    await until(() => !f.sockets[0]!.connected)
    assert.equal(f.state(state.id).phase, 'disconnected')
    assert.equal(f.sockets[0]!.sent.some(row => row.event === 'terminal:close'), false)
  } finally { await f.close() }
})

test('source reconnect drains accepted UTF-16 output before its new cursor and never replays uncertain input', async () => {
  const f = fixture({ initial: 'start\r\n' })
  try {
    const state = await f.open(), first = f.view(state); await first.frames.next()
    f.append('queued 😀\r\n')
    f.sockets[0]!.trigger('terminal:output', { terminalId: request.terminalId, data: 'queued 😀\r\n',
      stream: { version: 1, epoch: 'source-epoch', startOffset: 'start\r\n'.length, endOffset: 'start\r\nqueued 😀\r\n'.length, replay: false } })
    f.sockets[0]!.lose()
    const second = f.view(state), snapshot = await nextFrame(second.frames, 'snapshot')
    assert.match(snapshot.screen, /queued 😀/)
    assert.equal(snapshot.sequence, state.replay.sequence + 1, 'duplicate source coordinates never produce a second output frame')
    assert.deepEqual(f.requests[1]?.outputCursor, { epoch: 'source-epoch', offset: 'start\r\nqueued 😀\r\n'.length })
    f.sockets[1]!.failInput = true
    second.input.push({ type: 'write', sequence: 1, data: 'possibly delivered once' })
    await assert.rejects(nextFrame(second.frames, 'ack'), /delivery is uncertain/u)
    assert.equal(f.state(state.id).delivery.uncertain, true)
    f.sockets[1]!.failInput = false
    const third = f.view(state); await third.frames.next()
    assert.equal(f.sockets.flatMap(socket => socket.sent).filter(row => row.event === 'terminal:write').length, 1)
    first.abort.abort(); await first.frames.return?.()
  } finally { await f.close() }
})

test('source-ready without its replay baseline times out as unknown and never triggers automatic retry', async () => {
  const f = fixture({ autoReady: false, openTimeoutMs: 25, handoffMs: 5 })
  try {
    const opening = f.open(), rejected = assert.rejects(opening, /ready and compatible replay/u)
    await until(() => f.sockets.length === 1 && f.requests.length === 1)
    f.sockets[0]!.trigger('terminal:ready', { terminalId: request.terminalId, replayProtocol: 1 })
    // The event loop stays alive while exercising the production unref timer.
    await delay(30); await rejected
    const state = f.manager.list({ sessionId }, source)[0]!
    assert.equal(state.phase, 'failed'); assert.equal(state.replay.cursor, null)
    assert.equal(f.sockets[0]!.connected, false); assert.equal(f.requests.length, 1)
    assert.equal(f.sockets[0]!.sent.some(row => row.event !== 'terminal:create'), false)
  } finally { await f.close() }
})

test('owned or unidentifiable malformed frames fail closed while explicit other-source frames are ignored', async () => {
  for (const malformed of [{ terminalId: request.terminalId, data: 7 }, { data: 'unknown owner' }]) {
    const f = fixture()
    try {
      const state = await f.open(), viewer = f.view(state); await viewer.frames.next()
      f.sockets[0]!.trigger('terminal:output', { terminalId: 'other-terminal', data: 7 })
      f.sockets[0]!.trigger('terminal:output', { terminalId: request.terminalId, sessionId: 'other-source', data: 7 })
      assert.equal(f.state(state.id).phase, 'ready')
      f.sockets[0]!.trigger('terminal:output', malformed)
      viewer.input.push({ type: 'write', sequence: 1, data: 'cannot follow invalid output' })
      await assert.rejects(viewer.frames.next(), /malformed/u)
      assert.equal(f.state(state.id).replay.issue, 'invalid-stream')
      assert.equal(f.sockets[0]!.sent.filter(row => row.event === 'terminal:write').length, 0)
    } finally { await f.close() }
  }
})

test('output epoch gaps require explicit bounded replay reload and never silently replace a source screen', async () => {
  const f = fixture()
  try {
    const state = await f.open(), first = f.view(state); await first.frames.next()
    f.setEpoch('new-source-epoch'); f.sockets[0]!.lose()
    const second = f.view(state)
    await assert.rejects(second.frames.next(), /epoch-changed/u)
    const attempts = f.requests.length, blocked = f.view(state)
    await assert.rejects(blocked.frames.next(), /gap/u)
    assert.equal(f.requests.length, attempts)
    const reloaded = await f.open()
    assert.equal(reloaded.id, state.id); assert.equal(reloaded.replay.cursor?.epoch, 'new-source-epoch')
    assert.equal(f.requests.at(-1)?.outputCursor, undefined)
    assert.equal(f.sockets.flatMap(socket => socket.sent).filter(row => row.event === 'terminal:write').length, 0)
  } finally { await f.close() }
})

test('a slow output receiver loses input control immediately and stale queued ACKs cannot revive it', async () => {
  const f = fixture({ limits: { maxBufferedBytes: 1024 } })
  try {
    const state = await f.open(), viewer = f.view(state); await viewer.frames.next()
    for (let index = 0; index < 3; index++) {
      f.append(`${index}${'x'.repeat(600)}\r\n`)
      await f.manager.readText({ sessionId, id: state.id }, source)
    }
    viewer.input.push({ type: 'write', sequence: 1, data: 'must-not-run-after-overflow' })
    await assert.rejects(viewer.frames.next(), /receiver fell behind/u)
    assert.equal(f.sockets[0]!.sent.filter(row => row.event === 'terminal:write').length, 0)
    assert.equal(f.state(state.id).phase, 'disconnected')
    const next = f.view(state); assert.equal((await nextFrame(next.frames, 'snapshot')).writable, true)
  } finally { await f.close() }
  const queue = new LegacyTerminalFrames(1024)
  queue.push({ type: 'ack', sequence: 1 }); queue.fail(new Error('failed after admission'))
  await assert.rejects(queue.read(freshSignal())[Symbol.asyncIterator]().next(), /failed after admission/u)
})

test('fully detached LRU screens release quota, but retained views are never evicted', async () => {
  const f = fixture({ limits: { maxTerminals: 1 }, handoffMs: 5 })
  try {
    const first = await f.open('first')
    await until(() => !f.sockets[0]!.connected)
    const second = await f.open('second')
    assert.equal(f.manager.read({ sessionId, id: first.id }, source), null)
    const holdAbort = new AbortController(), hold = f.manager.retain(sessionId, source, second.id, holdAbort.signal)[Symbol.asyncIterator]()
    assert.deepEqual((await hold.next()).value, { type: 'retained' })
    await assert.rejects(f.open('third'), /limit/u)
    assert.equal(f.requests.length, 2)
    holdAbort.abort(); await hold.return?.()
    const third = await f.open('third'); assert.notEqual(third.id, second.id)
    assert.equal(f.manager.read({ sessionId, id: second.id }, source), null)
    assert.equal(f.sockets.flatMap(socket => socket.sent).some(row => row.event === 'terminal:close'), false)
  } finally { await f.close() }
})

test('retained scrollback copy is decoded at the same output boundary, does not claim input, and reports source truncation separately', async () => {
  const f = fixture({ initial: 'source tail\r\n', truncated: true })
  try {
    const state = await f.open(), viewer = f.view(state); await viewer.frames.next()
    const data = Array.from({ length: 1_500 }, (_, index) => `row ${index}\r\n`).join('')
    f.append(data)
    const snapshot = await f.manager.readText({ sessionId, id: state.id }, source)
    assert.equal(snapshot.sequence, state.replay.sequence + 1)
    assert.ok(snapshot.lines.includes('row 0')); assert.ok(snapshot.lines.includes('row 1499'))
    assert.equal(snapshot.localLimitReached, false); assert.equal(snapshot.replayIssue, 'truncated')
    assert.equal(snapshot.lines[0], 'source tail')
    assert.equal(f.requests.length, 1)
    assert.equal(f.sockets[0]!.sent.filter(row => row.event !== 'terminal:create').length, 0)
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(f.manager.readText({ sessionId, id: state.id }, source, cancelled.signal))
    assert.equal(f.sockets[0]!.connected, true)
  } finally { await f.close() }
})

test('a confirmed source exit remains exited until an explicit original attach-or-create and unknown identities fail closed', async () => {
  const f = fixture()
  try {
    const state = await f.open(), viewer = f.view(state); await viewer.frames.next()
    f.sockets[0]!.trigger('terminal:exit', { terminalId: request.terminalId, code: 7, signal: null })
    assert.equal((await nextFrame(viewer.frames, 'state')).info.exitCode, 7)
    const next = f.view(state), snapshot = await nextFrame(next.frames, 'snapshot')
    assert.equal(snapshot.info.state, 'exited'); assert.equal(snapshot.writable, false)
    assert.equal(f.requests.length, 1)
    assert.throws(() => f.manager.close(sessionId, source, state.id), /detach/u)
    assert.throws(() => f.manager.read({ sessionId, id: state.id }, { ...source, machineId: 'another-machine' }), /different source/u)
    const unknown = 'hapi-legacy-unknown' as WebTerminalId
    assert.equal(f.manager.read({ sessionId, id: unknown }, source), null)
    await assert.rejects(f.manager.attach(sessionId, source, unknown, uplink<TerminalInput>().source, freshSignal())[Symbol.asyncIterator]().next(), /not prepared/u)
    await assert.rejects(f.manager.open({ ...request, source: { ...source, sourceSessionId: 'other-source' } }, source, freshSignal()), /different original/u)
    assert.equal((await f.open()).phase, 'ready'); assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1]?.outputCursor, undefined)
  } finally { await f.close() }
})

test('official Remote Gateway routes exact legacy IDs to the adapter with original authorization and never exposes a kill/create fallback', async () => {
  const f = fixture(), ctx = new Context(), abort = new AbortController()
  try {
    const state = await f.open()
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(TypertRegistry)
    new RemoteAccessService(ctx)
    const config = TerminalController.Config()
    new TerminalController(officialDelegateFixture(ctx, 'terminal-controller', config), config)
    ctx.provide('hapi', { legacyTerminals: f.manager, workbenchSource: (id: string) => id === sessionId ? source : undefined } as unknown as Context['hapi'])
    ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-terminal-controller', TYPERT))
    await ctx.plugin({ inject: NativeAwareTerminalController.inject, apply(scope: Context) { new NativeAwareTerminalController(scope, config) } })
    const display = ctx.sessions.create(sessionId, { meta: { cwd: '/original/project' } })
    ctx.agents.enter({ id: sessionId, ctx: ctx.extend(), session: display, status: 'idle' } as unknown as Agent, undefined)
    const ordinaryId = SessionId('ordinary-display'), ordinary = ctx.sessions.create(ordinaryId)
    ctx.agents.enter({ id: ordinaryId, ctx: ctx.extend(), session: ordinary, status: 'idle' } as unknown as Agent, undefined)
    const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
    const peer: PeerScope = { id: 'legacy-fixture' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal: abort.signal, dispose: async () => {} }
    const invoke = (method: string, args: Record<string, unknown>) => gateway.invoke({ peer, namespace: 'terminal', method, args })
    const denied = { ...peer, principal: { kind: 'fixture-ungranted' } } as unknown as PeerScope
    await assert.rejects(gateway.invoke({ peer: denied, namespace: 'terminal', method: 'rename', args: { agentId: sessionId, id: state.id, title: 'denied' } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied')
    const input = uplink<TerminalInput>()
    const stream = await gateway.stream({ peer, namespace: 'terminal', method: 'attach', args: { agentId: sessionId, id: state.id }, signal: abort.signal, uplink: input.source })
    const frames = stream[Symbol.asyncIterator]() as AsyncIterator<TerminalFrame>
    assert.equal((await nextFrame(frames, 'snapshot')).info.id, state.id)
    input.push({ type: 'write', sequence: 1, data: 'gateway-original-write' })
    assert.equal((await nextFrame(frames, 'ack')).refusal, undefined)
    await invoke('rename', { agentId: sessionId, id: state.id, title: 'Local display alias' })
    assert.equal(f.state(state.id).info?.title, 'Local display alias')
    for (const agentId of [sessionId, ordinaryId]) {
      await assert.rejects(invoke('create', { agentId, request: { id: state.id, cols: 80, rows: 24 } }), /saved source/u)
      await assert.rejects(invoke('close', { agentId, id: state.id }), /detach|unavailable/u)
      await assert.rejects(invoke('rename', { agentId, id: 'hapi-legacy-unregistered', title: 'No fallback' }), /not prepared|unavailable/u)
    }
    assert.equal(f.requests.length, 1)
    assert.equal(f.sockets[0]!.sent.some(row => row.event === 'terminal:close'), false)
    abort.abort(); await frames.return?.()
  } finally { abort.abort(); await ctx.fiber.dispose(); await f.close() }
})
