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
import { Session } from '@deepseek-ai/dsh-session'
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
    bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, logLevel: 'silent',
  })
  runtime = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`)
})

function event(seq: number, turn: number, type = 'turn/start'): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq, time: seq, data: { turn } } } as unknown as SessionEventLikeEntry
}
function snapshot(id: SessionId): SessionSnapshot {
  return { sessionId: id, pendingSubmissions: [], running: false, subagent: null, removed: false,
    openState: 'open', openError: null, hasMore: true, loadingOlder: false, promptError: null,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function body(seq: number, turn: number, text: string, step = 1): SessionEventLikeEntry {
  return { type: 'event', event: { type: 'assistant/message', seq, time: seq, data: { turn, step, body: text } } } as unknown as SessionEventLikeEntry
}

function annotation(seq: number, surfaceSeq: number, turn: number, step = 1): SessionEventLikeEntry {
  return { type: 'event', event: { type: 'plugin:hapi-dsh/native-item', seq, time: seq,
    data: { nativeTurnId: 'stable-turn', nativeStepId: 'stable-step', displayTurn: turn, displayStep: step, surfaceSeq } } } as unknown as SessionEventLikeEntry
}

/** Real event source and facade; remote reads and the owner Session are controlled fixtures. */
async function historicalHarness(route: 'outline' | 'anchor' = 'outline', openHistory = true) {
  const id = 'hapi-codex-00000000000000000000000000000031' as SessionId
  const source = new runtime.MutableSessionEventSource()
  const seed = [body(1, 100, 'original-seed'), annotation(2, 1, 100)]
  source.replace(seed, true)
  const binding: any = { sessionId: id, eventSource: source, ctx: {}, session: {
    sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
    getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => {}, loadThrough: async () => {},
  } }
  const original = {
    retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  const outline: SourceHistoryOutlineValue = {
    entries: [
      { turn: 10, seq: 2_000_000_000, prompt: 'history', response: '', messageId: 'm-history', at: 1, sourceSeq: 1 },
      { turn: 200, seq: 2_000_000_001, prompt: 'latest', response: '', messageId: 'm-newest', at: 4, sourceSeq: 4 },
    ], seedIndex: 0, firstTurn: 100, complete: true, head: { messageId: 'm-head', at: 5, seq: 5 },
  }
  const page: SourceHistoryWindowValue = {
    records: [body(3_001_000_000, 10, 'historical-body', 1_000_000_001), annotation(3_001_000_001, 3_001_000_000, 10, 1_000_000_001)],
    // Live-merge tests use a context connected to the source tail. A context
    // with omitted newer history is exercised separately below.
    hasMoreBefore: true, hasMoreAfter: false, before: { at: 1, seq: 1 }, after: { at: 2, seq: 2 },
  }
  const api: SourceSessionsApi = {
    sourceHistoryOutline: async () => ({ ok: true, value: outline }),
    sourceHistoryOutlinePage: async () => ({ ok: true, value: { ...outline, hasMore: false, cursor: null, pageSize: 1 } }),
    sourceHistoryWindowPage: async () => ({ ok: true, value: page }),
    sourceReadingAnchor: async () => ({ ok: true, value: { sourceMessageId: 'm-history' } }),
  }
  const facade = new runtime.SourceSessions(original)
  facade.attach(api)
  const reference = facade.retain(id, { source: 'mainView' })
  await reference.ready
  if (openHistory) await reference.binding.session.loadThrough((route === 'outline' ? 2_000_000_000 : 12345) as SessionSeq)
  const entries = (): SessionEventLikeEntry[] => [...reference.binding.eventSource.getSnapshot().entries]
  const bodies = (): string[] => entries().map(row => (row.event.data as { body?: string })?.body).filter((value): value is string => value !== undefined)
  assert.deepEqual(bodies(), [openHistory ? 'historical-body' : 'original-seed'])
  return { source, seed, reference, api, outline, page, entries, bodies, dispose: () => reference.release() }
}

test('a short oldest context exposes its source gap and never appends live across omitted history', async () => {
  const h = await historicalHarness('outline', false)
  h.page.hasMoreBefore = false
  h.page.hasMoreAfter = true
  const session = h.reference.binding.session as any
  const binding = h.reference.binding, events = binding.eventSource
  const states: boolean[] = []
  const unwatch = session.sourceWindow.subscribe(() => states.push(session.sourceWindow.getSnapshot().hasMoreAfter))
  const warn = console.warn
  console.warn = () => {}
  try {
    await session.loadThrough(2_000_000_000 as SessionSeq)
    assert.equal(session.getSnapshot().hasMore, false, 'the oldest direction is exhausted')
    assert.equal(session.sourceWindow.getSnapshot().hasMoreAfter, true, 'newer source history still has a return path')
    const stopReader = session.registerWindowReader({ available: () => true,
      read: () => ({ firstSeq: 3_001_000_000, lastSeq: 3_001_000_001, followingTail: true }) })
    const revision = events.getSnapshot().revision
    for (const row of completeLiveRow('distant-live', 10)) h.source.append(row)
    await tick()
    assert.equal(events.getSnapshot().revision, revision, 'geometric tail following cannot bridge a source gap')
    assert.deepEqual(h.bodies(), ['historical-body'])

    h.api.sourceHistoryWindowPage = async () => ({ ok: false, error: new Error('latest temporarily unavailable') })
    assert.equal(await session.returnToLive(), false)
    assert.equal(session.sourceWindow.getSnapshot().hasMoreAfter, true)
    assert.equal(events.getSnapshot().revision, revision, 'failed latest preserves the exact archived window')

    stopReader()
    h.api.sourceHistoryWindowPage = async request => ({ ok: true, value: { ...h.page,
      records: [body(request.startSeq ?? 3_002_000_000, 200, 'source-latest')], hasMoreAfter: false } })
    assert.equal(await session.returnToLive(), true)
    assert.equal(h.reference.binding, binding)
    assert.equal(h.reference.binding.eventSource, events)
    assert.equal(session.sourceWindow.getSnapshot().hasMoreAfter, false)
    h.source.append(body(100, 100, 'after-latest')); await tick()
    assert.deepEqual(h.bodies(), ['source-latest', 'after-latest'])
    assert.deepEqual(states, [true, false], 'source state changes independently of older-history exhaustion')
  } finally { console.warn = warn; unwatch(); h.dispose() }
})

test('a withheld live suffix publishes the source gap and forward exhaustion clears it', async () => {
  const h = await historicalHarness()
  const session = h.reference.binding.session as any
  const states: boolean[] = []
  const unwatch = session.sourceWindow.subscribe(() => states.push(session.sourceWindow.getSnapshot().hasMoreAfter))
  const stopReader = session.registerWindowReader({ available: () => true,
    read: () => ({ firstSeq: 3_001_000_000, lastSeq: 3_001_000_001, followingTail: false }) })
  try {
    for (const row of completeLiveRow('later-source', 10)) h.source.append(row)
    await tick()
    assert.deepEqual(h.bodies(), ['historical-body'])
    assert.deepEqual(states, [], 'a non-following reader keeps the archived window and publishes no boundary')
    h.api.sourceHistoryWindowPage = async () => ({ ok: true, value: { ...h.page, records: [], hasMoreAfter: false } })
    assert.equal(await session.loadAfter(), false)
    assert.deepEqual(states, [])
    assert.deepEqual(h.bodies(), ['historical-body'])
  } finally { stopReader(); unwatch(); h.dispose() }
})

function completeLiveRow(key: string, seq: number, step = 1, text = key, sourcePosition = seq): SessionEventLikeEntry[] {
  const projector = new NativeProjector(Session.create(`capture-${key}` as SessionId), {
    model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined, stream: () => {}, turnBase: 99,
  })
  const row: NativeRow = { kind: 'assistant', key, rowId: key, localId: key, seq: sourcePosition, createdAt: sourcePosition,
    fingerprint: `existing-version-${text}`, text, reasoning: false, final: true,
    execution: { threadId: 'thread', turnId: 'captured-turn', itemId: key } }
  projector.beginHistorySeed(); projector.apply([row])
  const records = projector.historySeed()
  const mapping = new Map(records.map((record, index) => [Number(record.seq), seq + index]))
  return records.map((record, index) => {
    const data = record.data as any
    return { type: 'event', event: { ...record, seq: seq + index,
      data: { ...data, ...(typeof data.step === 'number' ? { step } : {}),
        ...(typeof data.displayStep === 'number' ? { displayStep: step } : {}),
        ...(typeof data.surfaceSeq === 'number' ? { surfaceSeq: mapping.get(data.surfaceSeq) } : {}) } } } as SessionEventLikeEntry
  }).filter(record => step === 1 || record.event.type !== 'turn/start')
}

function httpLiveRow(records: readonly SessionEventLikeEntry[], start: number): SessionEventLikeEntry[] {
  const annotation = records.find(row => String(row.event.type) === 'plugin:hapi-dsh/native-item')!.event.data as any
  const mapping = new Map(records.map((row, index) => [Number(row.event.seq), start + index]))
  return records.map((row, index) => {
    const data = row.event.data as any
    return { type: 'event', event: { ...row.event, seq: start + index, data: {
      ...data, ...(typeof data.turn === 'number' ? { turn: 200 } : {}),
      ...(typeof data.displayTurn === 'number' ? { displayTurn: 200 } : {}),
      ...(typeof data.step === 'number' ? { step: 1_000_000_000 + data.step } : {}),
      ...(typeof data.displayStep === 'number' ? { displayStep: 1_000_000_000 + data.displayStep } : {}),
      ...(typeof data.surfaceSeq === 'number' ? { surfaceSeq: mapping.get(data.surfaceSeq) } : {}),
    } }, source: { messageId: annotation.sourceMessageId, at: annotation.sourceAt, seq: annotation.sourceSeq } } as unknown as SessionEventLikeEntry
  })
}

for (const route of ['latest', 'outline', 'anchor'] as const) {
  test(`${route} capture does not repeat a complete native row already present in the HTTP window`, async () => {
    const h = await historicalHarness('outline', false)
    const gate = deferred<{ ok: true; value: SourceHistoryWindowValue }>(), started = deferred<void>()
    h.api.sourceHistoryWindowPage = () => { started.resolve(); return gate.promise }
    try {
      const operation = route === 'latest' ? (h.reference.binding.session.returnToLive(), undefined)
        : h.reference.binding.session.loadThrough((route === 'outline' ? 2_000_000_000 : 12345) as SessionSeq)
      await started.promise
      const overlap = completeLiveRow('overlap-body', 10), suffix = completeLiveRow('newer-body', 20, 2)
      for (const row of [...overlap, ...suffix]) h.source.append(row)
      h.source.replace([...h.seed, ...overlap, ...suffix], true)
      gate.resolve({ ok: true, value: { ...h.page, records: httpLiveRow(overlap, 3_000_000_000), hasMoreAfter: false } })
      await operation; await tick()
      const entries = h.entries(), bodies = entries.filter(row => row.event.type === 'assistant/message')
      assert.deepEqual(bodies.map(row => (row.event.data as any).message.content[0].text), ['overlap-body', 'newer-body'])
      assert.equal(entries.filter(row => String(row.event.type) === 'plugin:hapi-dsh/native-item').length, 2)
      assert.equal(entries.filter(row => row.event.type === 'step/start').length, 2)
      assert.equal(entries.filter(row => row.event.type === 'step/end').length, 2)
      assert.equal(new Set(entries.map(row => row.event.seq)).size, entries.length)
      assert.ok(entries.every((row, index) => index === 0 || row.event.seq > entries[index - 1]!.event.seq))
    } finally { h.dispose() }
  })
}

test('HTTP overlap remains deduplicated above the normal 256-event live flush threshold', async () => {
  const h = await historicalHarness('outline', false)
  const gate = deferred<{ ok: true; value: SourceHistoryWindowValue }>(), started = deferred<void>()
  h.api.sourceHistoryWindowPage = () => { started.resolve(); return gate.promise }
  try {
    h.reference.binding.session.returnToLive()
    await started.promise
    const groups = Array.from({ length: 70 }, (_, index) => completeLiveRow(`overlap-${index}`, 10 + index * 10, index + 1))
    const captured = groups.flat(), http = groups.flatMap((rows, index) => httpLiveRow(rows, 3_000_000_000 + index * 10))
    assert.ok(captured.length > 256)
    for (const row of captured) h.source.append(row)
    gate.resolve({ ok: true, value: { ...h.page, records: http, hasMoreAfter: false } })
    await tick()
    const entries = h.entries()
    assert.equal(entries.filter(row => row.event.type === 'assistant/message').length, 70)
    assert.equal(entries.length, http.length, 'the HTTP lifecycle and annotation records must also remain unique')
    assert.deepEqual(entries.map(row => row.event.seq), http.map(row => row.event.seq))
  } finally { h.dispose() }
})

for (const delivery of ['append', 'replace', 'settle-assistant'] as const) {
  test(`HTTP overlap preserves the newer captured body with the same message id (${delivery})`, async () => {
    const h = await historicalHarness('outline', false)
    const gate = deferred<{ ok: true; value: SourceHistoryWindowValue }>(), started = deferred<void>()
    h.api.sourceHistoryWindowPage = () => { started.resolve(); return gate.promise }
    try {
      h.reference.binding.session.returnToLive()
      await started.promise
      const older = completeLiveRow('same-item', 10, 1, 'older HTTP body')
      const newer = completeLiveRow('same-item', 10, 1, 'newer captured body', 20)
      if (delivery === 'replace') {
        for (const row of older) h.source.append(row)
        h.source.replace([...h.seed, ...newer], true)
      } else if (delivery === 'settle-assistant') {
        for (const row of newer) if (row.event.type !== 'assistant/message') h.source.append(row)
        h.source.settleAssistant('captured-attempt', newer.find(row => row.event.type === 'assistant/message'))
      } else for (const row of newer) h.source.append(row)
      const http = httpLiveRow(older, 3_000_000_000)
      gate.resolve({ ok: true, value: { ...h.page, records: http, hasMoreAfter: false } })
      await tick()
      const entries = h.entries(), bodies = entries.filter(row => row.event.type === 'assistant/message')
      assert.equal(bodies.length, 1)
      assert.equal((bodies[0]!.event.data as any).message.content[0].text, 'newer captured body')
      assert.equal((entries.find(row => String(row.event.type) === 'plugin:hapi-dsh/native-item')!.event.data as any).fingerprint,
        'existing-version-newer captured body')
      assert.deepEqual(entries.map(row => row.event.seq), http.map(row => row.event.seq),
        'the corrected source item retains its existing window coordinate')
    } finally { h.dispose() }
  })
}

test('an older captured version cannot replace a newer HTTP item with the same message id', async () => {
  const h = await historicalHarness('outline', false)
  const gate = deferred<{ ok: true; value: SourceHistoryWindowValue }>(), started = deferred<void>()
  h.api.sourceHistoryWindowPage = () => { started.resolve(); return gate.promise }
  try {
    h.reference.binding.session.returnToLive(); await started.promise
    const captured = completeLiveRow('same-item', 10, 1, 'older captured body', 10)
    const http = httpLiveRow(completeLiveRow('same-item', 10, 1, 'newer HTTP body', 20), 3_000_000_000)
    for (const row of captured) h.source.append(row)
    gate.resolve({ ok: true, value: { ...h.page, records: http, hasMoreAfter: false } }); await tick()
    const bodies = h.entries().filter(row => row.event.type === 'assistant/message')
    assert.equal(bodies.length, 1)
    assert.equal((bodies[0]!.event.data as any).message.content[0].text, 'newer HTTP body')
    assert.deepEqual(h.entries().map(row => row.event.seq), http.map(row => row.event.seq))
  } finally { h.dispose() }
})

for (const route of ['latest', 'outline', 'anchor'] as const) {
  test(`${route} same-position version conflict rereads authoritatively before replacing the visible window`, async () => {
    const h = await historicalHarness('outline', false)
    const gate = deferred<{ ok: true; value: SourceHistoryWindowValue }>(), started = deferred<void>()
    const reread = deferred<{ ok: true; value: SourceHistoryWindowValue }>(), rereadStarted = deferred<void>()
    let reads = 0
    h.api.sourceHistoryWindowPage = () => { reads++; if (reads === 1) { started.resolve(); return gate.promise }
      rereadStarted.resolve(); return reread.promise }
    try {
      const operation = route === 'latest' ? (h.reference.binding.session.returnToLive(), undefined)
        : h.reference.binding.session.loadThrough((route === 'outline' ? 2_000_000_000 : 12345) as SessionSeq)
      await started.promise
      const captured = completeLiveRow('same-item', 10, 1, 'captured candidate', 10)
      for (const row of captured) h.source.append(row)
      gate.resolve({ ok: true, value: { ...h.page,
        records: httpLiveRow(completeLiveRow('same-item', 10, 1, 'first HTTP candidate', 10), 3_000_000_000) } })
      await rereadStarted.promise
      assert.deepEqual(h.bodies(), ['original-seed'], 'neither conflicting candidate may replace the reader')
      const authoritative = httpLiveRow(completeLiveRow('same-item', 10, 1, 'authoritative body', 10), 3_000_000_000)
      reread.resolve({ ok: true, value: { ...h.page, records: authoritative, hasMoreAfter: false } })
      await operation; await tick()
      assert.equal(reads, 2, 'one coalesced reread covers the captured conflict')
      const bodies = h.entries().filter(row => row.event.type === 'assistant/message')
      assert.equal(bodies.length, 1)
      assert.equal((bodies[0]!.event.data as any).message.content[0].text, 'authoritative body')
    } finally { h.dispose() }
  })
}

test('repeated source-version conflicts stop after three bounded reads and preserve the reader', async () => {
  const h = await historicalHarness()
  let reads = 0
  const warn = console.warn
  console.warn = () => {}
  h.api.sourceHistoryWindowPage = async () => {
    reads++
    const capture = completeLiveRow('same-item', 10, 1, `captured version ${reads}`, 10)
    h.source.replace([...h.seed, ...capture], true)
    return { ok: true, value: { ...h.page,
      records: httpLiveRow(completeLiveRow('same-item', 10, 1, 'conflicting HTTP body', 10), 3_000_000_000) } }
  }
  try {
    h.reference.binding.session.returnToLive(); await tick()
    assert.equal(reads, 3)
    assert.deepEqual(h.bodies(), ['historical-body'])
    const realBodies = h.entries().filter(row => row.event.type === 'assistant/message' && (row.event.data as any).message)
    assert.deepEqual(realBodies.map(row => (row.event.data as any).message.content[0].text), ['captured version 3'],
      'the retained reader still receives the latest natural capture once')
    assert.equal(h.reference.binding.session.getSnapshot().loadingOlder, false)
  } finally { console.warn = warn; h.dispose() }
})

test('a partially indexed directory does not fail explicit latest', async () => {
  const h = await historicalHarness()
  const warn = console.warn
  console.warn = () => {}
  try {
    // Only the first page is known; older pages remain and indexing is explicit.
    h.api.sourceHistoryOutlinePage = async () => ({ ok: true, value: {
      ...h.outline, complete: false, indexing: true, hasMore: true, cursor: null, pageSize: 1 } })
    const opening = h.reference.binding.session.returnToLive()
    assert.equal(await opening, true, 'a partial directory still carries the authoritative head')
    assert.ok(h.bodies().length > 0, 'latest keeps a readable window while the directory indexes')
  } finally { console.warn = warn; h.dispose() }
})

for (const failure of ['outline-reject', 'outline-error', 'window-reject', 'window-error', 'window-empty'] as const) {
  test(`failed latest ${failure} preserves captured live updates in the historical window`, async () => {
    const h = await historicalHarness()
    const gate = deferred<any>()
    const windowStarted = deferred<void>()
    // Latest reads the paged directory now; the full-outline RPC is only a
    // compatibility fallback for hosts without the paged method.
    if (failure.startsWith('outline')) h.api.sourceHistoryOutlinePage = () => gate.promise
    else h.api.sourceHistoryWindowPage = () => { windowStarted.resolve(); return gate.promise }
    const originalBinding = h.reference.binding, originalFeed = originalBinding.eventSource
    const warn = console.warn
    console.warn = () => {}
    try {
      const opening = h.reference.binding.session.returnToLive()
      if (failure.startsWith('window')) await windowStarted.promise
      h.source.append(body(3, 100, 'during-read'))
      h.source.append(annotation(4, 3, 100))
      if (failure.endsWith('reject')) gate.reject(new Error('controlled latest read failure'))
      else if (failure.endsWith('error')) gate.resolve({ ok: false, error: new Error('controlled latest read error') })
      else gate.resolve({ ok: true, value: { ...h.page, records: [] } })
      assert.equal(await opening, false, 'failed source reads must not report a completed latest window')
      assert.deepEqual(h.bodies(), ['historical-body', 'during-read'])
      assert.equal(h.reference.binding, originalBinding)
      assert.equal(h.reference.binding.eventSource, originalFeed)
      assert.equal(h.reference.binding.session.getSnapshot().loadingOlder, false)
      h.source.append(body(5, 100, 'after-failure'))
      await tick()
      assert.deepEqual(h.bodies(), ['historical-body', 'during-read', 'after-failure'])
    } finally { console.warn = warn; h.dispose() }
  })
}

test('superseded latest failure cannot drain the next latest capture', async () => {
  const h = await historicalHarness()
  const oldRead = deferred<any>(), newRead = deferred<any>()
  let calls = 0
  // Latest reads the paged directory; keep the same supersession semantics.
  h.api.sourceHistoryOutlinePage = () => ++calls === 1 ? oldRead.promise : newRead.promise
  const warn = console.warn
  console.warn = () => {}
  try {
    h.reference.binding.session.returnToLive()
    h.source.append(body(3, 100, 'first-flight'))
    h.reference.binding.session.returnToLive()
    await tick()
    assert.deepEqual(h.bodies(), ['historical-body', 'first-flight'], 'starting a new intent releases the previous capture to the retained view')
    h.source.append(body(4, 100, 'second-flight'))
    oldRead.reject(new Error('older operation rejected late'))
    await tick()
    assert.equal(h.reference.binding.session.getSnapshot().loadingOlder, true)
    assert.deepEqual(h.bodies(), ['historical-body', 'first-flight'], 'an old failure cannot publish the newer capture')
    newRead.resolve({ ok: false, error: new Error('newer operation failed') })
    await tick()
    await tick()
    assert.deepEqual(h.bodies(), ['historical-body', 'first-flight', 'second-flight'])
    h.source.append(body(5, 100, 'after-both'))
    await tick()
    assert.deepEqual(h.bodies(), ['historical-body', 'first-flight', 'second-flight', 'after-both'])
  } finally { console.warn = warn; h.dispose() }
})

test('a superseded latest window failure cannot consume a direct target read capture', async () => {
  const h = await historicalHarness()
  const latestRead = deferred<any>(), targetRead = deferred<any>(), latestStarted = deferred<void>()
  h.api.sourceHistoryWindowPage = request => {
    if (request.messageId === 'm-head') { latestStarted.resolve(); return latestRead.promise }
    return targetRead.promise
  }
  const warn = console.warn
  console.warn = () => {}
  try {
    h.reference.binding.session.returnToLive()
    await latestStarted.promise
    h.source.append(body(3, 100, 'before-new-target'))
    const target = h.reference.binding.session.loadThrough(12345 as SessionSeq)
    await tick()
    assert.deepEqual(h.bodies(), ['historical-body', 'before-new-target'])
    h.source.append(body(4, 100, 'during-new-target'))
    latestRead.reject(new Error('old window failed late'))
    await tick()
    assert.equal(h.reference.binding.session.getSnapshot().loadingOlder, true)
    assert.deepEqual(h.bodies(), ['historical-body', 'before-new-target'])
    targetRead.resolve({ ok: true, value: { ...h.page, records: [body(3_002_000_000, 10, 'new-target'), annotation(3_002_000_001, 3_002_000_000, 10)] } })
    await target
    assert.deepEqual(h.bodies(), ['new-target', 'during-new-target'])
    assert.equal(h.reference.binding.session.getSnapshot().loadingOlder, false)
  } finally { console.warn = warn; h.dispose() }
})

test('failed latest preserves the unseen suffix of a same-owner follow replacement during its read', async () => {
  const h = await historicalHarness()
  const read = deferred<any>()
  h.api.sourceHistoryOutline = () => read.promise
  const warn = console.warn
  console.warn = () => {}
  try {
    h.reference.binding.session.returnToLive()
    h.source.append(body(3, 100, 'append-before-rebaseline'))
    h.source.replace([...h.seed, body(3, 100, 'append-before-rebaseline'), body(4, 100, 'new-rebaseline-suffix')], true)
    read.resolve({ ok: false, error: new Error('latest read unavailable') })
    await tick()
    assert.deepEqual(h.bodies(), ['historical-body', 'append-before-rebaseline', 'new-rebaseline-suffix'])
  } finally { console.warn = warn; h.dispose() }
})

for (const route of ['outline', 'anchor'] as const) {
  test(`direct target ${route} initializes the live boundary and stable turn/step mapping before follow rebaseline`, async () => {
    const h = await historicalHarness(route)
    try {
      h.source.replace([...h.seed, body(3, 100, 'new-suffix'), annotation(4, 3, 100)], true)
      await tick()
      assert.deepEqual(h.bodies(), ['historical-body', 'new-suffix'], 'an overlapping opening cannot replay the original prefix')
      const live = h.entries().find(row => (row.event.data as { body?: string })?.body === 'new-suffix')!
      assert.equal((live.event.data as { turn: number }).turn, 10)
      assert.equal((live.event.data as { step: number }).step, 1_000_000_001)
    } finally { h.dispose() }
  })
}

test('explicit latest loads the newest source turn and receives live appends', { timeout: 8_000 }, async () => {
  const id = 'hapi-codex-00000000000000000000000000000021' as SessionId
  const source = new runtime.MutableSessionEventSource()
  source.replace([event(1, 100)], true)
  const originalCache = Object.assign({}, new Error())
  const original = {
    retain(): SessionReference {
      return { sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference
    },
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  let resolveReady!: (value: unknown) => void
  const ready = new Promise(resolve => { resolveReady = resolve })
  const binding: any = {
    sessionId: id, eventSource: source, ctx: {},
    session: {
      sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
      getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => {},
      loadThrough: async () => {},
    },
  }
  const requests: any[] = []
  const facade = new runtime.SourceSessions(original)
  const api: SourceSessionsApi = {
    sourceHistoryOutline: async (): Promise<{ ok: true; value: SourceHistoryOutlineValue }> => ({ ok: true, value: {
      entries: [
        { turn: 100, seq: 2_000_000_000, prompt: 'old', response: '', messageId: 'm-old', at: 1, sourceSeq: 1 },
        { turn: 200, seq: 2_000_000_001, prompt: 'newest', response: '', messageId: 'm-newest', at: 3, sourceSeq: 3 },
      ], seedIndex: 0, firstTurn: 100, complete: true,
      head: { messageId: 'm-head', at: 4, seq: 4 },
    } }),
    sourceHistoryOutlinePage: async () => ({ ok: true, value: {
      entries: [
        { turn: 100, seq: 2_000_000_000, prompt: 'old', response: '', messageId: 'm-old', at: 1, sourceSeq: 1 },
        { turn: 200, seq: 2_000_000_001, prompt: 'newest', response: '', messageId: 'm-newest', at: 3, sourceSeq: 3 },
      ], seedIndex: 0, firstTurn: 100, complete: true, hasMore: false, cursor: null, pageSize: 1,
      head: { messageId: 'm-head', at: 4, seq: 4 },
    } }),
    sourceHistoryWindowPage: async (request): Promise<{ ok: true; value: SourceHistoryWindowValue }> => {
      requests.push(request)
      return { ok: true, value: { records: [{ type: 'event', event: { type: 'assistant/message', seq: 3_000_000_000,
        time: 3, data: { turn: 200, body: 'newest-body' } } } as unknown as SessionEventLikeEntry],
        hasMoreBefore: true, hasMoreAfter: false, before: { at: 2, seq: 2 }, after: { at: 4, seq: 4 } } }
    },
  }
  facade.attach(api)
  const reference = facade.retain(id, { source: 'mainView' })
  resolveReady(binding)
  await reference.ready
  assert.equal(await reference.binding.session.returnToLive(), true)
  for (let index = 0; index < 80; index++) {
    const turn = reference.binding.eventSource.getSnapshot().entries[0]?.event.data as { turn?: number } | undefined
    if (requests.length > 0 && turn?.turn === 200) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.messageId, 'm-head', 'latest must request the actual source head, not only the user prompt')
  assert.ok((requests[0]?.radius ?? 0) >= 1 && (requests[0]?.radius ?? 0) <= 99)
  const target = reference.binding.eventSource.getSnapshot()
  assert.deepEqual(target.entries.map((entry: SessionEventLikeEntry) => entry.event.data), [{ turn: 200, body: 'newest-body' }])

  // A natural live turn/start after the newest source turn is appended to the
  // same facade window with a dense display seq and the next display turn.
  source.append(event(4, 101))
  await new Promise(resolve => setTimeout(resolve, 20))
  const live = reference.binding.eventSource.getSnapshot()
  assert.equal(live.entries.length, 2)
  assert.equal(live.entries[1]?.event.seq, 3_000_000_001)
  assert.deepEqual(live.entries[1]?.event.data, { turn: 201 })
  reference.release()
})

test('live events arriving during the latest read are not lost and reconnect replace does not yank', { timeout: 8_000 }, async () => {
  const id = 'hapi-codex-00000000000000000000000000000022' as SessionId
  const source = new runtime.MutableSessionEventSource()
  source.replace([event(1, 100)], true)
  const binding: any = {
    sessionId: id, eventSource: source, ctx: {},
    session: {
      sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
      getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => {}, loadThrough: async () => {},
    },
  }
  const original = {
    retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  let releaseWindow!: (value: unknown) => void
  const windowGate = new Promise(resolve => { releaseWindow = resolve })
  let calls = 0
  const facade = new runtime.SourceSessions(original)
  facade.attach({
    sourceHistoryOutline: async () => ({ ok: true, value: { entries: [
      { turn: 100, seq: 2_000_000_000, prompt: 'old', response: '', messageId: 'm-old', at: 1, sourceSeq: 1 },
      { turn: 200, seq: 2_000_000_001, prompt: 'newest', response: '', messageId: 'm-newest', at: 3, sourceSeq: 3 },
    ], seedIndex: 0, firstTurn: 100, complete: true, head: { messageId: 'm-head', at: 4, seq: 4 } } }),
    sourceHistoryWindowPage: async () => { calls++; return windowGate },
  })
  const reference = facade.retain(id, { source: 'mainView' })
  await reference.ready
  const opening = reference.binding.session.returnToLive()
  // A live row arrives while the source head is still in flight.
  source.append(event(5, 101))
  releaseWindow({ ok: true, value: { records: [event(3_000_000_000, 200)], hasMoreBefore: true, hasMoreAfter: false,
    before: { at: 2, seq: 2 }, after: { at: 4, seq: 4 } } })
  assert.equal(await opening, true)
  for (let index = 0; index < 40 && reference.binding.eventSource.getSnapshot().entries.length < 2; index++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const after = reference.binding.eventSource.getSnapshot()
  assert.equal(after.entries.length, 2, 'the in-flight live row must be appended after the latest window')
  assert.equal((after.entries[1]?.event.data as { turn?: number } | undefined)?.turn, 201)
  // A reconnect replace at the live edge re-reads the head; it must not restore
  // the stale turn-100 tail.
  source.replace([event(6, 102)], false)
  for (let index = 0; index < 40 && calls < 2; index++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(calls, 2, 'reconnect replace must request the source head again')
  reference.release()
})

test('live mapping uses native turn identity across steer rows and a following turn', { timeout: 8_000 }, async () => {
  const id = 'hapi-codex-00000000000000000000000000000023' as SessionId
  const source = new runtime.MutableSessionEventSource()
  source.replace([{ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 100 } } }], true)
  const binding: any = {
    sessionId: id, eventSource: source, ctx: {},
    session: {
      sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
      getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => {}, loadThrough: async () => {},
    },
  }
  const original = {
    retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  const plugin = (seq: number, nativeTurnId: string, displayTurn: number, body: string, surfaceSeq?: number) => ({
    type: 'event', event: { type: 'plugin:hapi-dsh/native-item', seq, time: seq,
      data: { nativeTurnId, displayTurn, turn: displayTurn, body, ...(surfaceSeq === undefined ? {} : { surfaceSeq }) } },
  } as unknown as SessionEventLikeEntry)
  const assistant = (seq: number, turn: number, body: string) => ({
    type: 'event', event: { type: 'assistant/message', seq, time: seq, data: { turn, body } },
  } as unknown as SessionEventLikeEntry)
  const headRecord = plugin(3_000_000_001, 'turn-A', 200, 'head-body')
  const facade = new runtime.SourceSessions(original)
  facade.attach({
    sourceHistoryOutline: async () => ({ ok: true, value: { entries: [
      { turn: 200, seq: 2_000_000_000, prompt: 'head prompt', response: '', messageId: 'native:t:turn-A:i1:l1', at: 4, sourceSeq: 4 },
    ], seedIndex: 0, firstTurn: 200, complete: true, head: { messageId: 'm-head', at: 4, seq: 4 } } }),
    sourceHistoryWindowPage: async () => ({ ok: true, value: { records: [headRecord],
      hasMoreBefore: true, hasMoreAfter: false, before: { at: 2, seq: 2 }, after: { at: 5, seq: 5 } } }),
  })
  const reference = facade.retain(id, { source: 'mainView' })
  await reference.ready
  assert.equal(await reference.binding.session.returnToLive(), true)
  for (let index = 0; index < 40; index++) {
    if (reference.binding.eventSource.getSnapshot().entries.length > 0) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  // Real NativeProjector order: the body event is appended before its trailing
  // native-item annotation. The facade must batch the synchronous burst and
  // remap public seq references to the new display seqs.
  source.append({ type: 'event', event: { type: 'assistant/message', seq: 11, time: 11,
    data: { turn: 101, body: 'steer-body' }, sourceEventSeqs: [11],
    surfaceOp: { kind: 'append', startSeq: 11, endSeq: 11 } } } as unknown as SessionEventLikeEntry)
  source.append(plugin(12, 'turn-A', 101, 'steer-body', 11))
  // Following normal turn: a new native identity gets 201.
  source.append(assistant(13, 102, 'next-body'))
  source.append(plugin(14, 'turn-U', 102, 'next-body'))
  await new Promise(resolve => setTimeout(resolve, 40))
  const entries = reference.binding.eventSource.getSnapshot().entries
  const bodies = entries.map((entry: SessionEventLikeEntry) => (entry.event.data as any)?.body).filter(Boolean)
  assert.deepEqual(bodies, ['head-body', 'steer-body', 'steer-body', 'next-body', 'next-body'])
  assert.deepEqual(entries.map((entry: SessionEventLikeEntry) => (entry.event.data as any)?.turn),
    [200, 200, 200, 201, 201])
  // Six further natural increments in the same native turn must remain visible,
  // dense, and duplicate-free.
  for (let index = 0; index < 6; index++) source.append(assistant(20 + index, 101, `burst-${index}`))
  await new Promise(resolve => setTimeout(resolve, 40))
  const burst = reference.binding.eventSource.getSnapshot().entries.filter((entry: SessionEventLikeEntry) =>
    String((entry.event.data as any)?.body ?? '').startsWith('burst-'))
  assert.equal(burst.length, 6, 'all six live body increments must be retained')
  assert.deepEqual(burst.map((entry: SessionEventLikeEntry) => (entry.event.data as any)?.body),
    ['burst-0', 'burst-1', 'burst-2', 'burst-3', 'burst-4', 'burst-5'])
  assert.ok(burst.every((entry: SessionEventLikeEntry) => (entry.event.data as any)?.turn === 200))
  const steerAssistant = entries.find((entry: SessionEventLikeEntry) => (entry.event.data as any)?.body === 'steer-body' && entry.event.type === 'assistant/message')!
  const steerPlugin = entries.find((entry: SessionEventLikeEntry) => (entry.event.data as any)?.body === 'steer-body' && String(entry.event.type).startsWith('plugin:'))!
  assert.deepEqual((steerAssistant.event as any).sourceEventSeqs, [steerAssistant.event.seq])
  assert.deepEqual((steerAssistant.event as any).surfaceOp, { kind: 'append', startSeq: steerAssistant.event.seq, endSeq: steerAssistant.event.seq })
  assert.equal((steerPlugin.event.data as any).surfaceSeq, steerAssistant.event.seq)
  reference.release()
})

test('explicit latest re-reads the authoritative head after a long reading session', { timeout: 8_000 }, async () => {
  const id = 'hapi-codex-00000000000000000000000000000024' as SessionId
  const source = new runtime.MutableSessionEventSource()
  source.replace([event(1, 100)], true)
  const binding: any = {
    sessionId: id, eventSource: source, ctx: {},
    session: {
      sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
      getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => {}, loadThrough: async () => {},
    },
  }
  const original = {
    retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  let headCalls = 0
  let failHead = false
  const requests: string[] = []
  const facade = new runtime.SourceSessions(original)
  facade.attach({
    sourceHistoryOutline: async () => {
      headCalls++
      if (failHead) return { ok: false as const, error: new Error('source head unavailable') }
      const messageId = headCalls === 1 ? 'm-old-head' : 'm-new-head'
      return { ok: true, value: { entries: [
        { turn: 200, seq: 2_000_000_000, prompt: 'turn', response: '', messageId: 'native:t:turn:item:local', at: 4, sourceSeq: 4 },
      ], seedIndex: 0, firstTurn: 200, complete: true, head: { messageId, at: 4, seq: 4 } } }
    },
    sourceHistoryWindowPage: async (request: { messageId?: string }) => {
      requests.push(request.messageId ?? '')
      const body = request.messageId === 'm-new-head' ? 'new-head-body' : 'old-head-body'
      return { ok: true, value: { records: [{
        type: 'event', event: { type: 'assistant/message', seq: 3_000_000_000, time: 3, data: { turn: 200, body } },
      } as unknown as SessionEventLikeEntry], hasMoreBefore: true, hasMoreAfter: false,
      before: { at: 2, seq: 2 }, after: { at: 4, seq: 4 } } }
    },
  })
  const reference = facade.retain(id, { source: 'mainView' })
  await reference.ready
  assert.equal(headCalls, 1)
  // Simulate a long old-history reading session: the stored head is stale.
  assert.equal(await reference.binding.session.returnToLive(), true)
  for (let index = 0; index < 60; index++) {
    const body = (reference.binding.eventSource.getSnapshot().entries[0]?.event.data as { body?: string } | undefined)?.body
    if (body === 'new-head-body') break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(headCalls, 2, 'explicit latest must refresh the source head, not reuse a stale prefetch')
  assert.equal(requests.at(-1), 'm-new-head')
  assert.deepEqual(reference.binding.eventSource.getSnapshot().entries[0]?.event.data, { turn: 200, body: 'new-head-body' })
  // Negative control: a failed fresh head must not fall back to the old head
  // or replace the current complete window.
  failHead = true
  const beforeFailure = reference.binding.eventSource.getSnapshot()
  const beforeRequests = requests.length
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(await reference.binding.session.returnToLive(), false)
  } finally { console.warn = warn }
  const afterFailure = reference.binding.eventSource.getSnapshot()
  assert.equal(requests.length, beforeRequests, 'failed latest refresh must not issue a stale head context request')
  assert.equal(afterFailure.revision, beforeFailure.revision)
  assert.deepEqual(afterFailure.entries.map((entry: SessionEventLikeEntry) => entry.event.data),
    beforeFailure.entries.map((entry: SessionEventLikeEntry) => entry.event.data))
  reference.release()
})

test('live append is bounded and keeps a recoverable source sibling cursor', { timeout: 20_000 }, async () => {
  const id = 'hapi-codex-00000000000000000000000000000025' as SessionId
  const source = new runtime.MutableSessionEventSource()
  source.replace([event(1, 100)], true)
  const binding: any = {
    sessionId: id, eventSource: source, ctx: {},
    session: {
      sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
      getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => {}, loadThrough: async () => {},
    },
  }
  const original = {
    retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  const beforeRequests: Array<{ beforeAt?: number; beforeSeq?: number }> = []
  const facade = new runtime.SourceSessions(original)
  facade.attach({
    sourceHistoryOutline: async () => ({ ok: true, value: { entries: [
      { turn: 200, seq: 2_000_000_000, prompt: 'turn', response: '', messageId: 'native:t:turn:item:local', at: 4, sourceSeq: 4 },
    ], seedIndex: 0, firstTurn: 200, complete: true, head: { messageId: 'm-head', at: 4, seq: 4 } } }),
    sourceHistoryWindowPage: async (request: { messageId?: string; beforeAt?: number; beforeSeq?: number; radius?: number }) => {
      if (request.messageId !== undefined) return { ok: true, value: { records: [{
        type: 'event', event: { type: 'assistant/message', seq: 3_000_000_000, time: 3, data: { turn: 200, body: 'head' } },
        source: { messageId: 'm-head', at: 4, seq: 4 },
      } as unknown as SessionEventLikeEntry], hasMoreBefore: true, hasMoreAfter: false,
      before: { at: 2, seq: 2 }, after: { at: 4, seq: 4 } } }
      beforeRequests.push({ ...(request.beforeAt === undefined ? {} : { beforeAt: request.beforeAt }),
        ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }) })
      return { ok: true, value: { records: [{
        type: 'event', event: { type: 'assistant/message', seq: 3_100_000_000, time: 3, data: { turn: 200, body: 'older' } },
        source: { messageId: 'm-older', at: 1, seq: 1 },
      } as unknown as SessionEventLikeEntry], hasMoreBefore: false, hasMoreAfter: false,
      before: { at: 0, seq: 0 }, after: { at: 2, seq: 2 } } }
    },
  })
  const reference = facade.retain(id, { source: 'mainView' })
  await reference.ready
  assert.equal(await reference.binding.session.returnToLive(), true)
  for (let index = 0; index < 80; index++) {
    const head = reference.binding.eventSource.getSnapshot().entries[0]?.event.data as { body?: string } | undefined
    if (head?.body === 'head') break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  // Every three sibling events share one source row. 5,400 live events cross
  // the 5,000-event cap; trimming must not split a row group. Existing entry
  // byte lengths are cached, so the 5,400 appends must not re-encode the whole
  // retained 12 MiB window per batch.
  const realStringify = JSON.stringify
  let stringifyCalls = 0
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    stringifyCalls++
    return realStringify(...args)
  }) as typeof JSON.stringify
  for (let index = 0; index < 5_400; index++) {
    const row = Math.floor(index / 3)
    source.append({
      type: 'event', event: { type: 'assistant/message', seq: 20 + index, time: 20 + index,
        data: { turn: 101, body: `bulk-${index}` } },
      source: { messageId: `m-${row}`, at: 1000 + row, seq: 1000 + row },
    } as unknown as SessionEventLikeEntry)
  }
  for (let index = 0; index < 120; index++) {
    const entries = reference.binding.eventSource.getSnapshot().entries
    if (entries.length > 1 && entries.length <= 5_000) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  JSON.stringify = realStringify
  // The final partial projector burst commits in a microtask. Measure its
  // actual retained edge before asking the next navigation to use that edge.
  await tick()
  assert.ok(stringifyCalls < 7_000, `retained entries must not be re-encoded per batch, saw ${stringifyCalls}`)
  const bounded = reference.binding.eventSource.getSnapshot().entries
  assert.ok(bounded.length <= 5_000, `live window must be bounded, saw ${bounded.length}`)
  assert.ok(bounded.length > 1, 'live appends must reach the window')
  const first = bounded[0] as unknown as { source?: { messageId: string } }
  assert.ok(first.source?.messageId)
  assert.equal(bounded.filter((entry: SessionEventLikeEntry) => (entry.event.data as any)?.body.startsWith?.('bulk-')).length > 0, true)
  await reference.binding.session.loadOlder()
  assert.equal(beforeRequests.length, 1, 'the bounded live window must retain a usable before cursor')
  assert.equal(beforeRequests[0]?.beforeSeq, Number(first.source!.messageId.slice(2)) + 1000)
  reference.release()
})

test('real NativeProjector body-before-annotation bursts map by native turn', { timeout: 8_000 }, async () => {
  const id = 'hapi-codex-00000000000000000000000000000026' as SessionId
  const source = new runtime.MutableSessionEventSource()
  source.replace([event(1, 100)], true)
  const binding: any = {
    sessionId: id, eventSource: source, ctx: {},
    session: {
      sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
      getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => {}, loadThrough: async () => {},
    },
  }
  const original = {
    retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference),
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
    binding: () => binding,
  } as unknown as ISessions
  const facade = new runtime.SourceSessions(original)
  facade.attach({
    sourceHistoryOutline: async () => ({ ok: true, value: { entries: [
      { turn: 200, seq: 2_000_000_000, prompt: 'turn', response: '', messageId: 'native:t:turn-A:item:local', at: 4, sourceSeq: 4 },
    ], seedIndex: 0, firstTurn: 200, complete: true, head: { messageId: 'm-head', at: 4, seq: 4 } } }),
    sourceHistoryWindowPage: async () => ({ ok: true, value: { records: [{
      type: 'event', event: { type: 'plugin:hapi-dsh/native-item', seq: 3_000_000_000, time: 3,
        data: { nativeTurnId: 'turn-A', displayTurn: 200, turn: 200, body: 'head' } },
    } as unknown as SessionEventLikeEntry], hasMoreBefore: true, hasMoreAfter: false,
    before: { at: 2, seq: 2 }, after: { at: 4, seq: 4 } } }),
  })
  const reference = facade.retain(id, { source: 'mainView' })
  await reference.ready
  assert.equal(await reference.binding.session.returnToLive(), true)
  for (let index = 0; index < 80; index++) {
    const data = reference.binding.eventSource.getSnapshot().entries[0]?.event.data as { body?: string } | undefined
    if (data?.body === 'head') break
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  const session = Session.create(id)
  const projector = new NativeProjector(session, {
    model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined, stream: () => {}, turnBase: 100,
  })
  let seq = 0
  const makeRow = (kind: 'user' | 'assistant', turnId: string, itemId: string): NativeRow => ({
    key: `${turnId}:${itemId}`, rowId: `row-${++seq}`, localId: kind === 'user' ? `local-${seq}` : null,
    seq, createdAt: 1000 + seq, fingerprint: `${turnId}:${itemId}`,
    execution: { threadId: 'thread', turnId, itemId },
    ...(kind === 'user'
      ? { kind: 'user' as const, text: `question-${turnId}`, invoked: true, mode: 'queue' as const, parts: [] }
      : { kind: 'assistant' as const, text: `answer-${turnId}`, reasoning: false, final: true }),
  })
  projector.apply([makeRow('user', 'turn-A', 'i1')])
  projector.apply([makeRow('assistant', 'turn-A', 'i2')])
  projector.apply([makeRow('assistant', 'turn-A', 'i2b')])
  projector.apply([makeRow('user', 'turn-U', 'i3')])
  projector.apply([makeRow('assistant', 'turn-U', 'i4')])
  for (const ev of session.snapshotEvents()) source.append({ type: 'event', event: ev } as unknown as SessionEventLikeEntry)
  await new Promise(resolve => setTimeout(resolve, 60))
  const entries = reference.binding.eventSource.getSnapshot().entries
  const assistant = entries.filter((entry: SessionEventLikeEntry) => entry.event.type === 'assistant/message')
  const turns = assistant.map((entry: SessionEventLikeEntry) => (entry.event.data as any)?.turn)
  assert.deepEqual(turns, [200, 200, 201], 'same native turn stays 200; next native turn becomes 201')
  assert.ok(assistant.every((entry: SessionEventLikeEntry) =>
    typeof (entry as unknown as { source?: { messageId?: string } }).source?.messageId === 'string'),
  'real projector body events must retain their source row identity after annotation mapping')
  const text = assistant.map((entry: SessionEventLikeEntry) =>
    (entry.event.data as any)?.message?.content?.map((block: any) => block.text ?? '').join('') ?? '')
  assert.deepEqual(text, ['answer-turn-A', 'answer-turn-A', 'answer-turn-U'], 'body events remain in order and complete')
  reference.release()
})
