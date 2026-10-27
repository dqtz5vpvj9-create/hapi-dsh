import {
  freezeMessage, LlmAttemptId, MessageId, ToolCallId,
  type AssistantMessage, type AssistantStreamRecord, type ContentBlock, type StreamChunk, type UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  appendPluginRecord, type PluginRecordMap, type Session, type SessionEvent, type SessionEventMap,
  type SessionEventType, type SurfaceEventType, type SurfaceIntent, type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { NativeExecution, NativeRow } from './native.js'
import type { NativeForkBoundary } from './control-types.ts'
import { projectNotifySummaries, stripNotifySummaryFooter, type SourceNotifySummary } from '../hapi-agent/notify-summary.js'
import { parseSourceCodexReview, type SourceCodexReviewRecord } from '../hapi-agent/codex-review.js'
import './projection-state.js'
import { independentStreamDelta } from '../shared/stream-text.js'

interface Step {
  key: string
  turn: number
  step: number
  nativeTurnId: string
  open: boolean
}
interface Turn {
  number: number
  nextStep: number
  ended: boolean
  anchor: { id: string; at: number; seq: number; key: string | null } | undefined
}
interface Stream {
  key: string
  attemptId: LlmAttemptId
  revision: number
  index: number
  text: string
  rawText: string
  sourceRowId: string
  reasoning: boolean
  step: Step
  records: AssistantStreamRecord[]
}

export class NativeHistoryChangedError extends Error {
  override readonly name = 'NativeHistoryChangedError'
}

export interface NativeProjectorOptions {
  model(): string
  provider(): string
  submittedMessage(localId: string): UserMessage | undefined
  content?(row: NativeRow): readonly ContentBlock[] | undefined
  stream(frame: AssistantStreamFrame): void
  /** First display Turn number. History pages render below the live seed. */
  turnBase?: number
}

/**
 * Translates native observations into DSH's public display vocabulary. Logical
 * DSH steps group native items; they never launch an LLM or drain an inbox.
 */
export class NativeProjector {
  private readonly turns = new Map<string, Turn>()
  private readonly steps = new Map<string, Step>()
  private readonly calls = new Map<string, { step: Step; id: ToolCallId }>()
  private readonly committed = new Map<string, string>()
  private readonly rawKeys = new Set<string>()
  private readonly forkBoundaries = new Map<string, NativeForkBoundary>()
  private readonly rewindLocalIds = new Map<string, string>()
  private readonly rewindLocalIdsBySeq = new Map<number, string>()
  private readonly sourceMessageSeqs = new Map<string, number>()
  private readonly surfaceSeqs = new Map<string, number>()
  private readonly turnErrors = new Map<string, string>()
  private activeStream: Stream | undefined
  private latestSourceAt = Number.NEGATIVE_INFINITY
  private latestSourceSeq = Number.NEGATIVE_INFINITY
  private revision = 0
  private seed: SessionEvent[] | undefined
  private sourceTime = 0

  private readonly turnBase: number
  private suppressFirstTurn = false
  constructor(private currentSession: Session, private readonly options: NativeProjectorOptions) {
    this.turnBase = options.turnBase ?? 0
  }

  /** A live seed/history page begins inside its first source turn. */
  setSuppressFirstTurnStart(): void { this.suppressFirstTurn = true }

  get session(): Session { return this.currentSession }

  /** Collect a detached historical seed without altering any published log. */
  beginHistorySeed(): void {
    if (this.session.seq !== 0 || this.seed) throw new Error('Native history seeding requires a new detached Session')
    this.seed = []
  }

  historySeed(): readonly SessionEvent[] {
    if (!this.seed) throw new Error('Native history seeding was not started')
    return this.seed
  }

  /** Bind only a freshly prepared Session that validated our historical seed. */
  finishHistorySeed(session: Session): void {
    if (!this.seed || session.id !== this.session.id || session.firstLiveSeq !== this.seed.length) {
      throw new Error('The prepared native history does not match its display seed')
    }
    this.currentSession = session
    this.seed = undefined
  }

  private append<T extends SessionEventType>(
    type: T, data: SessionEventMap[T], ...options: T extends SurfaceEventType ? [options: SurfaceIntent<T>] : []
  ): SessionEvent<T> {
    const event = this.session.append(type, data, ...options)
    // append already validated the discriminated type/data pair. TypeScript
    // cannot distribute a generic T through the mapped SessionEvent union.
    if (this.seed) this.seed.push({ ...event, time: this.sourceTime } as SessionEvent)
    return event
  }

  /** Keep source annotations beside their messages, including detached seeds.
   * Deferring them until after the whole seed made every initial/older page
   * carry annotations for the entire transcript instead of its own window. */
  private appendRecord<K extends Extract<keyof PluginRecordMap, `plugin:${string}`>>(type: K, data: PluginRecordMap[K]): void {
    const seq = appendPluginRecord(this.session, type, data)
    if (this.seed) {
      const event = this.session.eventAt(seq)
      if (!event) throw new Error('The native annotation was not committed to its detached Session')
      this.seed.push({ ...event, time: this.sourceTime } as SessionEvent)
    }
  }

  get projectedKeys(): ReadonlySet<string> { return this.rawKeys }
  /** Source row identity -> display event seq for the rendered page. */
  sourceSeqEntries(): ReadonlyMap<string, number> { return this.sourceMessageSeqs }
  rewindSeqEntries(): ReadonlyMap<number, string> { return this.rewindLocalIdsBySeq }
  forkBoundaryEntries(): ReadonlyMap<string, NativeForkBoundary> { return this.forkBoundaries }
  get lastTurn(): number { let value = 0; for (const turn of this.turns.values()) value = Math.max(value, turn.number); return value }
  turnAnchorEntries(): ReadonlyMap<number, { id: string; at: number; seq: number; key: string | null }> {
    const values = new Map<number, { id: string; at: number; seq: number; key: string | null }>()
    for (const turn of this.turns.values()) if (turn.anchor) values.set(turn.number, turn.anchor)
    return values
  }
  stepAnchorEntries(): ReadonlyMap<string, { turn: number; step: number }> {
    return new Map([...this.steps].map(([key, step]) => [key, { turn: step.turn, step: step.step }]))
  }

  /** Only a committed displayed message can name a source-native boundary. */
  forkBoundary(messageId: string): NativeForkBoundary | undefined {
    const value = this.forkBoundaries.get(messageId)
    return value ? { ...value } : undefined
  }

  /** HAPI rewinds only at a source-confirmed invoked human input localId. */
  rewindLocalId(messageId: string): string | undefined { return this.rewindLocalIds.get(messageId) }
  rewindLocalIdAtSeq(seq: number): string | undefined { return this.rewindLocalIdsBySeq.get(seq) }
  sourceMessageDisplaySeq(id: string): number | undefined { return this.sourceMessageSeqs.get(id) }
  sourceMessageAtDisplaySeq(seq: number): string | undefined { for (const [id, value] of this.sourceMessageSeqs) if (value === seq) return id; return undefined }

  /** Apply a coherent source page; terminal facts settle after that page's items. */
  apply(rows: readonly NativeRow[], lateTolerant = false): void {
    const groups = new Map<string, NativeRow[]>()
    for (const row of rows) {
      const key = row.execution?.turnId ?? ''
      const group = groups.get(key) ?? []
      group.push(row)
      groups.set(key, group)
    }
    for (const [id, group] of groups) {
      let ending: NativeExecution['turn']
      for (const row of group) {
        this.sourceTime = row.createdAt
        if (row.execution?.turn?.ended) ending = row.execution.turn
        if (row.kind !== 'user' || row.invoked) this.applyRow(row, lateTolerant && this.isLateSourceRow(row), lateTolerant)
        const sourceAt = row.sourceAt ?? row.createdAt
        if (this.latestSourceAt < sourceAt || this.latestSourceAt === sourceAt && this.latestSourceSeq < (row.seq ?? 0)) {
          this.latestSourceAt = sourceAt; this.latestSourceSeq = row.seq ?? 0
        }
      }
      if (ending) this.endTurn(id, ending.status)
    }
  }

  private isLateSourceRow(row: NativeRow): boolean {
    const sourceAt = row.sourceAt ?? row.createdAt
    return sourceAt < this.latestSourceAt
      || sourceAt === this.latestSourceAt && (row.seq ?? 0) <= this.latestSourceSeq
  }

  private applyRow(row: NativeRow, late: boolean, lateTolerant: boolean): void {
    if (row.kind === 'user' && !row.invoked) return
    const previous = this.committed.get(row.key)
    if (previous !== undefined) {
      const seq = this.surfaceSeqs.get(row.key)
      if (seq !== undefined) this.sourceMessageSeqs.set(row.rowId, seq)
      if (row.kind === 'assistant' && !row.final) return // A delayed provisional frame cannot regress a committed item.
      if (previous !== row.fingerprint && row.kind !== 'turn') {
        // A delayed page may contain the older version of a row whose live
        // update was already committed. Keep the committed version; a genuine
        // newer source mutation still requires a fresh generation.
        if (lateTolerant && late) return
        throw new NativeHistoryChangedError('Native Codex changed an already projected item; the conversation must acquire a fresh history generation')
      }
      return
    }
    const turnId = row.execution?.turnId
    if (row.kind === 'notice') {
      if (turnId) this.turnErrors.set(turnId, row.text)
      this.committed.set(row.key, row.fingerprint)
      // Source notices are also published independently, including those
      // without a native model turn. They must not create synthetic steps.
      return
    }
    if (row.kind === 'turn') {
      if (turnId) this.ensureTurn(turnId, row)
      this.committed.set(row.key, row.fingerprint)
      return
    }
    // Native errors without a turn cannot be attributed to an invented model turn.
    if (!turnId) return
    const turn = this.ensureTurn(turnId, row)
    // A delayed page can legitimately name an already-ended turn. It is
    // appended with its source annotation; the history window orders by source
    // position rather than pretending the append-only log is source order.
    if (turn.ended && !(lateTolerant && late)) throw new NativeHistoryChangedError('A native item arrived after its projected terminal boundary; refresh native history')
    let event: SessionEvent | undefined
    let step: Step | undefined
    switch (row.kind) {
      case 'user': {
        const submitted = row.localId ? this.options.submittedMessage(row.localId) : undefined
        const message: UserMessage = submitted ?? freezeMessage({
          id: MessageId(`hapi:${row.key}`), role: 'user',
          content: this.options.content?.(row) ?? [{ type: 'text', text: row.text }], source: { kind: 'user' },
        })
        event = this.append('user/message', message, { surfaceOp: 'append' })
        if (row.invoked && row.localId) {
          this.rewindLocalIds.set(message.id, row.localId)
          this.rewindLocalIdsBySeq.set(event.seq, row.localId)
        }
        break
      }
      case 'assistant': {
        step = this.stepFor(row)
        if (!row.final) { this.updateStream(row, step); return }
        const original: ContentBlock = row.reasoning ? { type: 'reasoning', text: row.text } : { type: 'text', text: row.text }
        const display = projectNotifySummaries([original]), block = display.content[0]!
        const stream = this.activeStream?.key === row.key ? this.activeStream : undefined
        if (stream) this.updateStream(row, step)
        const current = this.activeStream?.key === row.key ? this.activeStream : undefined
        if (current) this.emitChunk(current, { type: 'block-end', index: 0, block })
        const message = this.assistant(row.key, [block])
        event = this.append('assistant/message', {
          turn: step.turn, step: step.step, message, stream: current?.records ?? [],
        }, { surfaceOp: 'append' })
        this.recordSummary(row.rowId, event, display)
        // Native shared snapshots carry streamSnapshot even after completion.
        // Only this proven final item boundary may gain a review annotation;
        // provisional snapshots and interruption-frozen partials stay text.
        const review = row.reasoning ? null : parseSourceCodexReview(row.text)
        if (review) {
          const record: SourceCodexReviewRecord = { messageId: event.data.message.id, sourceRowId: row.rowId, surfaceSeq: event.seq,
            turn: event.data.turn, step: event.data.step, review }
          this.appendRecord('plugin:hapi-dsh/codex-review', record)
        }
        if (current) {
          this.options.stream({ type: 'end', attemptId: current.attemptId, revision: ++this.revision,
            index: current.index, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } })
          this.activeStream = undefined
        }
        this.closeStep(step)
        break
      }
      case 'tool-call': {
        step = this.stepFor(row)
        // Native plan updates reuse `codex-plan-state` within a turn. The
        // completed item's stable key distinguishes each real invocation.
        // Stable per source item, so a result rendered from an older page can
        // match a call exposed after a bounded giant-turn continuation while
        // repeated same-callId plan updates remain distinct.
        const callId = ToolCallId(`codex:${turnId}:${row.callId}:${row.execution?.itemId ?? `call:${row.callId}`}`)
        const argumentsText = typeof row.input === 'string' ? row.input : JSON.stringify(row.input)
        event = this.append('assistant/message', {
          turn: step.turn, step: step.step,
          message: this.assistant(row.key, [{ type: 'tool-call', id: callId, name: row.name, arguments: argumentsText }]), stream: [],
        }, { surfaceOp: 'append' })
        this.append('tool/call', { turn: step.turn, step: step.step, callId, name: row.name, arguments: argumentsText })
        this.calls.set(`${turnId}:${row.callId}`, { step, id: callId })
        if (row.execution?.itemId) this.calls.set(`${turnId}:${row.callId}:${row.execution.itemId}`, { step, id: callId })
        break
      }
      case 'tool-result': {
        const call = (row.execution?.itemId ? this.calls.get(`${turnId}:${row.callId}:${row.execution.itemId}`) : undefined)
          ?? this.calls.get(`${turnId}:${row.callId}`)
        step = call?.step ?? this.stepFor(row)
        const callId = call?.id ?? ToolCallId(`codex:${turnId}:${row.callId}:${row.execution?.itemId ?? `call:${row.callId}`}`)
        event = this.append('tool/result', {
          turn: step.turn, step: step.step,
          message: freezeMessage({
            id: MessageId(`hapi:${row.key}`), role: 'tool',
            source: { kind: 'tool', callId }, toolCallId: callId,
            content: this.options.content?.(row) ?? [{ type: 'text', text: typeof row.output === 'string' ? row.output : JSON.stringify(row.output, null, 2) }],
            ...(row.isError ? { isError: true } : {}),
          }),
        }, { surfaceOp: 'append' })
        this.closeStep(step)
        break
      }
    }
    if (event) {
      this.surfaceSeqs.set(row.key, event.seq)
      this.sourceMessageSeqs.set(row.rowId, event.seq)
      const messageId = event.type === 'user/message' ? event.data.id
        : event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message.id : undefined
      if (messageId && row.execution?.itemId) {
        this.forkBoundaries.set(messageId, {
          threadId: row.execution.threadId, turnId: row.execution.turnId, itemId: row.execution.itemId,
        })
      }
      this.committed.set(row.key, row.fingerprint)
      this.rawKeys.add(row.key)
      const nativeRecord = {
        key: row.key, fingerprint: row.fingerprint, surfaceSeq: event.seq,
        sourceMessageId: row.rowId, sourceAt: row.sourceAt ?? row.createdAt, sourceSeq: row.seq ?? 0,
        // Official Conversation treats top-level `turn` / `step` fields on
        // every event as timeline coordinates, including ignorable records.
        // An annotation must not invent a Step 0 that replaces the final
        // answer's real latest Step in the official location index.
        displayTurn: step?.turn ?? turn.number, displayStep: step?.step ?? 0,
        nativeTurnId: turnId, nativeItemId: row.execution?.itemId ?? null,
        ...(step === undefined ? {} : { nativeStepId: step.key }),
      }
      this.appendRecord('plugin:hapi-dsh/native-item', nativeRecord)
    }
  }

  private ensureTurn(id: string, row?: NativeRow): Turn {
    let turn = this.turns.get(id)
    if (!turn) {
      turn = { number: this.turnBase + this.turns.size + 1, nextStep: 0, ended: false,
        anchor: row ? { id: row.rowId, at: row.sourceAt ?? row.createdAt, seq: row.seq ?? 0, key: id } : undefined }
      this.turns.set(id, turn)
      if (!(this.suppressFirstTurn && this.turns.size === 1)) this.append('turn/start', { turn: turn.number })
    }
    return turn
  }

  private stepFor(row: NativeRow): Step {
    const turnId = row.execution?.turnId
    if (!turnId) throw new Error('A native item must identify its source turn')
    const item = row.execution?.itemId
      ?? (row.kind === 'tool-call' || row.kind === 'tool-result' ? `call:${row.callId}` : row.key)
    const key = `${turnId}:${item}:${row.kind === 'assistant' && row.reasoning ? 'reasoning' : 'item'}`
    let step = this.steps.get(key)
    if (!step) {
      const turn = this.ensureTurn(turnId, row)
      step = { key, turn: turn.number, step: ++turn.nextStep, nativeTurnId: turnId, open: true }
      this.steps.set(key, step)
      this.append('step/start', { turn: step.turn, step: step.step })
    }
    return step
  }

  private assistant(key: string, content: readonly ContentBlock[]): AssistantMessage {
    return freezeMessage({ id: MessageId(`hapi:${key}`), role: 'assistant', content,
      source: { kind: 'model', provider: this.options.provider(), model: this.options.model() } })
  }

  private recordSummary(sourceRowId: string, event: SessionEvent<'assistant/message'>, display: ReturnType<typeof projectNotifySummaries>): void {
    if (!display.summaries.length) return
    const record: SourceNotifySummary = { messageId: event.data.message.id, sourceRowId, surfaceSeq: event.seq,
      turn: event.data.turn, step: event.data.step, originalText: display.originalText, summaries: display.summaries }
    this.appendRecord('plugin:hapi-dsh/notify-summary', record)
  }

  private updateStream(row: NativeRow & { kind: 'assistant' }, step: Step): void {
    let stream = this.activeStream
    const projectedText = row.reasoning ? row.text : stripNotifySummaryFooter(row.text)
    if (stream?.key === row.key && stream.reasoning === row.reasoning && stream.rawText.startsWith(row.text) && !row.final) return
    if (!stream || stream.key !== row.key || stream.reasoning !== row.reasoning || !projectedText.startsWith(stream.text)) {
      this.abandonStream()
      stream = { key: row.key, attemptId: LlmAttemptId(`native:${row.key}:${++this.revision}`),
        revision: this.revision, index: 0, text: '', rawText: '', sourceRowId: row.rowId, reasoning: row.reasoning, step, records: [] }
      this.activeStream = stream
      this.options.stream({ type: 'start', attemptId: stream.attemptId, revision: stream.revision, turn: step.turn, step: step.step })
      this.emitChunk(stream, { type: 'block-start', index: 0, blockType: row.reasoning ? 'reasoning' : 'text' })
    }
    const text = independentStreamDelta(projectedText, stream.text.length)
    if (text) this.emitChunk(stream, { type: row.reasoning ? 'reasoning-delta' : 'text-delta', index: 0, text })
    stream.text = projectedText; stream.rawText = row.text; stream.sourceRowId = row.rowId
  }

  private emitChunk(stream: Stream, chunk: StreamChunk): void {
    const time = Date.now()
    stream.records.push({ type: 'chunk', time, chunk })
    this.options.stream({ type: 'chunk', attemptId: stream.attemptId, revision: ++this.revision,
      index: stream.index++, time, chunk })
  }

  private closeStep(step: Step): void {
    if (!step.open) return
    this.append('step/end', { turn: step.turn, step: step.step })
    step.open = false
  }

  private endTurn(id: string, status: NonNullable<NativeExecution['turn']>['status']): void {
    if (status === 'inProgress') return
    const turn = this.ensureTurn(id)
    if (turn.ended) return
    const stream = this.activeStream
    if (stream?.step.nativeTurnId === id) {
      // An interrupted native item may never emit item/completed. Its visible
      // partial is committed only after an authoritative non-success terminal.
      if (status !== 'completed' && stream.rawText) {
        const block: ContentBlock = stream.reasoning ? { type: 'reasoning', text: stream.text } : { type: 'text', text: stream.text }
        const event = this.append('assistant/message', {
          turn: stream.step.turn, step: stream.step.step,
          message: this.assistant(stream.key, [block]), stream: stream.records, interrupted: true,
        }, { surfaceOp: 'append' })
        this.recordSummary(stream.sourceRowId, event, projectNotifySummaries([
          { type: stream.reasoning ? 'reasoning' : 'text', text: stream.rawText },
        ]))
        this.options.stream({ type: 'end', attemptId: stream.attemptId, revision: ++this.revision,
          index: stream.index, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } })
        this.activeStream = undefined
      } else this.abandonStream()
    }
    for (const step of this.steps.values()) if (step.nativeTurnId === id) this.closeStep(step)
    const reason: TurnEndReason = status === 'completed' ? { kind: 'completed' }
      : status === 'interrupted' ? { kind: 'aborted', reason: { kind: 'user' } }
        : { kind: 'error', error: { code: 'CODEX_NATIVE_TURN_FAILED', message: this.turnErrors.get(id) ?? 'The native Codex turn failed' } }
    this.append('turn/end', { turn: turn.number, reason })
    turn.ended = true
  }

  /** Viewer disposal abandons a transient view and never closes the native turn. */
  abandonStream(): void {
    const stream = this.activeStream
    if (!stream) return
    this.options.stream({ type: 'end', attemptId: stream.attemptId, revision: ++this.revision,
      index: stream.index, outcome: { kind: 'abandoned' } })
    this.activeStream = undefined
  }
}
