/** Source-owned queue snapshots projected into the official Conversation QueueDock. */
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionRequestId, QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteSourceSession } from './remote-sessions.ts'
import type { SourceEntry } from '../remote/protocol.ts'
import { nativeQueueItem, queueIntent, type NativeQueueItem } from './remote-native-task-state.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { QUEUED_STEER_METHOD, QUEUE_VIEW_METHOD } from '../remote/codex-access.ts'
import { boundedSourceRead } from './remote-read-recovery.ts'
import { nativeQuestionReplies, sourceQuestion, sourceQuestionCallId } from '../shared/native-async-questions.ts'
import { sourceControlOperationId } from '../shared/source-operation-policy.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface QueueActions { readonly edit: boolean; readonly remove: boolean; readonly steer: boolean; readonly start?: boolean; readonly editText?: string; readonly delivery?: NativeQueueItem['delivery'] }
export interface SourceQueueSnapshot { readonly inbox: InboxState; readonly actions: Readonly<Record<string, QueueActions>> }

export class RemoteNativeQueue {
    private readonly lifetime = new AbortController()
    private readonly assertAuthorization: () => void
    private rows: readonly NativeQueueItem[] = []
    private readonly consumed = new Set<string>()
    private readonly starting = new Map<string, NativeQueueItem>()
    private snapshot: SourceQueueSnapshot | undefined
    private boundarySeq = -1
    private readFlight: Promise<void> | undefined
    private dirty = false
    private disposed = false
    private readError: unknown
    private readonly stopActions: () => void
    constructor(private readonly session: RemoteSourceSession, private readonly api: Pick<HhpiRemoteApi, 'nativeCall'>, private readonly publish: (snapshot: SourceQueueSnapshot) => void) {
        this.assertAuthorization = session.nativeActions!.captureAuthorization(session.sessionId)
        this.stopActions = session.nativeActions!.subscribe(() => { this.pendingChanged(); void this.refresh() })
    }
    private current(): void { this.lifetime.signal.throwIfAborted(); this.assertAuthorization() }
    /** Native body identity owns the handoff, even when a queue read settles late. */
    observe(entries: readonly SourceEntry[]): void {
        let boundary = this.boundarySeq, changed = false
        for (const { event } of entries) if (event.type === 'user/message') {
            boundary = Math.max(boundary, event.seq)
            const source = event.data.source
            if ('rpcId' in source && typeof source.rpcId === 'string' && !this.consumed.has(source.rpcId)) {
                this.consumed.add(source.rpcId)
                for (const [id, row] of this.starting) if (row.clientUserMessageId === source.rpcId) this.starting.delete(id)
                changed = true
            }
        } else if (event.type === 'turn/start' || event.type === 'turn/end') boundary = Math.max(boundary, event.seq)
        if (changed && this.snapshot) this.emit(this.snapshot)
        if (boundary > this.boundarySeq) { this.boundarySeq = boundary; void this.refresh() }
    }
    private emit(snapshot: SourceQueueSnapshot): void {
        this.snapshot = snapshot
        const actions = { ...snapshot.actions }
        const composer = this.session.nativeActions!.get(this.session.sessionId, 'composer')
        for (const pending of this.session.getSnapshot().pendingSubmissions) if (pending.placement === 'queued') {
            const saved = this.session.deliveries.getSnapshot().find(entry => entry.operation.operationId === pending.requestId)
            actions[pending.requestId] = { edit: false, remove: false, steer: false,
                delivery: saved?.state === 'rejected' ? 'failed' : saved && ['confirming', 'accepted', 'owner-accepted'].includes(saved.state)
                    || composer?.phase === 'confirming' || composer?.phase === 'accepted' ? 'confirming' : 'sending' }
        }
        this.publish({ ...snapshot, actions, inbox: { ...snapshot.inbox, 'next-turn': snapshot.inbox['next-turn'].filter(message =>
            !('rpcId' in message.source) || !this.consumed.has(String(message.source.rpcId))) } })
    }
    pendingChanged(): void { this.emit(this.snapshot ?? { inbox: { 'next-turn': [], 'next-step': [] }, actions: {} }) }
    /** Coalesce source metadata, native receipt and history refreshes under the shared Session. */
    refresh = (): Promise<void> => {
        if (this.disposed || sourceIsOffline(this.session.metadata.getSnapshot())) return Promise.resolve()
        this.dirty = true
        if (this.readFlight) return this.readFlight
        const work = (async () => {
            while (this.dirty && !this.disposed) {
                this.dirty = false
                try {
                    this.current()
                    const directory = this.session.sourceDirectory(), metadata = this.session.metadata.getSnapshot()
                    if (!directory) return
                    const capabilities = await boundedSourceRead(signal => directory.capabilities(signal), this.lifetime.signal); this.current()
                    if (capabilities.methods['thread/queue/list'] !== 'read') return
                    const method = capabilities.methods[QUEUE_VIEW_METHOD] === 'read' ? QUEUE_VIEW_METHOD : 'thread/queue/list'
                    if (!this.api.nativeCall) throw new Error('The native source queue is unavailable.')
                    const rows: NativeQueueItem[] = [], cursors = new Set<string>()
                    let cursor: string | null = null
                    do {
                        const response = await boundedSourceRead(signal => this.api.nativeCall!({ sourceId: metadata.sourceId, method,
                            params: { threadId: metadata.nativeId, cursor, limit: 100 } }, signal), this.lifetime.signal)
                        this.current()
                        if (!response.ok) throw response.error
                        if (response.value.status !== 'accepted') throw new Error(response.value.message)
                        const page = response.value.result
                        if (!record(page) || !Array.isArray(page.data)) throw new Error('The source returned an invalid queue page.')
                        rows.push(...page.data.map(nativeQueueItem))
                        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
                        if (cursor && cursors.has(cursor)) throw new Error('The source queue cursor did not advance.')
                        if (cursor) cursors.add(cursor)
                    } while (cursor)
                    // Native start removes its item before the live body reaches this
                    // Session. Keep that original input in the native dock, without
                    // adding it back to the source queue or forging a body receipt.
                    for (const [id, row] of this.starting) if (!this.consumed.has(row.clientUserMessageId) && !rows.some(item => item.clientUserMessageId === row.clientUserMessageId)) {
                        const action = this.session.nativeActions!.get(this.session.sessionId, queueIntent(id))
                        if (action?.phase === 'rejected') this.starting.delete(id)
                        else rows.push({ ...row, delivery: action?.phase === 'confirming' ? 'confirming' : 'sending' })
                    }
                    this.rows = Object.freeze(rows)
                    this.readError = undefined
                    // The official question consumer recognizes its typed Inbox
                    // reply and yields the composer until admission/cancellation.
                    // Keep the current native question revision and immutable RPC
                    // identity; plain text or another client's input is not proof.
                    const questionCallIds = new Map<string, string>()
                    for (const request of metadata.pendingRequests) {
                        const question = sourceQuestion(request)
                        if (!question) continue
                        const matching = rows.filter(row => row.input.some(part => nativeQuestionReplies(part.type === 'text' ? part.text : undefined)
                            .some(reply => reply.questionItemId === request.id && reply.question === question.question)))
                        if (!matching.length) continue
                        const callId = sourceQuestionCallId(request)
                        const clientId = await sourceControlOperationId(this.session.sessionId, 'approve', callId)
                        this.current()
                        for (const row of matching) if (row.clientUserMessageId === clientId) questionCallIds.set(row.id, callId)
                    }
                    const actions: Record<string, QueueActions> = {}
                    const messages: UserMessage[] = rows.map(row => {
                        const local = this.session.getSnapshot().pendingSubmissions.find(item => item.requestId === row.clientUserMessageId)
                        const replies = row.input.flatMap(part => nativeQuestionReplies(part.type === 'text' ? part.text : undefined))
                        const replyText = replies.map(reply => `${reply.question}\n${reply.answer}`).join('\n')
                        if (local) this.session.updateQueuedSubmissionText(row.clientUserMessageId, row.input.flatMap(part =>
                            part.type === 'text' ? [String(part.text ?? '')] : part.type === 'skill' || part.type === 'mention' ? [String(part.name ?? '')] : []).join(''))
                        actions[row.id] = { edit: replies.length === 0 && !row.delivery && !row.resumeOperationId && capabilities.methods['thread/queue/update'] === 'write',
                            remove: !row.delivery && !row.resumeOperationId && capabilities.methods['thread/queue/delete'] === 'write',
                            steer: !row.delivery && capabilities.methods[QUEUED_STEER_METHOD] === 'write'
                                && (!!row.resumeOperationId && !!row.resumeTurnId || metadata.capabilities.steer && !!metadata.activeTurnId),
                            start: !row.delivery && !row.resumeOperationId && metadata.status === 'idle' && !metadata.activeTurnId
                                && metadata.capabilities.send && capabilities.methods['thread/queue/start'] === 'write',
                            ...(row.delivery ? { delivery: row.delivery } : {}),
                            editText: replies.length ? replyText : row.input.flatMap(part => part.type === 'text' ? [String(part.text ?? '')] : []).join('') }
                        return { id: row.id as MessageId, role: 'user', source: questionCallIds.has(row.id)
                            ? { kind: 'user-question-reply', callId: questionCallIds.get(row.id)! as ToolCallId, outcome: 'answered', rpcId: row.clientUserMessageId as SessionRequestId }
                            : { kind: 'user', rpcId: row.clientUserMessageId as SessionRequestId },
                            content: replies.length ? [{ type: 'text', text: replyText }] : row.input.flatMap(part => part.type === 'text' ? [{ type: 'text' as const, text: String(part.text ?? '') }]
                                : part.type === 'skill' || part.type === 'mention' ? [{ type: 'text' as const, text: String(part.name ?? '') }]
                                    : local?.attachments.length ? [] : [{ type: 'text' as const, text: 'Image attachment' }]) }
                    })
                    this.emit({ inbox: { 'next-turn': messages, 'next-step': [] }, actions })
                } catch (error) {
                    this.readError = error
                    // Keep the last source-confirmed rows during a failed read.
                    // Explicit actions report their own source outcome.
                    try { this.current() } catch {
                        this.publish({ inbox: { 'next-turn': [], 'next-step': [] }, actions: {} })
                        this.dispose()
                    }
                }
            }
        })().finally(() => { if (this.readFlight === work) this.readFlight = undefined })
        this.readFlight = work
        return work
    }
    async update(itemId: MessageId, action: QueueAction): Promise<void> {
        this.current()
        if (action.kind === 'start' && this.starting.has(itemId)) {
            const prior = await this.session.nativeActions!.recover(this.session.sessionId, queueIntent(itemId))
            this.current(); await this.refresh()
            if (prior?.phase === 'accepted') return
            if (prior?.phase !== 'rejected') throw new Error('The original send result is not confirmed yet.')
            this.starting.delete(itemId)
        }
        const original = this.rows.find(row => row.id === itemId)
        if (!original || this.consumed.has(original.clientUserMessageId)) throw new Error('This message has already left the source queue.')
        await this.refresh(); this.current()
        if (this.readError !== undefined) throw new Error('The source queue could not be checked. The original message was kept.')
        const current = this.rows.find(row => row.id === itemId)
        if (!current || this.consumed.has(current.clientUserMessageId) || current.clientUserMessageId !== original.clientUserMessageId || JSON.stringify(current.input) !== JSON.stringify(original.input))
            throw new Error('This queued message changed or has started. The original was not added again.')
        if (current.delivery) throw new Error('This message is being sent or awaiting source confirmation. The original input has been kept.')
        if (current.resumeOperationId && action.kind !== 'steer') throw new Error('Continue sending this original message before changing it.')
        const metadata = this.session.metadata.getSnapshot(), directory = this.session.sourceDirectory()
        if (sourceIsOffline(metadata) || !directory) throw new Error('The source queue is offline.')
        const method = action.kind === 'steer' ? QUEUED_STEER_METHOD : action.kind === 'start' ? 'thread/queue/start' : action.kind === 'remove' ? 'thread/queue/delete' : 'thread/queue/update'
        const capabilities = await directory.capabilities(this.lifetime.signal); this.current()
        if (capabilities.methods[method] !== 'write') throw new Error('The source does not support this queue action.')
        if (action.kind === 'steer' && (capabilities.methods[QUEUED_STEER_METHOD] !== 'write'
            || !(current.resumeOperationId && current.resumeTurnId) && (!metadata.capabilities.steer || !metadata.activeTurnId)))
            throw new Error('The source running turn is not available for this queued message.')
        if (action.kind === 'start' && (metadata.status !== 'idle' || metadata.activeTurnId || !metadata.capabilities.send))
            throw new Error('The source is no longer idle. Its queued messages were kept.')
        if (action.kind === 'edit' && current.input.some(part => nativeQuestionReplies(part.type === 'text' ? part.text : undefined).length))
            throw new Error('This answer belongs to its original question.')
        if (action.kind === 'edit' && !action.content.some(part => part.text.trim())) throw new Error('Enter text for this queued message.')
        // The native owner retains every attachment, skill and mention. Only the
        // text edited by QueueDock is replaced; display labels never become input.
        let inserted = false
        const editedText = action.kind === 'edit' ? action.content.map(part => part.text).join('') : ''
        const input = current.input.flatMap(part => {
            if (part.type !== 'text') return [part]
            if (inserted) return []
            inserted = true
            return [{ ...part, text: editedText, text_elements: [] }]
        })
        if (!inserted) input.unshift({ type: 'text', text: editedText, text_elements: [] })
        if (action.kind === 'start') this.starting.set(itemId, current)
        const result = await this.session.nativeActions!.submit({ sessionId: this.session.sessionId,
            intent: current.resumeOperationId && action.kind === 'steer' ? `${queueIntent(itemId)}:resume:${current.resumeOperationId}` : queueIntent(itemId), kind: 'queue', newAttempt: true,
            request: { sourceId: metadata.sourceId, method, params: { threadId: metadata.nativeId, queuedSubmissionId: itemId,
                ...(action.kind === 'steer' ? { expectedTurnId: current.resumeTurnId ?? metadata.activeTurnId, clientUserMessageId: current.clientUserMessageId, input: current.input,
                    ...(current.resumeOperationId ? { resumeOperationId: current.resumeOperationId } : {}) } : {}),
                ...(action.kind === 'edit' ? { input } : {}) } } }).catch(error => {
                const saved = this.session.nativeActions!.get(this.session.sessionId, queueIntent(itemId))
                if (action.kind === 'start' && (saved?.request.method !== 'thread/queue/start' || saved.phase === 'prepared')) this.starting.delete(itemId)
                throw error
            })
        this.current()
        if (action.kind === 'start' && result.phase === 'rejected') this.starting.delete(itemId)
        await this.refresh()
        if (result.phase !== 'accepted') throw new Error(result.outcome?.message ?? 'The original queue action is waiting for confirmation.')
        if (action.kind === 'remove') {
            if (result.outcome?.queueDeleted === false) throw new Error('This message has already left the source queue. It was not removed or sent again.')
            this.consumed.add(current.clientUserMessageId)
            if (this.snapshot) this.emit(this.snapshot)
            this.session.retireQueuedSubmission(current.clientUserMessageId)
        } else if (action.kind === 'edit') this.session.updateQueuedSubmissionText(current.clientUserMessageId, input.flatMap(part =>
            part.type === 'text' ? [String(part.text ?? '')] : part.type === 'skill' || part.type === 'mention' ? [String(part.name ?? '')] : []).join(''))
        await this.refresh()
    }
    dispose(): void { this.disposed = true; this.lifetime.abort(); this.stopActions() }
}
