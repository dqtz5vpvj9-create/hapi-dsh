/**
 * Official Host source-window memory soak.
 *
 * Uses the existing WarmOfficialSession (pinned real DSH Host + Chromium, real
 * lease/lifecycle) and durable native user/body/tool wire fixtures via
 * `hapi.add`; only the HAPI source data is synthetic.
 *
 * Fixed workload: a native source ring, one large native history (>5,000 actual
 * projected events and >12 MiB projected UTF-8 JSON), and one native live source
 * receiving bounded batches with real tool output. Live arrivals are
 * checked one by one and kept as a union; the DOM is never required to retain
 * the entire history at once. Large-history coverage is collected through the
 * official "Load earlier" control, not by demanding all IDs in one DOM.
 *
 * Default formal duration is 900 s, starting after setup and the GC baseline.
 * HAPI_DSH_MEMORY_SMOKE=1 is a separate short smoke run and is never acceptance.
 * Host node heap/external use a test-only public Node inspector; the narrow
 * launch patch is supplied separately. No product heap limit/restart exists.
 */
import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import WebSocket from 'ws'
import { WarmOfficialSession } from './warm-session.ts'
import { useBoundedSourceHistory, type BoundedSourceHistory } from './source-conversation-fixture.ts'
import type { HapiMessage } from '../src/codex/contracts.ts'
import {
  classifyProcess, evaluateBudgets, evaluatePlateau, overallStatus, parseMemoryBudgets, parseProcStatLine, toMiB,
  nativeMemoryWorkload, projectNativeSummary, workloadCrossesWindow, accumulateWindowEntries,
  sourceWindowResponseRecords, WindowReadBarrier, ENGINEERING_MEMORY_BUDGETS, memoryBodyMarkers, memoryBodyCoverage,
  type ProjectionSummary, type BodySource,
  type BudgetEvaluation, type MemoryMode, type MemorySnapshot, type PlateauEvaluation, type PlateauThresholds,
} from './source-window-memory-helpers.ts'

const FORMAL_MINIMUM_MS = 900_000
const PLATEAU_WINDOW_MS = 300_000
const SAMPLE_MS = 5_000
const GC_MS = 60_000
const LIVE_BATCH_MS = 20_000
const LIVE_BATCH_TURNS = 12
const LIVE_ROW_LIMIT = 1_800
const ARCHIVE_TRAVERSAL_MS = 180_000
const RING_KEYS = Array.from({ length: 6 }, (_, index) => `soak-${index}`)
const RING_TURNS = 12
const LIVE_KEY = 'soak-live'
const LIVE_INITIAL_TURNS = 8
const LARGE_KEY = 'soak-large'
const LARGE_TURNS = 450
const TOOL_OUTPUT_CHARACTERS = 12_288 // 36 KiB of real UTF-8 tool output per turn.

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}
const smoke = process.env.HAPI_DSH_MEMORY_SMOKE === '1'
const mode: MemoryMode = smoke ? 'SMOKE' : 'FORMAL'
const durationMs = smoke
  ? Math.max(30_000, envNumber('HAPI_DSH_MEMORY_SMOKE_MS', 120_000))
  : Math.max(60_000, envNumber('HAPI_DSH_MEMORY_SOAK_MS', FORMAL_MINIMUM_MS))
const sampleMs = Math.max(1_000, envNumber('HAPI_DSH_MEMORY_SAMPLE_MS', SAMPLE_MS))
const gcSampleMs = Math.max(10_000, envNumber('HAPI_DSH_MEMORY_GC_MS', GC_MS))
const liveBatchMs = Math.max(5_000, envNumber('HAPI_DSH_MEMORY_LIVE_MS', LIVE_BATCH_MS))
const outDirectory = process.env.HAPI_DSH_MEMORY_OUT_DIR ?? '/mnt/cache/data-cache/hapi-dsh-memory-soak'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const BUDGET_RAW = process.env.HAPI_DSH_MEMORY_BUDGETS
const PLATEAU: PlateauThresholds = {
  hostRssMiB: envNumber('HAPI_DSH_MEMORY_PLATEAU_HOST_RSS_MIB', 8),
  hostHeapUsedMiB: envNumber('HAPI_DSH_MEMORY_PLATEAU_HOST_HEAP_MIB', 2),
  hostExternalMiB: envNumber('HAPI_DSH_MEMORY_PLATEAU_HOST_EXTERNAL_MIB', 4),
  browserRssMiB: envNumber('HAPI_DSH_MEMORY_PLATEAU_BROWSER_RSS_MIB', 16),
  browserGcHeapMiB: envNumber('HAPI_DSH_MEMORY_PLATEAU_BROWSER_HEAP_MIB', 5),
  browserDomNodes: envNumber('HAPI_DSH_MEMORY_PLATEAU_DOM_NODES', 200),
  browserListeners: envNumber('HAPI_DSH_MEMORY_PLATEAU_LISTENERS', 50),
  sourceWindowDomMarkers: envNumber('HAPI_DSH_MEMORY_PLATEAU_SOURCE_MARKERS', 50),
  totalRssMiB: envNumber('HAPI_DSH_MEMORY_PLATEAU_TOTAL_RSS_MIB', 16),
}
test.setTimeout(durationMs + 300_000)
test.use({ screenshot: 'off' })

interface SourceFixture {
  rows: HapiMessage[]
  bodyIds: string[]
  bodySources: BodySource[]
  history: BoundedSourceHistory
  sessionId: string
  threadId: string
  servedRowIds: Set<string>
  projection: ProjectionSummary
}
interface ProcessGroup {
  status: 'MEASURED' | 'UNVERIFIED'
  count: number
  pids: number[]
  comms: string[]
  rssMiB: number | null
  hwmMiB: number | null
  anonMiB: number | null
  fileMiB: number | null
  note: string
}
interface ProcessSnapshot {
  host: ProcessGroup
  hostPid: number | null
  hostNodePids: number[]
  browser: ProcessGroup
  other: ProcessGroup
  totalRssMiB: number | null
  runner: 'ABSENT_LOCAL_MODE'
  error?: string
}
interface BrowserSnapshot {
  naturalHeapMiB: number | null
  gcHeapMiB: number | null
  totalHeapMiB: number | null
  embedderHeapMiB: number | null
  backingStorageMiB: number | null
  domNodes: number | null
  documents: number | null
  listeners: number | null
}
interface HostNodeTotals {
  heapUsedMiB: number
  heapTotalMiB: number
  externalMiB: number
  arrayBuffersMiB: number
  rssMiB: number
  gc: boolean
}
interface HostNodeSnapshot extends HostNodeTotals { pid: number }
interface UiSnapshot {
  panes: number
  sourceViews: number
  chatAnchors: number
  bodyMarkers: number
  uniqueBodyIds: number
}
interface SampleRow {
  kind: 'sample'
  at: string
  phase: 'setup' | 'soak'
  elapsedMs: number
  gc: boolean
  boundary?: string | undefined
  hostNodeProcesses: HostNodeSnapshot[]
  hostNodeSum: HostNodeTotals | null
  hostNodeComplete: boolean
  hostNodeMissing: number[]
  hostNodeUnexpected: number[]
  browser: BrowserSnapshot
  processes: ProcessSnapshot
  ui: UiSnapshot
  sourceWindow: { entries: null; held: 'UNVERIFIED_NO_PUBLIC_METRIC'; domMarkers: number; requests: number; budgetOwner: string }
  sampling: { intervalMs: number; gcIntervalMs: number; gapMs: number; missedPeakBoundary: true }
}

function now(): string { return new Date().toISOString() }
function safe(value: unknown): string {
  return String(value).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').replace(/\s+/g, ' ').slice(0, 300)
}
function nativeSource(environment: any, key: string, turns: number, outputCharacters: number): SourceFixture {
  const fixture = environment.hapi.add(key, 'Synthetic soak', 'machine-alpha')
  const threadId = fixture.session.metadata!.codexSessionId as string
  const { rows, bodyIds, bodySources } = nativeMemoryWorkload(threadId, key, turns, outputCharacters)
  fixture.rows = rows
  const history = useBoundedSourceHistory(fixture)
  const servedRowIds = new Set<string>()
  const read = fixture.readHistory!
  fixture.readHistory = async (url: URL) => {
    const result = await read(url)
    for (const row of result.messages) servedRowIds.add(row.id)
    return result
  }
  environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
  return { rows, bodyIds, bodySources, history, sessionId: fixture.session.id, threadId, servedRowIds,
    projection: projectNativeSummary(rows, threadId) }
}

function visibleBodies(pane: Locator): Promise<{ ids: string[]; duplicate: string[] }> {
  return pane.evaluate(memoryBodyMarkers, true)
}

async function waitForBody(pane: Locator, id: string): Promise<number> {
  const body = pane.locator('[data-chat-flow]:not([data-step-process-content])').getByText(id, { exact: true })
  await expect(body).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(async () => (await visibleBodies(pane)).ids.includes(id), {
    timeout: 30_000, message: 'the ready body must intersect the unobscured conversation viewport',
  }).toBe(true)
  return body.count()
}

/** The official pager changes its accessible name to Loading while busy.
 * Its temporary absence under the name Load earlier does not mean exhaustion. */
async function settleHistory(page: Page, pane: Locator, reads: WindowReadBarrier): Promise<void> {
  const flow = pane.locator('[data-chat-flow]:not([data-step-process-content])')
  const pager = flow.getByRole('button', { name: /^(?:Load earlier|Loading(?:…|\.{3})?)$/ })
  await expect.poll(async () => {
    await reads.settled()
    const count = await pager.count()
    assert.ok(count <= 1, 'one conversation must expose at most one history pager')
    return count === 0 || await pager.isEnabled()
  }, { timeout: 30_000, message: 'history request and official pager must finish before traversal continues' }).toBe(true)
  // Let the official layout effect and its following animation frame settle
  // before reading the DOM union or sending another wheel gesture.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

/** Trusted wheel gestures overlap successive viewports. Fetching a page or
 * mounting an offscreen body never contributes visible coverage. */
async function traverseBodies(page: Page, pane: Locator, ids: readonly string[], reads: WindowReadBarrier,
  maxSteps = 60, maxElapsedMs = 30_000): Promise<{
  missing: string[]; duplicate: string[]; union: string[]; steps: number; pages: number; elapsedMs: number; stop: string
}> {
  const union = new Set<string>(), duplicate = new Set<string>()
  const started = Date.now()
  let steps = 0, pages = 0, stop = 'step-limit'
  const port = pane.locator('[data-conversation-scroll]')
  await expect(port).toHaveCount(1)
  const box = await port.boundingBox()
  assert.ok(box, 'official conversation scrollport must be present')
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .5)
  for (; steps < maxSteps; steps += 1) {
    await settleHistory(page, pane, reads)
    const seen = await visibleBodies(pane)
    for (const id of seen.ids) union.add(id)
    for (const id of seen.duplicate) duplicate.add(id)
    if (ids.every(id => union.has(id))) { stop = 'covered'; break }
    if (Date.now() - started >= maxElapsedMs) { stop = 'time-limit'; break }
    const earlier = pane.locator('[data-chat-flow]:not([data-step-process-content])')
      .getByRole('button', { name: 'Load earlier', exact: true })
    if (await port.evaluate(element => element.scrollTop <= 1)) {
      if (!await earlier.isVisible().catch(() => false)) { stop = 'oldest'; break }
      await expect(earlier).toBeEnabled()
      await earlier.click()
      pages += 1
    } else {
      await page.mouse.move(box.x + box.width * .55, box.y + box.height * .5)
      await page.mouse.wheel(0, -Math.max(1, box.height * .5))
    }
    await page.waitForTimeout(100)
  }
  return { missing: ids.filter(id => !union.has(id)), duplicate: [...duplicate], union: [...union],
    steps, pages, elapsedMs: Date.now() - started, stop }
}

const workspacePanes = (page: Page): Locator => page.locator('.hapi-window-active > .hapi-pane')

async function paneIdentities(page: Page): Promise<Array<{ id: string | null; sessionId: string | null }>> {
  return workspacePanes(page).evaluateAll(panes => panes.map(pane => ({
    id: pane.getAttribute('data-pane-id'), sessionId: pane.getAttribute('data-session-id'),
  })))
}

async function focusedPaneMenu(page: Page): Promise<Locator> {
  await expect(page.locator('.hapi-window-active > .hapi-pane-focused')).toHaveCount(1)
  const menu = page.locator('.hapi-statusbar > .hapi-pane-actions')
  await expect(menu).toHaveCount(1)
  await menu.locator(':scope > summary').click()
  await expect(menu).toHaveAttribute('open', '')
  return menu
}

async function openSource(page: Page, key: string, lastBody: string, split: boolean): Promise<Locator> {
  const before = await paneIdentities(page)
  const focused = page.locator('.hapi-window-active > .hapi-pane-focused')
  await expect(focused).toHaveCount(1)
  let paneId = await focused.getAttribute('data-pane-id')
  assert.ok(paneId, 'the source must open into an identified workspace pane')
  if (split) {
    const menu = await focusedPaneMenu(page)
    await menu.getByRole('button', { name: 'Split left / right', exact: true }).click()
    await expect(workspacePanes(page)).toHaveCount(before.length + 1)
    const after = await paneIdentities(page)
    const added = after.filter(pane => !before.some(previous => previous.id === pane.id))
    assert.equal(added.length, 1, 'splitting must add exactly one pane')
    assert.deepEqual(after.filter(pane => before.some(previous => previous.id === pane.id)), before,
      'splitting must preserve every existing pane and source')
    paneId = added[0]!.id
    assert.ok(paneId)
    await expect(focused).toHaveAttribute('data-pane-id', paneId)
  }
  const title = `Native Codex ${key}`
  const trigger = page.locator('.hapi-session-open').filter({ has: page.getByText(title, { exact: true }) })
  await expect(trigger).toHaveCount(1, { timeout: 30_000 })
  await trigger.click()
  const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
  await expect(pane).toHaveCount(1, { timeout: 30_000 })
  await expect(pane).toHaveAttribute('data-pane-id', paneId)
  await expect(pane).toHaveClass(/\bhapi-pane-focused\b/)
  await expect(workspacePanes(page)).toHaveCount(before.length + Number(split))
  const flow = pane.locator('[data-chat-flow]:not([data-step-process-content])')
  await expect(flow).toHaveCount(1, { timeout: 45_000 })
  await expect(flow).toBeVisible({ timeout: 45_000 })
  const count = await waitForBody(pane, lastBody)
  assert.equal(count, 1, `source ${key} did not expose its ready body exactly once`)
  return pane
}

async function closePane(page: Page, pane: Locator): Promise<void> {
  await expect(pane).toHaveCount(1)
  const paneId = await pane.getAttribute('data-pane-id')
  assert.ok(paneId)
  const before = await paneIdentities(page)
  assert.ok(before.length > 1, 'cycling must leave the live pane open')
  await pane.click({ position: { x: 4, y: 4 } })
  await expect(page.locator('.hapi-window-active > .hapi-pane-focused')).toHaveAttribute('data-pane-id', paneId)
  const menu = await focusedPaneMenu(page)
  await menu.getByRole('button', { name: 'Close pane', exact: true }).click()
  await expect(pane).toHaveCount(0, { timeout: 20_000 })
  await expect(workspacePanes(page)).toHaveCount(before.length - 1)
  assert.deepEqual(await paneIdentities(page), before.filter(previous => previous.id !== paneId),
    'closing a cycling pane must preserve the other pane identities and sources')
}

async function readProcTable(): Promise<Map<number, { pid: number; ppid: number; comm: string; cmdline: string; rssKiB: number; hwmKiB: number; anonKiB: number; fileKiB: number }>> {
  const table = new Map<number, any>()
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue
    const pid = Number(entry.name)
    try {
      const parsed = parseProcStatLine(await readFile(`/proc/${pid}/stat`, 'utf8'))
      if (!parsed) continue
      const status = await readFile(`/proc/${pid}/status`, 'utf8')
      const field = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'mu').exec(status)?.[1] ?? 0)
      const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ').trim()
      table.set(pid, { pid, ppid: parsed.ppid, comm: parsed.comm, cmdline,
        rssKiB: field('VmRSS'), hwmKiB: field('VmHWM'), anonKiB: field('RssAnon'), fileKiB: field('RssFile') })
    } catch { /* process exited */ }
  }
  return table
}

function descendants(table: Map<number, any>, root: number): any[] {
  const children = new Map<number, any[]>()
  for (const row of table.values()) {
    const list = children.get(row.ppid)
    if (list) list.push(row); else children.set(row.ppid, [row])
  }
  const result: any[] = [], pending = [...(children.get(root) ?? [])]
  while (pending.length) { const row = pending.pop()!; result.push(row); pending.push(...(children.get(row.pid) ?? [])) }
  return result
}

function group(rows: any[], note: string): ProcessGroup {
  if (!rows.length) return { status: 'UNVERIFIED', count: 0, pids: [], comms: [], rssMiB: null, hwmMiB: null, anonMiB: null, fileMiB: null, note }
  const sum = (key: string): number => rows.reduce((total, row) => total + row[key], 0)
  return { status: 'MEASURED', count: rows.length, pids: rows.map(row => row.pid).sort((a, b) => a - b),
    comms: [...new Set(rows.map(row => row.comm))].sort(), rssMiB: toMiB(sum('rssKiB') * 1024),
    hwmMiB: toMiB(sum('hwmKiB') * 1024), anonMiB: toMiB(sum('anonKiB') * 1024), fileMiB: toMiB(sum('fileKiB') * 1024), note }
}

function subtree(table: Map<number, any>, root: number): any[] {
  const rootRow = table.get(root)
  return rootRow ? [rootRow, ...descendants(table, root)] : []
}

async function processSnapshot(root: number, hostPid: number | null): Promise<ProcessSnapshot> {
  try {
    const table = await readProcTable()
    const rows = descendants(table, root)
    const browserRows = rows.filter(row => classifyProcess(row.comm, row.cmdline) === 'browser')
    const hostTreeIds = hostPid === null ? null : new Set(subtree(table, hostPid).map(row => row.pid))
    const hostRows = hostTreeIds
      ? rows.filter(row => hostTreeIds.has(row.pid) && classifyProcess(row.comm, row.cmdline) !== 'browser')
      : rows.filter(row => classifyProcess(row.comm, row.cmdline) !== 'browser'
        && (/--profile(?:\s|=)/u.test(row.cmdline) || /dist[\\/](?:runner[\\/])?index\.js/iu.test(row.cmdline)))
    const otherRows = rows.filter(row => !browserRows.includes(row) && !hostRows.includes(row))
    const hostNodePids = hostRows.filter(row => /node/iu.test(`${row.comm} ${row.cmdline}`)).map(row => row.pid).sort((a, b) => a - b)
    const host = group(hostRows, 'isolated Host subtree; per-process heap/external come from inspector clients')
    const browser = group(browserRows, 'Chromium process tree; page JS metrics come from public CDP')
    const other = group(otherRows, 'test-driver/other descendants; not treated as Host memory')
    return { host, hostPid, hostNodePids, browser, other, runner: 'ABSENT_LOCAL_MODE',
      totalRssMiB: host.rssMiB !== null && browser.rssMiB !== null ? +(host.rssMiB + browser.rssMiB).toFixed(2) : null }
  } catch (error) {
    const unverified = (note: string): ProcessGroup => ({ status: 'UNVERIFIED', count: 0, pids: [], comms: [], rssMiB: null, hwmMiB: null, anonMiB: null, fileMiB: null, note })
    return { host: unverified('Host process tree unavailable'), hostPid, hostNodePids: [], browser: unverified('Browser process tree unavailable'), other: unverified('Other descendants unavailable'), totalRssMiB: null, runner: 'ABSENT_LOCAL_MODE', error: safe(error) }
  }
}

class HostInspector {
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  private id = 0
  private constructor(private readonly socket: WebSocket) {
    socket.on('message', data => {
      const message = JSON.parse(String(data)) as { id?: number; result?: any; error?: any }
      if (message.id === undefined) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Host inspector error'))
      else pending.resolve(message.result)
    })
    socket.on('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Host inspector closed')) } this.pending.clear() })
    socket.on('error', () => {})
  }
  static async open(url: string): Promise<HostInspector | undefined> {
    let socket: WebSocket | undefined
    try {
      socket = new WebSocket(url)
      const connection = socket
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Host inspector connect timeout')), 3_000)
        connection.once('open', () => { clearTimeout(timer); resolve() })
        connection.once('error', () => { clearTimeout(timer); reject(new Error('Host inspector connect failed')) })
      })
      const client = new HostInspector(socket)
      await client.send('HeapProfiler.enable', {})
      return client
    } catch { socket?.terminate(); return undefined }
  }
  send(method: string, params: unknown): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Host inspector ${method} timeout`)) }, 5_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async memory(gc: boolean): Promise<HostNodeSnapshot> {
    if (gc) await this.send('HeapProfiler.collectGarbage', {})
    const result = await this.send('Runtime.evaluate', { expression: 'JSON.stringify({pid:process.pid,...process.memoryUsage()})', returnByValue: true })
    const value = JSON.parse(result.result.value) as { pid: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number; rss: number }
    return { pid: value.pid, heapUsedMiB: toMiB(value.heapUsed), heapTotalMiB: toMiB(value.heapTotal),
      externalMiB: toMiB(value.external), arrayBuffersMiB: toMiB(value.arrayBuffers), rssMiB: toMiB(value.rss), gc }
  }
  close(): void { this.socket.close() }
}

function inspectorUrls(text: string): string[] {
  return [...new Set([...text.matchAll(/Debugger listening on (wss?:\/\/[^\s]+)/gu)].map(match => match[1]!))]
}

async function browserSnapshot(cdp: any, collect: boolean): Promise<BrowserSnapshot> {
  if (collect) for (let index = 0; index < 3; index += 1) await cdp.send('HeapProfiler.collectGarbage')
  const heap = await cdp.send('Runtime.getHeapUsage') as { usedSize?: number; totalSize?: number; embedderHeapUsedSize?: number; backingStorageSize?: number }
  const dom = await cdp.send('Memory.getDOMCounters') as { nodes?: number; documents?: number; jsEventListeners?: number }
  return { naturalHeapMiB: collect || heap.usedSize === undefined ? null : toMiB(heap.usedSize),
    gcHeapMiB: collect && heap.usedSize !== undefined ? toMiB(heap.usedSize) : null,
    totalHeapMiB: heap.totalSize === undefined ? null : toMiB(heap.totalSize),
    embedderHeapMiB: heap.embedderHeapUsedSize === undefined ? null : toMiB(heap.embedderHeapUsedSize),
    backingStorageMiB: heap.backingStorageSize === undefined ? null : toMiB(heap.backingStorageSize),
    domNodes: dom.nodes ?? null, documents: dom.documents ?? null, listeners: dom.jsEventListeners ?? null }
}

async function uiSnapshot(page: Page): Promise<UiSnapshot> {
  const markers = await page.locator('html').evaluate(memoryBodyMarkers, false)
  const counts = await page.evaluate(() => ({ panes: document.querySelectorAll('[data-pane-id]').length,
    sourceViews: document.querySelectorAll('[data-hapi-session-view]').length,
    chatAnchors: document.querySelectorAll('[data-chat-anchor-key]').length }))
  return { ...counts, bodyMarkers: markers.occurrences, uniqueBodyIds: markers.ids.length }
}

test('official Host source-window memory soak', async ({}, testInfo) => {
  const setupStarted = Date.now()
  const previousInspectorSetting = process.env.HAPI_DSH_MEMORY_HOST_INSPECTOR
  const budgetParse = parseMemoryBudgets(BUDGET_RAW ?? JSON.stringify(ENGINEERING_MEMORY_BUDGETS))
  const owner = budgetParse.owner ?? 'UNASSIGNED'
  const failures: string[] = [], pageErrors: string[] = []
  const outPath = join(outDirectory, `${runId}-${mode}.jsonl`)
  await mkdir(outDirectory, { recursive: true })
  const write = async (row: unknown): Promise<void> => { await appendFile(outPath, `${JSON.stringify(row)}\n`) }
  let warm: WarmOfficialSession | undefined
  let page: Page | undefined
  let cdp: any
  let hostPid: number | null = null
  let hostInspectors: HostInspector[] = []
  const connectedInspectorUrls = new Set<string>()
  let hostInspectorIncomplete = 0
  let hostPids: string | null = null
  let samples = 0, gcSamples = 0, cycles = 0, liveBatches = 0, bodyChecks = 0, liveDrops = 0, samplingGaps = 0
  let liveSourceRowsGenerated = 0, liveSourceBytesGenerated = 0
  let liveEventsGenerated = 0, liveBytesGenerated = 0, liveToolBytesGenerated = 0
  let lastSampleAt = Date.now(), sampleGapMax = 0
  let soakStartedAt = 0
  const history: any[] = []
  const maxima = { hostRssMiB: 0, hostHwmMiB: 0, hostHeapMiB: 0, hostExternalMiB: 0, browserRssMiB: 0,
    browserGcHeapMiB: 0, browserDomNodes: 0, browserListeners: 0, sourceWindowDomMarkers: 0, totalRssMiB: 0 }
  let lastProcesses: ProcessSnapshot | undefined, lastBrowser: BrowserSnapshot | undefined
  let lastHostNodes: HostNodeSnapshot[] = [], lastHostSum: HostNodeTotals | null = null
  const sources = new Map<string, SourceFixture>()
  const archiveUnion = new Set<string>()
  const liveUnion = new Set<string>()
  let liveBatchCounter = 0, liveTurn = LIVE_INITIAL_TURNS
  let sampleTimer: ReturnType<typeof setInterval> | undefined
  let pendingSample: Promise<void> | undefined
  let missingProcessSamples = 0
  const metricErrors: string[] = []
  const archiveEntrySizes = new Map<string, number>()
  const windowReads = new WindowReadBarrier()

  const discoverHostInspectors = async (): Promise<void> => {
    if (!warm) return
    // The fixture's live list can grow when the official Host starts a child
    // after admission. Coverage must not depend on which endpoints existed
    // before the first source session was opened.
    const urls = [...new Set([...(warm.environment.hostInspectorUrls ?? []),
      ...inspectorUrls(warm.environment.diagnostics())])]
    await Promise.all(urls.filter(url => !connectedInspectorUrls.has(url)).map(async url => {
      const client = await HostInspector.open(url)
      if (client) { connectedInspectorUrls.add(url); hostInspectors.push(client) }
    }))
  }

  const sample = async (collect: boolean, boundary?: string): Promise<void> => {
    if (!page || page.isClosed()) return
    await discoverHostInspectors()
    const at = Date.now()
    const gapMs = at - lastSampleAt
    sampleGapMax = Math.max(sampleGapMax, gapMs)
    if (soakStartedAt !== 0 && gapMs > sampleMs * 3) samplingGaps += 1
    const hostSamples = (await Promise.all(hostInspectors.map(client => client.memory(collect).catch(() => null))))
      .filter((value): value is HostNodeSnapshot => value !== null)
    const browser = await browserSnapshot(cdp, collect).catch(error => {
      metricErrors.push(`browser metrics unavailable: ${safe(error)}`)
      return { naturalHeapMiB: null, gcHeapMiB: null, totalHeapMiB: null,
        embedderHeapMiB: null, backingStorageMiB: null, domNodes: null, documents: null, listeners: null }
    })
    const processes = await processSnapshot(process.pid, hostPid)
    const ui = await uiSnapshot(page)
    const hostPidSet = new Set(processes.host.pids)
    const hostNodes = hostSamples.filter(node => hostPidSet.has(node.pid))
    const missing = processes.hostNodePids.filter(pid => !hostNodes.some(node => node.pid === pid))
    const unexpected = hostSamples.filter(node => !hostPidSet.has(node.pid)).map(node => node.pid)
    const complete = hostPid !== null && processes.hostNodePids.length > 0 && hostNodes.length > 0
      && hostInspectors.length > 0 && hostSamples.length === hostInspectors.length
      && missing.length === 0 && unexpected.length === 0
    if (!complete) hostInspectorIncomplete += 1
    const hostSum: HostNodeTotals | null = complete ? hostNodes.reduce((total, node) => ({
      heapUsedMiB: +(total.heapUsedMiB + node.heapUsedMiB).toFixed(2),
      heapTotalMiB: +(total.heapTotalMiB + node.heapTotalMiB).toFixed(2),
      externalMiB: +(total.externalMiB + node.externalMiB).toFixed(2),
      arrayBuffersMiB: +(total.arrayBuffersMiB + node.arrayBuffersMiB).toFixed(2),
      rssMiB: +(total.rssMiB + node.rssMiB).toFixed(2), gc: collect,
    }), { heapUsedMiB: 0, heapTotalMiB: 0, externalMiB: 0, arrayBuffersMiB: 0, rssMiB: 0, gc: collect }) : null
    if (processes.host.status !== 'MEASURED' || processes.browser.status !== 'MEASURED') missingProcessSamples += 1
    if (processes.host.status === 'MEASURED') {
      maxima.hostRssMiB = Math.max(maxima.hostRssMiB, processes.host.rssMiB ?? 0)
      maxima.hostHwmMiB = Math.max(maxima.hostHwmMiB, processes.host.hwmMiB ?? 0)
      if (soakStartedAt !== 0) {
        const pids = processes.host.pids.join(',')
        if (hostPids === null) hostPids = pids
        else if (hostPids !== pids) failures.push('Host process identity changed during soak')
      }
    }
    if (processes.browser.status === 'MEASURED') maxima.browserRssMiB = Math.max(maxima.browserRssMiB, processes.browser.rssMiB ?? 0)
    if (processes.totalRssMiB !== null) maxima.totalRssMiB = Math.max(maxima.totalRssMiB, processes.totalRssMiB)
    if (hostSum) {
      maxima.hostHeapMiB = Math.max(maxima.hostHeapMiB, hostSum.heapUsedMiB)
      maxima.hostExternalMiB = Math.max(maxima.hostExternalMiB, hostSum.externalMiB)
    }
    maxima.browserGcHeapMiB = Math.max(maxima.browserGcHeapMiB, browser.gcHeapMiB ?? 0)
    maxima.browserDomNodes = Math.max(maxima.browserDomNodes, browser.domNodes ?? 0)
    maxima.browserListeners = Math.max(maxima.browserListeners, browser.listeners ?? 0)
    maxima.sourceWindowDomMarkers = Math.max(maxima.sourceWindowDomMarkers, ui.bodyMarkers)
    const elapsedMs = soakStartedAt === 0 ? 0 : Date.now() - soakStartedAt
    const row: SampleRow = {
      kind: 'sample', at: now(), phase: soakStartedAt === 0 ? 'setup' : 'soak',
      elapsedMs, gc: collect, boundary, hostNodeProcesses: hostSamples, hostNodeSum: hostSum,
      hostNodeComplete: complete, hostNodeMissing: missing, hostNodeUnexpected: unexpected,
      browser, processes, ui,
      sourceWindow: { entries: null, held: 'UNVERIFIED_NO_PUBLIC_METRIC', domMarkers: ui.bodyMarkers,
        requests: [...sources.values()].reduce((total, source) => total + source.history.requests.length, 0), budgetOwner: owner },
      sampling: { intervalMs: sampleMs, gcIntervalMs: gcSampleMs, gapMs, missedPeakBoundary: true },
    }
    history.push({ ...row, hostRssMiB: processes.host.rssMiB,
      browserRssMiB: processes.browser.rssMiB, hostHeapMiB: hostSum?.heapUsedMiB ?? null, hostExternalMiB: hostSum?.externalMiB ?? null,
      browserGcHeapMiB: browser.gcHeapMiB, browserDomNodes: browser.domNodes, browserListeners: browser.listeners,
      totalRssMiB: processes.totalRssMiB, sourceWindowDomMarkers: ui.bodyMarkers })
    await write(row)
    lastSampleAt = Date.now(); lastProcesses = processes; lastBrowser = browser
    lastHostNodes = hostSamples; lastHostSum = hostSum
    samples += 1
    if (collect) gcSamples += 1
  }

  const sampleBoundary = async (collect: boolean, boundary?: string): Promise<void> => {
    await pendingSample
    pendingSample = sample(collect, boundary)
    try { await pendingSample } finally { pendingSample = undefined }
  }

  try {
    await write({ kind: 'start', at: now(), mode, durationMs, formalMinimumMs: FORMAL_MINIMUM_MS, sampleMs, gcSampleMs,
      liveBatchMs, sourceRing: RING_KEYS, largeSource: LARGE_KEY, largeTurns: LARGE_TURNS, toolOutputCharacters: TOOL_OUTPUT_CHARACTERS,
      archiveTraversal: { maxElapsedMs: ARCHIVE_TRAVERSAL_MS, maxSteps: LARGE_TURNS * 6 },
      markerMetric: 'all mounted short fixture-marker Text occurrences, including hidden views, previews and separate panes',
      liveBatchTurns: LIVE_BATCH_TURNS, liveSourceRowLimit: LIVE_ROW_LIMIT, plateauWindowMs: PLATEAU_WINDOW_MS, plateau: PLATEAU,
      plateauProvenance: 'engineering regression thresholds; range over the final five minutes, not user historical total-memory limits',
      owners: { host: 'official DSH Host', browser: 'official Chromium', sourceWindow: 'product owner (DOM marker proxy only)',
        budget: owner }, budgets: budgetParse, synthetic: true })
    // Test-only public Node inspector. The launch patch supplies the URL; this
    // is not a product heap limit, restart, or SIGUSR1 path.
    process.env.HAPI_DSH_MEMORY_HOST_INSPECTOR = '1'
    warm = new WarmOfficialSession()
    await warm.start()
    const env = warm.environment as typeof warm.environment & { hostInspectorUrls?: string[]; hostPid?: number }
    hostPid = env.hostPid ?? null
    await discoverHostInspectors()
    const definitions = [...RING_KEYS.map(key => [key, RING_TURNS, 0] as const),
      [LARGE_KEY, LARGE_TURNS, TOOL_OUTPUT_CHARACTERS] as const, [LIVE_KEY, LIVE_INITIAL_TURNS, 0] as const]
    for (const [key, turns, padding] of definitions) sources.set(key, nativeSource(env, key, turns, padding))
    await expect.poll(async () => {
      const catalog = await warm!.environment.rpc<{ sourceDiscovery: { sessions: Array<{ sourceSessionId: string }> } }>('hapi/catalog')
      return [...RING_KEYS, LARGE_KEY, LIVE_KEY].every(key => catalog.sourceDiscovery.sessions.some(row => row.sourceSessionId === `native-${key}`))
    }, { timeout: 30_000 }).toBe(true)
    page = await warm.page()
    page.on('pageerror', error => pageErrors.push(safe(error)))
    page.on('request', request => {
      if (new URL(request.url()).pathname !== '/api/hapi/sourceHistoryWindowPage') return
      const read = (async () => {
        const response = await request.response()
        if (!response?.ok()) throw new Error(`window HTTP response failed: ${response?.status() ?? 'request failed'}`)
        const records = sourceWindowResponseRecords(await response.json())
        accumulateWindowEntries(records, sources.get(LARGE_KEY)!.threadId, archiveEntrySizes)
      })().catch(error => { metricErrors.push(`window response metric unavailable: ${safe(error)}`) })
      windowReads.track(read)
    })
    page.on('console', message => {
      if (/event feed subscriber failed|received an update before its start/iu.test(message.text())) {
        pageErrors.push(safe(message.text()))
      }
    })
    await warm.admit(page)
    cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    lastSampleAt = Date.now()
    await sampleBoundary(false)
    // Archive pressure belongs to the absolute residency measurement too.
    // Starting only after its pane closes misses the largest loading phase.
    sampleTimer = setInterval(() => {
      if (pendingSample) return
      pendingSample = sample(false).catch(error => { metricErrors.push(`metric sample failed: ${safe(error)}`) })
        .finally(() => { pendingSample = undefined })
    }, sampleMs)
    const live = sources.get(LIVE_KEY)!
    const livePane = await openSource(page, LIVE_KEY, live.bodyIds.at(-1)!, false)
    const liveInitial = await traverseBodies(page, livePane, live.bodyIds, windowReads)
    bodyChecks += live.bodyIds.length
    await write({ kind: 'body-coverage', at: now(), phase: 'initial-live', source: LIVE_KEY, ...liveInitial })
    if (liveInitial.missing.length || liveInitial.duplicate.length) failures.push(`live initial body check failed: missing=${liveInitial.missing.length}, duplicate=${liveInitial.duplicate.length}`)
    const latest = livePane.getByRole('button', { name: 'Back to bottom', exact: true })
    if (await latest.isVisible()) await latest.click()
    await expect(livePane.getByText(live.bodyIds.at(-1)!, { exact: true })).toBeInViewport()
    // Large native history: collect a bounded union through the real Load earlier control.
    const large = sources.get(LARGE_KEY)!
    const largePane = await openSource(page, LARGE_KEY, large.bodyIds.at(-1)!, true)
    await sampleBoundary(false)
    assert.ok(workloadCrossesWindow(large.projection), 'large native projection must exceed both window limits')
    const archiveTraversal = await traverseBodies(page, largePane, large.bodyIds, windowReads,
      LARGE_TURNS * 6, ARCHIVE_TRAVERSAL_MS)
    const archivePages = archiveTraversal.pages
    for (const id of archiveTraversal.union) archiveUnion.add(id)
    bodyChecks += large.bodyIds.length
    const archiveCoverage = memoryBodyCoverage(large.bodySources, large.servedRowIds, archiveUnion)
    if (archiveTraversal.duplicate.length) failures.push('duplicate large-source body in one viewport')
    if (archiveCoverage.missingPlanned.length || archiveCoverage.missingServed.length || archiveCoverage.unserved.length) {
      failures.push(`large-source viewport coverage failed: planned missing=${archiveCoverage.missingPlanned.length}, served missing=${archiveCoverage.missingServed.length}, unserved=${archiveCoverage.unserved.length}, stop=${archiveTraversal.stop}`)
    }
    const archiveProjection = projectNativeSummary(large.rows.filter(row => large.servedRowIds.has(row.id)), large.threadId)
    if (!workloadCrossesWindow(archiveProjection)) failures.push('large-source pages did not deliver enough actual projected events/UTF-8 bytes')
    await windowReads.settled()
    const archiveReceivedProjection = { projectedEvents: archiveEntrySizes.size,
      projectedUtf8Bytes: [...archiveEntrySizes.values()].reduce((total, size) => total + size, 0) }
    if (archiveReceivedProjection.projectedEvents === 0) metricErrors.push('actual Chromium window-response metrics are unavailable')
    else if (archiveReceivedProjection.projectedEvents <= 5_000 || archiveReceivedProjection.projectedUtf8Bytes <= 12 * 1024 * 1024) {
      failures.push('Chromium did not receive >5,000 unique actual window records and >12 MiB UTF-8 record JSON')
    }
    await write({ kind: 'archive', at: now(), plannedProjection: large.projection, servedProjection: archiveProjection,
      receivedProjection: archiveReceivedProjection, sourcePages: archivePages, visibleBodyUnion: archiveUnion.size,
      traversal: archiveTraversal, bodyCoverage: archiveCoverage,
      coverage: 'real public sourceHistoryWindowPage responses; planned/served source bodies and actual viewport union are checked independently before GC/close' })
    await sampleBoundary(false, 'archive-open-before-gc')
    await sampleBoundary(true, 'archive-open')
    await closePane(page, largePane)
    await expect(livePane).toHaveCount(1)
    // Warm baseline is before the formal timer; the timer starts after it.
    lastSampleAt = Date.now()
    await sampleBoundary(true, 'archive-closed-baseline')
    soakStartedAt = Date.now()
    lastSampleAt = Date.now()
    let lastLiveAt = Date.now(), lastGcAt = Date.now(), cycleIndex = 0
    while (Date.now() - soakStartedAt < durationMs) {
      const key = RING_KEYS[cycleIndex % RING_KEYS.length]!
      const source = sources.get(key)!
      let cyclingPane: Locator | undefined
      try {
        cyclingPane = await openSource(page, key, source.bodyIds.at(-1)!, true)
        const checked = await traverseBodies(page, cyclingPane, source.bodyIds, windowReads)
        bodyChecks += source.bodyIds.length
        await write({ kind: 'body-coverage', at: now(), phase: 'cycle', cycle: cycleIndex, source: key, ...checked })
        if (checked.missing.length || checked.duplicate.length) failures.push(`cycle ${cycleIndex} body check failed: missing=${checked.missing.length}, duplicate=${checked.duplicate.length}`)
        await closePane(page, cyclingPane)
        cyclingPane = undefined
        await expect(livePane).toHaveCount(1, { timeout: 20_000 })
        cycles += 1
      } catch (error) {
        failures.push(`cycle ${cycleIndex} failed: ${safe(error)}`)
        if (cyclingPane) await closePane(page, cyclingPane).catch(() => {})
      }
      cycleIndex += 1
      if (Date.now() - lastLiveAt >= liveBatchMs) {
        try {
          liveBatchCounter += 1
          const batch = nativeMemoryWorkload(live.threadId, LIVE_KEY, LIVE_BATCH_TURNS,
            TOOL_OUTPUT_CHARACTERS, liveTurn, Date.now())
          liveTurn += LIVE_BATCH_TURNS
          const projection = projectNativeSummary(batch.rows, live.threadId, 'soak-machine', 'stream')
          liveSourceRowsGenerated += projection.sourceRows
          liveSourceBytesGenerated += projection.sourceUtf8Bytes
          liveEventsGenerated += projection.projectedEvents
          liveBytesGenerated += projection.projectedUtf8Bytes
          liveToolBytesGenerated += projection.toolResultUtf8Bytes
          // Deliver and check one complete turn before the bounded renderer can
          // evict it. Every turn contributes real output; no ignored filler rows.
          for (let turn = 0; turn < LIVE_BATCH_TURNS; turn += 1) {
            const rows = batch.rows.slice(turn * 4, turn * 4 + 4)
            live.rows.push(...rows)
            if (live.rows.length > LIVE_ROW_LIMIT) { live.rows.splice(0, live.rows.length - LIVE_ROW_LIMIT); liveDrops += 1 }
            for (const row of rows) warm.environment.hapi.emit({ type: 'message-received', sessionId: live.sessionId, message: row })
            const bodies = batch.bodyIds.slice(turn * 2, turn * 2 + 2)
            await waitForBody(livePane, bodies[1]!)
            const checked = await traverseBodies(page, livePane, bodies, windowReads, 12, 10_000)
            bodyChecks += bodies.length
            if (checked.missing.length || checked.duplicate.length) failures.push(`live turn ${liveTurn - LIVE_BATCH_TURNS + turn} body coverage failed`)
            for (const body of bodies) if (!checked.missing.includes(body)) liveUnion.add(body)
            const bottom = livePane.getByRole('button', { name: 'Back to bottom', exact: true })
            if (await bottom.isVisible()) await bottom.click()
            await waitForBody(livePane, bodies[1]!)
          }
          liveBatches += 1
          await write({ kind: 'live', at: now(), batch: liveBatchCounter, projection,
            sourceRowsRetainedByFixture: live.rows.length, sourceRowLimit: LIVE_ROW_LIMIT,
            drops: liveDrops, visibleBodyUnion: liveUnion.size })
        } catch (error) { failures.push(`live batch failed: ${safe(error)}`) }
        lastLiveAt = Date.now()
      }
      // Compare plateau at the same workload phase: the cycling pane is
      // closed and the live batch has committed. All-phase samples still set
      // the absolute budget maxima, including temporary two-pane residency.
      if (Date.now() - lastGcAt >= gcSampleMs) {
        await sampleBoundary(true).catch(error => { metricErrors.push(`GC sample failed: ${safe(error)}`) })
        lastGcAt = Date.now()
      }
      await page.waitForTimeout(250)
    }
    clearInterval(sampleTimer); sampleTimer = undefined
    await pendingSample
    await sample(true)
    const elapsed = Date.now() - soakStartedAt
    const diagnostics = warm.environment.diagnostics()
    if (/heap out of memory|JavaScript heap out of memory|FATAL ERROR|OOM/iu.test(diagnostics)) failures.push('Host diagnostics contain an OOM/fatal memory marker')
    if (pageErrors.length) failures.push(`page errors: ${pageErrors.slice(0, 5).join(' | ')}`)
    if (mode === 'FORMAL' && (liveEventsGenerated < 5_000 || liveBytesGenerated < 12 * 1024 * 1024)) {
      failures.push('formal live batches did not cross 5,000 actual projected events / 12 MiB projected UTF-8 JSON')
    }
    const series = (metric: string, gcOnly = false): Array<{ elapsedMs: number; value: number | null }> =>
      history.filter(row => row.phase === 'soak' && (!gcOnly || row.gc))
        .map(row => ({ elapsedMs: row.elapsedMs, value: row[metric] ?? null }))
    const plateau: PlateauEvaluation = evaluatePlateau({
      hostRssMiB: series('hostRssMiB', true), hostHeapUsedMiB: series('hostHeapMiB', true),
      hostExternalMiB: series('hostExternalMiB', true), browserRssMiB: series('browserRssMiB', true), browserGcHeapMiB: series('browserGcHeapMiB', true),
      browserDomNodes: series('browserDomNodes', true), browserListeners: series('browserListeners', true),
      sourceWindowDomMarkers: series('sourceWindowDomMarkers', true), totalRssMiB: series('totalRssMiB', true),
    }, PLATEAU, elapsed, PLATEAU_WINDOW_MS)
    if (plateau.status === 'FAIL') failures.push(...plateau.reasons)
    const hostInspectorComplete = hostPid !== null && hostInspectors.length > 0 && hostInspectorIncomplete === 0
    const snapshot: MemorySnapshot = {
      hostRssMiB: maxima.hostRssMiB || null,
      hostHeapUsedMiB: hostInspectorComplete && maxima.hostHeapMiB ? maxima.hostHeapMiB : null,
      hostExternalMiB: hostInspectorComplete && maxima.hostExternalMiB ? maxima.hostExternalMiB : null,
      browserRssMiB: maxima.browserRssMiB || null, browserGcHeapMiB: maxima.browserGcHeapMiB || null,
      browserDomNodes: maxima.browserDomNodes || null, browserListeners: maxima.browserListeners || null,
      sourceWindowEntries: null, sourceWindowDomMarkers: maxima.sourceWindowDomMarkers || null, totalRssMiB: maxima.totalRssMiB || null,
    }
    const required = ['hostRssMiB', 'hostHeapUsedMiB', 'hostExternalMiB', 'browserRssMiB', 'browserGcHeapMiB', 'browserDomNodes',
      'browserListeners', 'sourceWindowDomMarkers', 'totalRssMiB'] as const
    const budget: BudgetEvaluation = evaluateBudgets(budgetParse, snapshot, required)
    if (budget.status !== 'FAIL' && (!hostInspectorComplete || plateau.status === 'UNVERIFIED' || missingProcessSamples > 0 || samplingGaps > 0 || metricErrors.length > 0)) {
      budget.status = 'UNVERIFIED'
      budget.reasons.push(!hostInspectorComplete
        ? 'Host Node inspector coverage is incomplete (hostPid/process coverage missing)'
        : `plateau/process/sampling coverage incomplete: plateau=${plateau.status}, missingProcessSamples=${missingProcessSamples}, samplingGaps=${samplingGaps}, metricErrors=${metricErrors.length}`)
    }
    if (budget.status === 'FAIL') failures.push(...budget.reasons)
    const status = overallStatus({ mode, durationMs: elapsed, formalMinimumMs: FORMAL_MINIMUM_MS, failures, budget })
    const summary = {
      kind: 'summary', at: now(), mode, status: status.status, statusReasons: status.reasons, elapsedMs: elapsed,
      setupMs: soakStartedAt - setupStarted, formalMinimumMs: FORMAL_MINIMUM_MS, samples, gcSamples, cycles, liveBatches,
      liveDrops, bodyChecks, archivePages, archiveUnion: archiveUnion.size, liveUnion: liveUnion.size,
      archiveReceivedProjection, archiveCoverage, archiveTraversal, metricErrors,
      liveSourceRowsGenerated, liveSourceBytesGenerated, liveEventsGenerated, liveBytesGenerated, liveToolBytesGenerated,
      processTree: lastProcesses, hostNodeProcesses: lastHostNodes, hostNodeSum: lastHostSum,
      hostInspector: { hostPid, clients: hostInspectors.length, incompleteSamples: hostInspectorIncomplete,
        complete: hostInspectorComplete }, browser: lastBrowser, ui: await uiSnapshot(page),
      plateau, plateauPhase: 'post-close/post-live-batch GC checkpoints',
      sampling: { intervalMs: sampleMs, gcIntervalMs: gcSampleMs, maxGapMs: sampleGapMax, gaps: samplingGaps,
        phases: ['archive setup', 'formal source cycling and live arrival'],
        peakStatus: 'LOWER_BOUND', synchronousPeak: 'UNVERIFIED' },
      sourceWindow: { entries: 'UNVERIFIED_NO_PUBLIC_METRIC', domMarkers: maxima.sourceWindowDomMarkers,
        budgetOwner: 'product owner (DOM marker proxy only)', requests: [...sources.values()].reduce((total, source) => total + source.history.requests.length, 0) },
      budgets: { parsed: budgetParse, evaluation: budget, maxSnapshot: snapshot },
      totalMemory: 'UNVERIFIED_SYNCHRONOUS_PEAKS_NOT_MEASURED',
      sampledResidency: status.status,
      owners: { host: 'official DSH Host', browser: 'official Chromium',
        sourceWindow: 'product owner (SourceSessions/display cache)', budget: owner },
      artifacts: { jsonl: outPath },
    }
    await write({ ...summary, kind: 'end' })
    await testInfo.attach('source-window-memory-jsonl', { path: outPath, contentType: 'application/x-ndjson' })
    await testInfo.attach('source-window-memory-summary', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' })
    testInfo.annotations.push({ type: 'memory-soak-status', description: `${status.status} mode=${mode} elapsed=${elapsed}ms plateau=${plateau.status}` })
    console.log(JSON.stringify({ status: status.status, mode, elapsedMs: elapsed, samples, gcSamples, cycles, liveBatches,
      liveUnion: liveUnion.size, archiveUnion: archiveUnion.size, plateau: plateau.status, budget: budget.status,
      failures: failures.length, outPath }))
    expect.soft(failures, 'source-window memory soak invariants').toEqual([])
    if (mode === 'FORMAL') expect.soft(status.status, 'formal memory run must not be UNVERIFIED/FAIL').toBe('PASS')
  } catch (error) {
    failures.push(`soak failed: ${safe(error)}`)
    await write({ kind: 'aborted', at: now(), error: safe(error), failures }).catch(() => {})
    throw error
  } finally {
    clearInterval(sampleTimer)
    await pendingSample
    for (const client of hostInspectors) { try { client.close() } catch { /* best effort */ } }
    try { await cdp?.detach() } catch { /* best effort */ }
    await warm?.close().catch(() => {})
    if (previousInspectorSetting === undefined) delete process.env.HAPI_DSH_MEMORY_HOST_INSPECTOR
    else process.env.HAPI_DSH_MEMORY_HOST_INSPECTOR = previousInspectorSetting
  }
})
