import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceFrame, SourceFrameBatch, SourceFramePosition } from '../shared/source-frames.ts'
import { orderSourceWindow } from './source-event-order.ts'

type Data = Record<string, unknown>
type ProjectionCache = {
  frame: SourceFrame
  seq: number
  turn: number | undefined
  step: number | undefined
  references: readonly (number | undefined)[]
  entry: SessionEventLikeEntry
}
type ResidentFrame = { frame: SourceFrame; seq: number; turn: number | undefined; step: number | undefined;
  projection?: ProjectionCache | undefined }
const COORDINATE_BASE = 1_000_000_000
// Keep ample integer space between event rows: history pages can insert many
// source events inside a single existing turn/step without renumbering the
// resident window. Center the range so older prepends have room too.
// Start well inside Number's exact-integer range, with enough room on both
// sides for millions of resident rows at the page-insertion stride below.
const SEQUENCE_BASE = 4_000_000_000_000_000
const STRIDE = 1_024
const EVENT_SEQUENCE_STRIDE = 1_000_000_000
// Session-control rows are not part of the source transcript. Keep their
// event coordinates in a small fixed range so historical transcript prefixes
// can grow without consuming the shrinking gap in front of the first message.
const TRANSPORT_SEQUENCE = new Map([
  ['plugin:hapi-dsh/state', 1], ['plugin:hapi-dsh/status', 2], ['plugin:hapi-dsh/session-state', 3],
  ['plugin:hapi-dsh/execution', 4], ['plugin:hapi-dsh/notices', 5],
  ['plugin:hapi-dsh-observed/state', 6], ['plugin:hapi-dsh-observed/status', 7],
  ['plugin:hapi-dsh-observed/session-state', 8], ['plugin:hapi-dsh-observed/execution', 9],
  ['plugin:hapi-dsh-observed/notices', 10],
])

const dataOf = (frame: SourceFrame): Data => (frame.event.data ?? {}) as Data
const sourceOrder = (left: SourceFramePosition, right: SourceFramePosition): number => left.at - right.at || left.seq - right.seq
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>, rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord), rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(rightRecord, key)
    && sameValue(leftRecord[key], rightRecord[key]))
}
function sameRecordExcept(left: Data, right: Data, ignored: ReadonlySet<string>): boolean {
  const leftKeys = Object.keys(left).filter(key => !ignored.has(key))
  const rightKeys = Object.keys(right).filter(key => !ignored.has(key))
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key)
    && sameValue(left[key], right[key]))
}
export function sameSourceFrame(left: SourceFrame, right: SourceFrame): boolean {
  if (left === right) return true
  if (left.key !== right.key || left.transient !== right.transient
    || left.contentRevision !== right.contentRevision
    || left.event.type !== right.event.type || left.event.time !== right.event.time
    || !sameValue(left.source, right.source)) return false
  const viewCoordinates = new Set(['turn', 'step', 'displayTurn', 'displayStep', 'surfaceSeq'])
  if (!sameRecordExcept(dataOf(left), dataOf(right), viewCoordinates)) return false
  const leftOperation = (left.event as unknown as Data).surfaceOp as Data | undefined
  const rightOperation = (right.event as unknown as Data).surfaceOp as Data | undefined
  return sameRecordExcept(leftOperation ?? {}, rightOperation ?? {}, new Set(['startSeq', 'endSeq']))
}

/** Allocate view coordinates without changing surviving identities when a page
 * is prepended. The exceptional dense insertion is one projection replacement. */
type CoordinateTrace = typeof globalThis & { __hapiDshCoordinateRebaseTrace?:
  (name: string, reason: string, index: number, previous: number | null, next: number | null, value: number) => void }
function coordinates(keys: readonly string[], retained: ReadonlyMap<string, number>, base: number,
  stride = STRIDE, name = 'view'): Map<string, number> {
  const result = new Map<string, number>()
  let previous: number | undefined
  let nextIndex = 0
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!, old = retained.get(key)
    if (old !== undefined && (previous === undefined || old > previous)) {
      result.set(key, old); previous = old; continue
    }
    nextIndex = Math.max(nextIndex, index + 1)
    while (nextIndex < keys.length && retained.get(keys[nextIndex]!) === undefined) nextIndex++
    const next = nextIndex < keys.length ? retained.get(keys[nextIndex]!) : undefined
    const value = previous === undefined ? next === undefined ? base : next - (nextIndex - index) * stride
      : next === undefined ? previous + stride : previous + Math.floor((next - previous) / (nextIndex - index + 1))
    if (value < 0 || (previous !== undefined && value <= previous) || (next !== undefined && value >= next)) {
      try {
        const reason = value < 0 ? 'negative' : previous !== undefined && value <= previous ? 'prior-order' : 'next-order'
        ;(globalThis as CoordinateTrace).__hapiDshCoordinateRebaseTrace?.(name, reason, index, previous ?? null, next ?? null, value)
      } catch { /* diagnostics are optional */ }
      return new Map(keys.map((item, offset) => [item, base + offset * stride]))
    }
    result.set(key, value); previous = value
  }
  return result
}

/** One bounded source-owned window. Official events are a read-only projection;
 * no original-stream coordinate table or second live-tail window is retained. */
export class SourceWindowStore {
  private rows: ResidentFrame[] = []
  private projected: readonly SessionEventLikeEntry[] = []

  /** Request-local projection with the same resident coordinates. Page admission
   * must evaluate the exact merge the reader will receive. */
  fork(): SourceWindowStore {
    const copy = new SourceWindowStore()
    copy.rows = this.rows.map(row => ({ ...row }))
    copy.projected = this.projected
    return copy
  }

  get entries(): readonly SessionEventLikeEntry[] { return this.projected }
  get frames(): readonly SourceFrame[] { return this.rows.map(row => row.frame) }
  has(key: string): boolean { return this.rows.some(row => row.frame.key === key) }
  hasSource(messageId: string): boolean { return this.rows.some(row => row.frame.source?.messageId === messageId) }
  sourceForSeq(seq: number): SourceFramePosition | undefined { return this.rows.find(row => row.seq === seq)?.frame.source }

  apply(batch: SourceFrameBatch, existingOnly = false): void {
    const prior = new Map(this.rows.map(row => [row.frame.key, row]))
    const incoming = existingOnly ? batch.frames.filter(frame => prior.has(frame.key) || !frame.source) : batch.frames
    const removed = new Set(batch.replaceSources ?? [])
    const removedKeys = new Set(batch.removeKeys ?? [])
    const keys = new Set(incoming.map(frame => frame.key))
    const rows = batch.kind === 'replace' && !existingOnly ? [] : this.rows.filter(row =>
      !removedKeys.has(row.frame.key) && (!removed.has(row.frame.source?.messageId ?? '') || keys.has(row.frame.key)))
    const byKey = new Map(rows.map(row => [row.frame.key, row]))
    for (const frame of incoming) {
      const old = byKey.get(frame.key) ?? prior.get(frame.key)
      if (old && (frame.contentRevision ?? 0) < (old.frame.contentRevision ?? 0)) {
        if (!byKey.has(frame.key)) byKey.set(frame.key, old)
        continue
      }
      // Page responses and live frames share the original source position.
      // A late older revision cannot overwrite a newer resident item.
      if (!batch.reset && old && ((!old.frame.transient && frame.transient)
        || old.frame.source && frame.source && !old.frame.transient && sourceOrder(frame.source, old.frame.source) < 0)) {
        if (!byKey.has(frame.key)) byKey.set(frame.key, old)
        continue
      }
      if (!batch.reset && old && sameSourceFrame(old.frame, frame)) {
        if (!byKey.has(frame.key)) byKey.set(frame.key, old)
        continue
      }
      const row: ResidentFrame = { frame, seq: old?.seq ?? -1, turn: old?.turn, step: old?.step, projection: old?.projection }
      byKey.set(frame.key, row)
    }
    this.rows = [...byKey.values()]
    this.project()
  }

  /** Retention removes canonical rows, not just their displayed projection. */
  retain(entries: readonly SessionEventLikeEntry[]): void {
    const keep = new Set(entries.map(entry => Number(entry.event.seq)))
    this.rows = this.rows.filter(row => keep.has(row.seq))
    this.projected = entries
  }

  settle(attemptId: string): void {
    this.rows = this.rows.filter(row => !row.frame.transient || dataOf(row.frame).attemptId !== attemptId)
    this.project()
  }

  private project(): void {
    if (this.rows.every(row => row.frame.key.startsWith('legacy:'))) {
      this.rows.sort((left, right) => Number(left.frame.event.seq) - Number(right.frame.event.seq))
      this.projected = this.rows.map(row => {
        row.seq = Number(row.frame.event.seq)
        const data = dataOf(row.frame)
        row.turn = typeof data.turn === 'number' ? data.turn : undefined
        row.step = typeof data.step === 'number' ? data.step : undefined
        return (row.frame as SourceFrame & { legacyEntry?: SessionEventLikeEntry }).legacyEntry
          ?? { type: row.frame.transient ? 'transient' : 'event', event: row.frame.event,
            ...(row.frame.source ? { source: row.frame.source } : {}) } as SessionEventLikeEntry
      })
      return
    }
    const turnCoordinates = new Map<string, number>(), stepCoordinates = new Map<string, number>()
    for (const row of this.rows) {
      if (row.frame.turnKey && row.turn !== undefined) turnCoordinates.set(row.frame.turnKey, row.turn)
      if (row.frame.stepKey && row.step !== undefined) stepCoordinates.set(row.frame.stepKey, row.step)
    }
    const sorted = [...this.rows].sort((left, right) => left.frame.source && right.frame.source
      ? sourceOrder(left.frame.source, right.frame.source) : 0)
    const turnKeys = [...new Set(sorted.flatMap(row => row.frame.turnKey ? [row.frame.turnKey] : []))]
    const stepKeys = [...new Set(sorted.flatMap(row => row.frame.stepKey ? [row.frame.stepKey] : []))]
    const turns = coordinates(turnKeys, turnCoordinates, COORDINATE_BASE, STRIDE, 'turn')
    const steps = coordinates(stepKeys, stepCoordinates, COORDINATE_BASE, STRIDE, 'step')
    const stepTurns = new Map<string, number>()
    for (const row of this.rows) {
      const turn = row.frame.turnKey ? turns.get(row.frame.turnKey) : row.turn
      if (turn !== undefined && row.frame.stepKey) stepTurns.set(row.frame.stepKey, turn)
    }
    // Unknown partial observed turns can recover their scope from an overlapping
    // stable step. Otherwise they remain one local partial scope in this view.
    const partialTurns = new Map<number, number>()
    let nextPartial = Math.max(COORDINATE_BASE, ...turns.values()) + STRIDE
    const entries = this.rows.map((row, index) => {
      const frame = row.frame, data = dataOf(frame)
      let turn = frame.turnKey ? turns.get(frame.turnKey) : frame.stepKey ? stepTurns.get(frame.stepKey) : row.turn
      if (turn === undefined && typeof data.turn === 'number') {
        turn = partialTurns.get(data.turn)
        if (turn === undefined) { turn = nextPartial; nextPartial += STRIDE; partialTurns.set(data.turn, turn) }
      }
      const step = frame.stepKey ? steps.get(frame.stepKey) : row.step
      row.turn = turn; row.step = step
      const rewritten: Data = { ...data,
        ...(turn !== undefined && typeof data.turn === 'number' ? { turn } : {}),
        ...(turn !== undefined && typeof data.displayTurn === 'number' ? { displayTurn: turn } : {}),
        ...(step !== undefined && typeof data.step === 'number' ? { step } : {}),
        ...(step !== undefined && typeof data.displayStep === 'number' ? { displayStep: step } : {}) }
      return { type: frame.transient ? 'transient' : 'event', event: { ...frame.event, seq: index, data: rewritten },
        ...(frame.source ? { source: frame.source } : {}), sourceFrameKey: frame.key } as unknown as SessionEventLikeEntry
    })
    const sourceOrdered = orderSourceWindow(entries, index => this.rows[index]!)
    const byKey = new Map(this.rows.map(row => [row.frame.key, row]))
    const retainedKeys = this.rows.filter(row => row.seq >= 0).map(row => row.frame.key)
    const retainedSet = new Set(retainedKeys)
    let ordered: SessionEventLikeEntry[]
    if (retainedKeys.length === 0) {
      // An initial window has no established view order yet.
      ordered = sourceOrdered
    } else {
      // A later page may complete a partial turn and change how the source
      // ordering helper groups rows. Keep resident rows in their established
      // order and place each new source row by its source position. Lifecycle
      // starts sort ahead of their turn in the helper, so using its array index
      // alone can move a newer turn ahead of the whole resident transcript.
      const buckets: SessionEventLikeEntry[][] = Array.from({ length: retainedKeys.length + 1 }, () => [])
      // Source chronology and protocol chronology differ at clipped page
      // boundaries: an older assistant message can belong to a step whose
      // start was projected from the next source row. Keep its start before
      // every update without moving any resident event or changing its seq.
      const turnStarts = new Map<string, number>(), stepStarts = new Map<string, number>()
      for (const [index, key] of retainedKeys.entries()) {
        const frame = byKey.get(key)!.frame
        if (frame.event.type === 'turn/start' && frame.turnKey) turnStarts.set(frame.turnKey, index + 1)
        if (frame.event.type === 'step/start' && frame.stepKey) stepStarts.set(frame.stepKey, index + 1)
      }
      const retainedPositions = retainedKeys.flatMap((key, index) => {
        const position = byKey.get(key)!.frame.source
        return position ? [{ position, index }] : []
      })
      const sourcePositionsOrdered = retainedPositions.every((item, index) => index === 0
        || sourceOrder(retainedPositions[index - 1]!.position, item.position) <= 0)
      let passedRetained = 0, lastBucket = 0
      for (let index = 0; index < sourceOrdered.length; index++) {
        const entry = sourceOrdered[index]!
        const key = (entry as unknown as { sourceFrameKey: string }).sourceFrameKey
        if (retainedSet.has(key)) {
          passedRetained++
          lastBucket = Math.max(lastBucket, passedRetained)
        } else {
          const position = (entry as unknown as { source?: SourceFramePosition }).source ?? byKey.get(key)?.frame.source
          const lifecycleStart = /^(turn|step)\/start$/.test(String(entry.event.type))
          let bucket = Math.min(retainedKeys.length, Math.max(lastBucket, passedRetained))
          if (position) {
            if (sourcePositionsOrdered) {
              // Resident source positions are already in transcript order.
              // Find the insertion edge logarithmically instead of comparing
              // every new row with every resident row on each page.
              let low = 0, high = retainedPositions.length
              while (low < high) {
                const middle = (low + high) >>> 1
                const comparison = sourceOrder(position, retainedPositions[middle]!.position)
                if (comparison < 0 || comparison === 0 && lifecycleStart) high = middle
                else low = middle + 1
              }
              bucket = low < retainedPositions.length ? retainedPositions[low]!.index : retainedKeys.length
            } else {
              // Tool-call/result correction can intentionally move a row
              // across source order. Keep the established placement rule for
              // those uncommon windows rather than assuming monotonic keys.
              bucket = 0
              for (let retainedIndex = 0; retainedIndex < retainedKeys.length; retainedIndex++) {
                const retainedPosition = byKey.get(retainedKeys[retainedIndex]!)!.frame.source
                if (!retainedPosition) { bucket = retainedIndex + 1; continue }
                const comparison = sourceOrder(position, retainedPosition)
                if (comparison < 0 || comparison === 0 && lifecycleStart) { bucket = retainedIndex; break }
                bucket = retainedIndex + 1
              }
            }
          }
          const frame = byKey.get(key)!.frame
          if (frame.event.type !== 'turn/start' && frame.turnKey) bucket = Math.max(bucket, turnStarts.get(frame.turnKey) ?? 0)
          if (frame.event.type !== 'step/start' && frame.stepKey) bucket = Math.max(bucket, stepStarts.get(frame.stepKey) ?? 0)
          if (frame.event.type === 'turn/start' && frame.turnKey) turnStarts.set(frame.turnKey, bucket)
          if (frame.event.type === 'step/start' && frame.stepKey) stepStarts.set(frame.stepKey, bucket)
          lastBucket = Math.max(lastBucket, bucket)
          buckets[bucket]!.push(entry)
        }
      }
      const sourceEntryByKey = new Map(sourceOrdered.map(entry =>
        [(entry as unknown as { sourceFrameKey: string }).sourceFrameKey, entry]))
      const stableOrder: SessionEventLikeEntry[] = []
      for (let index = 0; index <= retainedKeys.length; index++) {
        stableOrder.push(...buckets[index]!)
        const retained = retainedKeys[index]
        if (retained !== undefined) {
          const entry = sourceEntryByKey.get(retained)
          if (entry) stableOrder.push(entry)
        }
      }
      ordered = stableOrder
    }
    const orderedKeys = ordered.map(entry => (entry as unknown as { sourceFrameKey: string }).sourceFrameKey)
    this.rows = orderedKeys.map(key => byKey.get(key)!)
    const transportKeys = new Set(this.rows.filter(row => row.frame.key.startsWith('transport:')).map(row => row.frame.key))
    const transcriptKeys = orderedKeys.filter(key => !transportKeys.has(key))
    const retained = new Map(this.rows.filter(row => !transportKeys.has(row.frame.key) && row.seq >= 0)
      .map(row => [row.frame.key, row.seq]))
    const seqs = coordinates(transcriptKeys, retained, SEQUENCE_BASE, EVENT_SEQUENCE_STRIDE, 'event')
    for (const key of transportKeys) {
      const type = String(byKey.get(key)?.frame.event.type)
      const fixed = TRANSPORT_SEQUENCE.get(type)
      if (fixed !== undefined) seqs.set(key, fixed)
    }
    this.projected = ordered.map(entry => {
      const key = (entry as unknown as { sourceFrameKey: string }).sourceFrameKey
      const row = byKey.get(key)!, frame = row.frame, refs = frame.refs
      row.seq = seqs.get(key)!
      const references = [refs?.surfaceKey && seqs.get(refs.surfaceKey),
        ...(refs?.sourceEventKeys?.map(ref => seqs.get(ref)) ?? []),
        refs?.surfaceOp?.startKey && seqs.get(refs.surfaceOp.startKey),
        refs?.surfaceOp?.endKey && seqs.get(refs.surfaceOp.endKey)].map(value => typeof value === 'number' ? value : undefined)
      const previous = row.projection
      if (previous?.frame === frame && previous.seq === row.seq && previous.turn === row.turn && previous.step === row.step
        && previous.references.length === references.length && previous.references.every((value, index) => value === references[index])) {
        return previous.entry
      }
      const data = entry.event.data as Data
      const event = { ...entry.event, seq: row.seq,
        data: refs?.surfaceKey && seqs.has(refs.surfaceKey) ? { ...data, surfaceSeq: seqs.get(refs.surfaceKey) } : data } as Data
      if (refs?.sourceEventKeys) event.sourceEventSeqs = refs.sourceEventKeys.flatMap(ref => seqs.has(ref) ? [seqs.get(ref)!] : [])
      if (refs?.surfaceOp) {
        const op = (frame.event as unknown as Data).surfaceOp as Data | undefined
        event.surfaceOp = { ...op,
          ...(refs.surfaceOp.startKey && seqs.has(refs.surfaceOp.startKey) ? { startSeq: seqs.get(refs.surfaceOp.startKey) } : {}),
          ...(refs.surfaceOp.endKey && seqs.has(refs.surfaceOp.endKey) ? { endSeq: seqs.get(refs.surfaceOp.endKey) } : {}) }
      }
      const projected = { ...entry, event } as unknown as SessionEventLikeEntry
      row.projection = { frame, seq: row.seq, turn: row.turn, step: row.step, references, entry: projected }
      return projected
    })
  }
}

/** Compatibility boundary for old fixtures/hosts. New source traffic always
 * arrives in explicit SourceFrameBatch records and never uses this adapter. */
export function legacySourceFrames(entries: readonly SessionEventLikeEntry[]): SourceFrame[] {
  const frames = entries.map(entry => {
    const event = entry.event, data = (event.data ?? {}) as Data
    const message = data.message as { id?: string } | undefined
    const source = (entry as unknown as { source?: SourceFramePosition }).source
    const id = typeof data.id === 'string' ? data.id : message?.id ?? (typeof data.callId === 'string' ? data.callId : undefined)
    return { key: `legacy:${event.type}:${id ?? event.seq}`, ...(source ? { source } : {}), legacyEntry: entry,
      ...(typeof data.turn === 'number' ? { turnKey: `legacy-turn:${data.turn}` } : {}),
      ...(typeof data.step === 'number' ? { stepKey: `legacy-step:${data.turn}:${data.step}` } : {}),
      event, ...(entry.type === 'transient' ? { transient: true as const } : {}) }
  })
  const keys = new Map(frames.map(frame => [Number(frame.event.seq), frame.key]))
  return frames.map(frame => {
    const data = dataOf(frame), event = frame.event as unknown as Data, op = event.surfaceOp as Data | undefined
    return { ...frame, refs: {
      ...(typeof data.surfaceSeq === 'number' && keys.has(data.surfaceSeq) ? { surfaceKey: keys.get(data.surfaceSeq)! } : {}),
      ...(Array.isArray(event.sourceEventSeqs) ? { sourceEventKeys: event.sourceEventSeqs.flatMap(seq => keys.has(Number(seq)) ? [keys.get(Number(seq))!] : []) } : {}),
      ...(op ? { surfaceOp: { ...(typeof op.startSeq === 'number' && keys.has(op.startSeq) ? { startKey: keys.get(op.startSeq)! } : {}),
        ...(typeof op.endSeq === 'number' && keys.has(op.endSeq) ? { endKey: keys.get(op.endSeq)! } : {}) } } : {}) } }
  })
}
