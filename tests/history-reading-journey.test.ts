import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readingJourney } from './history-reading-journey-fixture.ts'

test('continuous history survives older-page commits and a down/up round trip', async t => {
  const h = await readingJourney(t), initial = h.seqs(), tail = h.node('Answer 30')
  assert.ok(tail)
  const binding = h.pane.reference.binding, historyId = h.session.sourceWindow.getSnapshot().historyId
  for (let page = 0; page < 30 && !h.body().includes('Question 1'); page++) {
    const before = h.snapshot(), calls = h.calls.length, progress = h.session.sourceWindow.getSnapshot().olderRevision ?? 0
    await h.session.loadOlder()
    const after = h.snapshot(), requests = h.calls.slice(calls)
    assert.equal(requests.length, 1, 'each opaque older cursor causes exactly one bounded source read')
    assert.equal(requests[0]!.limit, 160, 'each interactive history request uses the native 160-event page budget')
    assert.ok(after.entries[0]!.event.seq < before.entries[0]!.event.seq, 'the accepted older cut advances')
    assert.notEqual(after.before, before.before)
    assert.equal((h.session.sourceWindow.getSnapshot().olderRevision ?? 0), progress + 1,
      'a committed older page reports progress even when folded DOM rows do not change')
    assert.equal(h.session.sourceWindow.getSnapshot().historyId, historyId)
    assert.ok([...initial].every(seq => h.seqs().has(seq)), 'a committed page never evicts previously accepted source entries')
    for (const seq of h.seqs()) initial.add(seq)
    assert.equal(h.node('Answer 30')?.key, tail.key, 'official Chat keeps the reader node identity while prepending')
    assert.equal(h.pane.reference.binding, binding)
    assert.equal(h.session.getSnapshot().loadingOlder, false)
  }
  assert.ok(h.body().includes('Question 1') && h.body().includes('Answer 1'))
  const calls = h.calls.length
  assert.equal(await h.session.loadAfter(), false)
  assert.equal(await h.session.returnToLive(), true)
  assert.equal(h.calls.length, calls, 'returning to the resident tail does not fetch its accepted body again')
  assert.ok([...initial].every(seq => h.seqs().has(seq)))
  assert.equal(h.snapshot().hasAfter, false)
})

test('a clipped tool-only turn exposes older official Chat nodes before its user input arrives', async t => {
  const h = await readingJourney(t, 600, 2)
  const firstTool = () => h.nodes().find(node => node.kind === 'tool-call')
  assert.ok(firstTool(), 'the clipped native tail assembles real tool nodes')
  assert.ok(!h.body().includes('Question 2'))
  for (let page = 0; page < 8; page++) {
    const before = h.snapshot(), prior = firstTool()!
    await h.session.loadOlder()
    assert.notEqual(h.snapshot().before, before.before, 'each page advances its opaque cut even while turn-start dependencies stay resident')
    assert.notEqual(firstTool()?.key, prior.key, 'each page exposes earlier process content through official Chat')
    assert.equal(h.session.getSnapshot().loadingOlder, false)
  }
})

test('explicit historical navigation returns to the actual native head without inventing continuity', async t => {
  const h = await readingJourney(t, 8, 30)
  await h.around(h.seq(2, 'question'))
  assert.ok(h.body().includes('Question 2'))
  assert.equal(h.snapshot().hasAfter, true)
  const beforeCalls = h.calls.length, old = h.seqs()
  assert.equal(await h.session.returnToLive(), true)
  assert.equal(h.calls.length, beforeCalls, 'the previously accepted native tail is reused without redundant IO')
  assert.ok(h.body().includes('Answer 30'), 'latest navigation must not reuse a historical body as the live head')
  assert.equal(h.snapshot().hasAfter, false)
  assert.equal(h.snapshot().hasBefore, true, 'the gap remains explicitly pageable')
  assert.ok([...h.seqs()].every(seq => !old.has(seq)), 'disjoint cuts are not joined by fabricated history')
  for (let page = 0; page < 30 && !h.body().includes('Question 1'); page++) await h.session.loadOlder()
  assert.ok(h.body().includes('Question 1'))
})

test('two current reading occurrences keep independent historical windows over one source owner', async t => {
  const h = await readingJourney(t), other = await h.open('second-journey')
  const second = other.reading.snapshot.getSnapshot()
  await h.around(h.seq(2, 'question'))
  assert.ok(h.body().includes('Question 2'))
  assert.equal(other.reading.snapshot.getSnapshot(), second)
  assert.ok(h.bodyOfOther(other).includes('Answer 30'))
  assert.notEqual(h.pane.binding, other.binding)
  assert.equal(h.pane.binding.sessionId, other.binding.sessionId)
})
