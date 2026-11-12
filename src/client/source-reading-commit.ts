/** Read-only bridge from an actual mounted official reader to application watermarks. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionEventLikeEntry, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatConversationViewNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AppReadPosition } from '../workspace/app-service-types.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
import type { WorkspacePaneNavigation } from './pane-navigation.ts'
import { resolveMountedChatForPane, subscribePaneMountedChat, type MountedChatControlV1 } from './mounted-chat-control.ts'

export interface SourceReadingCommit {
    hostId: string
    paneId: string
    sessionBinding: SessionBinding
    position: AppReadPosition
    at: number
}
export type SourceReadingCommitListener = (commit: SourceReadingCommit) => void
/** Shared Workspace UI scope owns this feed; it retains no transcript or reading state. */
export class SourceReadCommits {
    private readonly listeners = new Set<SourceReadingCommitListener>()
    private closed = false
    readonly publish: SourceReadingCommitListener = commit => {
        if (!this.closed) for (const listener of [...this.listeners]) listener(commit)
    }
    readonly subscribe = (listener: SourceReadingCommitListener): (() => void) => {
        if (this.closed) return () => {}
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }
    dispose(): void { this.closed = true; this.listeners.clear() }
}

function bodySequence(node: ChatConversationViewNode, entries: readonly SessionEventLikeEntry[]): number | undefined {
    // These are public Chat payload identities, not their fractional ordering anchors.
    const data = node.data as { seq?: number; finalNode?: { seq: number }; root?: { kind?: string; seq?: number; callId: string } }
    if (node.kind === 'assistant-step') return data.finalNode?.seq
    if (node.kind === 'user' || node.kind === 'steering' || node.kind === 'context' || node.kind === 'turn-trigger') return data.seq
    if (node.kind !== 'tool-call' || !data.root) return undefined
    if (data.root.kind === 'tool-result') return data.root.seq
    const call = entries.find(entry => entry.type === 'event' && entry.event.type === 'tool/call' && entry.event.data.callId === data.root!.callId)
    return call?.event.seq
}

/** Source identity must be backed by an actual event in this reader's accepted window. */
export function sourceReadingPosition(binding: SessionBinding, node: ChatConversationViewNode,
    entries: readonly SessionEventLikeEntry[], version?: string | null): { position: AppReadPosition; at: number } | undefined {
    if (node.visibility !== 'visible') return undefined
    const seq = bodySequence(node, entries)
    if (seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return undefined
    const entry = entries.find(entry => entry.type === 'event' && entry.event.seq === seq)
    if (!entry || !Number.isSafeInteger(entry.event.time) || entry.event.time < 0) return undefined
    if (!isSourceSessionId(binding.sessionId)) return { position: { kind: 'dsh', seq }, at: entry.event.time }
    const source = binding.session as typeof binding.session & {
        readingWindowPosition?(version: string, seq: number): { epoch: string; seq: number; at: number } | undefined
    }
    if (!version) return undefined
    const accepted = source.readingWindowPosition?.(version, seq)
    return accepted ? { position: { kind: 'hhpi', epoch: accepted.epoch, seq: accepted.seq }, at: accepted.at } : undefined
}

/** Subscribe only after the real occurrence is ready; never retain or navigate another view. */
export function bindSourceReadingCommits(ctx: Context, target: HTMLElement, reference: SessionReference,
    navigation: WorkspacePaneNavigation, available: () => boolean, publish: SourceReadingCommitListener): () => void {
    const binding = reference.binding, conversation = ctx.uiConversation.binding(binding), chat = conversation.target('chat')
    const document = target.ownerDocument, window = document.defaultView
    if (!window) return () => {}
    let stopped = false, frame: number | undefined, control: MountedChatControlV1 | undefined
    let stopControl = (): void => {}
    let last: string | undefined
    const active = (): boolean => {
        const state = navigation.state.getSnapshot()
        return !stopped && available() && target.isConnected && !target.hidden && state.visible && state.focused
            && document.visibilityState === 'visible' && !binding.session.getSnapshot().removed
            && !target.closest('[hidden],[aria-hidden="true"],[data-hapi-window-preparation]')
    }
    const sample = (): void => {
        frame = undefined
        if (!active() || !control) return
        // A released reference throws rather than yielding its old binding.
        try { if (reference.binding !== binding) return } catch { return }
        const reader = control.read()
        if (reader.revision === 0 || !reader.renderRevision || !control.renderedNode || reader.busy || !reader.following && !reader.anchor) return
        const view = conversation.readingView?.snapshot.getSnapshot()
        if (view && (view.phase !== 'ready' || view.busy || view.correction === 'failed')) return
        const entries = view?.entries ?? binding.eventSource.getSnapshot().entries
        const snapshot = chat.getSnapshot() as ChatSnapshot | undefined
        if (!snapshot) return
        const port = target.querySelector<HTMLElement>('[data-conversation-scroll]')
        if (!port || port.clientHeight <= 0 || port.clientWidth <= 0) return
        const box = port.getBoundingClientRect()
        // DOM rows prove that content, rather than a pre-read or catalog entry,
        // reached this viewport. Position remains owned by the official reader.
        const rows = [...port.querySelectorAll<HTMLElement>('[data-chat-node-key]')]
        let greatest: { position: AppReadPosition; at: number } | undefined
        for (const row of rows) {
            if (row.closest('[hidden],[aria-hidden="true"],[data-turn-process-hidden="true"]') || !row.getClientRects().length
                || window.getComputedStyle(row).visibility !== 'visible') continue
            const rect = row.getBoundingClientRect()
            if (rect.height <= 0 || rect.width <= 0 || rect.bottom <= Math.max(0, box.top)
                || rect.top >= Math.min(window.innerHeight, box.bottom) || rect.right <= Math.max(0, box.left)
                || rect.left >= Math.min(window.innerWidth, box.right)) continue
            const key = row.dataset.chatNodeKey, node = key && snapshot.nodes.get(key)
            if (!node || control.renderedNode(node.key) !== node) continue
            const read = sourceReadingPosition(binding, node, entries, view?.version)
            if (!read) continue
            if (!greatest || read.position.seq > greatest.position.seq) greatest = read
        }
        if (greatest) {
            const identity = JSON.stringify([greatest.position, greatest.at])
            if (identity !== last) {
                last = identity
                publish({ hostId: navigation.hostId, paneId: navigation.paneId, sessionBinding: binding, ...greatest })
            }
        }
    }
    const schedule = (): void => { if (!stopped && frame === undefined) frame = window.requestAnimationFrame(sample) }
    const mounted = (): void => {
        stopControl(); control = resolveMountedChatForPane(target)
        stopControl = control?.subscribe(schedule) ?? (() => {})
        schedule()
    }
    const stops = [subscribePaneMountedChat(target, mounted), navigation.state.subscribe(schedule), chat.subscribe(schedule),
        ...(conversation.readingView ? [conversation.readingView.snapshot.subscribe(schedule)] : [])]
    document.addEventListener('visibilitychange', schedule)
    mounted()
    return () => {
        if (stopped) return
        stopped = true
        if (frame !== undefined) window.cancelAnimationFrame(frame)
        stopControl(); for (const stop of stops) stop()
        document.removeEventListener('visibilitychange', schedule)
    }
}
