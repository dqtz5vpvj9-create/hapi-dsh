import type { Context } from '@deepseek-ai/cordis';
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import { remoteValue, type HapiRemoteApi } from '../client-api.ts';
import { messageNodeTarget, placeReadingAnchor, revealChatElement } from './reading-anchor.ts';
import { loadHistoryThrough } from './history-navigation.ts';
import { sourceMessageForSequence, sourceSequenceForMessage } from './source-event-order.ts';
import type { SourceViewportSession } from './source-sessions.ts';

declare module '@deepseek-ai/cordis' { interface Context { hapiMessageNavigation: SourceMessageNavigation } }

/** Anchors surround the actual official user row; no transcript is rendered twice. */
export class SourceMessageNavigation {
    private readonly anchors = new Map<string, Set<HTMLElement>>();
    private readonly current = new Map<HTMLElement | string, AbortController>();
    constructor(private readonly ctx: Context, private readonly api: HapiRemoteApi) {}

    anchor(sessionId: string, seq: number, element: HTMLElement): () => void {
        const key = JSON.stringify([sessionId, seq]);
        const entries = this.anchors.get(key) ?? new Set(); entries.add(element); this.anchors.set(key, entries);
        return () => { entries.delete(element); if (!entries.size) this.anchors.delete(key); };
    }
    private element(sessionId: string, seq: number, clicked: WeakSet<HTMLElement>, root?: HTMLElement): HTMLElement | undefined {
        const anchored = [...this.anchors.get(JSON.stringify([sessionId, seq])) ?? []].find(element => element.isConnected
            && element.getClientRects().length > 0 && !element.closest('[hidden], [data-hapi-visible="false"]') && (!root || root.contains(element)));
        if (anchored || !root) return anchored;
        const binding = this.ctx.sessions.binding(sessionId as SessionId);
        const target = binding && messageNodeTarget(this.ctx.uiConversation.binding(binding).target('chat').getSnapshot(), seq);
        return target ? revealChatElement(root, target, clicked) : undefined;
    }
    async sourceAnchor(sessionId: SessionId, seq: number): Promise<string | null> {
        const entries = this.ctx.sessions.binding(sessionId)?.eventSource.getSnapshot().entries
        const sourceMessageId = entries && sourceMessageForSequence(entries, seq)
        if (sourceMessageId) return sourceMessageId
        return remoteValue(await this.api.sourceReadingAnchor({ sessionId, seq })).sourceMessageId;
    }
    async locate(sessionId: SessionId, sourceMessageId: string, signal?: AbortSignal): Promise<{ sessionId: SessionId; seq: SessionSeq }> {
        const entries = this.ctx.sessions.binding(sessionId)?.eventSource.getSnapshot().entries
        const resident = entries && sourceSequenceForMessage(entries, sourceMessageId)
        if (resident !== undefined) return { sessionId, seq: resident as SessionSeq }
        const session = this.ctx.sessions.binding(sessionId)?.session as SourceViewportSession | undefined;
        const seq = await session?.loadSourceMessage?.(sourceMessageId, signal);
        signal?.throwIfAborted();
        if (seq === undefined) throw new Error('The source message is no longer available in this conversation.');
        return { sessionId, seq };
    }
    async reveal(sessionId: SessionId, sourceMessageId: string, signal?: AbortSignal, root?: HTMLElement): Promise<void> {
        const located = await this.locate(sessionId, sourceMessageId, signal);
        if (located.sessionId !== sessionId) throw new Error('The source history changed. Reopen its current conversation before navigating.');
        return this.revealSequence(sessionId, located.seq, signal, root);
    }
    async revealSequence(sessionId: SessionId, seq: SessionSeq, signal?: AbortSignal, root?: HTMLElement): Promise<void> {
        const scope = root ?? sessionId;
        this.current.get(scope)?.abort();
        const controller = new AbortController(); this.current.set(scope, controller);
        const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        try {
            const binding = this.ctx.sessions.binding(sessionId);
            if (!binding) throw new Error('The conversation is no longer open in this pane.');
            await loadHistoryThrough(binding.session, seq, lifetime, () => this.ctx.sessions.binding(sessionId) === binding);
            lifetime.throwIfAborted();
            if (this.ctx.sessions.binding(sessionId) !== binding) throw new Error('The conversation was replaced while loading history.');
            // Public Chat nodes cover assistant and Tool lifecycles. Folded
            // process rows open through official browser-find/disclosure DOM
            // controls in this occurrence, never through private view stores.
            const clicked = new WeakSet<HTMLElement>();
            let previous: { element: HTMLElement; top: number; height: number } | undefined;
            for (let frame = 0; frame < 90; frame++) {
                lifetime.throwIfAborted();
                const element = this.element(sessionId, seq, clicked, root);
                if (element) {
                    const box = element.getBoundingClientRect();
                    if (previous?.element === element && Math.abs(previous.top - box.top) < .5 && Math.abs(previous.height - box.height) < .5) {
                        const scrollport = element.closest<HTMLElement>('[data-conversation-scroll]');
                        // A completed process has its own capped scrollport.
                        // Reveal the exact inner row before positioning the
                        // outer conversation, so a late Tool does not remain clipped.
                        for (let parent = element.parentElement; parent && parent !== scrollport; parent = parent.parentElement) {
                            if (parent.hasAttribute('data-step-process-body')) placeReadingAnchor(parent, element);
                        }
                        if (scrollport) placeReadingAnchor(scrollport, element);
                        else element.scrollIntoView({ block: 'center', behavior: 'auto' });
                        element.tabIndex = -1; element.focus({ preventScroll: true });
                        element.animate?.([{ outline: '2px solid var(--hapi-focus, #6478dc)' }, { outline: '2px solid transparent' }], { duration: 1600 });
                        return;
                    }
                    previous = { element, top: box.top, height: box.height };
                } else previous = undefined;
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            }
            throw new Error('The message is loaded, but its official row could not be revealed. Retry navigation after the conversation finishes loading.');
        } finally { if (this.current.get(scope) === controller) this.current.delete(scope); }
    }
    dispose(): void {
        for (const controller of this.current.values()) controller.abort();
        this.current.clear(); this.anchors.clear();
    }
}
