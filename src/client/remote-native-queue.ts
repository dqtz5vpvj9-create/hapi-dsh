/** Source-owned queue snapshots projected into the official Conversation QueueDock. */
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionRequestId, QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteSourceSession } from './remote-sessions.ts'
import type { SourceEntry } from '../remote/protocol.ts'
import { nativeQueueItem, queueIntent, type NativeQueueItem } from './remote-native-task-state.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { QUEUED_STEER_METHOD, QUEUE_VIEW_METHOD } from '../remote/codex-access.ts'
import { boundedSourceRead } from './remote-read-recovery.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface QueueActions { readonly edit: boolean; readonly remove: boolean; readonly steer: boolean; readonly editText?: string; readonly delivery?: NativeQueueItem['delivery'] }
export interface SourceQueueSnapshot { readonly inbox: InboxState; readonly actions: Readonly<Record<string, QueueActions>> }

export class RemoteNativeQueue {
    private readonly lifetime = new AbortController()
    private readonly assertAuthorization: () => void
    private rows: readonly NativeQueueItem[] = []
    private readonly consumed = new Set<string>()
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
            if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string' && !this.consumed.has(source.rpcId)) { this.consumed.add(source.rpcId); changed = true }
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
                    this.rows = Object.freeze(rows)
                    this.readError = undefined
                    const actions: Record<string, QueueActions> = {}
                    const messages: UserMessage[] = rows.map(row => {
                        const local = this.session.getSnapshot().pendingSubmissions.find(item => item.requestId === row.clientUserMessageId)
                        if (local) this.session.updateQueuedSubmissionText(row.clientUserMessageId, row.input.flatMap(part =>
                            part.type === 'text' ? [String(part.text ?? '')] : part.type === 'skill' || part.type === 'mention' ? [String(part.name ?? '')] : []).join(''))
                        actions[row.id] = { edit: !row.delivery && !row.resumeOperationId && capabilities.methods['thread/queue/update'] === 'write',
                            remove: !row.delivery && !row.resumeOperationId && capabilities.methods['thread/queue/delete'] === 'write',
                            steer: !row.delivery && capabilities.methods[QUEUED_STEER_METHOD] === 'write'
                                && (!!row.resumeOperationId && !!row.resumeTurnId || metadata.capabilities.steer && !!metadata.activeTurnId),
                            ...(row.delivery ? { delivery: row.delivery } : {}),
                            editText: row.input.flatMap(part => part.type === 'text' ? [String(part.text ?? '')] : []).join('') }
                        return { id: row.id as MessageId, role: 'user', source: { kind: 'user', rpcId: row.clientUserMessageId as SessionRequestId },
                            content: row.input.flatMap(part => part.type === 'text' ? [{ type: 'text' as const, text: String(part.text ?? '') }]
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
        const method = action.kind === 'steer' ? QUEUED_STEER_METHOD : action.kind === 'remove' ? 'thread/queue/delete' : 'thread/queue/update'
        const capabilities = await directory.capabilities(this.lifetime.signal); this.current()
        if (capabilities.methods[method] !== 'write') throw new Error('The source does not support this queue action.')
        if (action.kind === 'steer' && (capabilities.methods[QUEUED_STEER_METHOD] !== 'write'
            || !(current.resumeOperationId && current.resumeTurnId) && (!metadata.capabilities.steer || !metadata.activeTurnId)))
            throw new Error('The source running turn is not available for this queued message.')
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
        const result = await this.session.nativeActions!.submit({ sessionId: this.session.sessionId,
            intent: current.resumeOperationId && action.kind === 'steer' ? `${queueIntent(itemId)}:resume:${current.resumeOperationId}` : queueIntent(itemId), kind: 'queue', newAttempt: true,
            request: { sourceId: metadata.sourceId, method, params: { threadId: metadata.nativeId, queuedSubmissionId: itemId,
                ...(action.kind === 'steer' ? { expectedTurnId: current.resumeTurnId ?? metadata.activeTurnId, clientUserMessageId: current.clientUserMessageId, input: current.input,
                    ...(current.resumeOperationId ? { resumeOperationId: current.resumeOperationId } : {}) } : {}),
                ...(action.kind === 'edit' ? { input } : {}) } } })
        this.current()
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
