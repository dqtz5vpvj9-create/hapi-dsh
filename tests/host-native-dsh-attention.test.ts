import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types';
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm';
import type { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { NativeDshAttention } from '../src/workspace/native-dsh-attention.ts';
import type { SourceAttentionEvent } from '../src/workspace/notification-events.ts';
import { messageNodeTarget } from '../src/client/reading-anchor.ts';
import { officialChat } from './official-conversation-fixture.ts';

/** Real installed Session commit publication and Chat assembly; no model, browser, or history RPC. */
async function fixture(t: TestContext) {
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    let session!: Session;
    const owner = await ctx.plugin({ inject: ['sessions'], apply(scope: Context) {
        session = (scope.sessions as unknown as SessionStore).create(SessionId('notification-anchor-fixture'));
    } });
    const lifetime = new AbortController(), reader = new AbortController(), attention = new NativeDshAttention(lifetime.signal);
    const chat = officialChat(), committed: SessionEvent[] = [], notices: SourceAttentionEvent[] = [];
    chat.assembler.replaceWindow([], false); chat.assembler.activateTarget('chat'); chat.assembler.flush();
    ctx.on('session/event', (owner, event) => {
        if (owner !== session) return;
        committed.push(event); attention.accept(owner, event);
        chat.assembler.append({ type: 'event', event }); chat.assembler.flush();
    });
    const disposed: string[] = [];
    ctx.on('session/disposed', session => { disposed.push(session.id); attention.forget(session); });
    const stream = attention.attentionEvents(undefined, reader.signal)[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value?.replay, true);
    const collected = (async () => {
        try { for (;;) { const next = await stream.next(); if (next.done) return; notices.push(...next.value.events.map(value => value.event)); } }
        catch (error) { if (!reader.signal.aborted && !lifetime.signal.aborted) throw error; }
    })();
    t.after(async () => { reader.abort(); lifetime.abort(); await collected; await chat.close(); await ctx.fiber.dispose(); });
    const nodes = () => { const snapshot = chat.assembler.snapshot('chat'); return snapshot.order.map(key => snapshot.nodes.get(key)!).filter(Boolean); };
    return {
        ctx, session, owner, attention, committed, notices, lifetime, nodes, disposed, assembler: chat.assembler,
        async settle() { await setImmediate(); },
        user(text = 'user request') { return session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' }); },
        start(turn = 1) { session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 }); },
        assistant(text = 'assistant response', turn = 1, step = 1) {
            return session.append('assistant/message', { turn, step, stream: [], message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' });
        },
        call(id: string, turn = 1) { return session.append('tool/call', { turn, step: 1, callId: ToolCallId(id), name: 'fixture_tool', arguments: '{}' }); },
        ask(id: string, callId?: string) { return session.append('approval/asked', { id: ApprovalRequestId(id), toolName: 'fixture_tool', ...(callId === undefined ? {} : { callId: ToolCallId(callId) }) }); },
        end(turn = 1) { session.append('step/end', { turn, step: 1 }); return session.append('turn/end', { turn, reason: { kind: 'completed' } }); },
        assertAnchor(notice: SourceAttentionEvent, seq: number, kind: string) {
            assert.deepEqual(notice.position, { kind: 'dsh', seq });
            const node = nodes().find(value => value.anchorSeq === seq && value.kind === kind);
            assert.ok(node, `installed Chat has a ${kind} node at committed seq ${seq}`);
            assert.notEqual((node as typeof node & { visibility?: string }).visibility, 'hidden', 'a hidden Chat node is not a readable notification target');
        },
    };
}

test('native completion lands on the committed assistant node, never the log-only turn/end', async t => {
    const f = await fixture(t); f.start(); f.user(); const response = f.assistant(), ended = f.end(); await f.settle();
    assert.equal(f.notices.length, 1); const notice = f.notices[0]!;
    assert.equal(notice.kind, 'completed'); f.assertAnchor(notice, response.seq, 'assistant-step');
    assert.notEqual(notice.position.kind === 'dsh' && notice.position.seq, ended.seq);
    assert.ok(!f.nodes().some(node => node.anchorSeq === ended.seq));
    assert.strictEqual(f.committed.find(event => event.seq === response.seq), response, 'the observer uses the accepted Session event');
});

test('tool results and failure completion retain the actual original tool-call anchor', async t => {
    const f = await fixture(t); f.start(); f.user(); const call = f.call('tool-result-call');
    const result = f.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('tool-result-call'), content: [{ type: 'text', text: 'tool result' }], isError: false }) }, { surfaceOp: 'append' });
    f.session.append('step/end', { turn: 1, step: 1 });
    f.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'synthetic failure' } } });
    await f.settle(); assert.equal(f.notices.length, 1); assert.equal(f.notices[0]!.kind, 'failed');
    f.assertAnchor(f.notices[0]!, call.seq, 'tool-call');
    assert.ok(!f.nodes().some(node => node.anchorSeq === result.seq), 'the result updates the call rather than creating a new result anchor');
});

test('two approvals for the same tool retain separate audit identities and exact calls', async t => {
    const f = await fixture(t); f.start(); f.user(); const first = f.call('call-a'); f.ask('audit-a', 'call-a');
    const second = f.call('call-b'); f.ask('audit-b', 'call-b'); await f.settle();
    assert.equal(f.notices.length, 2); assert.deepEqual(f.notices.map(notice => notice.requestId), ['audit-a', 'audit-b']);
    f.assertAnchor(f.notices[0]!, first.seq, 'tool-call'); f.assertAnchor(f.notices[1]!, second.seq, 'tool-call');
    assert.equal(f.attention.requestState(f.session.id, 'audit-a'), 'pending'); assert.equal(f.attention.requestState(f.session.id, 'audit-b'), 'pending');
    f.session.append('approval/decided', { id: ApprovalRequestId('audit-a'), outcome: 'allowed-once' });
    assert.equal(f.attention.requestState(f.session.id, 'audit-a'), 'settled'); assert.equal(f.attention.requestState(f.session.id, 'audit-b'), 'pending');
    assert.equal(f.attention.requestState(f.session.id, 'call-b'), 'settled', 'the audit ID is not the call or waterfall UI identity');
    f.end(); assert.equal(f.attention.requestState(f.session.id, 'audit-b'), 'settled');
});

test('a new turn retires an undecided old approval even when no old turn/end was observed', async t => {
    const f = await fixture(t); f.start(); f.user(); f.call('old-call'); f.ask('old-audit', 'old-call');
    f.session.append('turn/start', { turn: 2 });
    assert.equal(f.attention.requestState(f.session.id, 'old-audit'), 'settled');
    f.session.append('approval/decided', { id: ApprovalRequestId('old-audit'), outcome: 'cancelled' });
    f.session.append('step/start', { turn: 2, step: 1 }); f.user('next request'); f.call('new-call', 2); f.ask('new-audit', 'new-call');
    assert.equal(f.attention.requestState(f.session.id, 'new-audit'), 'pending');
    f.session.append('approval/decided', { id: ApprovalRequestId('old-audit'), outcome: 'cancelled' });
    assert.equal(f.attention.requestState(f.session.id, 'new-audit'), 'pending', 'a late decision cannot settle another audit');
});

test('an approval without callId keeps a human message committed before turn/start as its exact readable boundary', async t => {
    const f = await fixture(t); const user = f.user(); f.start(); f.ask('no-call-audit'); await f.settle();
    assert.equal(f.notices.length, 1); f.assertAnchor(f.notices[0]!, user.seq, 'user');
    f.end(); await f.settle(); assert.equal(f.notices.length, 2); f.assertAnchor(f.notices[1]!, user.seq, 'user');
    f.start(2); f.ask('unmapped-audit', 'call-never-observed'); await f.settle();
    assert.equal(f.notices.length, 2, 'an unknown call ID never borrows an unrelated prior readable node');
});

test('empty and tool-declaration-only assistant messages do not replace a real earlier reading anchor', async t => {
    const f = await fixture(t); f.start(); f.user(); const visible = f.assistant();
    f.session.append('step/end', { turn: 1, step: 1 }); f.session.append('step/start', { turn: 1, step: 2 }); f.assistant('  \n ', 1, 2);
    f.session.append('step/end', { turn: 1, step: 2 }); f.session.append('step/start', { turn: 1, step: 3 });
    f.session.append('assistant/message', { turn: 1, step: 3, stream: [], message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: ToolCallId('not-executed'), name: 'fixture_tool', arguments: '{}' }] }) }, { surfaceOp: 'append' });
    f.session.append('step/end', { turn: 1, step: 3 }); f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await f.settle(); assert.equal(f.notices.length, 1); f.assertAnchor(f.notices[0]!, visible.seq, 'assistant-step');
});

test('a turn with only invisible assistant content cannot publish a false readable completion', async t => {
    const f = await fixture(t); f.start(); f.assistant(''); f.end(); await f.settle();
    assert.equal(f.notices.length, 0, 'no notification target exists for a hidden assistant placeholder');
    f.start(2); const user = f.user('second turn'); f.end(2); await f.settle();
    assert.equal(f.notices.length, 1); f.assertAnchor(f.notices[0]!, user.seq, 'user');
    f.start(3); f.end(3); await f.settle(); assert.equal(f.notices.length, 1, 'the next empty turn cannot reuse the preceding user');
});

test('an explicitly interrupted empty assistant remains the visible interrupted Chat node', async t => {
    const f = await fixture(t); f.start(); f.user();
    const interrupted = f.session.append('assistant/message', { turn: 1, step: 1, stream: [], interrupted: true, message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [] }) }, { surfaceOp: 'append' });
    f.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'interrupted fixture' } } });
    await f.settle(); assert.equal(f.notices.length, 1); f.assertAnchor(f.notices[0]!, interrupted.seq, 'assistant-step');
});

test('model-only replacement messages do not masquerade as new Chat input anchors', async t => {
    const f = await fixture(t); f.start(); const user = f.user();
    const replacement = f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'replacement model input' }] }),
        { surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq }, sourceEventSeqs: [user.seq] });
    f.ask('replacement-audit'); f.end(); await f.settle();
    assert.equal(f.notices.length, 2); for (const notice of f.notices) f.assertAnchor(notice, user.seq, 'user');
    assert.ok(!f.nodes().some(node => node.anchorSeq === replacement.seq));
});

test('source owner shutdown settles requests and rejects late committed callbacks', async t => {
    const f = await fixture(t); f.start(); f.user(); f.call('closing-call'); f.ask('closing-audit', 'closing-call');
    f.lifetime.abort(); assert.equal(f.attention.requestState(f.session.id, 'closing-audit'), 'settled');
    f.ask('late-audit', 'closing-call'); assert.equal(f.attention.requestState(f.session.id, 'late-audit'), 'settled');
});

test('the real Session owner fiber disposal forgets undecided approvals without needing approval/decided', async t => {
    const f = await fixture(t); f.start(); f.user(); f.call('disposed-call'); const asked = f.ask('disposed-audit', 'disposed-call');
    assert.equal(f.attention.requestState(f.session.id, 'disposed-audit'), 'pending');
    await f.owner.dispose();
    assert.deepEqual(f.disposed, [f.session.id]); assert.equal(f.attention.requestState(f.session.id, 'disposed-audit'), 'settled');
    assert.ok(!f.committed.some(event => event.type === 'approval/decided'));
    assert.throws(() => f.ask('after-disposal', 'disposed-call'), /cannot append outside a SessionStore/, 'the installed Session also refuses new writes after removal');
    f.attention.accept(f.session, asked);
    assert.equal(f.attention.requestState(f.session.id, 'disposed-audit'), 'settled', 'a queued callback for the removed owner cannot restore pending state');
});

test('late disposal of an old owner cannot clear a new native Session with the same ID', async t => {
    const f = await fixture(t); f.start(); f.user(); f.call('old-owner-call'); f.ask('old-owner-audit', 'old-owner-call');
    assert.throws(() => (f.ctx.sessions as unknown as SessionStore).create(f.session.id), /already exists/, 'the installed store refuses concurrent live owners of one ID');
    await f.owner.dispose();
    let next!: Session;
    await f.ctx.plugin({ inject: ['sessions'], apply(scope: Context) { next = (scope.sessions as unknown as SessionStore).create(f.session.id); } });
    f.ctx.on('session/event', (session, event) => { if (session === next) f.attention.accept(session, event); });
    next.append('turn/start', { turn: 1 }); next.append('step/start', { turn: 1, step: 1 });
    next.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('new-owner-call'), name: 'fixture_tool', arguments: '{}' });
    next.append('approval/asked', { id: ApprovalRequestId('new-owner-audit'), toolName: 'fixture_tool', callId: ToolCallId('new-owner-call') });
    f.attention.forget(f.session);
    assert.equal(f.attention.requestState(next.id, 'new-owner-audit'), 'pending');
    assert.equal(f.attention.requestState(next.id, 'old-owner-audit'), 'settled');
});

test('an active streamed tool row keeps its transient Chat anchor while the notification retains the durable call position', async t => {
    const f = await fixture(t); f.start(); const user = f.user();
    // Public transient-entry boundary, exactly as the pinned controller orders
    // one streamed delta in the gap after this committed user. No Host event is forged.
    const assembler = f.assembler as unknown as Pick<ConversationNodeAssembler, 'append' | 'flush'>;
    assembler.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: user.seq + 0.5, time: Date.now(),
        data: { attemptId: 'streamed-tool-attempt' as LlmAttemptId, turn: 1, step: 1,
            chunk: { type: 'tool-call-delta', index: 0, id: ToolCallId('streamed-call'), name: 'fixture_tool', argumentsDelta: '{}' } } } });
    assembler.flush(); const call = f.call('streamed-call'); f.ask('streamed-audit', 'streamed-call'); await f.settle();
    assert.equal(f.notices.length, 1); assert.deepEqual(f.notices[0]!.position, { kind: 'dsh', seq: call.seq });
    const row = f.nodes().find(node => node.kind === 'tool-call'); assert.ok(row);
    assert.equal(row.anchorSeq, user.seq + 0.5);
    assert.equal((row.data as typeof row.data & { root: { callId: string } }).root.callId, 'streamed-call');
    assert.notEqual(row.anchorSeq, call.seq, 'an already mounted streamed tool must be located by its exact call identity');
    const entries = f.committed.map(event => ({ type: 'event' as const, event }));
    assert.equal(messageNodeTarget({ nodes: { values: f.nodes } }, call.seq, entries)?.key, row.key);
    const cold = officialChat(); t.after(() => cold.close());
    cold.assembler.replaceWindow(entries, false);
    cold.assembler.activateTarget('chat'); cold.assembler.flush();
    const snapshot = cold.assembler.snapshot('chat');
    assert.ok(snapshot.order.some(key => snapshot.nodes.get(key)?.kind === 'tool-call' && snapshot.nodes.get(key)?.anchorSeq === call.seq),
        'a cold committed window still lands on the original durable call, never an audit ID or fabricated fractional seq');
    const coldNodes = () => snapshot.order.map(key => snapshot.nodes.get(key)!).filter(Boolean);
    assert.equal(messageNodeTarget({ nodes: { values: coldNodes } }, call.seq, entries)?.key, row.key);
});

test('a warm assistant is located by its real finalNode.seq while hidden and log-only events remain unlocatable', async t => {
    const f = await fixture(t); f.start(); const user = f.user();
    const assembler = f.assembler as unknown as Pick<ConversationNodeAssembler, 'append' | 'flush'>;
    assembler.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: user.seq + 0.5, time: Date.now(),
        data: { attemptId: 'streamed-answer-attempt' as LlmAttemptId, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'assistant response' } } } });
    assembler.flush(); const answer = f.assistant();
    const entries = () => f.committed.map(event => ({ type: 'event' as const, event }));
    const row = f.nodes().find(node => node.kind === 'assistant-step'); assert.ok(row); assert.notEqual(row.anchorSeq, answer.seq);
    assert.equal(messageNodeTarget({ nodes: { values: f.nodes } }, answer.seq, entries())?.key, row.key);
    const ended = f.end(); assert.equal(messageNodeTarget({ nodes: { values: f.nodes } }, ended.seq, entries()), undefined);
    f.start(2); const hidden = f.assistant(' ', 2);
    assert.equal(messageNodeTarget({ nodes: { values: f.nodes } }, hidden.seq, entries()), undefined);
    assert.equal(messageNodeTarget({ nodes: { values: f.nodes } }, answer.seq + 100, entries()), undefined, 'an unknown original cannot choose a nearby row');
});
