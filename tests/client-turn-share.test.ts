import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSnapshot, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { ConversationBinding, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import { loadShareTurn, shareImageScale, shareTurnOf } from '../src/client/turn-share-model.ts';

/** Public snapshot/history faces are fixtures; browser tests use actual DSH. */
function fixture(options: { complete?: boolean; closed?: boolean; advances?: boolean; exhausted?: boolean } = {}) {
    let complete = options.complete ?? true, first = complete ? 1 : 10, loads = 0, current = true;
    const abort = new AbortController();
    const turn = (): TurnLocation => ({ turn: 1, start: complete ? { seq: 1, time: 100, type: 'turn/start', data: { turn: 1 } } : undefined,
        end: { seq: 30, time: 200, type: 'turn/end', data: { turn: 1 } }, status: options.closed === false ? 'open' : 'closed', steps: [], data: {} } as unknown as TurnLocation);
    const snapshot = (): ChatSnapshot => {
        const location = { kind: 'turn' as const, turn: turn() };
        const nodes = [
            { key: 'question', kind: 'user', data: {}, location, visibility: 'visible' },
            { key: 'reply', kind: 'assistant-step', data: { finalNode: { messageId: 'original-final' } }, location, visibility: 'visible' },
            { key: 'other', kind: 'assistant-step', data: { finalNode: { messageId: 'different-turn' } }, location: { kind: 'turn', turn: { ...turn(), turn: 2 } }, visibility: 'visible' },
        ] as ChatConversationViewNode[];
        return { order: nodes.map(node => node.key), nodes: { values: () => nodes, get: (key: string) => nodes.find(node => node.key === key) } } as unknown as ChatSnapshot;
    };
    const window = () => ({ entries: [{ type: 'event', event: { seq: first } }], revision: loads, hasMore: options.exhausted !== true });
    const binding = { session: { loadOlder: async () => { loads++; if (options.advances !== false) { complete = true; first = 1; } } }, eventSource: { getSnapshot: window } } as unknown as SessionBinding;
    const conversation = { activate() {}, target: () => ({ getSnapshot: snapshot }) } as unknown as ConversationBinding;
    return { options: { binding, conversation, messageId: 'original-final', current: () => current, signal: abort.signal },
        snapshot, loads: () => loads, replace: () => { current = false; }, abort };
}

test('sharing follows the clicked final message and loads its missing beginning through the original session', async () => {
    const value = fixture({ complete: false });
    assert.equal(shareTurnOf(value.snapshot(), 'different-turn')?.turn, 2);
    assert.equal(shareTurnOf(value.snapshot(), 'missing'), undefined);
    const selected = await loadShareTurn(value.options);
    assert.deepEqual(selected, { turn: 1, startSeq: 1, endSeq: 30, time: 100, keys: ['question', 'reply'] });
    assert.equal(value.loads(), 1);
});

test('a soft-failed or exhausted history read cannot silently export a partial turn', async () => {
    const soft = fixture({ complete: false, advances: false });
    await assert.rejects(loadShareTurn(soft.options), /Earlier history could not be loaded/); assert.equal(soft.loads(), 1);
    const exhausted = fixture({ complete: false, exhausted: true });
    await assert.rejects(loadShareTurn(exhausted.options), /does not contain the beginning/); assert.equal(exhausted.loads(), 0);
});

test('source generation replacement, cancellation and active turns stop image preparation', async () => {
    const replaced = fixture(); replaced.replace(); await assert.rejects(loadShareTurn(replaced.options), /conversation changed/);
    const cancelled = fixture(); cancelled.abort.abort(); await assert.rejects(loadShareTurn(cancelled.options), { name: 'AbortError' });
    const running = fixture({ closed: false }); await assert.rejects(loadShareTurn(running.options), /Wait for this turn to finish/);
});

test('image dimensions stay readable within the 24 MP memory and browser canvas limits', () => {
    assert.equal(shareImageScale(960, 1200), 2);
    assert.equal(shareImageScale(1200, 20000), 1);
    assert.throws(() => shareImageScale(960, 40000), /too large/);
    assert.throws(() => shareImageScale(0, 400), /no visible content/);
});
