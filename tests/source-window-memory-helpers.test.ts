import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateBudgets, evaluatePlateau, overallStatus, parseMemoryBudgets, parseProcStatLine,
  nativeMemoryWorkload, projectNativeSummary, workloadCrossesWindow, accumulateWindowEntries,
  sourceWindowResponseRecords, WindowReadBarrier, ENGINEERING_MEMORY_BUDGETS, memoryBodyMarkers, memoryBodyCoverage,
  type MemorySnapshot, type PlateauThresholds,
} from './fixtures/source-window-memory-helpers.ts'

const empty: MemorySnapshot = { hostRssMiB: null, hostHeapUsedMiB: null, hostExternalMiB: null,
  browserRssMiB: null, browserGcHeapMiB: null, browserDomNodes: null, browserListeners: null,
  sourceWindowEntries: null, sourceWindowDomMarkers: null, totalRssMiB: null }
const thresholds: PlateauThresholds = { hostRssMiB: 8, hostHeapUsedMiB: 2, hostExternalMiB: 4,
  browserRssMiB: 16, browserGcHeapMiB: 5, browserDomNodes: 200, browserListeners: 50,
  sourceWindowDomMarkers: 50, totalRssMiB: 16 }

test('native memory workload exceeds projected event and UTF-8 byte limits with actual tool output', () => {
  const workload = nativeMemoryWorkload('synthetic-thread', 'pressure', 450, 12_288)
  const summary = projectNativeSummary(workload.rows, 'synthetic-thread')
  assert.equal(summary.sourceRows, 1_800)
  assert.ok(summary.sourceRows < 5_000, 'source rows must not stand in for the projected event count')
  assert.ok(workloadCrossesWindow(summary))
  assert.equal(summary.toolResultEvents, 450)
  assert.ok(summary.toolResultUtf8Bytes > 12 * 1024 * 1024)
  assert.ok(summary.sourceUtf8Bytes > JSON.stringify(workload.rows).length,
    'UTF-8 accounting must include the multibyte output rather than JS string length')
})

test('durable user, tool and final rows project equally from one page or individual SSE arrivals', () => {
  const workload = nativeMemoryWorkload('synthetic-thread', 'stream', 12, 10)
  const page = projectNativeSummary(workload.rows, 'synthetic-thread')
  const stream = projectNativeSummary(workload.rows, 'synthetic-thread', 'machine', 'stream')
  assert.equal(stream.projectedEvents, page.projectedEvents)
  assert.equal(stream.bodyEvents, 36)
  assert.equal(stream.toolResultEvents, 12)
  assert.equal(stream.toolResultUtf8Bytes, page.toolResultUtf8Bytes)
  assert.equal(new Set(workload.bodyIds).size, 24)
})

test('unknown JSON padding and duplicate terminal rows cannot satisfy projected pressure', () => {
  const workload = nativeMemoryWorkload('synthetic-thread', 'negative', 1, 1)
  const padded = structuredClone(workload.rows)
  for (const row of padded) (row.content as any).ignoredPadding = 'x'.repeat(100_000)
  const baseline = projectNativeSummary(workload.rows, 'synthetic-thread')
  const projection = projectNativeSummary(padded, 'synthetic-thread')
  assert.ok(projection.sourceUtf8Bytes > baseline.sourceUtf8Bytes + 300_000)
  assert.equal(projection.projectedUtf8Bytes, baseline.projectedUtf8Bytes)
  const terminal = { ...workload.rows.at(-1)!, localId: 'terminal', content: { role: 'agent', content: {
    type: 'codex', data: { type: 'native-turn', id: 'terminal', nativeExecution: {
      threadId: 'synthetic-thread', turnId: 'negative-turn-0', turn: { status: 'completed', started: true, ended: true },
    } },
  } } }
  const repeated = projectNativeSummary([...workload.rows, ...Array(5_000).fill(terminal)], 'synthetic-thread')
  assert.equal(workloadCrossesWindow(repeated), false)
  assert.equal(repeated.projectedEvents, baseline.projectedEvents)
})

test('all required owner metrics and supplied budgets must exist before budget PASS', () => {
  assert.equal(parseMemoryBudgets(undefined).declared, false)
  assert.equal(parseMemoryBudgets('{').declared, false)
  assert.equal(parseMemoryBudgets('{"hostRssMiB":300}').declared, false)
  const parsed = parseMemoryBudgets('{"owner":"engineering regression","hostRssMiB":300,"browserRssMiB":600}')
  assert.equal(evaluateBudgets(parsed, { ...empty, hostRssMiB: 100 }, ['hostRssMiB', 'browserRssMiB']).status, 'UNVERIFIED')
  assert.equal(evaluateBudgets(parsed, { ...empty, hostRssMiB: 100, browserRssMiB: 500 }, ['hostHeapUsedMiB']).status, 'UNVERIFIED')
  assert.equal(evaluateBudgets(parsed, { ...empty, hostRssMiB: 301, browserRssMiB: 500 }).status, 'FAIL')
})

test('engineering defaults retain full RSS/DOM budgets and fail on an oversized mounted footprint', () => {
  assert.deepEqual(ENGINEERING_MEMORY_BUDGETS, {
    owner: 'engineering regression baseline 2026-10-25 (full process RSS and full CDP DOM)',
    hostRssMiB: 512, hostHeapUsedMiB: 256, hostExternalMiB: 64,
    browserRssMiB: 1_024, browserGcHeapMiB: 256, browserDomNodes: 15_000,
    browserListeners: 3_000, sourceWindowDomMarkers: 100, totalRssMiB: 1_536,
  })
  const parsed = parseMemoryBudgets(JSON.stringify(ENGINEERING_MEMORY_BUDGETS))
  const measured: MemorySnapshot = { hostRssMiB: 100, hostHeapUsedMiB: 50, hostExternalMiB: 20,
    browserRssMiB: 900, browserGcHeapMiB: 100, browserDomNodes: 25_657, browserListeners: 2_000,
    sourceWindowEntries: null, sourceWindowDomMarkers: 126, totalRssMiB: 1_000 }
  const result = evaluateBudgets(parsed, measured)
  assert.equal(result.status, 'FAIL')
  assert.deepEqual(result.checks.filter(check => check.status === 'FAIL').map(check => check.metric),
    ['browserDomNodes', 'sourceWindowDomMarkers'])
  assert.equal(evaluateBudgets(parsed, { ...measured, browserDomNodes: 15_000, sourceWindowDomMarkers: 100 }).status, 'PASS')
})

test('archive body coverage does not mistake fetched or revisited bodies for complete visible coverage', () => {
  const fixture = nativeMemoryWorkload('thread', 'coverage', 2, 0)
  const served = new Set(fixture.rows.map(row => row.id))
  const visible = new Set([fixture.bodyIds[2]!, fixture.bodyIds[3]!])
  // Seeing the same viewport twice must not fill the two oldest missing bodies.
  for (const body of [fixture.bodyIds[2]!, fixture.bodyIds[3]!]) visible.add(body)
  assert.deepEqual(memoryBodyCoverage(fixture.bodySources, served, visible), {
    planned: 4, served: 4, visible: 2, missingPlanned: fixture.bodyIds.slice(0, 2),
    missingServed: fixture.bodyIds.slice(0, 2), unserved: [],
  })
  served.delete(fixture.bodySources[0]!.sourceId)
  const partial = memoryBodyCoverage(fixture.bodySources, served, visible)
  assert.deepEqual(partial.missingServed, [fixture.bodyIds[1]!])
  assert.deepEqual(partial.unserved, [fixture.bodyIds[0]!])
  for (const body of fixture.bodyIds) visible.add(body)
  served.add(fixture.bodySources[0]!.sourceId)
  assert.deepEqual(memoryBodyCoverage(fixture.bodySources, served, visible), {
    planned: 4, served: 4, visible: 4, missingPlanned: [], missingServed: [], unserved: [],
  })
})

/** A small DOM/geometry fixture for the read-only sampler contract. These tests
 * do not claim actual Chromium layout or browser acceptance. */
function markerDom() {
  type Rect = { left: number; top: number; right: number; bottom: number }
  const texts: Array<{ nodeValue: string; parentElement: MarkerElement; rect: Rect }> = []
  let rangeReads = 0
  let occluded: Rect | undefined
  const normalStyle = { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' }
  const within = (rect: Rect, x: number, y: number) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
  const document: any = {
    defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: (element: MarkerElement) => element.style },
    createTreeWalker: (root: MarkerElement) => {
      const scoped = texts.filter(text => root.contains(text.parentElement))
      let index = 0
      return { nextNode: () => scoped[index++] ?? null }
    },
    createRange: () => {
      let selected: typeof texts[number]
      return { selectNodeContents: (node: typeof selected) => { selected = node },
        getClientRects: () => { rangeReads += 1; return [selected.rect] } }
    },
    elementFromPoint: (x: number, y: number) => occluded && within(occluded, x, y) ? overlay
      : texts.findLast(text => within(text.rect, x, y))?.parentElement ?? null,
  }
  class MarkerElement {
    ownerDocument = document
    style = { ...normalStyle }
    clientLeft = 0
    clientTop = 0
    hidden = false
    isConnected = true
    constructor(readonly kind: string, readonly parentElement: MarkerElement | null,
      public rect: Rect = { left: 0, top: 0, right: 800, bottom: 600 }) {}
    get clientWidth() { return this.rect.right - this.rect.left }
    get clientHeight() { return this.rect.bottom - this.rect.top }
    get textContent(): never { throw new Error('sampling must not concatenate subtree textContent') }
    getBoundingClientRect() { return this.rect }
    hasAttribute(name: string) { return name === 'hidden' && this.hidden }
    contains(candidate: MarkerElement | null): boolean {
      for (let element = candidate; element; element = element.parentElement) if (element === this) return true
      return false
    }
    closest(selector: string): MarkerElement | null {
      for (let element: MarkerElement | null = this; element; element = element.parentElement) {
        if (selector === '[data-conversation-scroll]' && element.kind === 'port') return element
        if (selector === '[data-chat-flow]:not([data-step-process-content])' && element.kind === 'flow') return element
      }
      return null
    }
  }
  const root = new MarkerElement('root', null), overlay = new MarkerElement('overlay', root)
  const pane = (rect: Rect = { left: 0, top: 50, right: 400, bottom: 350 }) => {
    const element = new MarkerElement('pane', root), port = new MarkerElement('port', element, rect)
    port.style.overflowY = 'auto'
    const flow = new MarkerElement('flow', port)
    return { element, port, flow }
  }
  const text = (parent: MarkerElement, value: string, top: number, left = 10) => {
    const leaf = new MarkerElement('leaf', parent)
    const node = { nodeValue: value, parentElement: leaf, rect: { left, top, right: left + 150, bottom: top + 20 } }
    texts.push(node)
    return { leaf, node }
  }
  const sample = (visible: boolean, scope = root) => memoryBodyMarkers(scope as unknown as Element, visible)
  return { root, pane, text, sample, get rangeReads() { return rangeReads },
    cover: (rect: Rect) => { occluded = rect } }
}

test('mounted marker metrics count each pane and hidden occurrence without copying large output', () => {
  const dom = markerDom(), left = dom.pane(), right = dom.pane({ left: 400, top: 50, right: 800, bottom: 350 })
  dom.text(left.flow, 'soak-body-same-0-user', 80)
  dom.text(right.flow, 'soak-body-same-0-user', 80, 420)
  right.element.style.display = 'none'
  dom.text(left.flow, '数'.repeat(40_000), 100)
  dom.text(left.element, 'soak-body-minimap-0-user', 120)
  assert.deepEqual(dom.sample(false), { ids: ['soak-body-same-0-user', 'soak-body-minimap-0-user'], duplicate: [], occurrences: 3 })
  assert.equal(dom.rangeReads, 0, 'mounted accounting must not measure layout')
  dom.text(left.flow, 'soak-body-same-0-user', 140)
  assert.deepEqual(dom.sample(false), { ids: ['soak-body-same-0-user', 'soak-body-minimap-0-user'], duplicate: ['soak-body-same-0-user'], occurrences: 4 })
  assert.deepEqual(dom.sample(true).ids, ['soak-body-same-0-user'], 'a minimap marker cannot prove transcript viewport coverage')
})

test('viewport coverage excludes clipped, hidden, covered and offscreen mounted bodies', () => {
  const dom = markerDom(), pane = dom.pane()
  const on = dom.text(pane.flow, 'soak-body-visible-0-user', 80)
  dom.text(pane.flow, 'soak-body-offscreen-0-user', 400)
  dom.text(pane.flow, 'soak-body-edge-0-user', 340)
  const hidden = dom.text(pane.flow, 'soak-body-hidden-0-user', 120)
  hidden.leaf.style.visibility = 'hidden'
  dom.text(pane.flow, 'soak-body-covered-0-user', 160)
  dom.cover({ left: 0, top: 150, right: 400, bottom: 190 })
  const clipped = dom.text(pane.flow, 'soak-body-clipped-0-user', 220)
  clipped.leaf.style.overflowY = 'hidden'
  clipped.leaf.rect = { left: 0, top: 250, right: 400, bottom: 300 }
  dom.text(pane.flow, '数'.repeat(40_000), 500)
  assert.deepEqual(dom.sample(true), { ids: ['soak-body-visible-0-user', 'soak-body-edge-0-user'], duplicate: [], occurrences: 2 })
  assert.equal(dom.sample(false).occurrences, 6, 'offscreen and hidden bodies still count against mounted residency')
  on.node.rect = { left: 10, top: 600, right: 160, bottom: 620 }
  assert.deepEqual(dom.sample(true).ids, ['soak-body-edge-0-user'])
  pane.element.hidden = true
  assert.deepEqual(dom.sample(true).ids, [])
})

test('actual public window records count UTF-8 entries and deduplicate overlapping remapped pages', () => {
  const sizes = new Map<string, number>()
  const row = (seq: number) => ({ type: 'event', source: { messageId: 'codex:thread:turn:tool:2' },
    event: { type: 'tool/result', seq, data: { text: '数'.repeat(100) } } })
  accumulateWindowEntries([row(100)], 'thread', sizes)
  accumulateWindowEntries([row(200)], 'thread', sizes)
  assert.equal(sizes.size, 1)
  assert.equal([...sizes.values()][0], Buffer.byteLength(JSON.stringify(row(100)), 'utf8'))
  accumulateWindowEntries([row(300)], 'another-thread', sizes)
  assert.equal(sizes.size, 1)
})

test('window metrics read the public RPC envelope and reject failures instead of treating them as empty pages', () => {
  const records = [{ source: { messageId: 'codex:thread:turn:answer:3' }, event: { type: 'assistant/message' } }]
  assert.equal(sourceWindowResponseRecords({ result: { ok: true, value: { records } } }), records)
  assert.deepEqual(sourceWindowResponseRecords({ result: { ok: true, value: { records: [] } } }), [])
  assert.throws(() => sourceWindowResponseRecords({ result: { ok: false, error: { code: 'hapi/request' } } }), /hapi\/request/)
  assert.throws(() => sourceWindowResponseRecords({ result: { ok: true, value: {} } }), /records are missing/)
})

test('request-dispatch barrier waits for late headers, JSON body, and a request started while waiting', async () => {
  const barrier = new WindowReadBarrier()
  const headers = Promise.withResolvers<void>(), body = Promise.withResolvers<void>(), following = Promise.withResolvers<void>()
  const sizes = new Map<string, number>()
  barrier.track((async () => {
    await headers.promise
    await body.promise
    accumulateWindowEntries(sourceWindowResponseRecords({ result: { ok: true, value: { records: [{
      source: { messageId: 'codex:thread:turn:answer:3' }, event: { type: 'assistant/message' },
    }] } } }), 'thread', sizes)
    barrier.track(following.promise)
  })())
  let complete = false
  const settled = barrier.settled().then(() => { complete = true })
  await Promise.resolve()
  assert.equal(complete, false, 'waiting before response headers must not appear idle')
  headers.resolve()
  await Promise.resolve()
  assert.equal(complete, false, 'headers do not prove that records were received')
  body.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sizes.size, 1)
  assert.equal(complete, false, 'a following request is still outstanding')
  following.resolve()
  await settled
  assert.equal(complete, true)
})

test('plateau requires coverage throughout the final five minutes and rejects sparse clustered samples', () => {
  const series = (offset = 0) => [600_000, 660_000, 720_000, 780_000, 840_000, 900_000]
    .map((elapsedMs, index) => ({ elapsedMs, value: 100 + offset * index }))
  const complete = Object.fromEntries(Object.keys(thresholds).map(metric => [metric, series()]))
  assert.equal(evaluatePlateau(complete, thresholds, 900_000, 300_000).status, 'PASS')
  assert.equal(evaluatePlateau({ ...complete, hostHeapUsedMiB: series(1) }, thresholds, 900_000, 300_000).status, 'FAIL')
  assert.equal(evaluatePlateau({ ...complete, hostHeapUsedMiB: series().slice(-2) }, thresholds, 900_000, 300_000).status, 'UNVERIFIED')
  assert.equal(evaluatePlateau({ ...complete, hostHeapUsedMiB: series().slice(-4) }, thresholds, 900_000, 300_000).status, 'UNVERIFIED')
  assert.equal(evaluatePlateau(complete, thresholds, 120_000, 300_000).status, 'UNVERIFIED')
})

test('short formal duration, missing metrics and smoke never become formal PASS', () => {
  const budget = { status: 'PASS' as const, checks: [], exceeded: [], unverified: [], reasons: [] }
  const base = { mode: 'FORMAL' as const, durationMs: 900_000, formalMinimumMs: 900_000, failures: [], budget }
  assert.equal(overallStatus(base).status, 'PASS')
  assert.equal(overallStatus({ ...base, durationMs: 899_999 }).status, 'UNVERIFIED')
  assert.equal(overallStatus({ ...base, mode: 'SMOKE' }).status, 'SMOKE')
  assert.equal(overallStatus({ ...base, budget: { ...budget, status: 'UNVERIFIED', reasons: ['missing Host'] } }).status, 'UNVERIFIED')
  assert.equal(overallStatus({ ...base, failures: ['missing body'] }).status, 'FAIL')
})

test('proc parser preserves parent PID when process names contain spaces and parentheses', () => {
  assert.deepEqual(parseProcStatLine('123 (dsh host (worker)) S 45 123 1 0 -1'), { pid: 123, ppid: 45, comm: 'dsh host (worker)' })
})
