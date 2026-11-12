/** Committed native events supply notification positions; no directory or transcript polling. */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import type {} from '@deepseek-ai/dsh-user-approval/types';
import { SourceAttentionAggregateJournal, attentionFromDshEvent, type SourceAttentionSourceFeed } from './notification-events.ts';

interface Turn { lastReadable?: number; openingUser?: number; started: boolean; calls: Map<string, number> }

/** Pinned Chat hides empty text/reasoning and tool declarations; an interrupted row remains visible. */
function readableAssistant(event: SessionEvent<'assistant/message'>): boolean {
    return isAppendSurfaceEvent(event) && (event.data.interrupted === true || event.data.message.content.some(block => {
        if (block.type === 'tool-call') return false;
        return block.type !== 'text' && block.type !== 'reasoning' || block.text.trim() !== '';
    }));
}
export class NativeDshAttention implements SourceAttentionSourceFeed {
    private readonly journal: SourceAttentionAggregateJournal;
    private readonly turns = new WeakMap<object, Turn>();
    private readonly forgotten = new WeakSet<object>();
    private readonly pending = new Map<string, { owner: object; ids: Set<string> }>();
    constructor(private readonly lifetime: AbortSignal) {
        this.journal = new SourceAttentionAggregateJournal(lifetime);
        lifetime.addEventListener('abort', () => this.pending.clear(), { once: true });
    }
    attentionEvents: SourceAttentionSourceFeed['attentionEvents'] = (cursor, signal) => this.journal.attentionEvents(cursor, signal);
    requestState(sessionId: string, requestId: string): 'pending' | 'settled' {
        return this.pending.get(sessionId)?.ids.has(requestId) ? 'pending' : 'settled';
    }
    /** Called from native session/disposed; an old owner cannot revive a request after removal. */
    forget(session: { id: string }): void {
        this.retireRequests(session);
        this.turns.delete(session);
        this.forgotten.add(session);
    }
    accept(session: { id: string }, event: SessionEvent): void {
        if (this.lifetime.aborted || this.forgotten.has(session)) return;
        let turn = this.turns.get(session);
        if (!turn || event.type === 'turn/start') {
            // An input may be committed before its opening boundary. Only that
            // unclaimed input crosses turn/start, never an older turn's body.
            const openingUser = turn?.openingUser;
            turn = { calls: new Map(), started: event.type === 'turn/start',
                ...(openingUser === undefined ? {} : { lastReadable: openingUser }) };
            this.turns.set(session, turn);
            if (event.type === 'turn/start') this.retireRequests(session);
        }
        if (event.type === 'step/start') turn.started = true;
        if (event.type === 'user/message' && isAppendSurfaceEvent(event)) {
            turn.lastReadable = event.seq;
            if (!turn.started) turn.openingUser = event.seq;
        } else if (event.type === 'assistant/message' && readableAssistant(event) || event.type === 'tool/call') {
            turn.lastReadable = event.seq;
            if (event.type === 'tool/call') turn.calls.set(event.data.callId, event.seq);
        }
        if (event.type === 'approval/decided') {
            const pending = this.pending.get(session.id);
            if (pending?.owner === session) {
                pending.ids.delete(event.data.id);
                if (!pending.ids.size) this.pending.delete(session.id);
            }
        } else if (event.type === 'approval/asked') {
            let pending = this.pending.get(session.id);
            if (pending?.owner !== session) this.pending.set(session.id, pending = { owner: session, ids: new Set() });
            pending.ids.add(event.data.id);
            // Audit IDs and the browser waterfall's UI keys are different. The
            // notification keeps the audit identity and lands on its real call.
            const seq = event.data.callId ? turn.calls.get(event.data.callId) : turn.lastReadable;
            if (seq !== undefined) this.journal.publish(session.id, { id: JSON.stringify(['approval/asked', event.data.id]),
                kind: 'request', requestId: event.data.id, position: { kind: 'dsh', seq }, createdAt: event.time });
        } else if (event.type === 'turn/end') {
            if (turn.lastReadable !== undefined) {
                const notice = attentionFromDshEvent(event, { kind: 'dsh', seq: turn.lastReadable });
                if (notice) this.journal.publish(session.id, notice);
            }
            this.retireRequests(session); this.turns.delete(session);
        }
    }
    private retireRequests(session: { id: string }): void {
        if (this.pending.get(session.id)?.owner === session) this.pending.delete(session.id);
    }
}
