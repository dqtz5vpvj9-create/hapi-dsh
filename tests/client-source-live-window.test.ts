/**
 * Focused regression for the source-latest path: a resident original tail may
 * be an older reconnect seed. The explicit latest intent must load the newest
 * source outline message directly, then keep appending natural live events with
 * stable display seqs/turns and the same editor/binding.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { before, test } from 'node:test'
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ISessions, SessionEventLikeEntry, SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { HistoryProjectionSink } from '../src/shared/projection-event-sink.ts'
import { toSourceFrames } from '../src/shared/source-frame-builder.ts'
import { SOURCE_FRAME_EVENT, type SourceFrame } from '../src/shared/source-frames.ts'
import { NativeProjector } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'
import type { SourceSessionsApi } from '../src/client/source-sessions.ts'
import type { SourceHistoryOutlineValue, SourceHistoryWindowValue } from '../src/source-window-types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const contractEvents = join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')),
  'lib/types/client/contract/events.js')
let runtime: any

before(async () => {
  const built = await build({
    stdin: { contents: [
      `export { SourceSessions } from ${JSON.stringify(join(root, 'src/client/source-sessions.ts'))}`,
      "export { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'",
    ].join('\n'), resolveDir: root, sourcefile: 'live-window-entry.ts', loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': contractEvents },
    // The actual browser has no Node process global.
    define: { process: 'undefined' },
    bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, logLevel: 'silent',
  })
  runtime = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Real pure Host projector; only transport and official owner are fixtures. */
function frames(key: string, position: number, text = key, turnId = 'turn', final = true): SourceFrame[] {
  const sink = new HistoryProjectionSink()
  const projector = new NativeProjector(sink, {
    model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined, stream: () => {},
  })
  const row: NativeRow = { kind: 'assistant', key, rowId: key, localId: key, seq: position, createdAt: position,
    fingerprint: `version:${text}`, text, reasoning: false, final,
    execution: { threadId: 'thread', turnId, itemId: key } }
  projector.apply([row])
  return [...toSourceFrames({ events: sink.events, eventSources: sink.eventSources,
    turnAnchors: projector.turnAnchorEntries(), stepAnchors: projector.stepAnchorEntries() }), ...projector.activeSourceFrames()]
}
function page(items: SourceFrame[], hasMoreAfter = false): SourceHistoryWindowValue {
  const positions = items.flatMap(frame => frame.source ? [frame.source] : [])
  return { records: [], frames: items, hasMoreBefore: true, hasMoreAfter,
    before: positions[0] ?? null, after: positions.at(-1) ?? null, epoch: 1 }
}
function snapshot(id: SessionId): SessionSnapshot {
  return { sessionId: id, pendingSubmissions: [], running: false, subagent: null, removed: false,
    openState: 'open', openError: null, hasMore: true, loadingOlder: false, promptError: null,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false }
}
async function harness(history = false) {
  const id = 'hapi-codex-00000000000000000000000000000031' as SessionId
  const source = new runtime.MutableSessionEventSource()
  let transportSeq = 0
  const batch = (items: SourceFrame[], kind: 'replace' | 'merge') => ({ type: 'event', event: {
    type: SOURCE_FRAME_EVENT, seq: transportSeq++, time: 1, ignorable: true, data: { kind, frames: items },
  } }) as unknown as SessionEventLikeEntry
  const seed = frames('seed', 1, 'original-seed', 'seed-turn')
  source.replace([batch(seed, 'replace')], true)
  const binding: any = { sessionId: id, eventSource: source, ctx: {}, session: {
    sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
    getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => { throw new Error('source history must not page the DSH log') },
    loadThrough: async () => { throw new Error('source history must use source identity') },
  } }
  const original = {
    retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  const outline: SourceHistoryOutlineValue = { entries: [
    { turn: 10, seq: 2_000_000_000, prompt: 'history', response: '', messageId: 'history', at: 10, sourceSeq: 10 },
  ], seedIndex: 0, firstTurn: 100, complete: true }
  let currentPage = page(frames('history', 10, 'historical-body', 'history-turn'))
  const api: SourceSessionsApi = {
    sourceHistoryOutline: async () => ({ ok: true, value: outline }),
    sourceHistoryOutlinePage: async () => ({ ok: true, value: { ...outline, hasMore: false, cursor: null, pageSize: 1 } }),
    sourceReadingAnchor: async () => ({ ok: true, value: { sourceMessageId: 'history' } }),
    sourceHistoryHead: async () => ({ ok: true, value: { messageId: 'head', at: 100, seq: 100 } }),
    sourceHistoryWindowPage: async () => ({ ok: true, value: currentPage }),
  }
  const facade = new runtime.SourceSessions(original); facade.attach(api)
  const reference = facade.retain(id, { source: 'mainView' }); await reference.ready; await tick()
  const session = reference.binding.session as any
  const entries = (): SessionEventLikeEntry[] => [...reference.binding.eventSource.getSnapshot().entries]
  const messages = () => entries().filter(entry => entry.event.type === 'assistant/message')
  const texts = () => messages().map(entry => (entry.event.data as any).message.content.map((part: any) => part.text ?? '').join(''))
  const emit = (items: SourceFrame[], kind: 'merge' | 'replace' = 'merge', reconnect = false) => {
    const value = batch(items, kind)
    if (reconnect) source.replace([value], true)
    else source.append(value)
  }
  if (history) await session.loadSourceMessage('history')
  return { api, source, reference, session, entries, messages, texts, emit, seed, batch,
    setPage: (value: SourceHistoryWindowValue) => { currentPage = value }, dispose: () => reference.release() }
}
const navigate = (h: Awaited<ReturnType<typeof harness>>, route: string) => route === 'latest' ? h.session.returnToLive()
  : route === 'outline' ? h.session.loadThrough(2_000_000_000 as SessionSeq) : h.session.loadSourceMessage('history')
const ok = (value: SourceHistoryWindowValue) => ({ ok: true as const, value })

test('an archived context keeps its source gap even when its short viewport follows the bottom', async () => {
  const h = await harness()
  h.setPage({ ...page(frames('history', 10, 'historical-body'), true), hasMoreBefore: false })
  try {
    await h.session.loadSourceMessage('history')
    const reader = h.session.registerWindowReader({ available: () => true, read: () => ({
      firstSeq: h.entries()[0]!.event.seq, lastSeq: h.entries().at(-1)!.event.seq, followingTail: true }) })
    h.emit(frames('far-live', 100)); await tick()
    assert.deepEqual(h.texts(), ['historical-body'])
    assert.equal(h.session.sourceWindow.getSnapshot().hasMoreAfter, true)
    assert.equal(h.session.getSnapshot().hasMore, false)
    reader()
    h.setPage(page(frames('latest', 100, 'source-latest')))
    assert.equal(await h.session.returnToLive(), true)
    h.emit(frames('after-latest', 110)); await tick()
    assert.deepEqual(h.texts(), ['source-latest', 'after-latest'])
    assert.equal(h.session.sourceWindow.getSnapshot().hasMoreAfter, false)
  } finally { h.dispose() }
})

test('a continuous window accepts live data while preserving a non-following reader and an empty forward page', async () => {
  const h = await harness(true)
  const reader = h.session.registerWindowReader({ available: () => true, read: () => ({
    firstSeq: h.entries()[0]!.event.seq, lastSeq: h.entries().at(-1)!.event.seq, followingTail: false }) })
  try {
    const anchor = h.messages()[0]!.event.seq
    h.emit(frames('later', 100)); await tick()
    assert.deepEqual(h.texts(), ['historical-body', 'later'])
    assert.equal(h.messages()[0]!.event.seq, anchor, 'the existing reading anchor retains its identity')
    h.setPage(page([]))
    assert.equal(await h.session.loadAfter(), false)
    assert.deepEqual(h.texts(), ['historical-body', 'later'])
  } finally { reader(); h.dispose() }
})

test('one bounded older page stays in one loading cycle and commits once', async () => {
  const h = await harness(true)
  const toolOnly: SourceFrame[] = frames('older-tools', 5, 'tool payload').map(frame => ({ ...frame,
    event: { ...frame.event, type: 'tool/call' } }) as SourceFrame)
  const readable = frames('older-answer', 4, 'earlier readable answer')
  const requests: Array<{ limit: number | undefined; busy: boolean }> = []
  h.api.sourceHistoryWindowPage = async request => {
    requests.push({ limit: request.limit, busy: h.session.getSnapshot().loadingOlder })
    return ok(page([...toolOnly, ...readable]))
  }
  try {
    await h.session.loadOlder()
    assert.deepEqual(requests, [{ limit: 50, busy: true }], 'ordinary paging uses the HAPI regular page budget')
    assert.equal(h.session.getSnapshot().loadingOlder, false)
    assert.deepEqual(h.texts(), ['earlier readable answer', 'historical-body'])
    assert.equal(requests.length, 1, 'one gesture commits one complete source page')
  } finally { h.dispose() }
})

for (const route of ['latest', 'outline', 'identity']) test(`${route} merges HTTP overlap and captured live data once`, async () => {
  const h = await harness(), gate = deferred<ReturnType<typeof ok>>(), started = deferred<void>()
  h.api.sourceHistoryWindowPage = () => { started.resolve(); return gate.promise }
  try {
    const operation = navigate(h, route); await started.promise
    const overlap = frames('overlap', 20), suffix = frames('suffix', 30)
    h.emit(overlap); h.emit(suffix)
    gate.resolve(ok(page(overlap))); await operation; await tick()
    assert.deepEqual(h.texts(), ['overlap', 'suffix'])
    assert.equal(h.entries().filter(entry => String(entry.event.type) === 'plugin:hapi-dsh/native-item').length, 2)
    assert.equal(new Set(h.entries().map(entry => entry.event.seq)).size, h.entries().length)
    assert.equal(h.reference.binding.session, h.session)
  } finally { h.dispose() }
})

test('HTTP overlap remains deduplicated across a synchronous burst larger than 256 projected events', async () => {
  const h = await harness(), gate = deferred<ReturnType<typeof ok>>(), started = deferred<void>()
  h.api.sourceHistoryWindowPage = () => { started.resolve(); return gate.promise }
  try {
    const operation = h.session.returnToLive(); await started.promise
    const all = Array.from({ length: 70 }, (_, index) => frames(`row-${index}`, 20 + index)).flat()
    assert.ok(all.length > 256)
    for (const frame of all) h.emit([frame])
    gate.resolve(ok(page(all))); await operation; await tick()
    assert.equal(h.messages().length, 70)
    assert.equal(h.entries().length, new Set(all.map(frame => frame.key)).size)
  } finally { h.dispose() }
})

for (const delivery of ['merge', 'replace', 'transient-final'] as const) test(`captured newer revision replaces HTTP overlap (${delivery})`, async () => {
  const h = await harness(), gate = deferred<ReturnType<typeof ok>>(), started = deferred<void>()
  h.api.sourceHistoryWindowPage = () => { started.resolve(); return gate.promise }
  try {
    const operation = h.session.returnToLive(); await started.promise
    const newer = frames('same', 30, 'newer captured body')
    if (delivery === 'transient-final') h.emit(frames('same', 30, 'partial', 'turn', false))
    h.emit(newer, delivery === 'replace' ? 'replace' : 'merge', delivery === 'replace')
    gate.resolve(ok(page(frames('same', 20, 'older HTTP body')))); await operation; await tick()
    assert.deepEqual(h.texts(), ['newer captured body'])
    assert.equal(h.entries().some(entry => entry.type === 'transient'), false)
    assert.equal(h.entries().filter(entry => String(entry.event.type) === 'plugin:hapi-dsh/native-item').length, 1)
  } finally { h.dispose() }
})

test('an older captured revision cannot replace a newer HTTP item', async () => {
  const h = await harness(), gate = deferred<ReturnType<typeof ok>>(), started = deferred<void>()
  h.api.sourceHistoryWindowPage = () => { started.resolve(); return gate.promise }
  try {
    const operation = h.session.returnToLive(); await started.promise
    h.emit(frames('same', 20, 'older captured body'))
    gate.resolve(ok(page(frames('same', 30, 'newer HTTP body')))); await operation; await tick()
    assert.deepEqual(h.texts(), ['newer HTTP body'])
  } finally { h.dispose() }
})

for (const route of ['latest', 'outline', 'identity']) test(`${route} rereads a same-position version conflict before changing the visible window`, { timeout: 2000 }, async () => {
  const h = await harness(), first = deferred<ReturnType<typeof ok>>(), second = deferred<ReturnType<typeof ok>>()
  const started = deferred<void>(), reread = deferred<void>(); let reads = 0
  h.api.sourceHistoryWindowPage = () => { if (++reads === 1) { started.resolve(); return first.promise }; reread.resolve(); return second.promise }
  try {
    const operation = navigate(h, route); await started.promise
    h.emit(frames('same', 20, 'captured candidate'))
    first.resolve(ok(page(frames('same', 20, 'HTTP candidate')))); await reread.promise
    assert.deepEqual(h.texts(), ['original-seed'])
    second.resolve(ok(page(frames('same', 20, 'authoritative body')))); await operation; await tick()
    assert.equal(reads, 2)
    assert.deepEqual(h.texts(), ['authoritative body'])
  } finally { h.dispose() }
})

test('repeated ambiguous revisions stop after three reads and retain the previous window', async () => {
  const h = await harness(true); let reads = 0
  h.api.sourceHistoryWindowPage = async () => {
    h.emit(frames('same', 20, `captured-${++reads}`), 'replace', true)
    return ok(page(frames('same', 20, 'HTTP candidate')))
  }
  const warn = console.warn; console.warn = () => {}
  try {
    assert.equal(await h.session.returnToLive(), false)
    assert.equal(reads, 3)
    assert.ok(h.texts().includes('historical-body'))
    assert.equal(h.session.getSnapshot().loadingOlder, false)
  } finally { console.warn = warn; h.dispose() }
})

for (const failure of ['head-reject', 'head-error', 'window-reject', 'window-error', 'window-empty'] as const)
  test(`failed latest ${failure} preserves its reader and captured updates`, async () => {
    const h = await harness(true), gate = deferred<any>(), started = deferred<void>()
    const read = () => { started.resolve(); return gate.promise }
    if (failure.startsWith('head')) h.api.sourceHistoryHead = read
    else h.api.sourceHistoryWindowPage = read
    const warn = console.warn; console.warn = () => {}
    try {
      const operation = h.session.returnToLive(); await started.promise
      h.emit(frames('during-failure', 30))
      if (failure.endsWith('reject')) gate.reject(new Error('controlled outage'))
      else if (failure.endsWith('error')) gate.resolve({ ok: false, error: new Error('controlled outage') })
      else gate.resolve(ok(page([])))
      assert.equal(await operation, false); await tick()
      assert.deepEqual(h.texts(), ['historical-body', 'during-failure'])
      assert.equal(h.session.getSnapshot().loadingOlder, false)
    } finally { console.warn = warn; h.dispose() }
  })

for (const next of ['latest', 'identity']) test(`a superseded latest failure cannot drain the newer ${next} capture`, async () => {
  const h = await harness(), first = deferred<any>(), second = deferred<any>(), firstStarted = deferred<void>(), secondStarted = deferred<void>()
  let calls = 0
  h.api.sourceHistoryWindowPage = () => { if (++calls === 1) { firstStarted.resolve(); return first.promise }; secondStarted.resolve(); return second.promise }
  const warn = console.warn; console.warn = () => {}
  try {
    const old = h.session.returnToLive(); await firstStarted.promise
    const current = navigate(h, next); await secondStarted.promise
    h.emit(frames('new-capture', 40))
    first.reject(new Error('superseded read failed')); await old
    second.resolve(ok(page(frames('new-target', 30)))); await current; await tick()
    assert.deepEqual(h.texts(), ['new-target', 'new-capture'])
    assert.equal(h.session.getSnapshot().loadingOlder, false)
  } finally { console.warn = warn; h.dispose() }
})

test('explicit latest uses a fresh head while a partial directory remains independent', async () => {
  const h = await harness(true); let heads = 0; const targets: string[] = []
  h.api.sourceHistoryHead = async () => ({ ok: true, value: { messageId: `head-${++heads}`, at: 100 + heads, seq: 100 + heads } })
  h.api.sourceHistoryOutlinePage = async () => ({ ok: true, value: { entries: [], firstTurn: 0, seedIndex: 0, indexing: true, hasMore: true, complete: false } })
  h.api.sourceHistoryWindowPage = async request => { targets.push(request.messageId!); return ok(page(frames(request.messageId!, 100 + heads))) }
  try {
    assert.equal(await h.session.returnToLive(), true)
    assert.equal(await h.session.returnToLive(), true)
    assert.deepEqual(targets, ['head-1', 'head-2'])
    assert.deepEqual(h.texts(), ['head-2'])
  } finally { h.dispose() }
})

test('stable source turn and step identities survive independent page and live projection', async () => {
  const h = await harness()
  h.setPage(page(frames('head', 10, 'head', 'turn-A')))
  try {
    await h.session.returnToLive()
    h.emit(frames('steer', 20, 'steer', 'turn-A'))
    h.emit(frames('next', 30, 'next', 'turn-B')); await tick()
    const turns = h.messages().map(entry => (entry.event.data as any).turn)
    assert.equal(turns[0], turns[1]); assert.notEqual(turns[1], turns[2])
    assert.deepEqual(h.texts(), ['head', 'steer', 'next'])
    for (const entry of h.entries().filter(entry => String(entry.event.type) === 'plugin:hapi-dsh/native-item')) {
      const data = entry.event.data as any
      assert.ok(h.entries().some(body => body.event.type === 'assistant/message' && body.event.seq === data.surfaceSeq))
    }
  } finally { h.dispose() }
})

test('committed history grows past the former cap and older reads use the real source cursor', async () => {
  const h = await harness(); const requests: Array<{ beforeAt?: number | undefined; beforeSeq?: number | undefined }> = []
  try {
    await h.session.returnToLive()
    for (let index = 0; index < 1_000; index++) h.emit(frames(`bulk-${index}`, 1000 + index))
    await tick()
    const loaded = h.entries().length
    assert.ok(loaded > 1_500, 'the active history retains every committed live source frame')
    const first = h.entries()[0] as unknown as { source: { at: number; seq: number } }
    h.api.sourceHistoryWindowPage = async request => { requests.push(request); return ok({ ...page(frames('older', 1)), hasMoreBefore: false }) }
    await h.session.loadOlder()
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.beforeAt, first.source.at)
    assert.equal(requests[0]!.beforeSeq, first.source.seq)
    assert.ok(h.entries().length > loaded, 'a newly committed older page is prepended without dropping the resident tail')
  } finally { h.dispose() }
})

/** Actual native pages include unnumbered user messages and many folded tools. */
function nativeWindow(turn: string, start: number, tools: number): SourceFrame[] {
  const projector = NativeProjector.history({ model: () => 'fixture', provider: () => 'fixture',
    submittedMessage: () => undefined, stream: () => {} })
  const row = (seq: number) => ({ key: `${turn}-${seq}`, rowId: `${turn}-${seq}`, localId: `${turn}-${seq}`,
    seq, createdAt: seq, fingerprint: `${turn}-${seq}`, execution: { threadId: 'thread', turnId: turn, itemId: `${seq}` } })
  const rows: NativeRow[] = [{ ...row(start), kind: 'user', text: `question-${turn}`, invoked: true, mode: 'queue', parts: [] }]
  for (let index = 0; index < tools; index++) {
    const seq = start + 1 + index * 2
    rows.push({ ...row(seq), kind: 'tool-call', callId: `${turn}-call-${index}`, name: 'read', input: {} },
      { ...row(seq + 1), kind: 'tool-result', callId: `${turn}-call-${index}`, output: 'contents', isError: false })
  }
  rows.push({ ...row(start + tools * 2 + 1), kind: 'assistant', text: `answer-${turn}`, reasoning: false, final: true },
    { ...row(start + tools * 2 + 2), kind: 'turn', execution: { ...row(start).execution,
      turn: { started: true, ended: true, status: 'completed' } } })
  projector.apply(rows)
  return toSourceFrames({ events: projector.historySeed(), eventSources: projector.eventSources()!,
    turnAnchors: projector.turnAnchorEntries(), stepAnchors: projector.stepAnchorEntries() })
}

test('paging a large native turn keeps its user, reader anchor, and every committed row', async () => {
  const h = await harness(), current = nativeWindow('current', 1000, 130), older = nativeWindow('older', 1, 100)
  try {
    h.setPage(page(current)); await h.session.loadSourceMessage('current-1000')
    const user = () => h.entries().find(entry => entry.event.type === 'user/message'
      && (entry.event.data as any).content.some((part: any) => part.text === 'question-current'))!
    const anchor = user().event.seq
    const stop = h.session.registerWindowReader({ available: () => true, read: () => ({
      firstSeq: anchor, lastSeq: anchor, followingTail: false }) })
    try {
      let requestedLimit: number | undefined
      h.api.sourceHistoryWindowPage = async request => { requestedLimit = request.limit; return ok(page(older)) }
      await h.session.loadOlder()
      assert.equal(requestedLimit, 50, 'ordinary paging keeps the DSH event fan-out within the HAPI regular page budget')
      assert.ok(h.entries().some(entry => entry.event.type === 'user/message'
        && (entry.event.data as any).content.some((part: any) => part.text === 'question-older')), 'an accepted page exposes its earlier question')
      assert.equal(user().event.seq, anchor, 'the current reading anchor survives the prepend')
      assert.ok(h.entries().length > 1500, 'the long page and resident tail remain in one history')
      assert.equal(h.session.getSnapshot().loadingOlder, false)
    } finally { stop() }
  } finally { h.dispose() }
})

test('a forward page preserves the actual following reader before folded rows beyond that reader', async () => {
  const h = await harness()
  try {
    h.setPage(page(Array.from({ length: 40 }, (_, index) => frames(`folded-${index + 1}`, index + 1)).flat(), true))
    await h.session.loadSourceMessage('folded-1')
    const anchor = h.messages()[0]!.event.seq
    const stop = h.session.registerWindowReader({ available: () => true, read: () => ({
      firstSeq: anchor, lastSeq: anchor, followingTail: true }) })
    try {
      h.setPage(page(Array.from({ length: 20 }, (_, index) => frames(`forward-${index + 41}`, index + 41)).flat(), true))
      assert.equal(await h.session.loadAfter(), true)
      assert.ok(h.texts().includes('folded-1'), 'paging cannot replace the visible reader with newly received folded content')
      assert.equal(h.messages().find(row => (row.event.data as any).message.content[0].text === 'folded-1')!.event.seq, anchor)
      assert.ok(h.texts().includes('forward-60'), 'the forward interval is admitted while preserving the reader')
    } finally { stop() }
  } finally { h.dispose() }
})

test('folded tool-only updates retain the readable conversation and new output', async () => {
  const h = await harness()
  const tools = (start: number, count: number) => nativeWindow(`tools-${start}`, start, count).filter(frame => {
    if (frame.event.type === 'user/message') return false
    if (frame.event.type !== 'assistant/message') return true
    return !(frame.event.data as any).message.content.some((block: any) => block.type === 'text')
  })
  try {
    h.setPage(page(frames('readable', 1, 'readable conversation paragraph'))); await h.session.loadSourceMessage('readable')
    let anchor = h.messages()[0]!.event.seq
    const stop = h.session.registerWindowReader({ available: () => true, read: () => ({
      firstSeq: anchor, lastSeq: anchor, followingTail: true }) })
    try {
      h.emit(tools(100, 40)); await tick()
      anchor = h.entries().at(-1)!.event.seq
      h.emit(tools(1000, 1)); await tick()
      assert.ok(h.texts().includes('readable conversation paragraph'), 'a folded heading cannot replace the readable window')
      assert.ok(h.entries().some(entry => (entry as any).source?.at >= 1000), 'the new tool output remains available')
      assert.ok(h.entries().length > 0)
    } finally { stop() }
  } finally { h.dispose() }
})

test('forward paging commits one bounded page with its readable continuation', async () => {
  const h = await harness()
  try {
    h.setPage(page(frames('reading', 1, 'reading paragraph'), true)); await h.session.loadSourceMessage('reading')
    const fragment = nativeWindow('tools', 100, 5).filter(frame => frame.event.type !== 'user/message'
      && (frame.event.type !== 'assistant/message' || !(frame.event.data as any).message.content.some((block: any) => block.type === 'text')))
    const limits: Array<number | undefined> = []
    h.api.sourceHistoryWindowPage = async request => {
      limits.push(request.limit)
      return ok(page(request.limit === 20 ? fragment : [...fragment, ...frames('continuation', 200, 'readable continuation')], true))
    }
    const published: string[][] = []
    const stop = h.reference.binding.eventSource.subscribe(() => published.push(h.texts()))
    try {
      assert.equal(await h.session.loadAfter(), true)
      assert.deepEqual(limits, [50])
      assert.ok(h.texts().includes('readable continuation'))
      assert.ok(published.every(texts => texts.includes('reading paragraph') || texts.includes('readable continuation')))
    } finally { stop() }
  } finally { h.dispose() }
})


test('continuing a gesture after forward history is exhausted needs no Node globals or extra request', async () => {
  const h = await harness(true)
  try {
    h.api.sourceHistoryWindowPage = async () => { throw new Error('exhausted forward history must not request another page') }
    assert.equal(await h.session.loadAfter(), false)
    assert.equal(h.session.getSnapshot().loadingOlder, false)
  } finally { h.dispose() }
})
