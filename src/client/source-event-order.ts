import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

type Position = { messageId: string; at: number; seq: number }
type Data = Record<string, unknown>
type Coordinates = { source: Position | undefined; turn: number | undefined; step: number | undefined }
type Located = Coordinates & { entry: SessionEventLikeEntry; index: number }

function dataOf(entry: SessionEventLikeEntry): Data {
  return (entry.event.data ?? {}) as Data
}
function position(entry: SessionEventLikeEntry): Position | undefined {
  const source = (entry as unknown as { source?: Position }).source
  if (source) return source
  const type = String(entry.event.type)
  if (type !== 'plugin:hapi-dsh/native-item' && type !== 'plugin:hapi-dsh-observed/item') return undefined
  const data = dataOf(entry)
  const messageId = type === 'plugin:hapi-dsh/native-item' ? data.sourceMessageId : data.sourceRowId
  return typeof messageId === 'string' && typeof data.sourceAt === 'number' && typeof data.sourceSeq === 'number'
    ? { messageId, at: data.sourceAt, seq: data.sourceSeq } : undefined
}
function compare(left: Position, right: Position): number {
  return left.at - right.at || left.seq - right.seq
}

/** A partial step can receive its call after its result. Keep both source
 * messages, but place the known call and its annotations before that update. */
function orderToolRows(rows: readonly Located[]): readonly Located[] {
  const calls = new Map<string, Located>()
  const resultId = (row: Located): string | undefined => {
    if (row.entry.event.type !== 'tool/result') return undefined
    const message = dataOf(row.entry).message as { source?: { callId?: unknown } } | undefined
    return typeof message?.source?.callId === 'string' ? message.source.callId : undefined
  }
  for (const row of rows) {
    const id = dataOf(row.entry).callId
    if (row.entry.event.type === 'tool/call' && typeof id === 'string' && !calls.has(id)) calls.set(id, row)
  }
  if (!rows.some(row => { const id = resultId(row); return id !== undefined && (calls.get(id)?.index ?? -1) > row.index })) return rows
  const messages = new Map<string, Located>()
  const annotations = new Map<number, Located[]>()
  for (const row of rows) {
    const data = dataOf(row.entry)
    if (row.entry.event.type === 'assistant/message') {
      const content = (data.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) for (const block of content) {
        if (block?.type === 'tool-call' && typeof block.id === 'string' && !messages.has(block.id)) messages.set(block.id, row)
      }
    }
    if (typeof data.surfaceSeq === 'number') {
      const list = annotations.get(data.surfaceSeq) ?? []
      list.push(row); annotations.set(data.surfaceSeq, list)
    }
  }
  const emitted = new Set<Located>(), ordered: Located[] = []
  const emit = (row: Located | undefined): void => {
    if (row && !emitted.has(row)) { emitted.add(row); ordered.push(row) }
  }
  for (const row of rows) {
    const id = resultId(row), call = id === undefined ? undefined : calls.get(id)
    if (call && call.index > row.index && !emitted.has(call)) {
      const message = messages.get(id!)
      emit(message); emit(call)
      for (const body of message ? [message, call] : [call]) {
        for (const annotation of annotations.get(Number(body.entry.event.seq)) ?? []) emit(annotation)
      }
    }
    emit(row)
  }
  return ordered
}

/** Live bodies and their identity annotations may arrive in separate frames. */
export function sourceMessageForSequence(entries: readonly SessionEventLikeEntry[], seq: number): string | undefined {
  const body = entries.find(entry => Number(entry.event.seq) === seq)
  const direct = body && position(body)
  if (direct) return direct.messageId
  const annotation = entries.find(entry => dataOf(entry).surfaceSeq === seq && position(entry))
  return annotation && position(annotation)?.messageId
}

export function sourceSequenceForMessage(entries: readonly SessionEventLikeEntry[], messageId: string): number | undefined {
  const visible = (entry: SessionEventLikeEntry) => ['user/message', 'assistant/message', 'tool/call'].includes(entry.event.type)
  const body = entries.find(entry => visible(entry) && position(entry)?.messageId === messageId)
  if (body) return Number(body.event.seq)
  for (const entry of entries) {
    if (position(entry)?.messageId !== messageId) continue
    const seq = dataOf(entry).surfaceSeq
    if (typeof seq === 'number' && entries.some(row => Number(row.event.seq) === seq && visible(row))) return seq
  }
  return undefined
}

/** Source order applies to message/step groups, never to isolated protocol events.
 * Turn and step starts must still precede all their updates after a late page.
 * This runs only when a batch contains a backwards source position. */
export function orderSourceWindow(entries: readonly SessionEventLikeEntry[],
  scopeAt?: (index: number) => { turn: number | undefined; step: number | undefined }): SessionEventLikeEntry[] {
  const surfaces = new Map<number, Coordinates>()
  for (const entry of entries) {
    const type = String(entry.event.type)
    if (type !== 'plugin:hapi-dsh/native-item' && type !== 'plugin:hapi-dsh-observed/item') continue
    const data = dataOf(entry)
    if (typeof data.surfaceSeq === 'number') surfaces.set(data.surfaceSeq, {
      source: position(entry),
      turn: typeof data.displayTurn === 'number' ? data.displayTurn : undefined,
      step: typeof data.displayStep === 'number' && data.displayStep > 0 ? data.displayStep : undefined,
    })
  }
  const bySeq = new Map<number, Located>()
  let currentTurn: number | undefined
  let currentStep: number | undefined
  const located: Located[] = entries.map((entry, index) => {
    const data = dataOf(entry), surface = surfaces.get(Number(entry.event.seq))
    const referenced = typeof data.surfaceSeq === 'number' ? bySeq.get(data.surfaceSeq) : undefined
    const scope = scopeAt?.(index)
    const turn = scope ? scope.turn : typeof data.turn === 'number' ? data.turn
      : typeof data.displayTurn === 'number' ? data.displayTurn : surface?.turn ?? referenced?.turn ?? currentTurn
    const step = scope ? scope.step : entry.event.type === 'turn/start' ? undefined : typeof data.step === 'number' ? data.step
      : typeof data.displayStep === 'number' && data.displayStep > 0 ? data.displayStep
        : surface?.step ?? referenced?.step ?? (entry.event.type === 'user/message' || turn !== currentTurn ? undefined : currentStep)
    const row = { entry, index, source: position(entry) ?? surface?.source ?? referenced?.source, turn, step }
    bySeq.set(Number(entry.event.seq), row)
    currentTurn = turn
    currentStep = step
    if (entry.event.type === 'step/end') currentStep = undefined
    if (entry.event.type === 'turn/end') { currentTurn = undefined; currentStep = undefined }
    return row
  })
  const sources = new Map(located.map(row => [row.entry, row.source]))
  type Group = { rows: Located[]; first: number; source: Position | undefined }
  const group = (rows: Located[]): Group => {
    const positions = rows.filter(row => !String(row.entry.event.type).match(/^(turn|step)\//))
      .flatMap(row => row.source ? [row.source] : [])
    return { rows, first: rows[0]!.index,
      source: positions.reduce<Position | undefined>((first, next) => !first || compare(next, first) < 0 ? next : first, undefined) }
  }
  const byOrder = (a: Group, b: Group): number => a.source && b.source ? compare(a.source, b.source) || a.first - b.first
    : a.source ? 1 : b.source ? -1 : a.first - b.first
  const turns = new Map<number, Located[]>(), unscoped: Located[] = []
  for (const row of located) {
    if (row.turn === undefined) { unscoped.push(row); continue }
    const list = turns.get(row.turn) ?? []
    list.push(row); turns.set(row.turn, list)
  }
  const ordered: SessionEventLikeEntry[] = unscoped.map(row => row.entry)
  const firstSeq = entries.reduce((min, entry) => Math.min(min, Number(entry.event.seq)), Number.MAX_SAFE_INTEGER)
  for (const turn of [...turns.values()].map(group).sort(byOrder)) {
    const starts = turn.rows.filter(row => row.entry.event.type === 'turn/start')
    const ends = turn.rows.filter(row => row.entry.event.type === 'turn/end')
    const steps = new Map<number, Located[]>(), units: Group[] = []
    for (const row of turn.rows) {
      if (row.entry.event.type === 'turn/start' || row.entry.event.type === 'turn/end') continue
      if (row.step === undefined) { units.push(group([row])); continue }
      const list = steps.get(row.step) ?? []
      list.push(row); steps.set(row.step, list)
    }
    if (starts.length) ordered.push(starts[0]!.entry)
    // A clipped source scope has no known start. The official assembler can
    // retain it as partial; inventing a start here makes an older prepend
    // precede that start and corrupts the same turn's process context.
    units.push(...[...steps.values()].map(group))
    for (const unit of units.sort(byOrder)) {
      const start = unit.rows.find(row => row.entry.event.type === 'step/start')
      if (start) ordered.push(start.entry)
      const body = unit.rows.filter(row => row.entry.event.type !== 'step/start' && row.entry.event.type !== 'step/end')
      for (const row of orderToolRows(body)) ordered.push(row.entry)
      const end = unit.rows.findLast(row => row.entry.event.type === 'step/end')
      if (end) ordered.push(end.entry)
    }
    if (ends.length) ordered.push(ends[ends.length - 1]!.entry)
  }
  const seqs = new Map(ordered.map((entry, index) => [Number(entry.event.seq), firstSeq + index]))
  return ordered.map((entry, index) => {
    const old = entry.event as unknown as Data
    const data = dataOf(entry)
    const event: Data = { ...old, seq: firstSeq + index,
      data: typeof data.surfaceSeq === 'number' ? { ...data, surfaceSeq: seqs.get(data.surfaceSeq) ?? data.surfaceSeq } : entry.event.data }
    if (Array.isArray(old.sourceEventSeqs)) event.sourceEventSeqs = old.sourceEventSeqs.map(seq => seqs.get(seq as number) ?? seq)
    if (old.surfaceOp && typeof old.surfaceOp === 'object') {
      const op = old.surfaceOp as Data
      event.surfaceOp = { ...op,
        ...(typeof op.startSeq === 'number' ? { startSeq: seqs.get(op.startSeq) ?? op.startSeq } : {}),
        ...(typeof op.endSeq === 'number' ? { endSeq: seqs.get(op.endSeq) ?? op.endSeq } : {}) }
    }
    const source = sources.get(entry)
    return { ...entry, event, ...(source === undefined ? {} : { source }) } as unknown as SessionEventLikeEntry
  })
}

export function hasLateSourceRows(resident: readonly SessionEventLikeEntry[], incoming: readonly SessionEventLikeEntry[]): boolean {
  let latest: Position | undefined
  for (const entry of resident) {
    const source = position(entry)
    if (source && (!latest || compare(latest, source) < 0)) latest = source
  }
  for (const entry of incoming) {
    const source = position(entry)
    if (!source) continue
    if (latest && compare(source, latest) < 0) return true
    latest = source
  }
  return false
}
