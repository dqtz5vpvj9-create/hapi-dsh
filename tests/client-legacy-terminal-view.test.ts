/** Real Cordis isolation, ClientTerminals and RemoteStream; the remote wire is
 * an explicit in-memory protocol fixture, not an emulator or a source shell. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { ClientTerminals as ClientTerminalsType, TerminalRemote } from '@deepseek-ai/dsh-api-terminal-controller/client'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalFrame, TerminalInput, TerminalRetentionFrame, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { LegacyTerminalViews, legacyTerminalRemote, legacyTerminalSource } from '../src/client/legacy-terminal-client.ts'
import { canOpenLegacyTerminalAddress, legacyTerminalNavigationParams, legacyTerminalPaneTarget, LEGACY_TERMINAL_TAB_KIND } from '../src/client/legacy-session-terminal.tsx'
import { legacyTerminalStateSchema, type LegacyTerminalApi, type LegacyTerminalOpenRequest, type LegacyTerminalState } from '../src/legacy-terminal-types.ts'
import { readLegacyTerminalCopy } from '../src/client/source-terminal/snapshot.ts'
import type { LegacyTerminalTextApi, LegacyTerminalTextSnapshot } from '../src/legacy-terminal-text-types.ts'

// The published terminal client is a browser factory rather than Node ESM.
// Evaluate those exact bytes with its declared public module dependencies.
const require = createRequire(import.meta.url)
let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-api-terminal-controller/client') } | undefined
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-api-terminal-controller/client'), 'utf8'))({ __ModuleLoader__: { load(value: typeof published) { published = value } } })
assert.ok(published)
const { ClientTerminals } = published.factory(require)

const sessionId = 'display-session-alpha' as SessionId
const source = { sourceHubId: 'original-hub', sourceSessionId: 'original-session', machineId: 'machine-alpha' }
const terminalId = 'original/terminal:α'
const request: LegacyTerminalOpenRequest = { sessionId, source, terminalId, cols: 80, rows: 24 }
function state(): LegacyTerminalState {
  const id = `hapi-legacy-${'a'.repeat(40)}`
  return legacyTerminalStateSchema.parse({ id, sessionId, terminalId, source, phase: 'ready',
    info: { id, title: 'Original terminal', shell: { path: '', args: [], name: 'Shell not reported by legacy source' }, cwd: '', cols: 80, rows: 24, state: 'running', exitCode: null },
    environment: { cwd: '/actual/current/source', maxInputBytes: 1024, maxBufferedBytes: 8192, maxCols: 300, maxRows: 200, scrollback: 10_000 },
    facts: { title: 'adapter-display-alias', shell: { kind: 'unreported' }, initialCwd: { kind: 'unreported' }, dimensions: { cols: 80, rows: 24, basis: 'source-open-ready' }, lastSourceReadyAt: 1, exitSignal: null },
    replay: { cursor: { epoch: 'original-epoch', offset: 4 }, issue: null, sequence: 0 },
    compatibility: { open: 'attach-or-create', inputAcknowledgement: 'adapter-transport', replay: 'bounded-source-tail', retention: 'source-idle-policy', close: 'detach-only' },
    delivery: { adapterAccepted: 0, lastAcceptedAt: null, uncertain: false }, error: null,
  })
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
async function until(predicate: () => boolean): Promise<void> {
  for (let step = 0; step < 100; step++) { if (predicate()) return; await tick() }
  assert.ok(predicate(), 'Expected public model state to settle')
}
class Channel<Out, In> implements RemoteStreamHandle<Out, In>, AsyncIterator<Out> {
  private readonly values: Out[] = []
  private waiting: ((value: IteratorResult<Out>) => void) | undefined
  private ended = false
  constructor(signal: AbortSignal | undefined, private readonly input: (value: In) => void, private readonly stopped: () => void) {
    signal?.addEventListener('abort', () => this.dispose(), { once: true }); if (signal?.aborted) this.dispose()
  }
  push(value: Out): void { if (this.ended) return; const waiting = this.waiting; this.waiting = undefined; if (waiting) waiting({ done: false, value }); else this.values.push(value) }
  send(value: In): void { if (this.ended) throw new Error('Fixture carrier closed'); this.input(value) }
  end(): void {}
  dispose(): void { if (this.ended) return; this.ended = true; this.values.length = 0; this.waiting?.({ done: true, value: undefined }); this.waiting = undefined; this.stopped() }
  next(): Promise<IteratorResult<Out>> { const value = this.values.shift(); return value !== undefined ? Promise.resolve({ done: false, value }) : this.ended ? Promise.resolve({ done: true, value: undefined }) : new Promise(resolve => { this.waiting = resolve }) }
  async return(): Promise<IteratorResult<Out>> { this.dispose(); return { done: true, value: undefined } }
  [Symbol.asyncIterator](): AsyncIterator<Out> { return this }
}

async function fixture(overrides: Partial<LegacyTerminalApi> = {}) {
  const root = new Context(), originalState = state(), calls = { open: 0, machineEnvironment: 0, machineList: 0, machineCreate: 0, holds: 0, attachments: 0, closes: [] as string[], inputs: [] as TerminalInput[] }
  const api: LegacyTerminalApi = {
    sourceLegacyTerminalOpen: async () => { calls.open++; return { ok: true, value: originalState } },
    sourceLegacyTerminalRead: async () => ({ ok: true, value: originalState }),
    sourceLegacyTerminals: async () => ({ ok: true, value: [originalState] }), ...overrides,
  }
  const connection = { generation: createSnapshotStore({}) } as unknown as Pick<ConnectionHandle, 'generation'>
  root.provide('connection', connection)
  root.provide('remote', { $stream: <T>(options: RemoteStreamOptions<T>) => new RemoteStream(connection, options) })
  const original: TerminalRemote = {
    environment: async () => { calls.machineEnvironment++; throw new Error('Machine environment is not a legacy provider') },
    list: async () => { calls.machineList++; throw new Error('Machine inventory is not a legacy provider') },
    create: async () => { calls.machineCreate++; throw new Error('Never replace an original terminal') },
    shells: async () => ({ ok: true, value: [] }),
    retain: (_session, id, signal) => {
      assert.equal(_session, sessionId); assert.equal(id, originalState.id); calls.holds++
      const channel = new Channel<TerminalRetentionFrame, never>(signal, () => { throw new Error('No uplink on retain') }, () => { calls.holds-- })
      channel.push({ type: 'retained' }); return channel
    },
    attach: (_session, id, signal) => {
      assert.equal(_session, sessionId); assert.equal(id, originalState.id); calls.attachments++
      const channel = new Channel<TerminalFrame, TerminalInput>(signal, input => { calls.inputs.push(input); channel.push({ type: 'ack', sequence: input.sequence }) }, () => { calls.attachments-- })
      channel.push({ type: 'snapshot', sequence: 0, info: originalState.info!, screen: 'Original screen', writable: true }); return channel
    },
    rename: async () => ({ ok: true, value: undefined }),
    close: async (_session, id) => { calls.closes.push(id); return { ok: true, value: undefined } },
  }
  let ordinary!: ClientTerminalsType, models!: ClientTerminalsType, views!: LegacyTerminalViews
  const normal = root.plugin({ inject: ['remote', 'connection'], apply(ctx: Context) { ordinary = new ClientTerminals(ctx, original) } })
  await normal
  const isolated = root.isolate('webTerminals').plugin({ inject: ['remote', 'connection'], apply(ctx: Context) {
    models = new ClientTerminals(ctx, legacyTerminalRemote(api, original)); views = new LegacyTerminalViews(api, models)
    ctx.effect(() => () => views.dispose())
  } })
  await isolated
  return { root, normal, isolated, ordinary, models, views, api, original, calls, originalState, dispose: () => root.fiber.dispose() }
}

test('legacy target keeps original identity, exact source projection and a separate public kind', () => {
  const resource = { kind: 'terminal', sessionId: 'display-alpha', terminalId, sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId } as const
  const target = legacyTerminalPaneTarget(resource)
  assert.equal(target.type, 'tab'); assert.equal(target.type === 'tab' && target.kind, LEGACY_TERMINAL_TAB_KIND)
  assert.deepEqual(target.type === 'tab' && target.params, { terminalId, sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId })
  assert.equal(resource.terminalId, terminalId)
  const projection = { engine: 'codex', hubId: source.sourceHubId, hapiSessionId: source.sourceSessionId, machineId: source.machineId }
  assert.deepEqual(legacyTerminalSource({ terminalId, sourceSessionId: source.sourceSessionId }, projection, false), source)
  assert.equal(legacyTerminalSource({ terminalId, sourceSessionId: source.sourceSessionId }, undefined, false), null)
  assert.throws(() => legacyTerminalSource({ terminalId, sourceSessionId: 'different' }, projection, false), /does not match/)
  assert.throws(() => legacyTerminalSource({ terminalId }, projection, true), /child session/)
})

test('retained legacy tab recovers missing navigation params from its stable source address after a display successor', () => {
  const resource = { kind: 'terminal', sessionId, terminalId, sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId } as const
  const original = legacyTerminalPaneTarget(resource), successor = legacyTerminalPaneTarget({ ...resource, sessionId: 'display-successor' })
  assert.ok(original.type === 'tab' && original.address && successor.type === 'tab')
  assert.equal(successor.address, original.address)
  assert.equal(canOpenLegacyTerminalAddress(original.address), true)
  // This is the public navigation snapshot reconstructed by TabDomain.sync
  // for a retained, inactive tab after the official layout is reloaded.
  const navigation = { address: original.address, params: undefined, revision: 0 }
  const recovered = legacyTerminalNavigationParams(navigation, 'display-successor')
  assert.deepEqual(recovered, original.params)
  assert.equal(recovered.terminalId, terminalId)
  const projection = { engine: 'codex', hubId: source.sourceHubId, hapiSessionId: source.sourceSessionId, machineId: source.machineId }
  assert.deepEqual(legacyTerminalSource(recovered, projection, false), source)
  assert.equal(legacyTerminalSource(recovered, undefined, false), null)
  assert.throws(() => legacyTerminalSource(recovered, { ...projection, hapiSessionId: 'other-source' }, false), /does not match/)
})

test('equal original terminal IDs in different sources or Hubs remain separate and projection-checked', () => {
  const resource = { kind: 'terminal', sessionId, terminalId, sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId } as const
  const targets = [resource, { ...resource, sourceSessionId: 'other-source' }, { ...resource, sourceHubId: 'other-hub' }].map(legacyTerminalPaneTarget)
  const addresses = targets.map(target => { assert.ok(target.type === 'tab' && target.address); return target.address })
  assert.equal(new Set(addresses).size, 3)
  const projection = { engine: 'codex', hubId: source.sourceHubId, hapiSessionId: source.sourceSessionId, machineId: source.machineId }
  for (const address of addresses.slice(1)) {
    const params = legacyTerminalNavigationParams({ address }, sessionId)
    assert.equal(params.terminalId, terminalId)
    assert.throws(() => legacyTerminalSource(params, projection, false), /does not match/)
  }
})

test('a display-bound address recovers only within that display and cannot be mistaken for a source ID', () => {
  const display = legacyTerminalPaneTarget({ kind: 'terminal', sessionId, terminalId, sourceHubId: source.sourceHubId })
  const sourceBound = legacyTerminalPaneTarget({ kind: 'terminal', sessionId: 'another-display', terminalId, sourceHubId: source.sourceHubId, sourceSessionId: sessionId })
  assert.ok(display.type === 'tab' && display.address && sourceBound.type === 'tab' && sourceBound.address)
  assert.notEqual(display.address, sourceBound.address)
  assert.deepEqual(legacyTerminalNavigationParams({ address: display.address }, sessionId), { terminalId, sourceHubId: source.sourceHubId })
  assert.throws(() => legacyTerminalNavigationParams({ address: display.address }, 'different-display'), /another display/)
  assert.throws(() => legacyTerminalNavigationParams({ address: display.address, params: display.params }, 'different-display'), /another display/)
  assert.deepEqual(legacyTerminalNavigationParams({ address: sourceBound.address }, 'display-successor'), { terminalId, sourceHubId: source.sourceHubId, sourceSessionId: sessionId })
  const remote = legacyTerminalPaneTarget({ kind: 'terminal', sessionId: `hapi-remote:runner-one:${encodeURIComponent(sessionId)}`, terminalId, sourceHubId: source.sourceHubId })
  assert.ok(remote.type === 'tab' && remote.address)
  assert.deepEqual(legacyTerminalNavigationParams({ address: remote.address }, sessionId), { terminalId, sourceHubId: source.sourceHubId }, 'the owning graph uses its raw Session ID, not the workspace Host envelope')
  assert.throws(() => legacyTerminalNavigationParams({ address: remote.address }, 'other-remote-session'), /another display/)
  assert.throws(() => legacyTerminalPaneTarget({ kind: 'terminal', sessionId: 'hapi-remote:missing-separator', terminalId }), /Invalid remote/)
})

test('a valid address never hides present invalid or conflicting legacy navigation params', () => {
  const target = legacyTerminalPaneTarget({ kind: 'terminal', sessionId, terminalId, sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId })
  assert.ok(target.type === 'tab' && target.address)
  for (const params of [null, false, '', [], {}, { terminalId: '' }, { terminalId, extra: 'ignored' }, { terminalId, sourceSessionId: 3 }]) {
    assert.throws(() => legacyTerminalNavigationParams({ address: target.address, params }, sessionId), /parameters are invalid/)
  }
  for (const params of [{ terminalId }, { terminalId, ...source }, { terminalId: 'other', sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId }]) {
    assert.throws(() => legacyTerminalNavigationParams({ address: target.address, params }, sessionId))
  }
  assert.deepEqual(legacyTerminalNavigationParams({ address: target.address, params: target.params }, sessionId), target.params)
})

test('legacy address recovery rejects foreign URLs, ambiguous old tuples and malformed identities', () => {
  const address = (value: unknown) => `sidebar://${LEGACY_TERMINAL_TAB_KIND}/${encodeURIComponent(JSON.stringify(value))}`
  const valid = address([1, 'source', source.sourceHubId, source.sourceSessionId, terminalId])
  for (const bad of [valid.replace('sidebar:', 'https:'), valid.replace(LEGACY_TERMINAL_TAB_KIND, 'terminal'),
    valid.replace(`${LEGACY_TERMINAL_TAB_KIND}/`, `user:secret@${LEGACY_TERMINAL_TAB_KIND}/`), valid.replace(`${LEGACY_TERMINAL_TAB_KIND}/`, `${LEGACY_TERMINAL_TAB_KIND}:80/`),
    `${valid}?x=1`, `${valid}?`, `${valid}#fragment`, `${valid}#`, `${valid}/extra`, ` ${valid}`, `${valid}\n`,
    `sidebar://${LEGACY_TERMINAL_TAB_KIND}/%`, `sidebar://${LEGACY_TERMINAL_TAB_KIND}/not-json`,
    ...[[2, 'source', null, 'source', terminalId], [1, 'unknown', null, 'source', terminalId], [1, 'source', '', 'source', terminalId],
      [1, 'source', null, '', terminalId], [1, 'source', null, 'source', ''], [1, 'source', null, 'a'.repeat(513), terminalId],
      [1, 'display', null, sessionId, 'bad\0terminal'], [1, 'source', null, 'source', terminalId, 'extra']].map(address),
  ]) {
    assert.equal(canOpenLegacyTerminalAddress(bad), false, bad)
    assert.throws(() => legacyTerminalNavigationParams({ address: bad }, sessionId), /address is invalid/)
  }
  const old = address([source.sourceHubId, source.sourceSessionId, terminalId])
  assert.equal(canOpenLegacyTerminalAddress(old), true)
  assert.throws(() => legacyTerminalNavigationParams({ address: old }, sessionId), /needs its saved source parameters/)
  assert.deepEqual(legacyTerminalNavigationParams({ address: old, params: { terminalId, sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId } }, sessionId),
    { terminalId, sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId })
  assert.throws(() => legacyTerminalNavigationParams({ address: old, params: { terminalId, sourceHubId: source.sourceHubId } }, sessionId), /do not match/)
})

test('real isolated ClientTerminals owns saved view, environment, holds and ordered input without machine create/list or close', async () => {
  const f = await fixture()
  try {
    assert.equal(f.root.get('webTerminals')?.closeFailures.getSnapshot(), f.ordinary.closeFailures.getSnapshot())
    assert.equal(f.isolated.ctx.get('webTerminals')?.closeFailures.getSnapshot(), f.models.closeFailures.getSnapshot())
    assert.notEqual(f.models.closeFailures.getSnapshot(), f.ordinary.closeFailures.getSnapshot())
    const occurrence = f.views.occurrence(sessionId, 'legacy-tab', 'sidebar://hapi-legacy-terminal/original')
    f.views.retainTabs([{ sessionId, tabId: 'legacy-tab', contentId: 'sidebar://hapi-legacy-terminal/original' }])
    const release = occurrence.mount(request); await occurrence.reload()
    const model = occurrence.view(); assert.equal(model, f.models.view(sessionId, 'legacy-tab', 'sidebar://hapi-legacy-terminal/original', f.originalState.id))
    const stopRender = model.state.subscribe(() => { const render = model.state.getSnapshot().render; if (render) model.acknowledge(render.revision) })
    const unmount = model.mount(); await until(() => model.state.getSnapshot().writable)
    assert.equal(model.state.getSnapshot().environment?.scrollback, 10_000)
    assert.equal(model.state.getSnapshot().info?.cwd, '')
    model.write('pwd\r'); await until(() => f.calls.inputs.length === 1)
    assert.deepEqual(f.calls.inputs[0], { type: 'write', sequence: 1, data: 'pwd\r' })
    unmount(); release(); await until(() => f.calls.attachments === 0)
    assert.equal(f.calls.holds, 1, 'Window occurrence retains the existing source without an input viewer')
    f.views.retainTabs([]); await until(() => f.calls.holds === 0)
    stopRender()
    assert.deepEqual({ environment: f.calls.machineEnvironment, list: f.calls.machineList, create: f.calls.machineCreate, close: f.calls.closes }, { environment: 0, list: 0, create: 0, close: [] })
    assert.equal(f.calls.inputs.length, 1)
  } finally { await f.dispose() }
})

test('a public leaf remount restarts an aborted pending source admission and does not stay opening forever', async () => {
  let open = 0, firstSignal: AbortSignal | undefined
  let releaseFirst!: () => void
  const first = new Promise<void>(resolve => { releaseFirst = resolve })
  const f = await fixture({ sourceLegacyTerminalOpen: async (_request, signal) => {
    open++; if (open === 1) { firstSignal = signal; await first }
    return { ok: true, value: state() }
  } })
  try {
    const occurrence = f.views.occurrence(sessionId, 'same-occurrence', 'sidebar://hapi-legacy-terminal/same')
    const detach = occurrence.mount(request)
    await until(() => open === 1); detach(); assert.equal(firstSignal?.aborted, true)
    const detachAgain = occurrence.mount({ ...request, source: { machineId: source.machineId, sourceSessionId: source.sourceSessionId, sourceHubId: source.sourceHubId } })
    releaseFirst(); await until(() => occurrence.state.getSnapshot().phase === 'ready')
    assert.equal(open, 2); assert.equal(occurrence.view().id, state().id)
    detachAgain(); assert.equal(f.calls.machineCreate, 0)
  } finally { releaseFirst(); await f.dispose() }
})

test('a delayed official environment refresh cannot retain a source after its tab was removed', async () => {
  let reads = 0, finishEnvironment!: () => void
  const environment = new Promise<void>(resolve => { finishEnvironment = resolve })
  const f = await fixture({ sourceLegacyTerminals: async () => {
    reads++; if (reads === 2) await environment
    return { ok: true, value: [state()] }
  } })
  try {
    const occurrence = f.views.occurrence(sessionId, 'closing-tab', 'sidebar://hapi-legacy-terminal/closing')
    f.views.retainTabs([{ sessionId, tabId: 'closing-tab', contentId: 'sidebar://hapi-legacy-terminal/closing' }])
    const release = occurrence.mount(request), pending = occurrence.reload()
    await until(() => reads === 2)
    release(); f.views.retainTabs([])
    finishEnvironment(); await pending; await tick()
    await until(() => f.calls.holds === 0)
    assert.equal(f.calls.attachments, 0); assert.deepEqual(f.calls.closes, [])
    // Cached official model is not disposed just to handle unmount; a real
    // later occurrence can still restore it through its public refresh.
    f.views.retainTabs([{ sessionId, tabId: 'closing-tab', contentId: 'sidebar://hapi-legacy-terminal/closing' }])
    const releaseAgain = occurrence.mount(request); await occurrence.reload()
    assert.equal(occurrence.state.getSnapshot().phase, 'ready')
    releaseAgain(); f.views.retainTabs([])
  } finally { finishEnvironment(); await f.dispose() }
})

test('legacy close rejects; a pre-existing nonlegacy close intent is delegated to its original remote', async () => {
  const f = await fixture()
  try {
    const remote = legacyTerminalRemote(f.api, f.original)
    const rejected = await remote.close(sessionId, f.originalState.id)
    assert.equal(rejected.ok, false); assert.deepEqual(f.calls.closes, [])
    assert.deepEqual(await remote.close(sessionId, 'ordinary-terminal' as WebTerminalId), { ok: true, value: undefined })
    assert.deepEqual(f.calls.closes, ['ordinary-terminal'])
    assert.throws(() => remote.attach(sessionId, 'ordinary-terminal' as WebTerminalId), /nonlegacy/)
    assert.equal((await remote.create(sessionId, { id: f.originalState.id, cols: 80, rows: 24 })).ok, false)
  } finally { await f.dispose() }
})

test('wrong source admission fails without a real model, machine fallback or new shell', async () => {
  const f = await fixture({ sourceLegacyTerminalOpen: async () => ({ ok: true, value: { ...state(), source: { ...source, machineId: 'wrong-machine' } } }) })
  try {
    const occurrence = f.views.occurrence(sessionId, 'bad', 'sidebar://hapi-legacy-terminal/bad'), release = occurrence.mount(request)
    await occurrence.reload()
    assert.equal(occurrence.state.getSnapshot().phase, 'failed')
    assert.match(occurrence.state.getSnapshot().error ?? '', /original source binding/)
    assert.throws(() => occurrence.view(), /source admission/)
    assert.equal(f.calls.attachments + f.calls.machineCreate + f.calls.machineList, 0)
    release()
  } finally { await f.dispose() }
})

test('legacy copy uses selection first then exact adapter-observed snapshot, never machine TerminalHost', async () => {
  const binding = state(), requests: unknown[] = []
  const snapshot: LegacyTerminalTextSnapshot = { id: binding.id, sessionId, terminalId, source, provenance: 'adapter-observed', replay: 'bounded-source-tail', replayIssue: 'history-truncated', sequence: 3, capturedAt: 1, lines: ['earlier output', 'last row'], localLimitReached: true }
  const api: LegacyTerminalTextApi = { sourceLegacyTerminalText: async (...args) => { requests.push(args); return { ok: true, value: snapshot } } }
  const abort = new AbortController()
  assert.deepEqual(await readLegacyTerminalCopy(api, binding, { text: 'my selection', selected: true }, abort.signal), { kind: 'selected', lines: ['my selection'] })
  assert.equal(requests.length, 0)
  assert.deepEqual(await readLegacyTerminalCopy(api, binding, { text: 'visible fallback', selected: false }, abort.signal), { kind: 'legacy', value: snapshot, lines: snapshot.lines })
  assert.deepEqual(requests, [[{ sessionId, id: binding.id }, abort.signal]])
  const wrong: LegacyTerminalTextApi = { sourceLegacyTerminalText: async () => ({ ok: true, value: { ...snapshot, source: { ...source, sourceSessionId: 'other' } } }) }
  await assert.rejects(readLegacyTerminalCopy(wrong, binding, { text: '', selected: false }, abort.signal), /different terminal/)
  abort.abort(new Error('copy closed'))
  await assert.rejects(readLegacyTerminalCopy(api, binding, { text: '', selected: false }, abort.signal), /copy closed/)
})
