/** Public SourceSessions race regressions with the pinned, real
 * MutableSessionEventSource. Source transport and the original SessionFace are
 * controlled fixtures; these tests do not start a Host or browser. */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { SourceHistoryWindowRequest, SourceHistoryWindowValue, SourceHistoryOutlinePageValue } from '../src/source-window-types.ts'
import type { SourceFrame } from '../src/shared/source-frames.ts'

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
      `export { SourceFrameFeed } from ${JSON.stringify(join(root, 'src/shared/source-frame-feed.ts'))}`,
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
/** Explicit source protocol fixtures. Numeric event coordinates below are
 * intentionally local and have no meaning to the canonical window. */
function canonical(records: Entry[]): SourceFrame[] {
  return records.map(entry => {
    const data = entry.event.data, ordinal = data.displayTurn ?? data.turn ?? entry.event.time / 1_000
    const name = data.message?.content?.[0]?.text ?? data.fingerprint
    const source = entry.source ?? (name ? position(name, ordinal) : undefined)
    const turnKey = `turn:${ordinal}`, stepKey = `step:${ordinal}:${data.displayStep ?? data.step ?? 1}`
    const key = entry.event.type === 'assistant/message' ? `body:${data.message.id}`
      : entry.event.type === 'plugin:hapi-dsh/native-item' ? `annotation:${data.key}`
        : entry.event.type === 'plugin:hapi-dsh/execution' ? `execution:${entry.event.seq}`
          : `${entry.event.type}:${stepKey}`
    return { key, ...(source ? { source } : {}), turnKey, stepKey,
      event: { ...entry.event, seq: Number.isFinite(entry.event.seq) ? entry.event.seq : 0,
        ...(entry.event.type === 'assistant/message' ? { surfaceOp: 'append' as const } : {}) } as unknown as SourceFrame['event'],
      ...(entry.event.type === 'plugin:hapi-dsh/native-item' ? { refs: { surfaceKey: `body:${data.key}` } } : {}) }
  })
}
function page(records: Entry[], afterOrdinal: number, hasMoreAfter: boolean): { ok: true; value: SourceHistoryWindowValue } {
  return { ok: true, value: { records: [], frames: canonical(records), hasMoreBefore: true, hasMoreAfter,
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

async function harness(handler: (request: SourceHistoryWindowRequest) => Promise<{ ok: true; value: SourceHistoryWindowValue }> | { ok: true; value: SourceHistoryWindowValue }, head?: SourcePosition, outlineEpoch = 1,
  lookup?: (seq: number) => Promise<string>, outlinePage?: () => Promise<{ ok: true; value: SourceHistoryOutlinePageValue }>) {
  const source = new runtime.MutableSessionEventSource()
  source.replace([], false)
  let currentFrames = canonical([body(1, 'head', 10), annotation(2, 1, 'head', 10)])
  const feed = new runtime.SourceFrameFeed(() => ({ kind: 'replace', frames: currentFrames }))
  const publish = (records: Entry[], kind: 'replace' | 'merge' = 'merge', reset = false) => {
    const frames = canonical(records)
    currentFrames = kind === 'replace' ? frames : [...currentFrames.filter(old => !frames.some(next => next.key === old.key)), ...frames]
    feed.publish({ kind, frames, ...(reset ? { reset: true } : {}) })
  }
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
    sourceWindowFollow: (_request: unknown, signal: AbortSignal) => feed.watch(signal),
    ...(outlinePage ? { sourceHistoryOutlinePage: outlinePage } : {}),
    sourceHistoryOutline: async () => ({ ok: true, value: {
      entries: [], seedIndex: 0, firstTurn: 10, epoch: outlineEpoch, complete: true, ...(head ? { head } : {}),
    } }),
    sourceReadingAnchor: async (request: { sessionId: string; seq: number }) => {
      anchorRequests.push(request)
      return { ok: true, value: { sourceMessageId: lookup ? await lookup(request.seq) : 'wrong-host-seq-lookup' } }
    },
    sourceHistoryWindowPage: async (request: SourceHistoryWindowRequest) => { requests.push(request); return handler(request) },
  })
  const reference = facade.retain(SESSION, { source: 'mainView' })
  await reference.ready
  const face = reference.binding.session, eventSource = reference.binding.eventSource
  return { source, face, eventSource, requests, anchorRequests, publish,
    entries: (): Entry[] => [...eventSource.getSnapshot().entries],
    append(seq: number, name: string, ordinal: number) {
      publish([body(seq, name, ordinal), annotation(seq + 1, seq, name, ordinal)])
    },
    replace(records: Entry[]) { publish(records, 'replace') },
    reset(records: Entry[]) { publish(records, 'replace', true) },
    release: () => { reference.release(); feed.dispose() },
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

for (const destination of ['latest', 'another historical window'] as const) {
  test(`a late older page cannot overwrite ${destination} or its paging cursor`, async () => {
    const older = deferred<ReturnType<typeof page>>(), entered = deferred<void>()
    let contexts = 0, holdOlder = true
    const h = await harness(request => {
      if (request.beforeSeq !== undefined && holdOlder) {
        entered.resolve()
        return older.promise
      }
      const ordinal = request.beforeSeq === undefined ? ++contexts * 10 : request.beforeSeq - 1
      const name = `window-${ordinal}`
      return { ok: true, value: { ...page([body(0, name, ordinal)], ordinal, false).value,
        before: { at: ordinal * 1_000, seq: ordinal }, beforeMessageId: `native:${name}`, epoch: ordinal } }
    }, position('newest', 100))
    try {
      await h.face.loadThrough(900)
      const paging = h.face.loadOlder(20)
      await entered.promise
      if (destination === 'latest') assert.equal(await h.face.returnToLive(), true)
      else await h.face.loadThrough(901)
      const committed = h.eventSource.getSnapshot()
      const pagingEdge = h.entries()[0]!.source!
      older.resolve(page([body(800, 'stale-page', 1)], 1, true))
      await paging
      assert.equal(h.eventSource.getSnapshot(), committed, 'an obsolete response must not republish or prepend')
      assert.deepEqual(bodyNames(h.entries()), ['window-20'])
      assert.equal(h.face.getSnapshot().loadingOlder, false)
      holdOlder = false
      await h.face.loadOlder(20)
      assert.equal(h.requests.at(-1)!.beforeSeq, pagingEdge.seq, 'the new window keeps its own cursor')
    } finally { older.resolve(page([], 0, false)); h.release() }
  })
}

test('a delayed source-anchor lookup cannot take ownership from a newer navigation', async () => {
  const first = deferred<string>(), entered = deferred<void>()
  const h = await harness(request => page([body(0, request.messageId!, 20)], 20, false), undefined, 1,
    async seq => {
      if (seq === 900) { entered.resolve(); return first.promise }
      return 'current-target'
    })
  try {
    const obsolete = h.face.loadThrough(900)
    await entered.promise
    await h.face.loadThrough(901)
    const committed = h.eventSource.getSnapshot()
    first.resolve('obsolete-target')
    await obsolete
    assert.equal(h.eventSource.getSnapshot(), committed)
    assert.deepEqual(h.requests.map(request => request.messageId), ['current-target'])
    assert.equal(h.face.getSnapshot().loadingOlder, false)
  } finally { first.resolve('obsolete-target'); h.release() }
})

test('older source page measures the live reader immediately before publishing its prepend', async () => {
  const h = await harness(request => {
    const ordinal = request.beforeSeq === undefined ? 10 : request.beforeSeq - 1
    const name = `older-${ordinal}`
    const value = page([body(0, name, ordinal)], ordinal, false).value
    return { ok: true, value: { ...value, before: { at: ordinal * 1_000, seq: ordinal },
      beforeMessageId: `native:${name}`, after: { at: ordinal * 1_000, seq: ordinal }, afterMessageId: `native:${name}` } }
  }, position('head', 10))
  const order: string[] = []
  try {
    await h.face.loadThrough(900)
    const stopReader = h.face.registerWindowReader({
      available: () => true,
      read: () => undefined,
      preparePrepend: () => {
        order.push('measure')
        return { commit: () => order.push('correct'), cancel: () => order.push('cancel') }
      },
    })
    const stopFeed = h.eventSource.subscribe(() => order.push('publish'))
    try {
      await h.face.loadOlder(20)
      assert.deepEqual(order, ['measure', 'publish', 'correct'])
    } finally { stopFeed(); stopReader() }
  } finally { h.release() }
})

test('a visible source reader warms its first older page and the prepend reuses that read', async () => {
  const requested = deferred<void>()
  const response = deferred<ReturnType<typeof page>>()
  let olderReads = 0
  const h = await harness(request => {
    if (request.messageId !== undefined) {
      const value = page([body(1, 'head', 10), annotation(2, 1, 'head', 10)], 10, true).value
      return { ok: true, value: { ...value, before: { at: 10_000, seq: 10 }, beforeMessageId: 'native:head',
        after: { at: 10_000, seq: 10 }, afterMessageId: 'native:head' } }
    }
    olderReads++
    requested.resolve()
    return response.promise
  }, position('head', 10))
  let stopReader = (): void => {}
  try {
    await h.face.loadThrough(900)
    stopReader = h.face.registerWindowReader({ available: () => true, read: () => undefined })
    await requested.promise
    assert.equal(h.face.getSnapshot().loadingOlder, false, 'background warming must not put the reader into loading state')
    const prepend = h.face.loadOlder()
    assert.equal(h.face.getSnapshot().loadingOlder, true)
    response.resolve({ ok: true, value: { ...page([body(0, 'older', 9), annotation(1, 0, 'older', 9)], 9, false).value,
      before: { at: 9_000, seq: 9 }, beforeMessageId: 'native:older',
      after: { at: 9_000, seq: 9 }, afterMessageId: 'native:older', hasMoreBefore: false } })
    await prepend
    assert.equal(olderReads, 1, 'the user-facing prepend must consume the in-flight warmed page')
    assert.deepEqual(bodyNames(h.entries()), ['older', 'head'])
  } finally { stopReader(); response.resolve(page([], 9, false)); h.release() }
})

test('a failed navigation lookup releases the paging busy state and permits retry', async () => {
  let unavailable = true
  const h = await harness(request => page([body(0, 'recovered', 20)], 20, false), undefined, 1,
    async () => {
      if (unavailable) throw new Error('anchor unavailable')
      return 'recovered'
    })
  try {
    const before = h.eventSource.getSnapshot()
    await assert.rejects(h.face.loadThrough(900), /anchor unavailable/)
    assert.equal(h.face.getSnapshot().loadingOlder, false)
    assert.equal(h.eventSource.getSnapshot(), before)
    unavailable = false
    await h.face.loadThrough(900)
    assert.deepEqual(bodyNames(h.entries()), ['recovered'])
    assert.equal(h.face.getSnapshot().loadingOlder, false)
  } finally { h.release() }
})

test('pagination keeps each committed edge epoch across newer outlines, opposite pages and failed reads', async () => {
  let olderPages = 0, newerPages = 0, rejectOlder = false
  const h = await harness(request => {
    if (rejectOlder && request.beforeSeq !== undefined) throw new Error('source revision temporarily unavailable')
    const ordinal = request.beforeSeq !== undefined ? 10 - ++olderPages
      : request.afterSeq !== undefined ? 10 + ++newerPages : 10
    const epoch = request.beforeSeq !== undefined ? 7 + olderPages : request.afterSeq !== undefined ? 20 + newerPages : 7
    const name = `row-${ordinal}`, seq = 0
    return { ok: true, value: { records: [], frames: canonical([body(seq, name, ordinal)]), epoch,
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
    h.replace(seed)
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
  test(`canonical rebaseline preserves the pinned source row while merging new tail content (following ${followingTail})`, async () => {
    const h = await harness(() => { throw new Error('a canonical rebaseline must not reload the source window') })
    let visible = true
    const stop = h.face.registerWindowReader({ available: () => visible,
      read: () => { const head = h.entries().find(entry => entry.event.type === 'assistant/message')!; return { firstSeq: head.event.seq, lastSeq: head.event.seq, followingTail } } })
    try {
      const face = h.face, eventSource = h.eventSource
      const pinned = h.entries().find(entry => entry.event.type === 'assistant/message')!
      // A follow baseline is source data. It may add new content while the
      // single resident window retains the reader's original source row.
      h.replace([body(3, 'rejected-tail', 20), annotation(4, 3, 'rejected-tail', 20)])
      await flush()
      assert.deepEqual(bodyNames(h.entries()), ['head', 'rejected-tail'])
      assert.equal(h.entries().find(entry => entry.event.data.message?.id === pinned.event.data.message.id)!.event.seq, pinned.event.seq)

      // Releasing the reader does not discard acknowledged canonical content.
      visible = false
      h.append(5, 'next-tail', 30)
      await flush()
      assert.deepEqual(bodyNames(h.entries()), ['head', 'rejected-tail', 'next-tail'])
      assertUniqueSeqs(h.entries(), 'after rejected tail recovery')
      assertAnnotationsResolve(h.entries())
      assert.equal(h.requests.length, 0)
      assert.equal(h.face, face)
      assert.equal(h.eventSource, eventSource)
    } finally { stop(); h.release() }
  })
}

test('a large committed source page and live arrivals remain in one resident history', { timeout: 5_000 }, async () => {
  const h = await harness(() => {
    const start = 0
    const controls: Entry[] = Array.from({ length: 4_998 }, (_, index) => ({ type: 'event', event: {
      type: 'plugin:hapi-dsh/execution', seq: start + index + 2, time: 10_000,
      data: { owner: 'native', generation: 1, sequence: index, status: 'active', turnId: 'turn:10' },
    } }))
    return page([body(start, 'head', 10), annotation(start + 1, start, 'head', 10), ...controls], 10, false)
  })
  try {
    await h.face.loadThrough(999)
    const committed = h.entries()
    assert.ok(committed.length > 1_500, 'the complete fetched page enters the reader window')
    const committedBodies = bodyNames(committed)
    assert.ok(committedBodies.includes('head'))

    h.append(3, 'live-one', 20)
    await flush()
    assert.equal(h.entries().length, committed.length + 2)
    assert.deepEqual(bodyNames(h.entries()), ['head', 'live-one'])
    assert.ok(committed.every(row => h.entries().includes(row)), 'live arrival retains every committed page row')
    assert.equal(await h.face.loadAfter(), false, 'continuous history does not invent an evicted forward gap')

    h.append(5, 'live-two', 30)
    await flush()
    assert.deepEqual(bodyNames(h.entries()), ['head', 'live-one', 'live-two'])
    assertUniqueSeqs(h.entries(), 'after consecutive live arrivals')
    assertAnnotationsResolve(h.entries())
  } finally { h.release() }
})

test('forward repair captures a live burst until the missing source interval commits without duplicates', { timeout: 5_000 }, async () => {
  const requested = deferred<SourceHistoryWindowRequest>()
  const response = deferred<{ ok: true; value: SourceHistoryWindowValue }>()
  const h = await harness(request => {
    if (request.afterAt !== undefined) { requested.resolve(request); return response.promise }
    const start = 0
    return page([body(start, 'head', 10), annotation(start + 1, start, 'head', 10)], 10, true)
  })
  try {
    await h.face.loadThrough(999)
    const face = h.face, eventSource = h.eventSource
    const forward = h.face.loadAfter()
    const request = await requested.promise
    const reserved = 0
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

test('returning to the resident bottom keeps loaded history cached and the next upward page advances from it', async () => {
  const requests: SourceHistoryWindowRequest[] = []
  const h = await harness(request => {
    requests.push(request)
    const ordinal = requests.length === 1 ? 9 : 8
    const name = requests.length === 1 ? 'cached-page-one' : 'next-page'
    const response = page([body(ordinal, name, ordinal)], ordinal, false)
    return { ok: true, value: { ...response.value,
      before: { at: ordinal * 1_000, seq: ordinal }, beforeMessageId: `native:${name}`,
      hasMoreBefore: true, hasMoreAfter: false, epoch: 1 } }
  }, position('head', 10))
  try {
    await h.face.loadOlder()
    assert.deepEqual(bodyNames(h.entries()), ['cached-page-one', 'head'])

    assert.equal(await h.face.returnToLive(), true, 'the authoritative resident tail is reused')
    assert.deepEqual(bodyNames(h.entries()), ['cached-page-one', 'head'], 'returning to the bottom does not replace the loaded page')
    assert.equal(requests.length, 1, 'the resident head needs no second transcript read')

    await h.face.loadOlder()
    assert.equal(requests.length, 2)
    assert.deepEqual([requests[1]!.beforeSeq, requests[1]!.cursorMessageId], [9, 'native:cached-page-one'],
      'the next upward page starts at the cached page edge instead of rereading the original tail')
    assert.deepEqual(bodyNames(h.entries()), ['next-page', 'cached-page-one', 'head'],
      'all previously read content remains in one continuous resident window')
  } finally { h.release() }
})

test('loadThrough uses the resident source identity instead of sending a remapped display seq to Host', { timeout: 5_000 }, async () => {
  const h = await harness(request => {
    const start = 0
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
    const start = 0
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
    for (const frame of frames) {
      frame.source = position('framed-live', 30)
      h.publish([frame]); await flush()
    }
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
    h.replace([body(1, 'head', 10), annotation(2, 1, 'head', 10), ...frames])
    await flush()
    assert.deepEqual(bodyNames(h.entries()), before, 'an overlapping follow rebaseline must not replay resident messages')
    assert.equal(h.requests.length, requests, 'same-owner compaction must not reload the source window')
  } finally { h.release() }
})


for (const phase of ['complete', 'first-pending', 'continuation-pending'] as const) {
  test(`a source rewrite replaces the ${phase} outline and ignores its late same-epoch reply`, async () => {
    const value = (name: string, complete = true): { ok: true; value: SourceHistoryOutlinePageValue } => ({ ok: true, value: {
      entries: [{ turn: 1, seq: 2_000_000_000, messageId: `native:${name}`, prompt: name, response: '', at: 1_000, sourceSeq: 1 }],
      seedIndex: 0, firstTurn: 1, epoch: 1, complete, hasMore: !complete,
      cursor: complete ? null : { at: 1_000, seq: 1 }, pageSize: 1,
    } })
    const obsolete = deferred<ReturnType<typeof value>>(), fresh = deferred<ReturnType<typeof value>>()
    let calls = 0
    const h = await harness(() => page([], 1, false), undefined, 1, undefined, async () => {
      calls++
      if (phase === 'first-pending') return calls === 1 ? obsolete.promise : fresh.promise
      if (calls === 1) return value('removed-label', phase === 'complete')
      if (phase === 'continuation-pending' && calls === 2) return obsolete.promise
      return fresh.promise
    })
    const outline = () => h.face.projections.faceOf('turnOutline').getSnapshot() as Array<{ prompt: string }>
    try {
      await flush()
      assert.equal(calls, phase === 'continuation-pending' ? 2 : 1)
      if (phase !== 'first-pending') assert.deepEqual(outline().map(row => row.prompt), ['removed-label'])
      const oldCalls = calls
      h.reset([body(1, 'rewritten-body', 20), annotation(2, 1, 'rewritten-body', 20)])
      await flush()
      assert.equal(calls, oldCalls + 1, 'a fulfilled directory must reopen when the source history changes')
      assert.deepEqual(outline(), [], 'removed labels disappear before the replacement directory arrives')
      assert.deepEqual(bodyNames(h.entries()), ['rewritten-body'], 'directory invalidation does not cancel the independent body feed')
      fresh.resolve(value('current-label'))
      await flush()
      assert.deepEqual(outline().map(row => row.prompt), ['current-label'])
      obsolete.resolve(value('late-removed-label'))
      await flush()
      assert.deepEqual(outline().map(row => row.prompt), ['current-label'], 'an obsolete first/continuation result cannot republish routes')
      h.append(3, 'still-live', 30)
      await flush()
      assert.ok(bodyNames(h.entries()).includes('still-live'))
    } finally { obsolete.resolve(value('closed')); fresh.resolve(value('closed')); h.release() }
  })
}
