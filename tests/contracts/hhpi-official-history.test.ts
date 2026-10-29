/** Actual patched DSH view/assembler and official Chat definitions; only source IO is controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { RemoteSourceHistory } from '../../src/client/remote-history.ts'
import { SourceEventIndex, type EventInput } from '../../src/remote/event-index.ts'
import { sourceSessionId, type SourceReadRequest, type SourceSession } from '../../src/remote/protocol.ts'
import type { OfficialChatAssembler, OfficialChatSnapshot } from '../official-conversation-fixture.ts'
import type { HistoryReadV1, HistorySnapshotV1 } from '@deepseek-ai/dsh-api-session-controller/client'

const require = createRequire(import.meta.url)
interface Store<T> { getSnapshot(): T; subscribe(callback: () => void): () => void }
interface ViewState { phase: string; busy: boolean; failure: string | null; before: string | null; after: string | null; revision: number }
interface View { snapshot: Store<ViewState>; reads: OfficialChatAssembler; read(request: HistoryReadV1, signal?: AbortSignal): Promise<ViewState>; release(): void }
interface Registry { entries(): readonly unknown[]; register(value: unknown): () => void }
const production = require('../../.tmp/hhpi-official-contract.cjs') as {
  BoundHistoryView: new (id: string, history: { version: 1; openView: RemoteSourceHistory['openView'] }, assembler: OfficialChatAssembler, close: () => void) => View
  ConversationNodeAssembler: new (events: Registry, views: Registry, groups: { forTarget(target: string): unknown }) => OfficialChatAssembler
  windowCommit: Record<string, unknown>
}
function browserModule(name: string): Record<string, unknown> {
  assert.equal(require(`${name}/package.json`).version, '0.2.1-rc.3')
  let registration: { factory(resolve: (id: string) => unknown): Record<string, unknown> } | undefined
  new Function('window', readFileSync(require.resolve(`${name}/client`), 'utf8'))({ __ModuleLoader__: { load(value: typeof registration) { registration = value } } })
  assert.ok(registration)
  const unused = new Proxy({}, { get: (_target, key) => () => { throw new Error(`Unexpected UI rendering ${String(key)}`) } })
  return registration.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? unused : require(id))
}
function definitions(): { assembler(): OfficialChatAssembler; close(): Promise<void> } {
  const core = browserModule('@deepseek-ai/dsh-client-ui-conversation') as unknown as { ConversationEventRegistry: new (ctx: Context) => Registry; ConversationViewRegistry: new (ctx: Context) => Registry }
  const ctx = new Context(), events = new core.ConversationEventRegistry(ctx), views = new core.ConversationViewRegistry(ctx)
  const groups: Array<{ target: string }> = [], done = Symbol('definitions registered')
  const chat = browserModule('@deepseek-ai/dsh-client-ui-chat') as { apply(ctx: unknown): void }
  assert.throws(() => chat.apply({ effect: () => () => {}, uiConversation: { events, views, groups: { register(value: { target: string }) { groups.push(value) } } }, uiSession: { provide() { throw done } } }), error => error === done)
  return { assembler: () => new production.ConversationNodeAssembler(events, views, { forTarget: target => groups.find(group => group.target === target) }), close: () => ctx.fiber.dispose() }
}
const identity = { machineId: 'contract-machine', sourceId: 'contract-codex', engine: 'codex', nativeId: 'contract-thread' }
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic official reading', cwd: '/synthetic', updatedAt: 1000, status: 'idle', activeTurnId: null,
  capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] }
const user = (id: number, text = `body-${id}`): EventInput => ({ type: 'user/message', time: 1000, surfaceOp: 'append', data: { id: `message-${id}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } as EventInput)
function readable(snapshot: OfficialChatSnapshot): string[] {
  return snapshot.order.flatMap(key => { const node = snapshot.nodes.get(key); return node ? [...(node.data.content ?? []), ...(node.data.blocks ?? [])].flatMap(block => typeof block.text === 'string' ? [block.text] : []) : [] })
}
async function ready(view: View): Promise<void> {
  if (view.snapshot.getSnapshot().phase === 'opening') await new Promise<void>(resolve => {
    const stop = view.snapshot.subscribe(() => { if (view.snapshot.getSnapshot().phase !== 'opening') { stop(); resolve() } })
  })
  assert.equal(view.snapshot.getSnapshot().phase, 'ready', JSON.stringify(view.snapshot.getSnapshot()))
}
function fixture() {
  const definitionsOwner = definitions(), index = new SourceEventIndex(':memory:', session), calls: SourceReadRequest[] = []
  index.edit(session, () => { for (let i = 1; i <= 1440; ++i) index.put(`item-${i}`, user(i)) })
  let gate: Promise<void> | undefined
  const owner = new RemoteSourceHistory(session.id, {
    async read(request, signal) { calls.push(request); const page = index.read(request); const waiting = gate; gate = undefined; if (waiting) await waiting; signal?.throwIfAborted(); return page },
    changes: (request, signal) => index.changes(request, signal),
  })
  const views: View[] = []
  return { calls, index, owner,
    defer() { const deferred = Promise.withResolvers<void>(); gate = deferred.promise; return deferred },
    async open(id: string) {
      const assembler = definitionsOwner.assembler(); assembler.activateTarget('chat')
      const view = new production.BoundHistoryView(id, { version: 1, openView: owner.openView.bind(owner) }, assembler, () => {})
      views.push(view); await ready(view); return view
    },
    async close() { for (const view of views) view.release(); owner.dispose(); index.dispose(); await definitionsOwner.close() },
  }
}

test('official Conversation obtains six earlier body-bearing segments and reuses accepted intervals', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const view = await f.open('pane-a'), cursors: string[] = []
  let text = readable(view.reads.snapshot('chat'))
  assert.equal(text.length, 160)
  for (let i = 0; i < 6; ++i) {
    const cursor = view.snapshot.getSnapshot().before; assert.ok(cursor); cursors.push(cursor)
    const next = await view.read({ kind: 'before', cursor })
    assert.equal(next.busy, false)
    const earlier = readable(view.reads.snapshot('chat'))
    assert.equal(earlier.length, 160 * (i + 2), `segment ${i + 1} must contain continuous readable body exactly once`)
    assert.ok(Number(earlier[0]!.slice(5)) < Number(text[0]!.slice(5)))
    assert.deepEqual(earlier.slice(-text.length), text)
    text = earlier
  }
  const count = f.calls.length
  for (const cursor of cursors.reverse()) await view.read({ kind: 'before', cursor })
  assert.equal(f.calls.length, count, 'return trips must reuse source pages')
  assert.equal(new Set(readable(view.reads.snapshot('chat'))).size, text.length)
})

test('coalesced official navigation and independent Panes do not duplicate body or source reads', { timeout: 10000 }, async t => {
  const f = fixture(); t.after(() => f.close())
  const a = await f.open('a'), b = await f.open('b'), cursor = a.snapshot.getSnapshot().before!
  const gate = f.defer(), cancel = new AbortController()
  const one = a.read({ kind: 'before', cursor }, cancel.signal)
  const rejected = assert.rejects(one, { name: 'AbortError' })
  const two = a.read({ kind: 'before', cursor })
  cancel.abort(); gate.resolve(); await rejected; await two
  assert.equal(readable(a.reads.snapshot('chat')).length, 320)
  assert.equal(readable(b.reads.snapshot('chat')).length, 160)
  const count = f.calls.length
  await b.read({ kind: 'before', cursor })
  assert.equal(readable(b.reads.snapshot('chat')).length, 320)
  assert.equal(f.calls.length, count)
})
