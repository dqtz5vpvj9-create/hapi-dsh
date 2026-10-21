import type { Context } from '@deepseek-ai/cordis';
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import { remoteValue, type HapiRemoteApi } from '../client-api.ts';

declare module '@deepseek-ai/cordis' { interface Context { hapiMessageNavigation: SourceMessageNavigation } }

/** Anchors surround the actual official user row; no transcript is rendered twice. */
export class SourceMessageNavigation {
    private readonly anchors = new Map<string, Set<HTMLElement>>();
    private current: AbortController | undefined;
    constructor(private readonly ctx: Context, private readonly api: HapiRemoteApi) {}

    anchor(sessionId: string, seq: number, element: HTMLElement): () => void {
        const key = JSON.stringify([sessionId, seq]);
        const entries = this.anchors.get(key) ?? new Set(); entries.add(element); this.anchors.set(key, entries);
        return () => { entries.delete(element); if (!entries.size) this.anchors.delete(key); };
    }
    private element(sessionId: string, seq: number): HTMLElement | undefined {
        return [...this.anchors.get(JSON.stringify([sessionId, seq])) ?? []].find(element => element.isConnected && element.getClientRects().length > 0);
    }
    async reveal(sessionId: SessionId, sourceMessageId: string, signal?: AbortSignal): Promise<void> {
        this.current?.abort(); const controller = new AbortController(); this.current = controller;
        const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const located = remoteValue(await this.api.sourceLocateMessage({ sessionId, sourceMessageId }));
        lifetime.throwIfAborted();
        if (located.sessionId !== sessionId) throw new Error('The source history changed. Reopen its current conversation before navigating.');
        if (located.seq === null) throw new Error('This source message has not been observed in the conversation yet.');
        const binding = this.ctx.sessions.binding(sessionId);
        if (!binding) throw new Error('The conversation is no longer open in this pane.');
        const seq = located.seq;
        await binding.session.loadThrough(seq as SessionSeq);
        lifetime.throwIfAborted();
        if (this.ctx.sessions.binding(sessionId) !== binding) throw new Error('The conversation was replaced while loading history.');
        // React owns the rows. Wait for its pending layout commit, never insert
        // copied source text into the official transcript to manufacture a hit.
        for (let frame = 0; frame < 12; frame++) {
            lifetime.throwIfAborted();
            const element = this.element(sessionId, seq);
            if (element) {
                element.scrollIntoView({ block: 'center', behavior: 'auto' });
                element.tabIndex = -1; element.focus({ preventScroll: true });
                element.animate?.([{ outline: '2px solid var(--color-primary, #6478dc)' }, { outline: '2px solid transparent' }], { duration: 1600 });
                return;
            }
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        throw new Error('The message is loaded, but this conversation view has not exposed its navigation anchor.');
    }
    dispose(): void { this.current?.abort(); this.anchors.clear(); }
}
