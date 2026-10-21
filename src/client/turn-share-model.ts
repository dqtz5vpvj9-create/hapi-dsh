import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ConversationBinding, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client';

export interface ShareTurnSelection {
    turn: number;
    startSeq: number;
    endSeq: number;
    time: number;
    keys: readonly string[];
}
export const SHARE_MAX_PIXELS = 24_000_000;
export const SHARE_MAX_MEDIA = 8 * 1024 * 1024;

/** Resolve the actual final message, never the focused or latest turn. */
export function shareTurnOf(snapshot: ChatSnapshot | undefined, messageId: string): TurnLocation | undefined {
    if (!snapshot) return undefined;
    for (const node of snapshot.nodes.values()) {
        if (node.kind !== 'assistant-step' || !node.data || typeof node.data !== 'object') continue;
        const final = Reflect.get(node.data, 'finalNode');
        if (!final || typeof final !== 'object' || Reflect.get(final, 'messageId') !== messageId) continue;
        if (node.location.kind === 'turn' || node.location.kind === 'step') return node.location.turn;
    }
    return undefined;
}

/** A soft-failed DSH history read must never yield an apparently complete image. */
export async function loadShareTurn(options: {
    binding: Pick<SessionBinding, 'session' | 'eventSource'>;
    conversation: Pick<ConversationBinding, 'target' | 'activate'>;
    messageId: string;
    current(): boolean;
    signal: AbortSignal;
}): Promise<ShareTurnSelection> {
    const { binding, conversation, messageId, signal } = options;
    const assertCurrent = () => {
        signal.throwIfAborted();
        if (!options.current()) throw new Error('The conversation changed while preparing this turn. Open Share again from the original message.');
    };
    assertCurrent(); conversation.activate('chat');
    const source = conversation.target('chat');
    const initialCount = binding.eventSource.getSnapshot().entries.length;
    for (let page = 0; page <= 100; page++) {
        assertCurrent();
        const snapshot = source.getSnapshot(), turn = shareTurnOf(snapshot, messageId);
        if (!snapshot || !turn) throw new Error('The original message is no longer in this conversation.');
        if (turn.status !== 'closed' || !turn.end) throw new Error('Wait for this turn to finish before sharing it.');
        const before = binding.eventSource.getSnapshot();
        if (turn.start) {
            const keys = snapshot.order.filter(key => {
                const node = snapshot.nodes.get(key);
                return node?.visibility === 'visible' && node.kind !== 'turn-process'
                    && (node.location.kind === 'turn' || node.location.kind === 'step') && node.location.turn.turn === turn.turn;
            });
            if (keys.length > 3000 || before.entries.filter(entry => entry.event.seq >= turn.start!.seq && entry.event.seq <= turn.end!.seq).length > 10_000) {
                throw new Error('This turn is too large for one image. Copy the original messages instead.');
            }
            return { turn: turn.turn, startSeq: turn.start.seq, endSeq: turn.end.seq, time: turn.start.time, keys };
        }
        if (!before.hasMore) throw new Error('The source history does not contain the beginning of this turn. A partial image was not exported.');
        if (page === 100 || before.entries.length - initialCount > 10_000) throw new Error('This turn exceeds the history export limit. A partial image was not exported.');
        const first = before.entries[0]?.event.seq;
        await binding.session.loadOlder(); assertCurrent();
        const after = binding.eventSource.getSnapshot();
        if (after.entries[0]?.event.seq === first && after.hasMore) {
            throw new Error('Earlier history could not be loaded. Retry after the connection recovers; a partial image was not exported.');
        }
    }
    throw new Error('The complete turn could not be loaded.');
}

export function shareImageScale(width: number, height: number): number {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The export has no visible content.');
    // Avoid silently downscaling a very long turn to unreadable text.
    if (width * height > SHARE_MAX_PIXELS || width > 16_000 || height > 32_000) throw new Error('This turn is too large for a readable image. Copy its messages instead.');
    return Math.min(2, Math.sqrt(SHARE_MAX_PIXELS / (width * height)), 32_000 / height, 16_000 / width);
}
