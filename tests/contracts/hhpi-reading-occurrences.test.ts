import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fixture } from './hhpi-reading-fixture.ts'
import { SourceReadingCache, type SourceReadingPosition } from '../../src/client/remote-reading-cache.ts'
const require = createRequire(import.meta.url)

test('all official readers and input shells use exact independent occurrences of one canonical Session', { timeout: 15000 }, async t => {
  const f = await fixture(t), a = await f.open('pane-a'), b = await f.open('pane-b')
  assert.equal(a.binding.sessionId, f.canonical.sessionId)
  assert.equal(b.binding.sessionId, f.canonical.sessionId)
  assert.notEqual(a.binding, b.binding); assert.notEqual(a.binding.ctx, b.binding.ctx)
  assert.equal(f.sessions.binding(f.canonical.sessionId), f.canonical.binding)
  assert.equal(a.scoped.owner, a.binding); assert.equal(b.scoped.owner, b.binding)
  assert.equal(a.scoped.injectionKey, f.canonical.sessionId)
  assert.equal(a.scoped.key, JSON.stringify([f.canonical.sessionId, 'pane-a']))
  assert.notEqual(a.scoped.key, b.scoped.key)
  assert.equal(a.scoped.props.sessionBinding, a.binding)
  assert.equal(a.scoped.hooks.conversation!.getSnapshot(), a.conversation.snapshot.getSnapshot())
  assert.equal(a.scoped.hooks.chat!.getSnapshot(), a.conversation.target('chat').getSnapshot())
  assert.notEqual(a.scoped.hooks.input, b.scoped.hooks.input)
  a.input.setDraft('Independent draft A'); b.input.setDraft('Independent draft B')
  assert.equal(a.input.state.getSnapshot().draft, 'Independent draft A')
  assert.equal(b.input.state.getSnapshot().draft, 'Independent draft B')
  assert.equal(f.body(a).length, 160); assert.equal(f.body(b).length, 160)
  const checkpoints: string[] = []
  assert.ok(a.conversation.windowCommit)
  const stopReader = a.conversation.windowCommit.register(a.binding.viewId!, {
    id: 'actual-occurrence-checkpoint',
    measure: () => { checkpoints.push('measure'); return { revision: 1, anchor: null, following: false, scrollTop: 0, clientHeight: 600, scrollHeight: 10000, nodes: 0, available: false } },
    correct: () => { checkpoints.push('correct') },
  })
  for (let i = 0; i < 6; ++i) await a.binding.session.loadOlder()
  stopReader()
  assert.deepEqual(checkpoints, Array.from({ length: 6 }, () => ['measure', 'correct']).flat())
  assert.equal(f.body(a).length, 1120); assert.equal(f.body(b).length, 160)
  assert.equal(new Set(f.body(a)).size, 1120)
  assert.equal(a.scoped.hooks.chat!.getSnapshot(), a.conversation.target('chat').getSnapshot())
  const before = f.calls.length
  await b.binding.session.loadOlder()
  assert.equal(f.body(b).length, 320); assert.equal(f.calls.length, before)
  assert.equal(a.input.state.getSnapshot().draft, 'Independent draft A')
  assert.equal(b.input.state.getSnapshot().draft, 'Independent draft B')
  const pending = a.binding.session.beginSubmission({ text: 'Native target A', attachments: [], mode: 'queue' })
  const outcome = await a.binding.session.prompt([{ type: 'text', text: 'Native target A' }], 'queue', undefined, pending.requestId)
  assert.equal(outcome.ok, true)
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.sessionId, f.canonical.sessionId)
  const oldScope = a.binding.ctx, oldSession = a.binding.session
  a.reference.release()
  assert.equal(f.sessions.ownsBinding(a.binding), false)
  assert.equal(f.sessions.bindingOf(oldScope), undefined)
  assert.equal(f.sessions.sessionOf(oldScope), undefined)
  assert.throws(() => f.ctx.uiConversation.binding(a.binding), /inactive/)
  await assert.rejects(oldSession.loadOlder(), /released/)
  assert.equal(f.body(b).length, 320)
  assert.equal(f.writes.length, 1, 'closing a reader must not cancel or resend native execution')
})

test('manufactured presentation bindings fail closed and capability-off refuses only direct-source occurrences', { timeout: 15000 }, async t => {
  const f = await fixture(t), a = await f.open('pane-a')
  const foreign = { ...a.binding, viewId: 'manufactured' }
  assert.equal(f.sessions.ownsBinding(foreign), false)
  assert.throws(() => f.ctx.uiConversation.binding(foreign), /inactive/)
  assert.throws(() => f.ctx.uiSession.bindingSource({ ...a.reference, binding: foreign }), /not active/)
  const owner = f.remote.windowCommit!
  assert.equal(owner.readingOccurrences, 1)
  Reflect.set(globalThis, '__DSH_CLIENT_READING_OCCURRENCES', 'off')
  try {
    const controllerRoot = resolve(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'), '..')
    const { createWindowCommitFactory } = require(resolve(controllerRoot, 'lib/types/client/sessions/window-commit.js'))
    assert.equal(createWindowCommitFactory().readingOccurrences, undefined)
  } finally { Reflect.deleteProperty(globalThis, '__DSH_CLIENT_READING_OCCURRENCES') }
})

test('a released real Pane forwards only its already saved submission after Conversation yields a paint', { timeout: 15000 }, async t => {
  const f = await fixture(t), pane = await f.open('pane-admission'), face = pane.binding.session
  const pending = face.beginSubmission({ text: 'Saved before the Pane closes', attachments: [], mode: 'queue' })
  const lifetime = new AbortController(); lifetime.abort(); pane.reference.release()
  assert.equal(f.writes.length, 0, 'saving an intent does not dispatch before prompt confirms preparation')
  const outcome = await face.prompt([{ type: 'text', text: 'Saved before the Pane closes' }], 'queue', lifetime.signal, pending.requestId)
  assert.equal(outcome.ok, true)
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.operationId, pending.requestId)
  assert.throws(() => face.beginSubmission({ text: 'New work after release', attachments: [], mode: 'queue' }), /released/)
  await assert.rejects(face.prompt([{ type: 'text', text: 'Unadmitted work' }], 'queue'), /released/)
  await assert.rejects(face.prompt([{ type: 'text', text: 'Unadmitted steer' }], 'steer', undefined, pending.requestId), /released/)
  assert.equal(f.writes.length, 1)
})

test('official Chat persists semantic positions per stable Pane and rejects late saves across storage scopes', { timeout: 15000 }, async t => {
  const f = await fixture(t, { preparedChatSource: process.env.HHPI_DSH_READING_MEMORY_SOURCE })
  const a = await f.open('pane-a:1', 'pane-a'), b = await f.open('pane-b:2', 'pane-b')
  const stopRoot = f.ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, () => null)
  t.after(stopRoot)
  const registration = f.ctx.slots.entriesOfSlot('conversation.view').find(entry => entry.options.id === 'chat')
  assert.ok(registration?.inject)
  const inject = registration.inject as (...args: unknown[]) => { chatScroll: { read(): SourceReadingPosition | null; save(position: SourceReadingPosition | null): void } }
  const scroll = (pane: typeof a) => inject(f.canonical.sessionId, undefined, pane.scoped).chatScroll
  const position = { anchorKey: a.conversation.target('chat').getSnapshot()!.order[0]!, anchorTop: 27, scrollTop: 890 }
  const access = { storage: f.dom.window.localStorage, scope: 'synthetic-reading' }
  const durableA = scroll(a), durableB = scroll(b)
  durableA.save(position); durableB.save(null)
  f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'))
  const persisted = new SourceReadingCache(access)
  t.after(() => persisted.dispose())
  assert.deepEqual(persisted.readPosition(f.canonical.sessionId, 'pane-a'), position, 'production RemoteSessions enables the authenticated browser cache and official memory provider')
  const reopened = await f.open('pane-a:99', 'pane-a')
  assert.deepEqual(scroll(reopened).read(), position, 'runtime view sequence changes must not lose the persistent Pane anchor')
  assert.equal(scroll(b).read(), null, 'independent Pane scroll memory is not copied from another reader')
  const retiring = scroll(b)
  b.reference.release()
  assert.doesNotThrow(() => retiring.save(position), 'a late unmount save cannot query an already released official binding')
  assert.equal(persisted.readPosition(f.canonical.sessionId, 'pane-b'), null)
  Reflect.set(globalThis, '__DSH_CLIENT_READING_MEMORY', 'off')
  try {
    const disabled = scroll(reopened)
    assert.equal(disabled.read(), null)
    disabled.save({ ...position, scrollTop: 100 })
    assert.deepEqual(persisted.readPosition(f.canonical.sessionId, 'pane-a'), position, 'turning the optional extension off restores the unchanged in-memory path')
    assert.deepEqual(disabled.read(), { ...position, scrollTop: 100 })
  } finally { Reflect.deleteProperty(globalThis, '__DSH_CLIENT_READING_MEMORY') }
  f.remote.setReadingStorage({ ...access, scope: 'another-authenticated-account' })
  durableA.save({ ...position, scrollTop: 9999 })
  f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'))
  const replacement = new SourceReadingCache({ ...access, scope: 'another-authenticated-account' })
  try { assert.equal(replacement.readPosition(f.canonical.sessionId, 'pane-a'), null, 'retired bindings cannot write across authenticated storage scopes') }
  finally { replacement.dispose() }
})
