import {
  freezeMessage, LlmAttemptId, MessageId, ToolCallId,
  type AssistantMessage, type AssistantStreamRecord, type ContentBlock, type StreamChunk, type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { appendPluginRecord, type PluginRecordMap, type Session, type SessionEvent, type SessionEventMap,
  type SessionEventType, type SurfaceEventType, type SurfaceIntent } from '@deepseek-ai/dsh-session'
import { NativeHistoryChangedError } from '../codex/projector.js'
import type { ObservedItem } from './parser.js'
import { projectNotifySummaries, stripNotifySummaryFooter, type SourceNotifySummary } from './notify-summary.js'
import { projectGeneratedMedia, type SourceGeneratedMediaRecord } from './generated-media-record.js'
import { sourceToolProgressPayloadSchema, type SourceToolProgress, type SourceToolProgressPayload } from './tool-progress.js'
import { canonicalJson } from '../codex/native.js'
import type { SourceCodexReviewRecord } from './codex-review.js'
import './projection-state.js'
import { independentStreamDelta } from '../shared/stream-text.js'

interface Step { sourceStepId: string; turn: number; step: number; open: boolean }
type SteppedItem = Extract<ObservedItem, { kind: 'assistant' | 'tool-call' | 'tool-result' }>
interface SourceTool {
  id: ToolCallId; sourceCallId: string; step: Step; key: string; name: string
  progress?: SourceToolProgressPayload; progressFingerprint?: string
  progressPhase?: SourceToolProgress['phase']
}
interface Live {
  item: ObservedItem & { kind: 'assistant' }; step: Step; attemptId: LlmAttemptId; revision: number;
  index: number; text: string; records: AssistantStreamRecord[]
}
export interface ObservedProjectorOptions {
  scopeId?: string | null
  model(): string
  submittedMessage(localId: string): UserMessage | undefined
  content(item: ObservedItem): readonly ContentBlock[] | undefined
  stream(frame: AssistantStreamFrame): void
  /** First display Turn number. History pages render below the live seed. */
  turnBase?: number
}

/** Display grouping only. Every message/tool/terminal comes from an observed source fact. */
export class ObservedProjector {
  private seed: SessionEvent[] | undefined
  private sourceTime = 0
  private readonly committed = new Map<string, string>()
  private readonly rowKeys = new Set<string>()
  private readonly rewindIds = new Map<string, string>()
  private readonly rewindSeqs = new Map<number, string>()
  private readonly sourceSeqs = new Map<string, number>()
  private readonly surfaceSeqs = new Map<string, number>()
  private readonly tools = new Map<string, SourceTool>()
  private readonly steps = new Map<string, Step>()
  private turn = 0
  private step = 0
  private open = false
  private suppressFirstTurn = false
  private readonly turnAnchors = new Map<number, { id: string; at: number; seq: number; key: string | null }>()
  private responseInTurn = false
  private live: Live | undefined
  private revision = 0
  constructor(private current: Session, private readonly options: ObservedProjectorOptions) {
    this.turn = options.turnBase ?? 0
  }
  get session(): Session { return this.current }
  get projectedKeys(): ReadonlySet<string> { return this.rowKeys }
  /** Source row identity -> display event seq for the rendered page. */
  sourceSeqEntries(): ReadonlyMap<string, number> { return this.sourceSeqs }
  rewindSeqEntries(): ReadonlyMap<number, string> { return this.rewindSeqs }
  get lastTurn(): number { return this.turn }
  /** A live seed/history page begins inside its first source turn. */
  setSuppressFirstTurnStart(): void { this.suppressFirstTurn = true }
  turnAnchorEntries(): ReadonlyMap<number, { id: string; at: number; seq: number; key: string | null }> { return this.turnAnchors }
  /** Stable source step identity -> coordinates in this live seed or detached page. */
  stepAnchorEntries(): ReadonlyMap<string, { turn: number; step: number }> { return this.steps }
  rewindLocalId(id: string): string | undefined { return this.rewindIds.get(id) }
  rewindLocalIdAtSeq(seq: number): string | undefined { return this.rewindSeqs.get(seq) }
  sourceMessageDisplaySeq(id: string): number | undefined { return this.sourceSeqs.get(id) }
  sourceMessageAtDisplaySeq(seq: number): string | undefined { for (const [id, value] of this.sourceSeqs) if (value === seq) return id; return undefined }

  beginHistorySeed(): void {
    if (this.session.seq || this.seed) throw new Error('Observed history requires a detached new Session')
    this.seed = []
  }
  historySeed(): readonly SessionEvent[] { if (!this.seed) throw new Error('History seed was not started'); return this.seed }
  finishHistorySeed(session: Session): void {
    if (!this.seed || session.id !== this.session.id || session.firstLiveSeq !== this.seed.length) throw new Error('Observed history seed does not match the prepared Session')
    this.current = session; this.seed = undefined
  }
  private append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...intent: T extends SurfaceEventType ? [SurfaceIntent<T>] : []): SessionEvent<T> {
    const event = this.session.append(type, data, ...intent)
    if (this.seed) this.seed.push({ ...event, time: this.sourceTime } as SessionEvent)
    return event
  }

  /** Source records share the same bounded page and chronology as their body. */
  private appendRecord<K extends Extract<keyof PluginRecordMap, `plugin:${string}`>>(type: K, data: PluginRecordMap[K]): void {
    const seq = appendPluginRecord(this.session, type, data)
    if (this.seed) {
      const event = this.session.eventAt(seq)
      if (!event) throw new Error('The source annotation was not committed to its detached Session')
      this.seed.push({ ...event, time: this.sourceTime } as SessionEvent)
    }
  }

  apply(items: readonly ObservedItem[]): void {
    for (const item of items) {
      if (item.scopeId !== (this.options.scopeId ?? null) || item.kind === 'notice' || item.kind === 'usage') continue
      if (item.kind === 'user' && !item.invoked) continue
      this.sourceTime = item.createdAt
      const previous = this.committed.get(item.key)
      if (previous !== undefined) {
        const seq = this.surfaceSeqs.get(item.key)
        if (seq !== undefined) this.sourceSeqs.set(item.rowId, seq)
        if (item.kind === 'assistant' && item.live && this.live?.item.key !== item.key) continue
        if (previous !== item.fingerprint) throw new NativeHistoryChangedError('The HAPI source changed a displayed message; acquire its current history generation')
        if (item.kind === 'tool-call') this.updateToolProgress(item)
        continue
      }
      if (item.kind === 'end') {
        this.flushLive(item.reason === 'aborted')
        if (this.open) {
          for (const call of this.tools.values()) {
            if (call.step.turn !== this.turn || call.progressPhase !== 'progress' || call.progress === undefined) continue
            this.recordProgress({ callId: call.id, sourceCallId: call.sourceCallId, toolName: call.name, sourceRowId: item.rowId,
              createdAt: item.createdAt, turn: call.step.turn, step: call.step.step,
              phase: 'turn-ended', payload: call.progress, reason: item.reason })
            call.progressPhase = 'turn-ended'
          }
          for (const step of this.steps.values()) this.closeStep(step)
          this.append('turn/end', { turn: this.turn, reason: item.reason === 'completed' ? { kind: 'completed' }
            : item.reason === 'aborted' ? { kind: 'aborted', reason: { kind: 'user' } }
              : { kind: 'error', error: { code: 'HAPI_SOURCE_ERROR', message: item.error ?? 'The source engine reported an error' } } })
          this.open = false
        }
        this.committed.set(item.key, item.fingerprint); this.rowKeys.add(item.key)
        continue
      }
      // A following invoked user starts a new display group if the previous
      // source did not retain its ready marker. No synthetic terminal is added.
      if (item.kind === 'user' && this.responseInTurn) { this.flushLive(); this.open = false }
      this.ensureTurn(item)
      // A corrected final message reuses the abandoned attempt's step so the
      // discarded partial leaves no phantom step behind.
      let settlementStep: Step | undefined
      // A final row can arrive while the same item is still streamed from
      // provisional snapshots. Settle that attempt once with the completed text
      // instead of leaving a live bubble or appending a duplicate message.
      if (item.kind === 'assistant' && !item.live && this.live?.item.key === item.key) {
        const live = this.live, projectedText = item.reasoning ? item.text : stripNotifySummaryFooter(item.text)
        if (projectedText.startsWith(live.text)) {
          const delta = independentStreamDelta(projectedText, live.text.length)
          if (delta) this.chunk(live, { type: item.reasoning ? 'reasoning-delta' : 'text-delta', index: 0, text: delta })
          live.text = projectedText; live.item = item
          this.flushLive()
          this.responseInTurn = true
          continue
        }
        // The completed item is not an extension of the provisional text (the
        // source rewrote it). Abandon that stream so its stale partial cannot
        // survive; the regular non-live path below appends the final message.
        settlementStep = this.live.step
        this.abandonStream()
      }
      if (item.kind === 'assistant' && item.live) { this.updateLive(item); continue }
      if (this.live?.item.key !== item.key) this.flushLive()
      let event: SessionEvent
      if (item.kind === 'user') {
        const prior = item.localId ? this.options.submittedMessage(item.localId) : undefined
        const message = prior ?? freezeMessage({ id: MessageId(`hapi-observed:${item.key}`), role: 'user',
          content: this.content(item), source: { kind: 'user' } })
        event = this.append('user/message', message, { surfaceOp: 'append' })
        if (item.localId && item.invoked && item.scopeId === null) {
          this.rewindIds.set(message.id, item.localId); this.rewindSeqs.set(event.seq, item.localId)
        }
      } else if (item.kind === 'assistant') {
        this.responseInTurn = true
        const live = this.live?.item.key === item.key ? this.live : undefined
        if (live) { this.updateLive(item); this.flushLive(); continue }
        const step = settlementStep ?? this.nextStep(item)
        settlementStep = undefined
        const media = projectGeneratedMedia(item.parts, this.content(item))
        const display = projectNotifySummaries(media.content)
        event = this.append('assistant/message', { turn: step.turn, step: step.step, message: this.assistant(item, display.content), stream: [] }, { surfaceOp: 'append' })
        this.recordSummary(item, event, display)
        this.recordReview(item, event)
        if (media.files.length) {
          const record: SourceGeneratedMediaRecord = { messageId: event.data.message.id, sourceRowId: item.rowId, surfaceSeq: event.seq,
            turn: event.data.turn, step: event.data.step, files: media.files }
          this.appendRecord('plugin:hapi-dsh/generated-media', record)
        }
        this.closeStep(step)
      } else if (item.kind === 'tool-call') {
        this.responseInTurn = true
        const step = this.nextStep(item)
        const id = ToolCallId(`hapi-observed:tool:${this.toolIdentity(item)}`)
        const args = typeof item.input === 'string' ? item.input : JSON.stringify(item.input)
        event = this.append('assistant/message', { turn: step.turn, step: step.step,
          message: this.assistant(item, [{ type: 'tool-call', id, name: item.name, arguments: args }]), stream: [] }, { surfaceOp: 'append' })
        this.append('tool/call', { turn: step.turn, step: step.step, callId: id, name: item.name, arguments: args })
        this.tools.set(this.toolIdentity(item), { id, sourceCallId: item.callId, step, key: item.key, name: item.name })
        this.updateToolProgress(item)
      } else {
        this.responseInTurn = true
        const call = this.tools.get(this.toolIdentity(item))
        const step = call?.step ?? this.nextStep(item)
        const id = call?.id ?? ToolCallId(`hapi-observed:tool:${this.toolIdentity(item)}`)
        event = this.append('tool/result', { turn: step.turn, step: step.step,
          message: freezeMessage({ id: MessageId(`hapi-observed:${item.key}`), role: 'tool', toolCallId: id,
            source: { kind: 'tool', callId: id }, content: this.content(item), ...(item.isError ? { isError: true } : {}) }) }, { surfaceOp: 'append' })
        if (call?.progressPhase && call.progressPhase !== 'result') {
          this.recordProgress({ callId: id, sourceCallId: item.callId, toolName: call.name, sourceRowId: item.rowId,
            createdAt: item.createdAt, turn: step.turn, step: step.step, phase: 'result', isError: item.isError })
          call.progressPhase = 'result'
        }
        this.closeStep(step)
      }
      this.record(item, event.seq)
    }
  }
  private ensureTurn(item?: ObservedItem): void {
    if (this.open) return
    this.turn++; this.step = 0; this.open = true; this.responseInTurn = false
    if (item) this.turnAnchors.set(this.turn, { id: item.rowId, at: item.sourceAt ?? item.createdAt, seq: item.seq ?? 0,
      key: item.kind === 'user' ? item.rowId : null })
    if (!(this.suppressFirstTurn && this.turn === 1)) this.append('turn/start', { turn: this.turn })
  }
  private toolIdentity(item: Extract<SteppedItem, { kind: 'tool-call' | 'tool-result' }>): string {
    // HAPI callId / SDK tool_use_id identifies a call within its source scope.
    // Native source turns add their own namespace; display turns and transport
    // row IDs differ between pages and cannot identify a call/result pair.
    return JSON.stringify([item.scopeId, item.nativeExecution?.threadId ?? null, item.nativeExecution?.turnId ?? null, item.callId])
  }
  private sourceStepId(item: SteppedItem): string {
    return item.kind === 'assistant'
      ? `hapi-observed:step:${JSON.stringify([item.scopeId, item.reasoning ? 'reasoning' : 'message', item.key])}`
      : `hapi-observed:step:tool:${this.toolIdentity(item)}`
  }
  private nextStep(item: SteppedItem): Step {
    const sourceStepId = this.sourceStepId(item)
    const previous = this.steps.get(sourceStepId)
    if (previous) return previous
    const step = { sourceStepId, turn: this.turn, step: ++this.step, open: true }
    this.steps.set(sourceStepId, step); this.append('step/start', { turn: step.turn, step: step.step }); return step
  }
  private closeStep(step: Step): void {
    if (!step.open) return
    this.append('step/end', { turn: step.turn, step: step.step }); step.open = false
  }
  private content(item: ObservedItem): readonly ContentBlock[] {
    return this.options.content(item) ?? [{ type: 'text', text: 'text' in item ? item.text
      : item.kind === 'tool-result' ? typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2) : '' }]
  }
  private updateToolProgress(item: ObservedItem & { kind: 'tool-call' }): void {
    const call = this.tools.get(this.toolIdentity(item))
    // A replay, late partial, or missing progress is not a new invocation or a
    // final result. A corrected invocation input still takes the history-reset
    // path above instead of silently modifying an official tool/call.
    if (!call || call.key !== item.key || !call.step.open || !('progress' in item)) return
    const parsed = sourceToolProgressPayloadSchema.safeParse(item.progress)
    if (!parsed.success) return
    const fingerprint = canonicalJson(parsed.data)
    if (call.progressFingerprint === fingerprint) return
    call.progress = parsed.data; call.progressFingerprint = fingerprint; call.progressPhase = 'progress'
    this.recordProgress({ callId: call.id, sourceCallId: item.callId, toolName: call.name, sourceRowId: item.rowId,
      createdAt: item.createdAt, turn: call.step.turn, step: call.step.step, phase: 'progress', payload: parsed.data })
  }
  private recordProgress(record: SourceToolProgress): void {
    this.appendRecord('plugin:hapi-dsh/tool-progress', record)
  }
  private assistant(item: ObservedItem, content = this.content(item)): AssistantMessage {
    return freezeMessage({ id: MessageId(`hapi-observed:${item.key}`), role: 'assistant', content,
      source: { kind: 'model', provider: 'hapi-observed', model: item.model ?? this.options.model() } })
  }
  private record(item: ObservedItem, surfaceSeq: number): void {
    this.committed.set(item.key, item.fingerprint); this.rowKeys.add(item.key)
    this.surfaceSeqs.set(item.key, surfaceSeq)
    if (!this.sourceSeqs.has(item.rowId)) this.sourceSeqs.set(item.rowId, surfaceSeq)
    const step = item.kind === 'assistant' || item.kind === 'tool-call' || item.kind === 'tool-result'
      ? this.steps.get(this.sourceStepId(item)) : undefined
    const value = { key: item.key, sourceRowId: item.rowId, sourceLocalId: item.localId, sourceSeq: item.seq ?? 0, sourceAt: item.sourceAt ?? item.createdAt,
      scopeId: item.scopeId, parentToolCallId: item.parentToolCallId, surfaceSeq, displayTurn: step?.turn ?? this.turn,
      ...(step ? { sourceStepId: step.sourceStepId, displayStep: step.step } : {}) }
    this.appendRecord('plugin:hapi-dsh-observed/item', value)
  }
  private recordSummary(item: ObservedItem, event: SessionEvent<'assistant/message'>, display: ReturnType<typeof projectNotifySummaries>): void {
    if (!display.summaries.length) return
    const record: SourceNotifySummary = { messageId: event.data.message.id, sourceRowId: item.rowId, surfaceSeq: event.seq,
      turn: event.data.turn, step: event.data.step, originalText: display.originalText, summaries: display.summaries }
    this.appendRecord('plugin:hapi-dsh/notify-summary', record)
  }
  private recordReview(item: ObservedItem, event: SessionEvent<'assistant/message'>): void {
    if (item.kind !== 'assistant' || item.live || item.reasoning || !item.review) return
    const record: SourceCodexReviewRecord = { messageId: event.data.message.id, sourceRowId: item.rowId, surfaceSeq: event.seq,
      turn: event.data.turn, step: event.data.step, review: item.review }
    this.appendRecord('plugin:hapi-dsh/codex-review', record)
  }
  private updateLive(item: ObservedItem & { kind: 'assistant' }): void {
    this.responseInTurn = true
    let live = this.live
    if (live && live.item.key !== item.key) { this.flushLive(); live = undefined }
    // REST can seed a longer cumulative snapshot before an older queued SSE
    // frame is applied. A provisional prefix cannot shrink that same stream;
    // non-prefix corrections and final source text still follow normal rules.
    if (live && item.live && live.item.reasoning === item.reasoning && live.item.text.startsWith(item.text)) return
    const step = live?.step, projectedText = item.reasoning ? item.text : stripNotifySummaryFooter(item.text)
    if (live && !projectedText.startsWith(live.text)) { this.abandonStream(); live = undefined }
    if (!live) {
      live = { item, step: step ?? this.nextStep(item), attemptId: LlmAttemptId(`hapi-observed:${item.key}:${++this.revision}`),
        revision: this.revision, index: 0, text: '', records: [] }
      this.live = live
      this.options.stream({ type: 'start', attemptId: live.attemptId, revision: live.revision, turn: live.step.turn, step: live.step.step })
      this.chunk(live, { type: 'block-start', index: 0, blockType: item.reasoning ? 'reasoning' : 'text' })
    }
    const delta = independentStreamDelta(projectedText, live.text.length)
    if (delta) this.chunk(live, { type: item.reasoning ? 'reasoning-delta' : 'text-delta', index: 0, text: delta })
    live.text = projectedText; live.item = item
  }
  private chunk(live: Live, chunk: StreamChunk): void {
    const time = this.sourceTime
    live.records.push({ type: 'chunk', time, chunk })
    this.options.stream({ type: 'chunk', attemptId: live.attemptId, revision: ++this.revision, index: live.index++, time, chunk })
  }
  private flushLive(interrupted = false): void {
    const live = this.live
    if (!live) return
    this.chunk(live, { type: 'block-end', index: 0, block: { type: live.item.reasoning ? 'reasoning' : 'text', text: live.text } })
    const display = projectNotifySummaries(this.content(live.item))
    const event = this.append('assistant/message', { turn: live.step.turn, step: live.step.step,
      message: this.assistant(live.item, display.content), stream: live.records, ...(interrupted ? { interrupted: true as const } : {}) }, { surfaceOp: 'append' })
    this.recordSummary(live.item, event, display)
    this.recordReview(live.item, event)
    this.record(live.item, event.seq)
    this.options.stream({ type: 'end', attemptId: live.attemptId, revision: ++this.revision, index: live.index,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } })
    this.closeStep(live.step); this.live = undefined
  }
  abandonStream(): void {
    const live = this.live
    if (!live) return
    this.options.stream({ type: 'end', attemptId: live.attemptId, revision: ++this.revision, index: live.index, outcome: { kind: 'abandoned' } })
    this.live = undefined
  }
}
