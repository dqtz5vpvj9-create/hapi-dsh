import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fixture } from './hhpi-reading-fixture.ts'
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
