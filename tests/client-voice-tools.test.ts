import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceToolDispatcher, type VoiceToolOwner } from '../src/client/source-voice/tools.ts';
import type { VoiceContext } from '../src/client/source-voice/context.ts';

function context(approvals: VoiceContext['approvals'] = []): VoiceContext {
    return { sessionId: 'original-session', title: 'Original source', agentLabel: 'Codex', active: true, thinking: false, epoch: 1, hasEarlier: false,
        messages: [], approvals, plan: { bootstrap: 'Source history', streamChunks: [], truncated: false, totalMessages: 0, messagesInBootstrap: 0, messagesStreamed: 0, notice: null } };
}
function fixture() {
    const sent: string[] = [], answers: string[] = [];
    const source = { context: context(), fail: false, observed: 'unknown' as 'submitted' | 'rejected' | 'unknown', alive: true };
    const owner: VoiceToolOwner = { current() { if (!source.alive) throw new Error('Original pane closed'); }, readContext: async () => structuredClone(source.context),
        async submit(message, _signal, identified) { const id = `durable-request-${sent.length + 1}`; identified(id); sent.push(message); if (source.fail) throw new Error('Socket disconnected after send'); },
        answer: async (id, decision) => { answers.push(`${id}:${decision}`); }, inspect: () => source.observed };
    const abort = new AbortController(), dispatcher = new VoiceToolDispatcher(owner, abort.signal);
    return { source, owner, sent, answers, abort, dispatcher };
}

test('voice tools preserve real call identity while allowing a later identical user command', async () => {
    const f = fixture(), call = { id: 'wire-1', name: 'messageCodingAgent', args: { message: 'Run the tests' } };
    const [first, duplicate] = await Promise.all([f.dispatcher.call(call), f.dispatcher.call(call)]);
    assert.equal(first, duplicate); assert.match(first, /admission, not task completion/); assert.deepEqual(f.sent, ['Run the tests']);
    assert.match(await f.dispatcher.call({ ...call, args: { message: 'Delete a different file' } }), /different arguments/);
    await f.dispatcher.call({ ...call, id: 'wire-2' }); assert.deepEqual(f.sent, ['Run the tests', 'Run the tests']);
    assert.notEqual(f.dispatcher.receipts()[0]?.requestId, f.dispatcher.receipts()[1]?.requestId);
});

test('an unknown voice send reads original admission and never automatically replays its mutation', async () => {
    const f = fixture(); f.source.fail = true;
    const call = { id: 'call-unknown', name: 'messageCodingAgent', args: { message: 'Apply the migration' } };
    assert.match(await f.dispatcher.call(call), /unknown outcome/);
    assert.match(await f.dispatcher.call(call), /unknown outcome/);
    assert.match(await f.dispatcher.call({ ...call, id: 'different-id-same-command' }), /still unconfirmed/); assert.equal(f.sent.length, 1);
    f.source.observed = 'submitted'; f.dispatcher.reconcile();
    assert.match(await f.dispatcher.call(call), /No duplicate request was sent/); assert.equal(f.sent.length, 1);
    f.source.fail = false; await f.dispatcher.call({ ...call, id: 'explicit-next-tool-call' }); assert.equal(f.sent.length, 2);
});

test('voice approval targets the exact single advertised request and rejects stale or structured questions', async () => {
    const f = fixture(), approval = { id: 'permission-1', tool: 'exec_command', context: 'Run tests?', answerable: true };
    f.source.context = context([approval]); f.dispatcher.advertise(structuredClone(f.source.context));
    f.source.context.approvals[0]!.id = 'permission-2';
    assert.match(await f.dispatcher.call({ id: 'allow-old', name: 'processPermissionRequest', args: { decision: 'allow' } }), /pending approval changed/);
    assert.deepEqual(f.answers, []);
    f.dispatcher.advertise(structuredClone(f.source.context));
    assert.match(await f.dispatcher.call({ id: 'deny-current', name: 'processPermissionRequest', args: { decision: 'deny' } }), /request permission-2/);
    assert.deepEqual(f.answers, ['permission-2:deny']);
    f.source.context = context([{ ...approval, tool: 'request_user_input', answerable: false }]); f.dispatcher.advertise(f.source.context);
    assert.match(await f.dispatcher.call({ id: 'question', name: 'processPermissionRequest', args: { decision: 'allow' } }), /structured questions/);
    assert.deepEqual(f.answers, ['permission-2:deny']);
});

test('queued voice callbacks cannot dispatch after the connection closes', async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.owner.submit; f.owner.submit = async (...args) => { await original(...args); await gate; };
    const first = f.dispatcher.call({ id: 'first', name: 'messageCodingAgent', args: { message: 'First admitted command' } });
    await new Promise<void>(resolve => setImmediate(resolve));
    const second = f.dispatcher.call({ id: 'second', name: 'messageCodingAgent', args: { message: 'Never dispatch after close' } });
    f.dispatcher.dispose(); f.abort.abort(); release(); await first;
    assert.match(await second, /voice session has ended/); assert.deepEqual(f.sent, ['First admitted command']);
});

test('voice argument validation and lost source ownership cannot reach a tool mutation', async () => {
    const f = fixture();
    for (const input of [ { id: 'empty', name: 'messageCodingAgent', args: { message: '' } }, { id: 'missing', name: 'messageCodingAgent', args: null },
        { id: 'invalid-approval', name: 'processPermissionRequest', args: { decision: 'approve-all' } }, { id: 'unknown', name: 'deleteWorkspace', args: {} } ]) {
        assert.match(await f.dispatcher.call(input), /^error/);
    }
    f.source.alive = false; assert.match(await f.dispatcher.call({ id: 'closed', name: 'messageCodingAgent', args: { message: 'Wrong source' } }), /Original pane closed/);
    assert.equal(f.sent.length, 0); assert.equal(f.answers.length, 0);
});
