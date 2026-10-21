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

interface Step { turn: number; step: number; open: boolean }
interface SourceTool {
  id: ToolCallId; step: Step; key: string; name: string
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
  private readonly steps: Step[] = []
  private turn = 0
  private step = 0
  private open = false
  private responseInTurn = false
  private live: Live | undefined
  private revision = 0
  constructor(private current: Session, private readonly options: ObservedProjectorOptions) {}
  get session(): Session { return this.current }
  get projectedKeys(): ReadonlySet<string> { return this.rowKeys }
  rewindLocalId(id: string): string | undefined { return this.rewindIds.get(id) }
  rewindLocalIdAtSeq(seq: number): string | undefined { return this.rewindSeqs.get(seq) }
  sourceMessageDisplaySeq(id: string): number | undefined { return this.sourceSeqs.get(id) }

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
          for (const [sourceCallId, call] of this.tools) {
            if (call.step.turn !== this.turn || call.progressPhase !== 'progress' || call.progress === undefined) continue
            this.recordProgress({ callId: call.id, sourceCallId, toolName: call.name, sourceRowId: item.rowId,
              createdAt: item.createdAt, turn: call.step.turn, step: call.step.step,
              phase: 'turn-ended', payload: call.progress, reason: item.reason })
            call.progressPhase = 'turn-ended'
          }
          for (const step of this.steps) this.closeStep(step)
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
      this.ensureTurn()
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
        const step = this.nextStep()
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
        const step = this.nextStep()
        const id = ToolCallId(`hapi-observed:${this.options.scopeId ?? 'root'}:${this.turn}:${item.callId}`)
        const args = typeof item.input === 'string' ? item.input : JSON.stringify(item.input)
        event = this.append('assistant/message', { turn: step.turn, step: step.step,
          message: this.assistant(item, [{ type: 'tool-call', id, name: item.name, arguments: args }]), stream: [] }, { surfaceOp: 'append' })
        this.append('tool/call', { turn: step.turn, step: step.step, callId: id, name: item.name, arguments: args })
        this.tools.set(item.callId, { id, step, key: item.key, name: item.name })
        this.updateToolProgress(item)
      } else {
        this.responseInTurn = true
        const call = this.tools.get(item.callId)
        const step = call?.step ?? this.nextStep()
        const id = call?.id ?? ToolCallId(`hapi-observed:orphan:${this.options.scopeId ?? 'root'}:${item.callId}`)
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
  private ensureTurn(): void {
    if (this.open) return
    this.turn++; this.step = 0; this.open = true; this.responseInTurn = false
    this.append('turn/start', { turn: this.turn })
  }
  private nextStep(): Step {
    const step = { turn: this.turn, step: ++this.step, open: true }
    this.steps.push(step); this.append('step/start', { turn: step.turn, step: step.step }); return step
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
    const call = this.tools.get(item.callId)
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
    const value = { key: item.key, sourceRowId: item.rowId, sourceLocalId: item.localId, sourceSeq: item.seq,
      scopeId: item.scopeId, parentToolCallId: item.parentToolCallId, surfaceSeq }
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
    const step = live?.step, projectedText = item.reasoning ? item.text : stripNotifySummaryFooter(item.text)
    if (live && !projectedText.startsWith(live.text)) { this.abandonStream(); live = undefined }
    if (!live) {
      live = { item, step: step ?? this.nextStep(), attemptId: LlmAttemptId(`hapi-observed:${item.key}:${++this.revision}`),
        revision: this.revision, index: 0, text: '', records: [] }
      this.live = live
      this.options.stream({ type: 'start', attemptId: live.attemptId, revision: live.revision, turn: live.step.turn, step: live.step.step })
      this.chunk(live, { type: 'block-start', index: 0, blockType: item.reasoning ? 'reasoning' : 'text' })
    }
    const delta = projectedText.slice(live.text.length)
    if (delta) this.chunk(live, { type: item.reasoning ? 'reasoning-delta' : 'text-delta', index: 0, text: delta })
    live.text = projectedText; live.item = item
  }
  private chunk(live: Live, chunk: StreamChunk): void {
    const time = this.sourceTime
    live.records.push({ type: 'chunk', time, chunk })
    this.options.stream({ type: 'chunk', attemptId: live.attemptId, revision: live.revision, index: live.index++, time, chunk })
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
    this.options.stream({ type: 'end', attemptId: live.attemptId, revision: live.revision, index: live.index,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } })
    this.closeStep(live.step); this.live = undefined
  }
  abandonStream(): void {
    const live = this.live
    if (!live) return
    this.options.stream({ type: 'end', attemptId: live.attemptId, revision: live.revision, index: live.index, outcome: { kind: 'abandoned' } })
    this.live = undefined
  }
}
