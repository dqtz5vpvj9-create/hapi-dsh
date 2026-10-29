/** Real pinned view, assembler, coordinator and official Chat definitions; IO and reader geometry are controlled boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { RemoteSourceHistory } from '../../src/client/remote-history.ts'
import { SourceEventIndex, type EventInput } from '../../src/remote/event-index.ts'
import { sourceSessionId, type SourceReadRequest, type SourceSession } from '../../src/remote/protocol.ts'
import type { OfficialChatAssembler, OfficialChatSnapshot } from '../official-conversation-fixture.ts'
import type { HistoryReadV1, HistorySnapshotV1, WindowCommitCoordinatorV1, WindowCommitFactoryV1, WindowReaderMeasurementV1 } from '@deepseek-ai/dsh-api-session-controller/client'

const require = createRequire(import.meta.url)
interface Store<T> { getSnapshot(): T; subscribe(callback: () => void): () => void }
interface ViewState { phase: string; busy: boolean; failure: string | null; before: string | null; after: string | null; revision: number }
interface Assembler extends OfficialChatAssembler { derivedNodeCount(): number; containsReadingKey(key: string): boolean }
interface Candidate { entries: HistorySnapshotV1['entries']; hasBefore: boolean; hasAfter: boolean; version: string; assembled: Assembler }
interface View {
  snapshot: Store<ViewState>; reads: Assembler
  read(request: HistoryReadV1, signal?: AbortSignal): Promise<ViewState>; refresh(signal?: AbortSignal): Promise<ViewState>; release(): void
  publishCandidate(candidate: Candidate): void; validateCandidate(candidate: Candidate, measurements: readonly WindowReaderMeasurementV1[]): void
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
interface Reader {
  anchor: string | null; top: number; revision: number; fail: boolean; available: boolean
  measurements: WindowReaderMeasurementV1[]; corrections: WindowReaderMeasurementV1[]; publications: number
}
function fixture() {
  const definitionsOwner = definitions(), index = new SourceEventIndex(':memory:', session), calls: SourceReadRequest[] = []
  index.edit(session, () => { for (let i = 1; i <= 1440; ++i) index.put(`item-${i}`, user(i)) })
  let gate: { waiting: Promise<void>; started(): void } | undefined
  const owner = new RemoteSourceHistory(session.id, {
    async read(request, signal) { calls.push(request); const page = index.read(request); const waiting = gate; gate = undefined; waiting?.started(); if (waiting) await waiting.waiting; signal?.throwIfAborted(); return page },
    changes: (request, signal) => index.changes(request, signal),
  })
  const views: View[] = [], coordinators: WindowCommitCoordinatorV1[] = []
  return { calls, index, owner,
    defer() { const deferred = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); gate = { waiting: deferred.promise, started: () => entered.resolve() }; return { ...deferred, entered: entered.promise } },
    async open(id: string) {
      const assembler = definitionsOwner.assembler()
      let view: View
      const reader: Reader = { anchor: null, top: 0, revision: 0, fail: false, available: false, measurements: [], corrections: [], publications: 0 }
      const coordinator = production.windowCommit.createWindowCommitFactory().create<Candidate>({ windowId: id, revision: 0,
        buildCandidate(snapshot) {
          const assembled = definitionsOwner.assembler(); assembled.replaceWindow(snapshot.entries, snapshot.hasBefore); assembled.flush()
          return { candidate: { ...snapshot, assembled }, nodes: assembled.derivedNodeCount() }
        },
        validate(candidate, measurements) { view.validateCandidate(candidate, measurements) },
        publish(candidate) { view.publishCandidate(candidate); ++reader.publications },
        discard() {},
      })
      coordinator.register({ id: `reader-${id}`,
        measure() {
          if (reader.fail) throw new Error('Injected unavailable reader measurement')
          const measurement: WindowReaderMeasurementV1 = { revision: ++reader.revision, anchor: reader.anchor === null ? null : { key: reader.anchor, top: reader.top }, following: false,
            scrollTop: reader.top, clientHeight: 600, scrollHeight: 10000, nodes: assembler.derivedNodeCount(), available: reader.available }
          reader.measurements.push(measurement); return measurement
        },
        correct(measurement) {
          if (measurement.available && measurement.anchor) assert.ok(assembler.containsReadingKey(measurement.anchor.key), 'the current reader anchor survives publication')
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
