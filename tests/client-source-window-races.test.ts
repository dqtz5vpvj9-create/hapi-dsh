/** Public SourceSessions race regressions with the pinned, real
 * MutableSessionEventSource. Source transport and the original SessionFace are
 * controlled fixtures; these tests do not start a Host or browser. */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { SourceHistoryWindowRequest, SourceHistoryWindowValue } from '../src/source-window-types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const contractEvents = join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')),
  'lib/types/client/contract/events.js')
const SESSION = 'hapi-codex-00000000000000000000000000000073'
const WINDOW_BASE = 3_000_000_000
let runtime: any

before(async () => {
  const built = await build({
    stdin: { contents: [
      `export { SourceSessions } from ${JSON.stringify(join(root, 'src/client/source-sessions.ts'))}`,
      "export { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'",
    ].join('\n'), resolveDir: root, sourcefile: 'source-window-races-entry.ts', loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': contractEvents },
    bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, logLevel: 'silent',
  })
  runtime = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`)
})

interface SourcePosition { messageId: string; at: number; seq: number }
interface Entry { type: 'event'; event: { type: string; seq: number; time: number; data: any }; source?: SourcePosition }
function position(name: string, ordinal: number): SourcePosition {
  return { messageId: `native:${name}`, at: ordinal * 1_000, seq: ordinal }
}
function body(seq: number, name: string, ordinal: number, withSource = true): Entry {
  return { type: 'event', event: { type: 'assistant/message', seq, time: ordinal * 1_000,
    data: { turn: ordinal, step: 1, message: { id: `body:${name}`, role: 'assistant',
      content: [{ type: 'text', text: name }], source: { kind: 'model', provider: 'synthetic', model: 'synthetic' } }, stream: [] } },
    ...(withSource ? { source: position(name, ordinal) } : {}) }
}
function annotation(seq: number, surfaceSeq: number, name: string, ordinal: number): Entry {
  return { type: 'event', event: { type: 'plugin:hapi-dsh/native-item', seq, time: ordinal * 1_000,
    data: { key: `body:${name}`, fingerprint: name, surfaceSeq,
      sourceMessageId: `native:${name}`, sourceAt: ordinal * 1_000, sourceSeq: ordinal,
      nativeTurnId: `turn:${ordinal}`, nativeItemId: name, displayTurn: ordinal, displayStep: 1 } },
    source: position(name, ordinal) }
}
function page(records: Entry[], afterOrdinal: number, hasMoreAfter: boolean): { ok: true; value: SourceHistoryWindowValue } {
  return { ok: true, value: { records, hasMoreBefore: true, hasMoreAfter,
    before: { at: 1_000, seq: 1 }, after: { at: afterOrdinal * 1_000, seq: afterOrdinal } } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const bodyNames = (entries: Entry[]): string[] => entries.filter(entry => entry.event.type === 'assistant/message')
  .map(entry => entry.event.data.message.content[0].text as string)

async function harness(handler: (request: SourceHistoryWindowRequest) => Promise<{ ok: true; value: SourceHistoryWindowValue }> | { ok: true; value: SourceHistoryWindowValue }, head?: SourcePosition, outlineEpoch = 1) {
  const source = new runtime.MutableSessionEventSource()
  source.replace([body(1, 'head', 10), annotation(2, 1, 'head', 10)], true)
  const emptyProjection = { getSnapshot: () => [], subscribe: () => () => {} }
  const originalFace = {
    sessionId: SESSION, projections: { faceOf: () => emptyProjection },
    getSnapshot: () => ({ sessionId: SESSION, pendingSubmissions: [], running: false, subagent: null,
      removed: false, openState: 'open', openError: null, hasMore: true, loadingOlder: false,
      promptError: null, blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false }),
    subscribe: () => () => {}, loadOlder: async () => {}, loadThrough: async () => {},
  }
  const binding = { sessionId: SESSION, session: originalFace, eventSource: source, ctx: {} }
  const original = {
    retain: () => ({ sessionId: SESSION, binding, ready: Promise.resolve(binding), release() {} }),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  }
  const requests: SourceHistoryWindowRequest[] = [], anchorRequests: Array<{ sessionId: string; seq: number }> = []
  const facade = new runtime.SourceSessions(original)
  facade.attach({
    sourceHistoryOutline: async () => ({ ok: true, value: {
      entries: [], seedIndex: 0, firstTurn: 10, epoch: outlineEpoch, complete: true, ...(head ? { head } : {}),
    } }),
    sourceReadingAnchor: async (request: { sessionId: string; seq: number }) => {
      anchorRequests.push(request)
      return { ok: true, value: { sourceMessageId: 'wrong-host-seq-lookup' } }
    },
    sourceHistoryWindowPage: async (request: SourceHistoryWindowRequest) => { requests.push(request); return handler(request) },
  })
  const reference = facade.retain(SESSION, { source: 'mainView' })
  await reference.ready
  const face = reference.binding.session, eventSource = reference.binding.eventSource
  return { source, face, eventSource, requests, anchorRequests,
    entries: (): Entry[] => [...eventSource.getSnapshot().entries],
    append(seq: number, name: string, ordinal: number) {
      // NativeProjector publishes the body before its identity annotation.
      // A source-order implementation must join the coherent burst.
      source.append(body(seq, name, ordinal, false))
      source.append(annotation(seq + 1, seq, name, ordinal))
    },
    release: () => reference.release(),
  }
}

function assertUniqueSeqs(entries: Entry[], label: string): void {
  const seqs = entries.map(entry => entry.event.seq)
  assert.equal(new Set(seqs).size, seqs.length, `${label}: each resident event must have a unique display seq`)
}
function assertAnnotationsResolve(entries: Entry[]): void {
  for (const entry of entries.filter(entry => entry.event.type === 'plugin:hapi-dsh/native-item')) {
    const surface = entries.find(candidate => candidate.event.seq === entry.event.data.surfaceSeq)
    assert.equal(surface?.event.data.message?.id, entry.event.data.key,
      `native annotation for ${entry.event.data.key} must resolve to its own resident body`)
  }
}

test('pagination keeps each committed edge epoch across newer outlines, opposite pages and failed reads', async () => {
  let olderPages = 0, newerPages = 0, rejectOlder = false
  const h = await harness(request => {
    if (rejectOlder && request.beforeSeq !== undefined) throw new Error('source revision temporarily unavailable')
    const ordinal = request.beforeSeq !== undefined ? 10 - ++olderPages
      : request.afterSeq !== undefined ? 10 + ++newerPages : 10
    const epoch = request.beforeSeq !== undefined ? 7 + olderPages : request.afterSeq !== undefined ? 20 + newerPages : 7
    const name = `row-${ordinal}`, seq = request.endSeq !== undefined ? request.endSeq - 1 : request.startSeq!
    return { ok: true, value: { records: [body(seq, name, ordinal)], epoch,
      before: { at: ordinal * 1_000, seq: ordinal }, after: { at: ordinal * 1_000, seq: ordinal },
      beforeMessageId: `native:${name}`, afterMessageId: `native:${name}`, hasMoreBefore: true, hasMoreAfter: true } }
  }, undefined, 50)
  try {
    const face = h.face, source = h.eventSource
    await face.loadThrough(900)
    assert.equal(h.requests[0]!.epoch, undefined, 'a context lookup uses current source identity, not the outline epoch')
    assert.equal(h.requests[0]!.cursorMessageId, undefined)
    await face.loadOlder()
    assert.deepEqual([h.requests[1]!.epoch, h.requests[1]!.cursorMessageId], [7, 'native:row-10'])
    assert.equal(await face.loadAfter(), true)
    assert.deepEqual([h.requests[2]!.epoch, h.requests[2]!.cursorMessageId], [7, 'native:row-10'],
      'prepending epoch 8 must not rewrite the retained epoch 7 forward cursor')
    const prior = source.getSnapshot()
    rejectOlder = true
    await assert.rejects(face.loadOlder(), /temporarily unavailable/)
    assert.equal(source.getSnapshot(), prior, 'failed paging preserves the visible window')
    assert.equal(h.face, face)
    assert.equal(h.eventSource, source)
    rejectOlder = false
    await face.loadOlder()
    assert.deepEqual([h.requests[3]!.epoch, h.requests[3]!.cursorMessageId], [8, 'native:row-9'])
    assert.deepEqual([h.requests[4]!.epoch, h.requests[4]!.cursorMessageId], [8, 'native:row-9'],
      'explicit retry must keep the failed edge identity')
    assert.equal(await face.loadAfter(), true)
    assert.deepEqual([h.requests[5]!.epoch, h.requests[5]!.cursorMessageId], [21, 'native:row-11'])
    await face.loadThrough(901)
    assert.equal(h.requests[6]!.epoch, undefined, 'a later context lookup must not inherit either paging epoch')
    assert.equal(h.requests[6]!.cursorMessageId, undefined)
    assert.equal(h.requests[6]!.messageId, 'wrong-host-seq-lookup')
  } finally { h.release() }
})

test('latest completion belongs to the committed window, not request admission', async () => {
  const response = deferred<ReturnType<typeof page>>()
  const requested = deferred<void>()
  const h = await harness(() => { requested.resolve(); return response.promise }, position('new-head', 11))
  try {
    let settled = false
    const opening = h.face.returnToLive()
    assert.ok(opening instanceof Promise)
    void opening.then(() => { settled = true })
    await requested.promise
    assert.equal(settled, false)
    assert.deepEqual(bodyNames(h.entries()), ['head'])
    response.resolve(page([body(WINDOW_BASE, 'new-head', 11), annotation(WINDOW_BASE + 1, WINDOW_BASE, 'new-head', 11)], 11, false))
    assert.equal(await opening, true)
    assert.deepEqual(bodyNames(h.entries()), ['new-head'])
  } finally { h.release() }
})

test('a newer reading gesture cancels late latest publication into the old reader', async () => {
  const response = deferred<ReturnType<typeof page>>()
  const requested = deferred<void>()
  const h = await harness(() => { requested.resolve(); return response.promise }, position('new-head', 11))
  const intent = new AbortController()
  try {
    const opening = h.face.returnToLive(intent.signal)
    await requested.promise
    intent.abort()
    assert.equal(h.face.getSnapshot().loadingOlder, false)
    response.resolve(page([body(WINDOW_BASE, 'new-head', 11), annotation(WINDOW_BASE + 1, WINDOW_BASE, 'new-head', 11)], 11, false))
    assert.equal(await opening, false)
    assert.deepEqual(bodyNames(h.entries()), ['head'])
  } finally { h.release() }
})

test('native execution-only updates preserve the first usable tail and its older-history cursor', async () => {
  const h = await harness(() => page([], 0, false))
  const base = 1_000_000_100
  try {
    const seed = Array.from({ length: 20 }, (_, index) => [
      body(base + index * 2, `initial-${index}`, index + 1, false),
      annotation(base + index * 2 + 1, base + index * 2, `initial-${index}`, index + 1),
    ]).flat()
    h.source.replace(seed, true)
    await flush()
    const stop = h.face.registerWindowReader({ available: () => true, read: () => {
      const bodies = h.entries().filter(row => row.event.type === 'assistant/message')
      return { firstSeq: bodies.at(-4)!.event.seq, lastSeq: bodies.at(-1)!.event.seq, followingTail: true }
    } })
    try {
      for (let index = 0; index < 30; index++) {
        h.source.append({ type: 'event', event: { type: 'plugin:hapi-dsh/execution',
          seq: base + seed.length + index, time: 5000 + index,
          data: { owner: 'native', generation: 1, sequence: index, status: 'active', turnId: 'native-turn' } } })
        await flush()
        assert.deepEqual(bodyNames(h.entries()).slice(-4), ['initial-16', 'initial-17', 'initial-18', 'initial-19'])
        assert.equal(h.face.getSnapshot().hasMore, true)
        assert.equal(h.face.getSnapshot().removed, false)
      }
    } finally { stop() }
  } finally { h.release() }
})

for (const followingTail of [false, true]) {
  test(`a rejected native tail replacement is replayed when its reader releases the old range (following ${followingTail})`, async () => {
    const h = await harness(() => { throw new Error('tail recovery must use the retained native snapshot') })
    let visible = true
    const stop = h.face.registerWindowReader({ available: () => visible,
      read: () => ({ firstSeq: 1, lastSeq: 1, followingTail }) })
    try {
      const face = h.face, eventSource = h.eventSource
      // A follow rebaseline no longer contains the currently pinned source row.
      // Rejecting it must keep the old reader, but cannot acknowledge its contents.
      h.source.replace([body(3, 'rejected-tail', 20), annotation(4, 3, 'rejected-tail', 20)], true)
      await flush()
      assert.deepEqual(bodyNames(h.entries()), ['head'])

      // Once the old pane is parked, the next small in-order append alone would
      // fit. Recovery must still replay the earlier rejected replacement first.
      visible = false
      h.append(5, 'next-tail', 30)
      await flush()
      assert.deepEqual(bodyNames(h.entries()), ['rejected-tail', 'next-tail'])
      assertUniqueSeqs(h.entries(), 'after rejected tail recovery')
      assertAnnotationsResolve(h.entries())
      assert.equal(h.requests.length, 0)
      assert.equal(h.face, face)
      assert.equal(h.eventSource, eventSource)
    } finally { stop(); h.release() }
  })
}

test('a rejected live burst leaves a gap until forward repair also merges arrivals during the read', { timeout: 5_000 }, async () => {
  const requested = deferred<SourceHistoryWindowRequest>()
  const response = deferred<ReturnType<typeof page>>()
  const h = await harness(request => {
    if (request.afterAt !== undefined) { requested.resolve(request); return response.promise }
    const start = request.startSeq ?? WINDOW_BASE
    // Reach the actual 5,000-event safety ceiling without changing the product
    // budget. A visible reader with unknown geometry must preserve this range.
    const controls: Entry[] = Array.from({ length: 4_998 }, (_, index) => ({ type: 'event', event: {
      type: 'plugin:hapi-dsh/execution', seq: start + index + 2, time: 10_000,
      data: { owner: 'native', generation: 1, sequence: index, status: 'active', turnId: 'turn:10' },
    } }))
    return page([body(start, 'head', 10), annotation(start + 1, start, 'head', 10), ...controls], 10, false)
  })
  let stop = () => {}, geometryKnown = false
  try {
    await h.face.loadThrough(999)
    stop = h.face.registerWindowReader({ available: () => true, read: () => {
      if (!geometryKnown) return undefined
      const last = h.entries().findLast(row => row.event.type === 'assistant/message')!
      return { firstSeq: last.event.seq, lastSeq: last.event.seq, followingTail: true }
    } })
    h.append(3, 'rejected-live', 20)
    await flush()
    assert.equal(h.entries().length, 1_500, 'live output replaces evicted history inside the same budget')
    assert.deepEqual(bodyNames(h.entries()), ['rejected-live'], 'live output is not withheld across an evicted interval')

    // Measurable geometry permits trimming again, but does not prove that the
    // rejected source interval was received. Do not jump across it with live.
    geometryKnown = true
    h.append(5, 'parked-after-gap', 30)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['rejected-live', 'parked-after-gap'],
      'measurable geometry lets live rows land without jumping the evicted interval')

    assert.equal(await h.face.loadAfter(), false, 'live eviction leaves no forward gap to repair')
    h.append(7, 'arrived-during-repair', 40)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['rejected-live', 'parked-after-gap', 'arrived-during-repair'])
    assertUniqueSeqs(h.entries(), 'after live evictions')
    assertAnnotationsResolve(h.entries())
    assert.equal(await h.face.loadAfter(), false, 'live eviction never leaves a forward gap request')

    h.append(9, 'live-after-repair', 50)
    await flush()
    assert.deepEqual(bodyNames(h.entries()).slice(-4),
      ['rejected-live', 'parked-after-gap', 'arrived-during-repair', 'live-after-repair'])
    assertUniqueSeqs(h.entries(), 'after live resumes')
    assertAnnotationsResolve(h.entries())
  } finally { stop(); h.release() }
})

test('trimming a newer source interval blocks distant live rows until that interval is paged back', { timeout: 5_000 }, async () => {
  const requested = deferred<SourceHistoryWindowRequest>()
  const response = deferred<ReturnType<typeof page>>()
  const h = await harness(request => {
    if (request.afterAt !== undefined) { requested.resolve(request); return response.promise }
    const older = request.beforeAt !== undefined
    const count = older ? 9 : 24, ordinal = older ? 1 : 10
    const start = older ? request.endSeq! - count * 2 : request.startSeq ?? WINDOW_BASE
    const records = Array.from({ length: count }, (_, index) => [
      body(start + index * 2, `source-${ordinal + index}`, ordinal + index),
      annotation(start + index * 2 + 1, start + index * 2, `source-${ordinal + index}`, ordinal + index),
    ]).flat()
    const result = page(records, ordinal + count - 1, older)
    result.value.before = { at: ordinal * 1_000, seq: ordinal }
    result.value.hasMoreBefore = !older
    return result
  })
  let stop = () => {}, stopRepairObservation = () => {}, followingTail = false
  try {
    await h.face.loadThrough(999)
    stop = h.face.registerWindowReader({ available: () => true, read: () => {
      const bodies = h.entries().filter(row => row.event.type === 'assistant/message')
      const anchor = followingTail ? bodies.at(-1)! : bodies.find(row => row.event.data.message.id === 'body:source-16')!
      return { firstSeq: anchor.event.seq, lastSeq: anchor.event.seq, followingTail }
    } })
    await h.face.loadOlder()
    const retained = bodyNames(h.entries())
    assert.ok(retained.includes('source-16'), 'paging must preserve the actual reader')
    assert.ok(!retained.includes('source-33'), 'this case must really evict a newer source interval')
    const lastOrdinal = h.entries().findLast(row => row.event.type === 'assistant/message')!.source!.seq
    followingTail = true
    h.append(3, 'new-live', 40)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), retained,
      'following the retained window bottom does not fill the newer interval that was evicted')

    let completeIntervalPublished = false
    const missingNames = Array.from({ length: 33 - lastOrdinal }, (_, index) => `source-${lastOrdinal + index + 1}`)
    stopRepairObservation = h.eventSource.subscribe(() => {
      const names = bodyNames(h.entries())
      if (missingNames.every(name => names.includes(name)) && names.includes('new-live')) completeIntervalPublished = true
    })
    const forward = h.face.loadAfter()
    const request = await requested.promise
    assert.equal(request.afterSeq, lastOrdinal)
    h.append(5, 'during-trim-repair', 50)
    const ordinals = [...Array.from({ length: 33 - lastOrdinal }, (_, index) => lastOrdinal + index + 1), 40]
    const start = request.startSeq!
    response.resolve(page(ordinals.flatMap((ordinal, index) => {
      const name = ordinal === 40 ? 'new-live' : `source-${ordinal}`
      return [body(start + index * 2, name, ordinal), annotation(start + index * 2 + 1, start + index * 2, name, ordinal)]
    }), 40, false))
    assert.equal(await forward, true)
    await flush()
    const names = bodyNames(h.entries())
    assert.equal(completeIntervalPublished, true, 'the evicted interval must be complete before live following can trim it again')
    assert.deepEqual(names.slice(-3), ['source-33', 'new-live', 'during-trim-repair'])
    assertUniqueSeqs(h.entries(), 'after an evicted interval is repaired')
    assertAnnotationsResolve(h.entries())
  } finally { stopRepairObservation(); stop(); h.release() }
})

test('an empty repair page preserves the source cursor needed by the next live gap', async () => {
  let forwardReads = 0
  const h = await harness(request => {
    const start = request.startSeq ?? WINDOW_BASE
    if (request.afterAt === undefined) {
      return page([body(start, 'head', 10), annotation(start + 1, start, 'head', 10)], 10, false)
    }
    forwardReads++
    assert.equal(request.afterSeq, 10, 'an empty transport page must not erase the last committed source position')
    if (forwardReads === 1) {
      // This is the public empty-page shape emitted by windowAfter when its
      // source read contains no rows: no records and no replacement cursor.
      const empty = page([], 10, false)
      empty.value.after = null
      return empty
    }
    return page([
      body(start, 'first-gap', 20), annotation(start + 1, start, 'first-gap', 20),
      body(start + 2, 'second-gap', 30), annotation(start + 3, start + 2, 'second-gap', 30),
    ], 30, false)
  })
  let stop = () => {}
  try {
    await h.face.loadThrough(999)
    stop = h.face.registerWindowReader({ available: () => true, read: () => {
      const head = h.entries().find(row => row.event.type === 'assistant/message')!
      return { firstSeq: head.event.seq, lastSeq: head.event.seq, followingTail: false }
    } })
    h.append(3, 'first-gap', 20)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['head', 'first-gap'],
      'live rows land even when the source interval behind them was evicted')
    assert.equal(await h.face.loadAfter(), false)
    assert.equal(forwardReads, 0, 'live eviction does not request a forward repair')

    h.append(5, 'second-gap', 30)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['head', 'first-gap', 'second-gap'])
    assert.equal(await h.face.loadAfter(), false)
    assert.equal(forwardReads, 0)
    assertUniqueSeqs(h.entries(), 'after consecutive live bursts')
    assertAnnotationsResolve(h.entries())
  } finally { stop(); h.release() }
})

test('forward repair captures a live burst until the missing source interval commits without duplicates', { timeout: 5_000 }, async () => {
  const requested = deferred<SourceHistoryWindowRequest>()
  const response = deferred<{ ok: true; value: SourceHistoryWindowValue }>()
  const h = await harness(request => {
    if (request.afterAt !== undefined) { requested.resolve(request); return response.promise }
    const start = request.startSeq ?? WINDOW_BASE
    return page([body(start, 'head', 10), annotation(start + 1, start, 'head', 10)], 10, true)
  })
  try {
    await h.face.loadThrough(999)
    const face = h.face, eventSource = h.eventSource
    const forward = h.face.loadAfter()
    const request = await requested.promise
    const reserved = request.startSeq!
    h.append(3, 'live', 30)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['head'], 'the live burst cannot appear across an unfilled source gap')
    response.resolve(page([body(reserved, 'paged', 20), annotation(reserved + 1, reserved, 'paged', 20)], 20, false))
    assert.equal(await forward, true)
    await flush()
    assertUniqueSeqs(h.entries(), 'after forward/live race')
    assert.deepEqual(bodyNames(h.entries()), ['head', 'paged', 'live'], 'source position must win over HTTP completion order')
    assertAnnotationsResolve(h.entries())
    h.append(5, 'next-live', 40)
    await flush()
    assertUniqueSeqs(h.entries(), 'after the next live append')
    assert.deepEqual(bodyNames(h.entries()), ['head', 'paged', 'live', 'next-live'])
    assertAnnotationsResolve(h.entries())
    assert.equal(h.face, face, 'the same source SessionFace must survive the race')
    assert.equal(h.eventSource, eventSource, 'the same public event source must survive the race')
  } finally { h.release() }
})

test('tail mode orders a late native body before the already visible newer body', { timeout: 5_000 }, async () => {
  const h = await harness(() => { throw new Error('tail ordering must not request a replacement source window') })
  try {
    const face = h.face, eventSource = h.eventSource
    h.append(3, 'live', 30)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['head', 'live'])
    h.append(5, 'late-earlier', 20)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['head', 'late-earlier', 'live'],
      'tail mode must merge native source positions rather than append delayed HTTP data at the end')
    assertUniqueSeqs(h.entries(), 'tail late merge')
    assertAnnotationsResolve(h.entries())
    assert.equal(h.requests.length, 0)
    assert.equal(h.face, face)
    assert.equal(h.eventSource, eventSource)
  } finally { h.release() }
})

test('return to an authoritative resident head preserves the paged reading window and live boundary', async () => {
  const h = await harness(() => page([body(-1, 'older', 1), annotation(0, -1, 'older', 1)], 1, true), position('head', 10))
  try {
    await h.face.loadOlder()
    assert.deepEqual(bodyNames(h.entries()), ['older', 'head'])
    h.source.replace(h.source.getSnapshot().entries, true)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['older', 'head'], 'the follow snapshot must not replay the already retained tail')
    assert.notEqual(h.face.returnToLive(), false)
    await flush()
    assert.equal(h.requests.length, 1, 'head freshness must not discard the larger resident window for a shorter page')
    assert.deepEqual(bodyNames(h.entries()), ['older', 'head'])
    assert.equal(await h.face.loadAfter(), false, 'an older prepend does not create an unloaded gap after the retained tail')
    h.append(3, 'new-live', 20)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['older', 'head', 'new-live'])
  } finally { h.release() }
})

test('loadThrough uses the resident source identity instead of sending a remapped display seq to Host', { timeout: 5_000 }, async () => {
  const h = await harness(request => {
    const start = request.startSeq ?? WINDOW_BASE
    return page([body(start, 'head', 10), annotation(start + 1, start, 'head', 10)], 10, false)
  })
  try {
    await h.face.loadThrough(999)
    const remapped = h.entries().find(entry => entry.event.type === 'assistant/message')!
    assert.ok(remapped.event.seq >= WINDOW_BASE)
    await h.face.loadThrough(remapped.event.seq)
    assert.deepEqual(h.anchorRequests.map(request => request.seq), [999], 'a client-assigned resident display seq is not a Host log seq')
    assert.equal(h.requests.length, 1, 'a resident target must not replace its window again')
    assert.deepEqual(bodyNames(h.entries()), ['head'])
  } finally { h.release() }
})

test('separate transport frames keep the turn, step and surface established before a native annotation', async () => {
  const h = await harness(request => {
    const start = request.startSeq ?? WINDOW_BASE
    return page([body(start, 'head', 10), annotation(start + 1, start, 'head', 10)], 10, false)
  })
  try {
    await h.face.loadThrough(999)
    const frames: Entry[] = [
      { type: 'event', event: { type: 'turn/start', seq: 3, time: 30_000, data: { turn: 30 } } },
      { type: 'event', event: { type: 'step/start', seq: 4, time: 30_000, data: { turn: 30, step: 1 } } },
      body(5, 'framed-live', 30, false),
      annotation(6, 5, 'framed-live', 30),
      { type: 'event', event: { type: 'step/end', seq: 7, time: 30_000, data: { turn: 30, step: 1 } } },
      { type: 'event', event: { type: 'turn/end', seq: 8, time: 30_000, data: { turn: 30 } } },
    ]
    frames[3]!.event.data.nativeStepId = 'turn:30:framed-live:item'
    for (const frame of frames) { h.source.append(frame); await flush() }
    const live = h.entries().slice(2)
    const startedTurn = live.find(row => row.event.type === 'turn/start')!.event.data.turn
    const startedStep = live.find(row => row.event.type === 'step/start')!.event.data.step
    for (const row of live) {
      const data = row.event.data
      if (typeof data.turn === 'number') assert.equal(data.turn, startedTurn, row.event.type)
      if (typeof data.displayTurn === 'number') assert.equal(data.displayTurn, startedTurn, row.event.type)
      if (typeof data.step === 'number') assert.equal(data.step, startedStep, row.event.type)
      if (typeof data.displayStep === 'number') assert.equal(data.displayStep, startedStep, row.event.type)
    }
    assertAnnotationsResolve(h.entries())
    const requests = h.requests.length
    const before = bodyNames(h.entries())
    const originalSnapshot = h.source.getSnapshot().entries
    h.source.replace(originalSnapshot.slice(-4), true)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), before, 'an overlapping follow rebaseline must not replay resident messages')
    assert.equal(h.requests.length, requests, 'same-owner compaction must not reload the source window')
  } finally { h.release() }
})
