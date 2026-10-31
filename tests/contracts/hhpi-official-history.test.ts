/** Real pinned view, assembler, coordinator and official Chat definitions; IO and reader geometry are controlled boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { RemoteStream, RemoteStreamCarrierError, type RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteSourceHistory } from '../../src/client/remote-history.ts'
import { followSourceChanges } from '../../src/client/remote-follow.ts'
import { SourceEventIndex, type EventInput } from '../../src/remote/event-index.ts'
import { sourceSessionId, type SourceChanges, type SourceChangesRequest, type SourceReadRequest, type SourceSession } from '../../src/remote/protocol.ts'
import type { OfficialChatAssembler, OfficialChatSnapshot } from '../official-conversation-fixture.ts'
import type { HistoryReadV1, HistorySnapshotV1, WindowCommitCoordinatorV1, WindowCommitFactoryV1, WindowReaderMeasurementV1 } from '@deepseek-ai/dsh-api-session-controller/client'

const require = createRequire(import.meta.url)
interface Store<T> { getSnapshot(): T; subscribe(callback: () => void): () => void }
interface ViewState { phase: string; busy: boolean; failure: string | null; before: string | null; after: string | null; hasBefore: boolean; revision: number }
interface Assembler extends OfficialChatAssembler { derivedNodeCount(): number; derivedNodeKeys(): readonly string[]; containsReadingKey(key: string): boolean }
interface Candidate { entries: HistorySnapshotV1['entries']; hasBefore: boolean; hasAfter: boolean; version: string; assembled: Assembler }
interface View {
  snapshot: Store<ViewState>; reads: Assembler
  read(request: HistoryReadV1, signal?: AbortSignal): Promise<ViewState>; refresh(signal?: AbortSignal): Promise<ViewState>; release(): void
  publishCandidate(candidate: Candidate): void; validateCandidate(candidate: Candidate, measurements: readonly WindowReaderMeasurementV1[]): void
  capacityScope(): 'window' | 'growth'
}
interface Registry { entries(): readonly unknown[]; register(value: unknown): () => void }
const production = require('../../.tmp/hhpi-official-contract.cjs') as {
  BoundHistoryView: new (id: string, history: { version: 1; openView: RemoteSourceHistory['openView'] }, assembler: Assembler, close: () => void, coordinator: WindowCommitCoordinatorV1) => View
  ConversationNodeAssembler: new (events: Registry, views: Registry, groups: { entries(): unknown[]; forTarget(target: string): unknown }) => Assembler
  windowCommit: { createWindowCommitFactory(): WindowCommitFactoryV1 }
}
function browserModule(name: string): Record<string, unknown> {
  assert.equal(require(`${name}/package.json`).version, '0.2.1-rc.3')
  let registration: { factory(resolve: (id: string) => unknown): Record<string, unknown> } | undefined
  new Function('window', readFileSync(require.resolve(`${name}/client`), 'utf8'))({ __ModuleLoader__: { load(value: typeof registration) { registration = value } } })
  assert.ok(registration)
  const unused = new Proxy({}, { get: (_target, key) => () => { throw new Error(`Unexpected UI rendering ${String(key)}`) } })
  return registration.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? unused : require(id))
}
function definitions(): { assembler(): Assembler; close(): Promise<void> } {
  const core = browserModule('@deepseek-ai/dsh-client-ui-conversation') as unknown as { ConversationEventRegistry: new (ctx: Context) => Registry; ConversationViewRegistry: new (ctx: Context) => Registry }
  const ctx = new Context(), events = new core.ConversationEventRegistry(ctx), views = new core.ConversationViewRegistry(ctx)
  const groups: Array<{ target: string }> = [], done = Symbol('definitions registered')
  const chat = browserModule('@deepseek-ai/dsh-client-ui-chat') as { apply(ctx: unknown): void }
  assert.throws(() => chat.apply({ effect: () => () => {}, uiConversation: { events, views, groups: { register(value: { target: string }) { groups.push(value) } } }, uiSession: { provide() { throw done } } }), error => error === done)
  return { assembler: () => { const value = new production.ConversationNodeAssembler(events, views, { entries: () => groups, forTarget: target => groups.find(group => group.target === target) }); value.activateTarget('chat'); return value }, close: () => ctx.fiber.dispose() }
}
const identity = { machineId: 'contract-machine', sourceId: 'contract-codex', engine: 'codex', nativeId: 'contract-thread' }
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic official reading', cwd: '/synthetic', updatedAt: 1000, status: 'idle', activeTurnId: null,
  capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] }
const user = (id: number, text = `body-${id}`): EventInput => ({ type: 'user/message', time: 1000, surfaceOp: 'append', data: { id: `message-${id}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } as EventInput)
function readable(snapshot: OfficialChatSnapshot): string[] {
  return snapshot.order.flatMap(key => { const node = snapshot.nodes.get(key); return node ? [...(node.data.content ?? []), ...(node.data.blocks ?? [])].flatMap(block => typeof block.text === 'string' ? [block.text] : []) : [] })
}
async function waitState(view: View, predicate: () => boolean): Promise<void> {
  if (predicate()) return
  await new Promise<void>(resolve => { const stop = view.snapshot.subscribe(() => { if (predicate()) { stop(); resolve() } }); if (predicate()) { stop(); resolve() } })
}
async function settleTurn(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)) }
interface Reader {
  anchor: string | null; anchorOwnerKey: string | undefined; top: number; revision: number; fail: boolean; available: boolean
  latestCandidate: Candidate | undefined
  measurements: WindowReaderMeasurementV1[]; corrections: WindowReaderMeasurementV1[]; publications: number
}
function fixture(total = 1440, growth = true) {
  const definitionsOwner = definitions(), index = new SourceEventIndex(':memory:', session), calls: SourceReadRequest[] = []
  index.edit(session, () => { for (let i = 1; i <= total; ++i) index.put(`item-${i}`, user(i)) })
  let gate: { waiting: Promise<void>; started(): void } | undefined
  type Interruption = 'close' | 'carrier' | 'bare' | 'stale'
  interface FollowAttempt { request: SourceChangesRequest; done: Promise<void> }
  interface ActiveFollow { request: SourceChangesRequest; interruption: Promise<Interruption>; interrupt(kind: Interruption): void; settled: Promise<void> }
  const followRequests: SourceChangesRequest[] = [], followListeners = new Set<() => void>()
  let acceptedConfirmations = 0
  const confirmationListeners = new Set<() => void>()
  let activeFollow: ActiveFollow | undefined
  let connectionGeneration: object | undefined = {}
  const generationListeners = new Set<() => void>()
  const generation = {
    getSnapshot: () => connectionGeneration,
    subscribe(listener: () => void) { generationListeners.add(listener); return () => generationListeners.delete(listener) },
  }
  const setGeneration = (next: object | undefined): void => {
    connectionGeneration = next
    for (const listener of [...generationListeners]) listener()
  }
  const remote: RemoteStreamFactory = { $stream: options => new RemoteStream({ generation }, options) }
  const followAttemptSource = async function* (request: SourceChangesRequest, signal: AbortSignal): AsyncIterable<SourceChanges> {
    followRequests.push(request)
    for (const listener of [...followListeners]) listener()
    const interruption = Promise.withResolvers<Interruption>(), settled = Promise.withResolvers<void>()
    const held: ActiveFollow = { request, interruption: interruption.promise, interrupt: kind => interruption.resolve(kind), settled: settled.promise }
    activeFollow = held
    const local = new AbortController()
    const changes = index.changes(request, AbortSignal.any([signal ?? new AbortController().signal, local.signal]))[Symbol.asyncIterator]()
    try {
      if (request.epoch === index.epoch && request.version === index.version) {
        yield { session: index.session, epoch: index.epoch, base: index.version, version: index.version, reset: false, upserts: [], removed: [] }
        // The generator resumes only after followSourceChanges has accepted
        // the yielded item and the history consumer asks for the next one.
        ++acceptedConfirmations
        for (const listener of [...confirmationListeners]) listener()
      }
      while (true) {
        const next = changes.next().then(value => ({ kind: 'change' as const, value }))
        const result = await Promise.race([next, interruption.promise.then(interruption => ({ kind: 'interrupt' as const, interruption }))])
        if (result.kind === 'interrupt') {
          local.abort()
          if (result.interruption === 'close') return
          if (result.interruption === 'carrier') throw new RemoteStreamCarrierError('Controlled carrier interruption')
          if (result.interruption === 'stale') throw new RemoteError('hhpi/source' as never,
            'The source update stream has a version gap.', { sourceCode: 'STALE_VERSION', outcome: 'rejected' } as never)
          throw new Error('Unexpected local follow failure')
        }
        if (result.kind === 'change') {
          if (result.value.done) return
          yield result.value.value
        }
      }
    } finally {
      local.abort()
      if (activeFollow === held) activeFollow = undefined
      settled.resolve()
      await changes.return?.()
    }
  }
  const interruptFollow = (kind: Interruption): FollowAttempt => {
    assert.ok(activeFollow, 'the source changes stream is active')
    const current = activeFollow
    // RemoteStream retries only after Connection reports a fresh generation.
    // Lower readiness before the current physical iterator ends so the test
    // controls that boundary without inventing a retry timer.
    if (kind !== 'close') setGeneration(undefined)
    current.interrupt(kind)
    return { request: current.request, done: current.settled }
  }
  const owner = new RemoteSourceHistory(session.id, {
    async read(request, signal) { calls.push(request); const page = index.read(request); const waiting = gate; gate = undefined; waiting?.started(); if (waiting) await waiting.waiting; signal?.throwIfAborted(); return page },
    changes: (request, signal) => followSourceChanges(remote, followAttemptSource, request, signal),
  })
  const views: View[] = [], coordinators: WindowCommitCoordinatorV1[] = []
  return { calls, index, owner, followRequests,
    waitForFollowCount(count: number): Promise<void> {
      if (followRequests.length >= count) return Promise.resolve()
      return new Promise(resolve => {
        const check = (): void => { if (followRequests.length >= count) { followListeners.delete(check); resolve() } }
        followListeners.add(check); check()
      })
    },
    waitForConfirmationCount(count: number): Promise<void> {
      if (acceptedConfirmations >= count) return Promise.resolve()
      return new Promise(resolve => {
        const check = (): void => { if (acceptedConfirmations >= count) { confirmationListeners.delete(check); resolve() } }
        confirmationListeners.add(check); check()
      })
    },
    interruptFollow,
    setGeneration,
    activeFollowSettled(): Promise<void> { return activeFollow?.settled ?? Promise.resolve() },
    assemble(entries: HistorySnapshotV1['entries'], hasBefore: boolean) {
      const assembled = definitionsOwner.assembler(); assembled.replaceWindow(entries, hasBefore); assembled.flush(); return assembled
    },
    defer() { const deferred = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); gate = { waiting: deferred.promise, started: () => entered.resolve() }; return { ...deferred, entered: entered.promise } },
    async open(id: string) {
      const assembler = definitionsOwner.assembler()
      let view: View
      const reader: Reader = { anchor: null, anchorOwnerKey: undefined, top: 0, revision: 0, fail: false, available: false,
        latestCandidate: undefined, measurements: [], corrections: [], publications: 0 }
      const coordinator = production.windowCommit.createWindowCommitFactory().create<Candidate>({ windowId: id, revision: 0,
        ...growth ? { capacityScope: () => view?.capacityScope() ?? 'window' } : {},
        buildCandidate(snapshot) {
          const assembled = definitionsOwner.assembler(); assembled.replaceWindow(snapshot.entries, snapshot.hasBefore); assembled.flush()
          const candidate = { ...snapshot, assembled }
          reader.latestCandidate = candidate
          return { candidate, nodes: assembled.derivedNodeCount(), nodeKeys: assembled.derivedNodeKeys() }
        },
        validate(candidate, measurements) { view.validateCandidate(candidate, measurements) },
        publish(candidate) { view.publishCandidate(candidate); ++reader.publications },
        discard() {},
      })
      coordinator.register({ id: `reader-${id}`,
        measure() {
          if (reader.fail) throw new Error('Injected unavailable reader measurement')
          const measurement: WindowReaderMeasurementV1 = { revision: ++reader.revision, anchor: reader.anchor === null ? null : {
            key: reader.anchor, top: reader.top, ...(reader.anchorOwnerKey === undefined ? {} : { ownerKey: reader.anchorOwnerKey }),
          }, following: false,
            scrollTop: reader.top, clientHeight: 600, scrollHeight: 10000, nodes: assembler.derivedNodeCount(), available: reader.available }
          reader.measurements.push(measurement); return measurement
        },
        correct(measurement) {
          if (measurement.available && measurement.anchor) {
            assert.ok(assembler.containsReadingKey(measurement.anchor.ownerKey ?? measurement.anchor.key), 'the current reader anchor owner survives publication')
          }
          reader.corrections.push(measurement)
        },
      })
      view = new production.BoundHistoryView(id, { version: 1, openView: owner.openView.bind(owner) }, assembler, () => {}, coordinator)
      views.push(view); coordinators.push(coordinator)
      await waitState(view, () => view.snapshot.getSnapshot().phase !== 'opening')
      assert.equal(view.snapshot.getSnapshot().phase, 'ready', JSON.stringify(view.snapshot.getSnapshot()))
      return { view, reader, coordinator }
    },
    async close() { for (const view of views) view.release(); for (const coordinator of coordinators) coordinator.dispose(); owner.dispose(); index.dispose(); await definitionsOwner.close() },
  }
}

function seedAnchorEvents(index: SourceEventIndex): { rootCallId: string; innerCallId: string } {
  const rootCallId = 'reader-anchor-root', innerCallId = 'reader-anchor-inner'
  index.edit(session, () => {
    const put = (key: string, type: string, data: Record<string, unknown>, surfaceOp?: 'append'): void => {
      index.put(key, { type, time: 2000, data, ...(surfaceOp ? { surfaceOp } : {}) } as EventInput)
    }
    put('anchor-turn-start', 'turn/start', { turn: 1 })
    put('anchor-tool-step-start', 'step/start', { turn: 1, step: 1 })
    put('anchor-tool-advertisement', 'assistant/message', {
      turn: 1, step: 1, stream: [], message: { id: 'anchor-tool-advertisement', role: 'assistant',
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'tool-call', id: rootCallId, name: 'run_code', arguments: '{}' }] },
    }, 'append')
    put('anchor-tool-call', 'tool/call', { turn: 1, step: 1, callId: rootCallId, name: 'run_code', arguments: '{}' })
    put('anchor-tool-dispatch-start', 'tool/ptc-dispatch-start', {
      rootCallId, parentCallId: rootCallId, subCallId: innerCallId, name: 'read', arguments: { path: 'anchor.txt' },
    })
    put('anchor-tool-dispatch-end', 'tool/ptc-dispatch', {
      rootCallId, parentCallId: rootCallId, subCallId: innerCallId, name: 'read', arguments: { path: 'anchor.txt' },
      isError: false, content: [{ type: 'text', text: 'read complete' }],
    })
    put('anchor-tool-result', 'tool/result', { turn: 1, step: 1, message: {
      id: 'anchor-tool-result', role: 'tool', toolCallId: rootCallId,
      source: { kind: 'tool', callId: rootCallId }, content: [{ type: 'text', text: 'run complete' }], isError: false,
    } }, 'append')
    put('anchor-tool-step-end', 'step/end', { turn: 1, step: 1 })
    put('anchor-tool-turn-end', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    put('anchor-reasoning-turn-start', 'turn/start', { turn: 2 })
    put('anchor-reasoning-step-start', 'step/start', { turn: 2, step: 1 })
    put('anchor-reasoning-assistant', 'assistant/message', {
      turn: 2, step: 1, stream: [], message: { id: 'anchor-reasoning-assistant', role: 'assistant',
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'reasoning', text: 'reasoning segment for reading anchor' }, { type: 'text', text: 'answer segment' }] },
    }, 'append')
    put('anchor-reasoning-step-end', 'step/end', { turn: 2, step: 1 })
    put('anchor-reasoning-turn-end', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  })
  return { rootCallId, innerCallId }
}

test('an idle-ended official RemoteStream reconnects without replacing either accepted Pane window or its reader anchor', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const a = await f.open('idle-pane-a'), b = await f.open('idle-pane-b')
  await f.waitForFollowCount(1); await settleTurn()
  assert.equal(f.followRequests.length, 1, 'the shared source history owns one remote follow')
  const request = f.followRequests[0]!, reads = f.calls.length
  const anchorA = a.view.reads.snapshot('chat').order[40]!, nodeA = a.view.reads.snapshot('chat').nodes.get(anchorA)
  const anchorB = b.view.reads.snapshot('chat').order[75]!, nodeB = b.view.reads.snapshot('chat').nodes.get(anchorB)
  assert.ok(nodeA && nodeB)
  a.reader.available = true; a.reader.anchor = anchorA; a.reader.top = 61
  b.reader.available = true; b.reader.anchor = anchorB; b.reader.top = 84
  const bodyA = readable(a.view.reads.snapshot('chat')), bodyB = readable(b.view.reads.snapshot('chat'))
  const publicationsA = a.reader.publications, publicationsB = b.reader.publications

  const closed = f.interruptFollow('close')
  await closed.done; await settleTurn()
  assert.equal(a.view.snapshot.getSnapshot().phase, 'ready', 'a quiet stream closing does not fail the displayed reading view')
  assert.equal(b.view.snapshot.getSnapshot().phase, 'ready')
  assert.equal(a.view.snapshot.getSnapshot().failure, null)
  assert.equal(b.view.snapshot.getSnapshot().failure, null)
  assert.deepEqual(readable(a.view.reads.snapshot('chat')), bodyA, 'the accepted body remains visible during reconnect')
  assert.deepEqual(readable(b.view.reads.snapshot('chat')), bodyB)
  assert.equal(a.reader.publications, publicationsA, 'disconnect does not publish a replacement candidate')
  assert.equal(b.reader.publications, publicationsB)
  assert.equal(f.calls.length, reads, 'reconnecting the follow does not reread the accepted page')

  f.setGeneration({})
  await f.waitForFollowCount(2)
  assert.deepEqual(f.followRequests[1], request, 'the new subscription resumes at the accepted epoch and version')
  assert.equal(f.calls.length, reads)

  f.index.edit(session, () => { f.index.put('item-1441', user(1441, 'live-after-idle-reconnect')) })
  await Promise.all([
    waitState(a.view, () => readable(a.view.reads.snapshot('chat')).includes('live-after-idle-reconnect')),
    waitState(b.view, () => readable(b.view.reads.snapshot('chat')).includes('live-after-idle-reconnect')),
  ])
  const afterA = a.view.reads.snapshot('chat'), afterB = b.view.reads.snapshot('chat')
  assert.equal(readable(afterA).length, 161); assert.equal(readable(afterB).length, 161)
  assert.equal(afterA.nodes.get(anchorA), nodeA, 'Pane A keeps its original anchor node identity')
  assert.equal(afterB.nodes.get(anchorB), nodeB, 'Pane B keeps its original anchor node identity')
  assert.notEqual(afterA.nodes.get(anchorA), afterB.nodes.get(anchorA), 'the two Panes retain independent assemblers')
  assert.deepEqual(a.reader.corrections.at(-1)?.anchor, { key: anchorA, top: 61 })
  assert.deepEqual(b.reader.corrections.at(-1)?.anchor, { key: anchorB, top: 84 })
  assert.equal(a.view.snapshot.getSnapshot().failure, null)
  assert.equal(b.view.snapshot.getSnapshot().failure, null)
  assert.equal(f.calls.length, reads, 'live recovery arrives on the stream without a history page read')
})

test('repeated idle ends on one live generation remain harmless after a validated no-change confirmation', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const a = await f.open('repeated-idle-a'), b = await f.open('repeated-idle-b')
  await f.waitForFollowCount(1); await f.waitForConfirmationCount(1)
  const reads = f.calls.length
  const snapshotA = a.view.reads.snapshot('chat'), snapshotB = b.view.reads.snapshot('chat')
  const bodyA = readable(snapshotA), bodyB = readable(snapshotB)
  const anchorA = snapshotA.order[45]!, anchorB = snapshotB.order[86]!
  const nodeA = snapshotA.nodes.get(anchorA), nodeB = snapshotB.nodes.get(anchorB)
  assert.ok(nodeA && nodeB)
  a.reader.available = true; a.reader.anchor = anchorA; a.reader.top = 52
  b.reader.available = true; b.reader.anchor = anchorB; b.reader.top = 96
  const publicationsA = a.reader.publications, publicationsB = b.reader.publications

  for (let end = 1; end <= 2; ++end) {
    const ended = f.interruptFollow('close')
    await ended.done
    await f.waitForFollowCount(end + 1)
    await f.waitForConfirmationCount(end + 1)
    await settleTurn()
    assert.equal(a.view.snapshot.getSnapshot().phase, 'ready')
    assert.equal(b.view.snapshot.getSnapshot().phase, 'ready')
    assert.equal(a.view.snapshot.getSnapshot().failure, null)
    assert.equal(b.view.snapshot.getSnapshot().failure, null)
    assert.deepEqual(readable(a.view.reads.snapshot('chat')), bodyA)
    assert.deepEqual(readable(b.view.reads.snapshot('chat')), bodyB)
    assert.equal(a.view.reads.snapshot('chat').nodes.get(anchorA), nodeA)
    assert.equal(b.view.reads.snapshot('chat').nodes.get(anchorB), nodeB)
    assert.equal(a.reader.publications, publicationsA)
    assert.equal(b.reader.publications, publicationsB)
    assert.equal(f.calls.length, reads, 'idle reconnects neither reread pages nor replace accepted windows')
  }
  assert.equal(f.followRequests.length, 3, 'each idle end opens one replacement on the still-live Host generation')
  assert.equal(f.index.version, f.followRequests[2]!.version, 'the source remained at the same accepted version throughout')
})

test('an official carrier failure reconnects from the last accepted source version', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const { view } = await f.open('carrier-pane')
  await f.waitForFollowCount(1); await settleTurn()
  const first = f.followRequests[0]!, reads = f.calls.length
  f.index.edit(session, () => { f.index.put('item-1441', user(1441, 'accepted-before-carrier-loss')) })
  await waitState(view, () => readable(view.reads.snapshot('chat')).includes('accepted-before-carrier-loss'))
  await settleTurn()
  const accepted = { sessionId: session.id, epoch: f.index.epoch, version: f.index.version }
  assert.ok(accepted.version > first.version, 'the stream consumer accepted a source update before reconnect')

  const interrupted = f.interruptFollow('carrier')
  await interrupted.done; await settleTurn()
  assert.equal(view.snapshot.getSnapshot().phase, 'ready')
  assert.equal(view.snapshot.getSnapshot().failure, null)
  assert.deepEqual(readable(view.reads.snapshot('chat')).at(-1), 'accepted-before-carrier-loss')
  assert.equal(f.calls.length, reads, 'carrier recovery does not reread the history page')
  assert.equal(f.followRequests.length, 1, 'the official stream waits until Connection establishes a new generation')

  f.setGeneration({})
  await f.waitForFollowCount(2)
  assert.deepEqual(f.followRequests[1], accepted, 'the replacement follows from the last accepted epoch/version')
  assert.equal(f.calls.length, reads)
  f.index.edit(session, () => { f.index.put('item-1442', user(1442, 'after-carrier-reconnect')) })
  await waitState(view, () => readable(view.reads.snapshot('chat')).includes('after-carrier-reconnect'))
  assert.equal(view.snapshot.getSnapshot().failure, null)
})

test('bare and stale source-follow failures stay terminal instead of entering carrier recovery', { timeout: 10000 }, async t => {
  for (const kind of ['bare', 'stale'] as const) await t.test(kind, async t => {
    const f = fixture(); t.after(() => f.close())
    const { view } = await f.open(`${kind}-pane`)
    await f.waitForFollowCount(1); await settleTurn()
    const body = readable(view.reads.snapshot('chat')), reads = f.calls.length
    const failed = f.interruptFollow(kind)
    await failed.done
    await waitState(view, () => view.snapshot.getSnapshot().failure !== null)
    assert.equal(view.snapshot.getSnapshot().phase, 'error')
    assert.deepEqual(readable(view.reads.snapshot('chat')), body, 'terminal failure preserves the accepted body')
    assert.equal(f.calls.length, reads)
    assert.equal(f.followRequests.length, 1, 'non-carrier protocol/local errors never reopen a RemoteStream generation')
  })
})

test('releasing the final reader aborts its official RemoteStream without reopening it', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const { view } = await f.open('release-pane')
  await f.waitForFollowCount(1); await settleTurn()
  assert.equal(f.followRequests.length, 1)
  const settled = f.activeFollowSettled()
  // Releasing the only official view cancels the history owner's lifetime;
  // the source iterator must close through the actual RemoteStream signal.
  view.release()
  await settled
  await settleTurn()
  assert.equal(f.followRequests.length, 1)
  assert.equal(view.snapshot.getSnapshot().failure, null, 'normal owner release is cancellation, not a failed follow')
})

test('official tool, group, and segmented anchors validate by their real semantic owner while retaining exact DOM anchors', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const { rootCallId, innerCallId } = seedAnchorEvents(f.index)
  const { view, reader } = await f.open('anchor-pane'), initial = view.reads.snapshot('chat')
  const toolNode = initial.order.map(key => initial.nodes.get(key)).find(node => node?.kind === 'tool-call')
  assert.ok(toolNode, 'the official Chat assembler materializes the root tool call')
  const root = (toolNode.data as unknown as { root: { callId: string; subCalls: readonly { callId: string }[] } }).root
  assert.equal(root.callId, rootCallId)
  assert.ok(root.subCalls.some(call => call.callId === innerCallId), 'the real PTC lifecycle produces the nested ToolCallTree row')
  const grouped = view.reads.grouped('chat') as unknown as {
    entries: readonly { kind: 'group' | 'node'; key: string; groupPart?: string }[]
    groupSource(key: string): { getSnapshot(): { members: readonly { kind: 'node'; key: string; groupPart?: string }[] } | undefined }
  }
  const groupEntry = grouped.entries.find(entry => entry.kind === 'group'
    && grouped.groupSource(entry.key).getSnapshot()?.members.some(member => member.groupPart === 'reasoning'))
  assert.ok(groupEntry, 'the official process grouper emits a group containing the reasoning segment')
  const segmented = grouped.groupSource(groupEntry.key).getSnapshot()?.members.find(member => member.groupPart === 'reasoning')
  assert.ok(segmented, 'the official process grouper emits the reasoning segment')
  const segmentedAlias = JSON.stringify([segmented.key, segmented.groupPart])
  assert.equal(view.reads.containsReadingKey(`group:${groupEntry.key}`), true)
  assert.equal(view.reads.containsReadingKey('group:missing-owner'), false)
  assert.equal(view.reads.containsReadingKey(segmentedAlias), true)
  assert.equal(view.reads.containsReadingKey(JSON.stringify([segmented.key, 'missing-part'])), false)

  const exactToolAnchor = `call:${innerCallId}`
  reader.available = true; reader.anchor = exactToolAnchor; reader.anchorOwnerKey = toolNode.key; reader.top = 41
  const cursor = view.snapshot.getSnapshot().before
  assert.ok(cursor)
  const committed = await view.read({ kind: 'before', cursor })
  assert.equal(committed.busy, false, 'the real nested call anchor owner permits the earlier page')
  const correction = reader.corrections.at(-1)!
  assert.deepEqual(correction.anchor, { key: exactToolAnchor, top: 41, ownerKey: toolNode.key }, 'scroll correction keeps the precise nested call anchor')

  const candidate = reader.latestCandidate!
  const groupMeasurement = { ...reader.measurements.at(-1)!, anchor: { key: `group:${groupEntry.key}`, top: 13, ownerKey: groupEntry.key } }
  const segmentMeasurement = { ...reader.measurements.at(-1)!, anchor: { key: segmentedAlias, top: 17, ownerKey: segmented.key } }
  assert.doesNotThrow(() => view.validateCandidate(candidate, [groupMeasurement]), 'a real group alias is accepted through its group owner')
  assert.doesNotThrow(() => view.validateCandidate(candidate, [segmentMeasurement]), 'a real segmented alias is accepted through its node owner')

  const withoutToolEvents = candidate.entries.filter(entry => !['tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(entry.event.type)
    && !(entry.event.type === 'assistant/message' && entry.event.data.message.id === 'anchor-tool-advertisement'))
  const withoutToolOwner = { ...candidate, entries: withoutToolEvents, assembled: f.assemble(withoutToolEvents, candidate.hasBefore) }
  assert.equal(withoutToolOwner.assembled.containsReadingKey(toolNode.key), false)
  const ownerStillMeasured = { ...reader.measurements.at(-1)!, anchor: { key: exactToolAnchor, top: 41, ownerKey: toolNode.key } }
  assert.throws(() => view.validateCandidate(withoutToolOwner, [ownerStillMeasured]), { code: 'CAPACITY_EXCEEDED' },
    'an explicitly measured owner must still be present in the prepared candidate')
  const rawOnlyMeasurement = { ...reader.measurements.at(-1)!, anchor: { key: exactToolAnchor, top: 41 } }
  assert.throws(() => view.validateCandidate(withoutToolOwner, [rawOnlyMeasurement]), { code: 'CAPACITY_EXCEEDED' },
    'without an owner key, a candidate that drops the owning node must still be rejected')
})

test('official Conversation obtains six earlier body-bearing segments while retaining resident node identities', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const { view, reader } = await f.open('pane-a'), cursors: string[] = []
  let text = readable(view.reads.snapshot('chat'))
  assert.equal(text.length, 160)
  const key = view.reads.snapshot('chat').order.at(-1)!, node = view.reads.snapshot('chat').nodes.get(key)
  reader.anchor = key; reader.available = true; reader.top = 37
  for (let i = 0; i < 6; ++i) {
    const cursor = view.snapshot.getSnapshot().before; assert.ok(cursor); cursors.push(cursor)
    const next = await view.read({ kind: 'before', cursor })
    assert.equal(next.busy, false)
    const earlier = readable(view.reads.snapshot('chat'))
    assert.equal(earlier.length, 160 * (i + 2), `segment ${i + 1} must contain continuous readable body exactly once`)
    assert.ok(Number(earlier[0]!.slice(5)) < Number(text[0]!.slice(5)))
    assert.deepEqual(earlier.slice(-text.length), text)
    assert.equal(view.reads.snapshot('chat').nodes.get(key), node, 'ordinary prepend retains the official node object')
    text = earlier
  }
  const count = f.calls.length
  for (const cursor of cursors.reverse()) await view.read({ kind: 'before', cursor })
  assert.equal(f.calls.length, count)
  assert.equal(new Set(readable(view.reads.snapshot('chat'))).size, text.length)
})

test('continuous official reading crosses the old total-node and total-event ceilings without discarding history', { timeout: 20000 }, async t => {
  const f = fixture(6400); t.after(() => f.close())
  const { view, reader } = await f.open('long-pane'), { view: other } = await f.open('other-pane')
  const tailKey = view.reads.snapshot('chat').order.at(-1)!, tailNode = view.reads.snapshot('chat').nodes.get(tailKey)
  for (let page = 1; page < 40; page++) {
    reader.anchor = view.reads.snapshot('chat').order[0]!; reader.available = true; reader.top = 37
    const before = view.snapshot.getSnapshot().before; assert.ok(before)
    await view.read({ kind: 'before', cursor: before })
    assert.equal(readable(view.reads.snapshot('chat')).length, (page + 1) * 160, `page ${page + 1} keeps every accepted body`)
    if (page < 39) assert.equal(view.reads.snapshot('chat').nodes.get(tailKey), tailNode, `page ${page + 1} retains the tail node`)
    else assert.deepEqual(view.reads.snapshot('chat').nodes.get(tailKey), tailNode, 'reaching the true start changes hasBefore and rebuilds dependency locations without losing the tail identity or body')
    assert.equal(readable(other.reads.snapshot('chat')).length, 160)
  }
  assert.equal(view.snapshot.getSnapshot().hasBefore, false)
  assert.equal(view.snapshot.getSnapshot().failure, null)
  const count = f.calls.length
  await view.read({ kind: 'latest' })
  assert.equal(f.calls.length, count, 'the complete resident tail needs no new source read')
  assert.deepEqual(readable(view.reads.snapshot('chat')), Array.from({ length: 6400 }, (_, i) => `body-${i + 1}`))
  f.index.edit(session, () => { f.index.put('item-6400', user(6400, 'revised resident tail')); f.index.put('item-6401', user(6401, 'appended live tail')) })
  await waitState(view, () => readable(view.reads.snapshot('chat')).at(-1) === 'appended live tail')
  assert.deepEqual(readable(view.reads.snapshot('chat')).slice(-2), ['revised resident tail', 'appended live tail'])
  assert.equal(view.snapshot.getSnapshot().failure, null, 'resident history beyond an admission budget still accepts live revisions')
})

test('the default coordinator keeps its bounded-window capacity contract', { timeout: 10000 }, async t => {
  const f = fixture(2240, false); t.after(() => f.close())
  const { view } = await f.open('bounded-window')
  for (let page = 1; page < 12; page++) await view.read({ kind: 'before', cursor: view.snapshot.getSnapshot().before! })
  const accepted = view.reads.snapshot('chat')
  await assert.rejects(view.read({ kind: 'before', cursor: view.snapshot.getSnapshot().before! }), { code: 'CAPACITY_EXCEEDED' })
  assert.deepEqual(readable(view.reads.snapshot('chat')), readable(accepted), 'rejected admission cannot replace the published body')
})

test('coalesced official navigation and independent Panes do not duplicate body or source reads', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const { view: a, reader } = await f.open('a'), { view: b } = await f.open('b'), cursor = a.snapshot.getSnapshot().before!
  const gate = f.defer(), cancel = new AbortController(), publications = reader.publications
  const one = a.read({ kind: 'before', cursor }, cancel.signal), rejected = assert.rejects(one, { name: 'AbortError' })
  const two = a.read({ kind: 'before', cursor })
  cancel.abort(); gate.resolve(); await rejected; await two
  assert.equal(reader.publications, publications + 1, 'automatic and button requests publish once')
  assert.equal(readable(a.reads.snapshot('chat')).length, 320); assert.equal(readable(b.reads.snapshot('chat')).length, 160)
  const count = f.calls.length
  await b.read({ kind: 'before', cursor })
  assert.equal(readable(b.reads.snapshot('chat')).length, 320); assert.equal(f.calls.length, count)
})

test('the official coordinator measures the position at commit after scrolling during source IO', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const { view, reader } = await f.open('a'), gate = f.defer()
  reader.available = true; reader.anchor = view.reads.snapshot('chat').order[0]!; reader.top = 11
  const pending = view.read({ kind: 'before', cursor: view.snapshot.getSnapshot().before! })
  await gate.entered
  const latestAnchor = view.reads.snapshot('chat').order[80]!
  reader.anchor = latestAnchor; reader.top = 93
  gate.resolve(); await pending
  assert.deepEqual(reader.measurements.at(-1)?.anchor, { key: latestAnchor, top: 93 })
  assert.deepEqual(reader.corrections.at(-1)?.anchor, { key: latestAnchor, top: 93 })
})

test('failed pre-publication measurement keeps old body and permits explicit recovery without refetching its page', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const { view, reader } = await f.open('a'), previous = readable(view.reads.snapshot('chat')), cursor = view.snapshot.getSnapshot().before!, count = reader.publications
  reader.fail = true
  await assert.rejects(view.read({ kind: 'before', cursor }), { code: 'TARGET_UNAVAILABLE' })
  assert.equal(reader.publications, count); assert.deepEqual(readable(view.reads.snapshot('chat')), previous)
  assert.equal(view.snapshot.getSnapshot().phase, 'error')
  const reads = f.calls.length
  reader.fail = false
  await view.read({ kind: 'before', cursor })
  assert.equal(readable(view.reads.snapshot('chat')).length, 320); assert.equal(f.calls.length, reads)
})

test('live revisions arriving while a page is pending remain present in the committed official body', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const { view } = await f.open('a'), gate = f.defer(), pending = view.read({ kind: 'before', cursor: view.snapshot.getSnapshot().before! })
  await gate.entered
  f.index.edit(session, () => { f.index.put('item-1200', user(1200, 'stream-revision-1200')) })
  gate.resolve(); await pending
  await waitState(view, () => readable(view.reads.snapshot('chat')).includes('stream-revision-1200'))
  const body = readable(view.reads.snapshot('chat'))
  assert.equal(body.filter(text => text === 'stream-revision-1200').length, 1)
  assert.ok(!body.includes('body-1200'))
})
