/** Pure helpers for the official Host source-window memory soak.
 * No browser, Host, or product code is started here. */

export type MemoryMode = 'FORMAL' | 'SMOKE'

export interface MemoryBudgets {
  owner?: string
  hostRssMiB?: number
  hostHeapUsedMiB?: number
  hostExternalMiB?: number
  browserRssMiB?: number
  browserGcHeapMiB?: number
  browserDomNodes?: number
  browserListeners?: number
  sourceWindowEntries?: number
  sourceWindowDomMarkers?: number
  totalRssMiB?: number
}

/** Explicit engineering regression limits, not historical user acceptance limits.
 * RSS covers whole process groups; DOM/listeners cover the complete CDP target. */
export const ENGINEERING_MEMORY_BUDGETS: Readonly<MemoryBudgets> = Object.freeze({
  owner: 'engineering regression baseline 2026-10-25 (full process RSS and full CDP DOM)',
  hostRssMiB: 512, hostHeapUsedMiB: 256, hostExternalMiB: 64,
  browserRssMiB: 1_024, browserGcHeapMiB: 256, browserDomNodes: 15_000,
  browserListeners: 3_000, sourceWindowDomMarkers: 100, totalRssMiB: 1_536,
})

export interface BodyMarkerSample {
  ids: string[]
  duplicate: string[]
  occurrences: number
}

/** Runs directly in Locator.evaluate, so it deliberately has no module captures.
 * Never flatten panes or tool output into a large temporary string. Mounted
 * occurrences include hidden views, previews and separate panes. Visible body
 * coverage and duplicate detection are scoped to official transcript flows. */
export function memoryBodyMarkers(root: Element | Document, visibleOnly: boolean): BodyMarkerSample {
  const document = root.ownerDocument ?? root as Document
  const view = document.defaultView!
  const ids = new Set<string>(), duplicate = new Set<string>()
  const counts = new Map<Element, Set<string>>()
  const styles = new Map<Element, CSSStyleDeclaration>()
  const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */)
  let occurrences = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue
    if (!text || text.length > 256) continue
    const id = text.trim()
    if (!/^soak-body-[a-z0-9-]+$/u.test(id)) continue
    const parent = node.parentElement
    const flow = parent?.closest('[data-chat-flow]:not([data-step-process-content])')
    if (!parent) continue
    if (visibleOnly) {
      if (!flow || !root.contains(flow)) continue
      const port = parent.closest('[data-conversation-scroll]')
      if (!parent.isConnected || !port) continue
      const box = port.getBoundingClientRect()
      let left = Math.max(0, box.left + port.clientLeft), top = Math.max(0, box.top + port.clientTop)
      let right = Math.min(view.innerWidth, box.left + port.clientLeft + port.clientWidth)
      let bottom = Math.min(view.innerHeight, box.top + port.clientTop + port.clientHeight)
      let hidden = false
      for (let ancestor: Element | null = parent; ancestor; ancestor = ancestor.parentElement) {
        let style = styles.get(ancestor)
        if (!style) { style = view.getComputedStyle(ancestor); styles.set(ancestor, style) }
        if (ancestor.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden'
          || style.visibility === 'collapse' || style.opacity === '0') { hidden = true; break }
        if (/(hidden|clip|scroll|auto)/u.test(`${style.overflowX} ${style.overflowY}`)) {
          const clip = ancestor.getBoundingClientRect()
          if (/(hidden|clip|scroll|auto)/u.test(style.overflowX)) {
            left = Math.max(left, clip.left + ancestor.clientLeft)
            right = Math.min(right, clip.left + ancestor.clientLeft + ancestor.clientWidth)
          }
          if (/(hidden|clip|scroll|auto)/u.test(style.overflowY)) {
            top = Math.max(top, clip.top + ancestor.clientTop)
            bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight)
          }
        }
      }
      if (hidden || right <= left || bottom <= top) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const visible = [...range.getClientRects()].some(rect => {
        const x1 = Math.max(left, rect.left), x2 = Math.min(right, rect.right)
        const y1 = Math.max(top, rect.top), y2 = Math.min(bottom, rect.bottom)
        if (x2 <= x1 || y2 <= y1) return false
        const hit = document.elementFromPoint((x1 + x2) / 2, (y1 + y2) / 2)
        return hit !== null && parent.contains(hit)
      })
      if (!visible) continue
    }
    if (flow) {
      let seen = counts.get(flow)
      if (!seen) { seen = new Set(); counts.set(flow, seen) }
      if (seen.has(id)) duplicate.add(id)
      seen.add(id)
    }
    ids.add(id)
    occurrences += 1
  }
  return { ids: [...ids], duplicate: [...duplicate], occurrences }
}

export interface BodySource { sourceId: string; bodyId: string }

/** Fetch coverage and actual viewport coverage are independent requirements. */
export function memoryBodyCoverage(plan: readonly BodySource[], servedRows: ReadonlySet<string>, visibleIds: ReadonlySet<string>): {
  planned: number; served: number; visible: number; missingPlanned: string[]; missingServed: string[]; unserved: string[]
} {
  const served = plan.filter(body => servedRows.has(body.sourceId))
  return { planned: plan.length, served: served.length,
    visible: plan.filter(body => visibleIds.has(body.bodyId)).length,
    missingPlanned: plan.filter(body => !visibleIds.has(body.bodyId)).map(body => body.bodyId),
    missingServed: served.filter(body => !visibleIds.has(body.bodyId)).map(body => body.bodyId),
    unserved: plan.filter(body => !servedRows.has(body.sourceId)).map(body => body.bodyId) }
}

export interface BudgetParse {
  declared: boolean
  owner?: string
  values: MemoryBudgets
  error?: string
}

export type BudgetMetric = keyof Omit<MemoryBudgets, 'owner'>
export type BudgetStatus = 'PASS' | 'FAIL' | 'UNVERIFIED'
export interface BudgetCheck {
  metric: keyof Omit<MemoryBudgets, 'owner'>
  budget: number
  value: number | null
  status: 'PASS' | 'FAIL' | 'UNVERIFIED'
}
export interface BudgetEvaluation {
  status: BudgetStatus
  checks: BudgetCheck[]
  exceeded: string[]
  unverified: string[]
  reasons: string[]
}

export interface MemorySnapshot {
  hostRssMiB: number | null
  hostHeapUsedMiB: number | null
  hostExternalMiB: number | null
  browserRssMiB: number | null
  browserGcHeapMiB: number | null
  browserDomNodes: number | null
  browserListeners: number | null
  sourceWindowEntries: number | null
  sourceWindowDomMarkers: number | null
  totalRssMiB: number | null
}

export function toMiB(bytes: number): number {
  return +(bytes / (1024 * 1024)).toFixed(2)
}

/** Parse a JSON budget object. Missing/invalid budgets are explicitly unverified,
 * never replaced by an invented default. */
export function parseMemoryBudgets(raw: string | undefined): BudgetParse {
  if (!raw) return { declared: false, values: {}, error: 'HAPI_DSH_MEMORY_BUDGETS is not set' }
  let value: unknown
  try { value = JSON.parse(raw) } catch (error) {
    return { declared: false, values: {}, error: `HAPI_DSH_MEMORY_BUDGETS is not valid JSON: ${String(error)}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { declared: false, values: {}, error: 'HAPI_DSH_MEMORY_BUDGETS must be an object' }
  }
  const row = value as Record<string, unknown>
  const owner = typeof row.owner === 'string' ? row.owner.trim() : ''
  const keys: BudgetMetric[] = ['hostRssMiB', 'hostHeapUsedMiB', 'hostExternalMiB',
    'browserRssMiB', 'browserGcHeapMiB', 'browserDomNodes', 'browserListeners', 'sourceWindowEntries', 'sourceWindowDomMarkers', 'totalRssMiB']
  const values: MemoryBudgets = {}
  for (const key of keys) {
    const candidate = row[key]
    if (candidate === undefined) continue
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
      return { declared: false, values: {}, error: `HAPI_DSH_MEMORY_BUDGETS.${key} must be a nonnegative finite number` }
    }
    values[key] = candidate
  }
  if (!owner) return { declared: false, values, error: 'HAPI_DSH_MEMORY_BUDGETS.owner is required' }
  return { declared: true, owner, values }
}

/** Compare only supplied budgets. Missing metrics remain UNVERIFIED; a PASS here
 * does not by itself mean total memory is within a budget. */
export function evaluateBudgets(parse: BudgetParse, snapshot: MemorySnapshot,
  required: readonly BudgetMetric[] = []): BudgetEvaluation {
  if (!parse.declared) {
    return { status: 'UNVERIFIED', checks: [], exceeded: [], unverified: [parse.error ?? 'budgets are not declared'],
      reasons: ['budget owner/platform is missing'] }
  }
  const keys: BudgetMetric[] = ['hostRssMiB', 'hostHeapUsedMiB', 'hostExternalMiB',
    'browserRssMiB', 'browserGcHeapMiB', 'browserDomNodes', 'browserListeners', 'sourceWindowEntries', 'sourceWindowDomMarkers', 'totalRssMiB']
  const checks: BudgetCheck[] = []
  const exceeded: string[] = []
  const unverified: string[] = []
  for (const metric of keys) {
    const budget = parse.values[metric]
    if (budget === undefined) continue
    const value = snapshot[metric]
    if (value === null) {
      const check: BudgetCheck = { metric, budget, value, status: 'UNVERIFIED' }
      checks.push(check); unverified.push(`${metric} has a budget but no obtainable metric`)
      continue
    }
    const status = value <= budget ? 'PASS' : 'FAIL'
    checks.push({ metric, budget, value, status })
    if (status === 'FAIL') exceeded.push(`${metric}=${value} > ${budget}`)
  }
  for (const metric of required) {
    if (parse.values[metric] === undefined) unverified.push(`${metric} budget is required but missing`)
  }
  if (unverified.length === 0 && checks.length === 0) unverified.push('no comparison budgets were supplied')
  const status: BudgetStatus = exceeded.length > 0 ? 'FAIL' : unverified.length > 0 ? 'UNVERIFIED' : 'PASS'
  return { status, checks, exceeded, unverified,
    reasons: status === 'FAIL' ? exceeded : status === 'UNVERIFIED' ? unverified : [] }
}

export function overallStatus(input: {
  mode: MemoryMode
  durationMs: number
  formalMinimumMs: number
  failures: readonly string[]
  budget: BudgetEvaluation
}): { status: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'SMOKE'; reasons: string[] } {
  if (input.failures.length > 0 || input.budget.status === 'FAIL') {
    return { status: 'FAIL', reasons: [...input.failures, ...input.budget.reasons] }
  }
  if (input.mode === 'SMOKE') return { status: 'SMOKE', reasons: ['SMOKE run is not formal acceptance'] }
  if (input.durationMs < input.formalMinimumMs) {
    return { status: 'UNVERIFIED', reasons: [`duration ${input.durationMs}ms is below the required ${input.formalMinimumMs}ms formal window`] }
  }
  if (input.budget.status === 'UNVERIFIED') return { status: 'UNVERIFIED', reasons: input.budget.reasons }
  return { status: 'PASS', reasons: [] }
}

/** Parse the ppid/comm fields from `/proc/<pid>/stat` without treating the
 * command name's spaces or parentheses as fields. */
export function parseProcStatLine(line: string): { pid: number; ppid: number; comm: string } | null {
  const open = line.indexOf('('), close = line.lastIndexOf(')')
  if (open < 0 || close <= open) return null
  const pid = Number(line.slice(0, open).trim())
  const fields = line.slice(close + 2).trim().split(/\s+/)
  const ppid = Number(fields[1])
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null
  return { pid, ppid, comm: line.slice(open + 1, close) }
}

export function classifyProcess(comm: string, cmdline: string): 'browser' | 'hostRunner' {
  return /chrom|chrome|headless_shell/i.test(`${comm} ${cmdline}`) ? 'browser' : 'hostRunner'
}

export type PlateauMetric = Exclude<BudgetMetric, 'sourceWindowEntries'>
export type PlateauThresholds = Record<PlateauMetric, number>
export interface PlateauCheck {
  metric: PlateauMetric
  threshold: number
  delta: number | null
  sampleCount: number
  status: 'PASS' | 'FAIL' | 'UNVERIFIED'
}
export interface PlateauEvaluation {
  status: 'PASS' | 'FAIL' | 'UNVERIFIED'
  checks: PlateauCheck[]
  exceeded: string[]
  unverified: string[]
  reasons: string[]
}

/** Last-window range (max-min) for each metric. This measures plateau stability,
 * not absolute residency; it never demands that the window retain everything. */
export function evaluatePlateau(
  metrics: Partial<Record<PlateauMetric, readonly { elapsedMs: number; value: number | null }[]>>,
  thresholds: PlateauThresholds,
  lastElapsedMs: number,
  windowMs: number,
  maximumGapMs = 90_000,
): PlateauEvaluation {
  const checks: PlateauCheck[] = []
  const exceeded: string[] = []
  const unverified: string[] = []
  for (const metric of Object.keys(thresholds) as PlateauMetric[]) {
    const series = (metrics[metric] ?? []).filter(point => point.elapsedMs >= lastElapsedMs - windowMs
      && point.elapsedMs <= lastElapsedMs && point.value !== null && Number.isFinite(point.value))
      .sort((left, right) => left.elapsedMs - right.elapsedMs)
    const values = series.map(point => point.value as number)
    const sampleCount = values.length
    const boundaries = [lastElapsedMs - windowMs, ...series.map(point => point.elapsedMs), lastElapsedMs]
    const gaps = boundaries.slice(1).map((value, index) => value - boundaries[index]!)
    if (lastElapsedMs < windowMs || sampleCount < 4 || gaps.some(gap => gap > maximumGapMs)) {
      checks.push({ metric, threshold: thresholds[metric], delta: null, sampleCount, status: 'UNVERIFIED' })
      unverified.push(`${metric} does not cover the plateau window with at least four samples and gaps <=${maximumGapMs}ms`)
      continue
    }
    const delta = +(Math.max(...values) - Math.min(...values)).toFixed(2)
    const status = delta <= thresholds[metric] ? 'PASS' : 'FAIL'
    checks.push({ metric, threshold: thresholds[metric], delta, sampleCount, status })
    if (status === 'FAIL') exceeded.push(`${metric} last-window range ${delta} > ${thresholds[metric]}`)
  }
  const status: PlateauEvaluation['status'] = exceeded.length > 0 ? 'FAIL' : unverified.length > 0 ? 'UNVERIFIED' : 'PASS'
  return { status, checks, exceeded, unverified,
    reasons: status === 'FAIL' ? exceeded : status === 'UNVERIFIED' ? unverified : [] }
}

/** Preflight the real NativeProjector for planned synthetic rows. This counts
 * projected Session events and their JSON UTF-8 bytes, not input source rows. */
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseNativeRow, type NativeBinding } from '../../src/codex/native.ts'
import { NativeProjector } from '../../src/codex/projector.ts'
import type { HapiMessage } from '../../src/codex/contracts.ts'

export interface ProjectionSummary {
  sourceRows: number
  sourceUtf8Bytes: number
  projectedEvents: number
  projectedUtf8Bytes: number
  bodyEvents: number
  toolResultEvents: number
  toolResultUtf8Bytes: number
}

let projectionSequence = 0
export function projectNativeSummary(rows: readonly HapiMessage[], threadId: string, machineId = 'soak-machine', delivery: 'page' | 'stream' = 'page'): ProjectionSummary {
  const binding: NativeBinding = { hubId: 'soak-hub', hapiSessionId: `soak-source-${++projectionSequence}`,
    threadId, home: null, homeId: null, machineId }
  const id = SessionId(`soak-projection-${projectionSequence}`)
  const projector = new NativeProjector(Session.create(id), {
    model: () => 'synthetic-model', provider: () => 'synthetic-provider', submittedMessage: () => undefined, stream: () => {},
  })
  projector.beginHistorySeed()
  const parsed = rows.flatMap(row => { const value = parseNativeRow(row, binding); return value ? [value] : [] })
  if (delivery === 'stream') for (const row of parsed) projector.apply([row])
  else projector.apply(parsed)
  const session = Session.create(id, projector.historySeed())
  projector.finishHistorySeed(session)
  const events = session.snapshotEvents()
  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
  const toolResults = events.filter(event => event.type === 'tool/result')
  return { sourceRows: rows.length, sourceUtf8Bytes: rows.reduce((total, row) => total + bytes(row), 0),
    projectedEvents: events.length, projectedUtf8Bytes: events.reduce((total, event) => total + bytes(event), 0),
    bodyEvents: events.filter(event => event.type === 'user/message' || event.type === 'assistant/message').length,
    toolResultEvents: toolResults.length,
    toolResultUtf8Bytes: toolResults.reduce((total, event) => total + bytes(event.data.message.content), 0) }
}

/** Durable source items use their native ID as localId. Only the final row
 * ends the turn, so the same fixture is valid as a page and as individual SSE
 * arrivals. The large payload is actual tool output, including non-ASCII text. */
export function nativeMemoryWorkload(threadId: string, key: string, turns: number, outputCharacters: number,
  firstTurn = 0, startAt = 1_760_000_000_000): { rows: HapiMessage[]; bodyIds: string[]; bodySources: BodySource[] } {
  const rows: HapiMessage[] = [], bodyIds: string[] = [], bodySources: BodySource[] = []
  for (let offset = 0; offset < turns; offset += 1) {
    const turn = firstTurn + offset, turnId = `${key}-turn-${turn}`, at = startAt + offset * 10
    const user = `soak-body-${key}-${turn}-user`, answer = `soak-body-${key}-${turn}-agent`
    bodyIds.push(user, answer)
    const append = (ordinal: number, itemId: string, role: 'user' | 'agent', content: unknown): void => {
      const id = `codex:${threadId}:${turnId}:${itemId}:${ordinal}`
      const execution = { threadId, turnId, itemId, turn: {
        status: ordinal === 3 ? 'completed' : 'inProgress', started: true, ended: ordinal === 3,
      } }
      const body = role === 'user' ? content : { type: 'codex', data: { ...(content as object), id, nativeExecution: execution } }
      rows.push({ id, localId: id, seq: turn * 4 + ordinal + 1, createdAt: at + ordinal, invokedAt: at + ordinal,
        content: { role, content: body, meta: { sentFrom: 'cli', nativeExecution: execution } } })
      if (ordinal === 0 || ordinal === 3) bodySources.push({ sourceId: id, bodyId: ordinal === 0 ? user : answer })
    }
    append(0, 'input', 'user', { type: 'text', text: user })
    append(1, 'tool', 'agent', { type: 'tool-call', callId: `${turnId}-tool`, name: 'read_file', input: { path: `synthetic-${turn}.txt` } })
    append(2, 'tool', 'agent', { type: 'tool-call-result', callId: `${turnId}-tool`, output: '数'.repeat(outputCharacters) })
    append(3, 'answer', 'agent', { type: 'message', message: answer, streamSnapshot: true })
  }
  return { rows, bodyIds, bodySources }
}

export function workloadCrossesWindow(summary: ProjectionSummary): boolean {
  return summary.projectedEvents > 5_000 && summary.projectedUtf8Bytes > 12 * 1024 * 1024
}

/** Accumulate the actual public window records received by Chromium. Source
 * identity plus event kind/ordinal avoids counting overlapping pages twice;
 * remapped display seq values are deliberately not treated as new content. */
export function accumulateWindowEntries(entries: readonly unknown[], threadId: string, sizes: Map<string, number>): void {
  const ordinals = new Map<string, number>()
  for (const candidate of entries) {
    const entry = candidate as { source?: { messageId?: string }; event?: { type?: string } }
    const sourceId = entry.source?.messageId, type = entry.event?.type
    if (!sourceId?.startsWith(`codex:${threadId}:`) || !type) continue
    const group = `${sourceId}/${type}`
    const ordinal = ordinals.get(group) ?? 0
    ordinals.set(group, ordinal + 1)
    const key = `${group}/${ordinal}`
    if (!sizes.has(key)) sizes.set(key, Buffer.byteLength(JSON.stringify(entry), 'utf8'))
  }
}

/** Register at request dispatch, before headers or the JSON body arrive. A
 * response-only listener cannot account for an outstanding request yet. */
export class WindowReadBarrier {
  private readonly pending = new Set<Promise<void>>()

  track(read: Promise<void>): void {
    this.pending.add(read)
    void read.then(() => this.pending.delete(read), () => this.pending.delete(read))
  }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }
}

/** A failed RPC is not an empty successful page, even when HTTP returned 200. */
export function sourceWindowResponseRecords(value: unknown): readonly unknown[] {
  const response = value as { result?: { ok?: boolean; value?: { records?: unknown }; error?: { code?: string } } } | null
  if (response?.result?.ok !== true) {
    throw new Error(`sourceHistoryWindowPage failed: ${response?.result?.error?.code ?? 'invalid RPC result'}`)
  }
  if (!Array.isArray(response.result.value?.records)) throw new Error('sourceHistoryWindowPage records are missing')
  return response.result.value.records
}
