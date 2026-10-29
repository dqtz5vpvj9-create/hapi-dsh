import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { readingJourney } from './history-reading-journey-fixture.ts'
import type { SourceViewportSession } from '../src/client/source-sessions.ts'

test('continuous history survives older-page commits and a down/up round trip', async () => {
  // Keep this user journey inside the retained safety budget. Large histories
  // intentionally release rows outside every mounted reader once that budget
  // is exceeded; the focused retention tests cover that policy separately.
  const h = await readingJourney(8, 12)
  const anchor = h.textEntry('Question 12').event.seq
  const stop = h.session.registerWindowReader!({ available: () => true,
    read: () => ({ firstSeq: anchor, lastSeq: anchor, followingTail: false }) })
  const admitted = h.sourceIds(), initialText = h.bodyTexts()
  const initialNodes = initialText.map(text => { const node = h.renderedNode(text); assert.ok(node); return { text, node } })
  try {
    for (let index = 0; index < 40 && !h.bodyTexts().includes('Question 1'); index++) {
      const before = h.probe(), changeStart = h.changes.length
      await h.session.loadOlder()
      const after = h.probe()
      // A visible reader warms its next page before the gesture. loadOlder may
      // commit that already-issued read and immediately start warming the
      // following cursor, so the last request is not necessarily the page
      // that this gesture committed.
      const matchingRequests = h.reads.filter(request => request.beforeAt === before.source.before!.at
        && request.beforeSeq === before.source.before!.seq)
      assert.equal(matchingRequests.length, 1, 'each source cursor is read once, either by prefetch or by the gesture')
      const request = matchingRequests[0]!
      assert.equal(request.limit, 50, 'each interactive history request uses HAPI’s normal 50-row page budget')
      assert.equal(typeof before.source.historyId, 'string')
      assert.equal(after.source.historyId, before.source.historyId)
      assert.equal(after.source.historyVersion, before.source.historyVersion)
      assert.deepEqual({ at: request.beforeAt, seq: request.beforeSeq }, before.source.before)
      assert.ok(after.source.before!.seq < before.source.before!.seq, 'each page advances the real HAPI cursor')
      assert.equal(h.progressed(before, after), true, 'folded history reports progress with an unchanged outer DOM')
      const resident = h.sourceIds()
      assert.ok([...admitted].every(id => resident.has(id)),
        `a committed page never evicts previously loaded source rows (page ${index + 1}, missing ${[...admitted].filter(id => !resident.has(id)).slice(0, 8).join(', ')})`)
      assert.deepEqual(h.changes.slice(changeStart).map(change => change.kind), ['prepend'],
        'one bounded page reaches the official Conversation as one prepend')
      for (const id of resident) admitted.add(id)
      assert.ok(initialText.every(text => h.bodyTexts().includes(text)), 'older pages stay in the same readable history')
      assert.equal(h.textEntry('Question 12').event.seq, anchor)
      for (const { text, node } of initialNodes) {
        const retained = h.renderedNode(text)
        assert.equal(retained?.key, node.key, 'the official Conversation keeps the reader node key')
      }
      assert.equal(h.reference.binding, h.binding)
      assert.equal(h.reference.binding!.session, h.session)
      assert.equal(h.session.getSnapshot().loadingOlder, false)
    }

    assert.ok(h.bodyTexts().includes('Question 1') && h.bodyTexts().includes('Answer 1'))
    assert.ok(h.renderedTexts().includes('Question 1') && h.renderedTexts().includes('Answer 1'))
    const readCount = h.reads.length
    assert.equal(await h.session.loadAfter(), false, 'the resident history has no artificial forward gap')
    assert.equal(h.reads.length, readCount, 'scrolling back to the tail does not fetch already loaded rows')
    assert.equal(await h.session.returnToLive(), true)
    assert.equal(h.reads.length, readCount, 'the already resident source head is reused')
    assert.ok([...admitted].every(id => h.sourceIds().has(id)))
    assert.equal(h.session.sourceWindow.getSnapshot().hasMoreAfter, false)
    assert.equal(h.session.getSnapshot().loadingOlder, false)
  } finally { stop(); await h.close() }
})

test('a clipped tool-only turn keeps exposing older Chat nodes across the retention boundary', async () => {
  const h = await readingJourney(600, 2, 50)
  const firstTool = () => h.renderedNodes().find(node => node.kind === 'tool-call')
  const stop = h.session.registerWindowReader!({ available: () => true, read: () => {
    const first = firstTool()
    return first ? { firstSeq: first.anchorSeq, lastSeq: first.anchorSeq, followingTail: false } : undefined
  } })
  try {
    assert.ok(firstTool(), 'the clipped source tail is readable before its user input is loaded')
    for (let page = 0; page < 20; page++) {
      const before = h.session.sourceWindow.getSnapshot().before!, prior = firstTool()!
      await h.session.loadOlder()
      const after = h.session.sourceWindow.getSnapshot().before!, next = firstTool()
      assert.ok(after.seq < before.seq, `page ${page + 1} advances the older source cut`)
      assert.ok(next && next.key !== prior.key, `page ${page + 1} exposes older tool content in the actual Chat order`)
      assert.equal(h.session.getSnapshot().loadingOlder, false)
    }
  } finally { stop(); await h.close() }
})

test('returning from an overlapping historical window to latest preserves the cached prefix', async () => {
  const h = await readingJourney(50, 3)
  try {
    await h.session.loadSourceMessage('row-2010')
    const admitted = h.sourceIds(), before = h.session.sourceWindow.getSnapshot().before
    const question = h.renderedNode('Question 1')
    assert.equal(admitted.size, 80)
    assert.ok(question)
    assert.equal(h.session.sourceWindow.getSnapshot().hasMoreAfter, true)
    assert.equal(h.session.getSnapshot().hasMore, false, 'this context already includes the archive beginning')

    assert.equal(await h.session.returnToLive(), true)
    assert.ok([...admitted].every(id => h.sourceIds().has(id)), 'the overlapping latest read must not evict the 61 earlier cached messages')
    assert.equal(h.renderedNode('Question 1')?.key, question.key)
    assert.ok(h.renderedTexts().includes('Answer 1') && h.renderedTexts().includes('Answer 3'))
    assert.deepEqual(h.session.sourceWindow.getSnapshot().before, before)
    assert.equal(h.session.sourceWindow.getSnapshot().hasMoreAfter, false)
    assert.equal(h.session.getSnapshot().hasMore, false)

    const reads = h.reads.length
    await h.session.loadOlder()
    assert.equal(await h.session.returnToLive(), true)
    assert.equal(h.reads.length, reads, 'upward reading and repeated latest reuse the complete resident archive')
  } finally { await h.close() }
})

test('a prepared latest interval keeps its earlier prefix cursor when it overlaps the existing reader', async () => {
  const h = await readingJourney(50, 30)
  // This journey also mounts the real read-only candidate scope.
  Object.assign(h.binding!, { ctx: new Context() })
  let stop = () => {}
  try {
    await h.session.loadSourceMessage('row-29010')
    const admitted = h.sourceIds(), previousBefore = h.session.sourceWindow.getSnapshot().before!
    stop = h.session.registerWindowPreparer!({ available: () => true, async prepare(reference) {
      await (reference.binding.session as typeof reference.binding.session & SourceViewportSession).loadViewportPage(200)
      return true
    } })

    assert.equal(await h.session.returnToLive(), true)
    const preparationRead = h.reads.at(-1)!
    assert.equal(preparationRead.limit, 200)
    const earliest = h.rows.filter(row => row.seq! < preparationRead.beforeSeq!).slice(-200)[0]!
    assert.ok(earliest.seq! < previousBefore.seq, 'the prepared interval genuinely extends the old prefix')
    assert.ok([...admitted].every(id => h.sourceIds().has(id)))
    assert.deepEqual(h.session.sourceWindow.getSnapshot().before, { at: earliest.sourceAt, seq: earliest.seq })
    assert.equal(h.session.getSnapshot().hasMore, true)
    assert.equal(h.session.sourceWindow.getSnapshot().hasMoreAfter, false)
    assert.ok(h.renderedTexts().includes('Answer 30'))

    await h.session.loadOlder()
    const next = h.reads.at(-1)!
    assert.deepEqual({ at: next.beforeAt, seq: next.beforeSeq, messageId: next.cursorMessageId, epoch: next.epoch },
      { at: earliest.sourceAt, seq: earliest.seq, messageId: earliest.rowId, epoch: 1 },
      'the next upward read uses the earliest committed cursor and its matching source identity and epoch')
  } finally { stop(); await h.close() }
})

test('returning to a disjoint latest interval does not present unread history as continuous', async () => {
  const h = await readingJourney(80, 3)
  try {
    await h.session.loadSourceMessage('row-2010')
    const old = h.sourceIds()
    assert.equal(h.session.sourceWindow.getSnapshot().hasMoreAfter, true)
    assert.equal(await h.session.returnToLive(), true)
    assert.ok([...h.sourceIds()].every(id => !old.has(id)), 'these fixture intervals have a real unread gap')
    assert.ok(!h.bodyTexts().includes('Question 1'))
    assert.ok(h.renderedTexts().includes('Answer 3'))
    assert.equal(h.session.getSnapshot().hasMore, true, 'the missing earlier range remains explicitly pageable')
    const before = h.session.sourceWindow.getSnapshot().before!
    for (let page = 0; page < 12 && !h.renderedTexts().includes('Question 1'); page++) {
      const cursor = h.session.sourceWindow.getSnapshot().before!
      await h.session.loadOlder()
      assert.deepEqual({ at: h.reads.at(-1)!.beforeAt, seq: h.reads.at(-1)!.beforeSeq }, cursor)
      assert.ok(h.session.sourceWindow.getSnapshot().before!.seq < cursor.seq,
        'each bounded page advances the unresolved gap toward older history')
    }
    assert.ok(h.renderedTexts().includes('Question 1'), 'the gap is only closed by an actual source page')
  } finally { await h.close() }
})
