import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

/** Measured by a visible official Chat occurrence, including rendered payload dependencies. */
export interface SourceWindowViewport {
  firstSeq: number
  lastSeq: number
  followingTail: boolean
  /** Additional measured outer rows needed to retain a full readable viewport. */
  overscan?: { firstSeq: number; lastSeq: number }
}
export interface SourcePosition { messageId: string; at: number; seq: number }
export interface SourceGroup { key: string; start: number; end: number; source: SourcePosition | undefined; content: boolean }
export interface SourceWindowPin {
  first: string
  last: string
  /** Source/content groups only; log-only control frames consume no reading area. */
  visibleGroups: number
  followingTail: boolean
  unknownGeometry?: boolean
  requestedPage?: boolean
}
/** Keep the received bounded page until layout can measure its rendered rows.
 * A long folded tool interval can place readable text far from its near edge. */
export function protectSourcePage(records: readonly SessionEventLikeEntry[], pins: readonly SourceWindowPin[]): SourceWindowPin[] {
  if (!pins.length) return []
  const groups = sourceGroups(records)
  if (!groups.length) return [...pins]
  return [...pins, { first: groups[0]!.key, last: groups.at(-1)!.key,
    visibleGroups: groups.filter(group => group.content).length, followingTail: false, requestedPage: true }]
}

type Data = Record<string, unknown>
// These records feed projections or bracket existing content. Their arrival
// updates status without introducing another rendered message. Unknown plugin
// records remain content-capable, so extensions are never silently discarded.
const CONTROL_RECORDS = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'request/header', 'request/context', 'session/end-seed',
  'session/title', 'model/selection', 'permission/preset', 'sandbox/mode', 'approval/policy',
  // Official Chat's inbox contexts publish "none"; the later user/message
  // creates the human-readable node. Keep the splice for classification.
  'agent/inbox/spliced',
  'plugin:hapi-dsh/state', 'plugin:hapi-dsh/status', 'plugin:hapi-dsh/session-state',
  'plugin:hapi-dsh/execution', 'plugin:hapi-dsh/notices', 'plugin:hapi-dsh/native-item',
  'plugin:hapi-dsh-observed/state', 'plugin:hapi-dsh-observed/status', 'plugin:hapi-dsh-observed/notices',
  'plugin:hapi-dsh-observed/item',
])
function position(entry: SessionEventLikeEntry): SourcePosition | undefined {
  const direct = (entry as unknown as { source?: SourcePosition }).source
  if (direct) return direct
  const type = String(entry.event.type), data = (entry.event.data ?? {}) as Data
  if (type !== 'plugin:hapi-dsh/native-item' && type !== 'plugin:hapi-dsh-observed/item') return undefined
  const messageId = typeof data.sourceMessageId === 'string' ? data.sourceMessageId : data.sourceRowId
  return typeof messageId === 'string' && typeof data.sourceAt === 'number' && typeof data.sourceSeq === 'number'
    ? { messageId, at: data.sourceAt, seq: data.sourceSeq } : undefined
}

/** Keep a projected source row intact, including its surrounding lifecycle
 * events. Clipped boundaries remain partial; no lifecycle events are invented. */
export function sourceGroups(entries: readonly SessionEventLikeEntry[]): SourceGroup[] {
  const surfaces = new Map<number, SourcePosition>()
  for (const entry of entries) {
    const source = position(entry), data = (entry.event.data ?? {}) as Data
    if (source && typeof data.surfaceSeq === 'number') surfaces.set(data.surfaceSeq, source)
  }
  const positions = entries.map(row => {
    const data = (row.event.data ?? {}) as Data
    return position(row) ?? surfaces.get(Number(row.event.seq))
      ?? (typeof data.surfaceSeq === 'number' ? surfaces.get(data.surfaceSeq) : undefined)
  })
  // A native tool-call source row emits assistant/message + tool/call before
  // its identity annotation. surfaceSeq names the assistant, while the public
  // tool-call ID identifies the sibling event that must survive the same trim.
  const calls = new Map<string, SourcePosition>()
  const callKey = (data: Data, id: string): string => `${data.turn}:${data.step}:${id}`
  for (let index = 0; index < entries.length; index++) {
    if (entries[index]!.event.type !== 'assistant/message' || !positions[index]) continue
    const data = (entries[index]!.event.data ?? {}) as Data
    const message = data.message as { content?: unknown } | undefined
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool-call' && typeof block.id === 'string') calls.set(callKey(data, block.id), positions[index]!)
    }
  }
  for (let index = 0; index < entries.length; index++) {
    if (positions[index] || entries[index]!.event.type !== 'tool/call') continue
    const data = (entries[index]!.event.data ?? {}) as Data
    if (typeof data.callId === 'string') positions[index] = calls.get(callKey(data, data.callId))
  }
  // Start boundaries belong to the following source row; end boundaries to
  // the preceding one. Other unannotated events remain independent units.
  let next: SourcePosition | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    next = positions[index] ?? next
    if (!positions[index] && /^(turn|step)\/start$/.test(String(entries[index]!.event.type))) positions[index] = next
  }
  let previous: SourcePosition | undefined
  for (let index = 0; index < entries.length; index++) {
    if (!positions[index] && /^(turn|step)\/end$/.test(String(entries[index]!.event.type))) positions[index] = previous
    previous = positions[index] ?? previous
  }
  // A status frame can arrive between a body and its trailing annotation.
  // Bridge only source-less control records bracketed by that same source;
  // unrelated content and distinct source rows remain separate.
  const nextSources: Array<SourcePosition | undefined> = new Array(entries.length)
  next = undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    next = positions[index] ?? next
    nextSources[index] = next
  }
  previous = undefined
  for (let index = 0; index < entries.length; index++) {
    if (!positions[index] && previous && nextSources[index]?.messageId === previous.messageId
      && CONTROL_RECORDS.has(String(entries[index]!.event.type))) positions[index] = previous
    previous = positions[index] ?? previous
  }
  const groups: SourceGroup[] = []
  for (let index = 0; index < entries.length; index++) {
    const source = positions[index], key = source?.messageId ?? `event:${entries[index]!.event.seq}`
    const content = !CONTROL_RECORDS.has(String(entries[index]!.event.type))
    const last = groups.at(-1)
    if (last?.key === key) { last.end = index + 1; last.content ||= content }
    else groups.push({ key, source, start: index, end: index + 1, content })
  }
  return groups
}

export function pinSourceViewport(entries: readonly SessionEventLikeEntry[], view: SourceWindowViewport): SourceWindowPin | undefined {
  const groups = sourceGroups(entries)
  const indexOf = (seq: number) => {
    const row = entries.findIndex(entry => Number(entry.event.seq) === seq)
    return groups.findIndex(group => group.start <= row && row < group.end)
  }
  const first = indexOf(Math.min(view.firstSeq, view.lastSeq)), last = indexOf(Math.max(view.firstSeq, view.lastSeq))
  if (first < 0 || last < 0) return undefined
  return { first: groups[first]!.key, last: groups[last]!.key,
    visibleGroups: groups.slice(first, last + 1).filter(group => group.content).length, followingTail: view.followingTail }
}

export interface SourceRetentionPlan {
  first: number
  last: number
  groups: readonly SourceGroup[]
  /** False means the protected visible range itself exceeds a retained ceiling. */
  fits: boolean
  oversizedRow: boolean
}

/** Retain the continuous received window until its safety budget is exhausted.
 * Only then release source groups opposite the reading direction, keeping all
 * measured readers. DOM locality must not delete the conversation being read. */
export function sourceRetentionPlan(entries: readonly SessionEventLikeEntry[], pins: readonly SourceWindowPin[],
  direction: 'older' | 'newer', budget: { events: number; bytes: number; groups?: number; size(entry: SessionEventLikeEntry): number }): SourceRetentionPlan {
  const groups = sourceGroups(entries)
  if (!groups.length) return { first: 0, last: 0, groups, fits: true, oversizedRow: false }
  const contentGroups = groups.map(group => group.content)
  const sums = [0]
  for (const row of entries) sums.push(sums.at(-1)! + budget.size(row))
  const costFits = (first: number, last: number) => {
    const start = groups[first]!.start, end = groups[last]!.end
    return contentGroups.slice(first, last + 1).filter(Boolean).length <= (budget.groups ?? Number.POSITIVE_INFINITY)
      && end - start <= budget.events && sums[end]! - sums[start]! <= budget.bytes
  }
  const content = groups.flatMap((group, index) => group.content ? [index] : [])
  // A visible pane whose geometry is unknown may still be following live
  // output. Keep live arrivals until its geometry is measurable. Explicit
  // paging is different: preserve the previously captured interval plus the
  // bounded requested page. Its readable span is not known until it renders.
  if (pins.some(pin => pin.unknownGeometry) && !pins.some(pin => pin.requestedPage)) {
    const fits = costFits(0, groups.length - 1)
    return { first: 0, last: entries.length, groups, fits: fits || groups.length === 1,
      oversizedRow: !fits && groups.length === 1 }
  }
  const ranges = pins.map(pin => {
    const first = groups.findIndex(group => group.key === pin.first)
    const last = groups.findLastIndex(group => group.key === pin.last)
    if (first < 0 || last < first) return undefined
    if (pin.followingTail && pin.visibleGroups > 0 && content.length) {
      return { first: content[Math.max(0, content.length - pin.visibleGroups)]!, last: groups.length - 1 }
    }
    return { first, last }
  })
  if (pins.length && ranges.some(range => range === undefined)) {
    // A missing captured boundary does not prove that its reader moved. Let
    // the caller preserve the current window instead of guessing which side
    // may be discarded from the proposed replacement.
    return { first: 0, last: entries.length, groups, fits: false, oversizedRow: false }
  }
  if (costFits(0, groups.length - 1)) {
    return { first: 0, last: entries.length, groups, fits: true, oversizedRow: false }
  }
  if (pins.length) {
    const firstPin = Math.min(...ranges.map(range => range!.first)), lastPin = Math.max(...ranges.map(range => range!.last))
    if (!costFits(firstPin, lastPin)) {
      return { first: groups[firstPin]!.start, last: groups[lastPin]!.end, groups,
        fits: firstPin === lastPin, oversizedRow: firstPin === lastPin }
    }
    let first = 0, last = groups.length - 1
    while (!costFits(first, last) && (first < firstPin || last > lastPin)) {
      if (direction === 'older' ? last > lastPin : first === firstPin) last--
      else first++
    }
    return { first: groups[first]!.start, last: groups[last]!.end, groups, fits: true, oversizedRow: false }
  }
  // Until geometry is known, preserve the existing safety-window semantics.
  let first = direction === 'older' ? 0 : groups.length - 1, last = first
  while (direction === 'older' ? last + 1 < groups.length : first > 0) {
    const nextFirst = direction === 'older' ? first : first - 1, nextLast = direction === 'older' ? last + 1 : last
    if (!costFits(nextFirst, nextLast)) break
    first = nextFirst; last = nextLast
  }
  return { first: groups[first]!.start, last: groups[last]!.end, groups, fits: true, oversizedRow: !costFits(first, last) }
}
