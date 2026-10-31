/** Synthetic native items pass through the production source index and pinned DSH validators. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts';

const identity = { machineId: 'fixture', sourceId: 'native', engine: 'codex', nativeId: 'thread' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Rendering fixture', cwd: '/workspace',
    updatedAt: 1000, status: 'idle', activeTurnId: null, pendingRequests: [],
    capabilities: { send: false, steer: false, cancel: false, approve: false, files: false } };

function fixture(): { index: SourceEventIndex; history: CodexHistory } {
    const index = new SourceEventIndex(':memory:', session);
    return { index, history: new CodexHistory(index) };
}
function entries(index: SourceEventIndex) { return index.read({ sessionId: session.id, limit: 500 }).entries; }
const textOf = (content: readonly ContentBlock[]): string => content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');

test('native command completion keeps action semantics, exit status and one stable DSH call', () => {
    const { index, history } = fixture();
    try {
        const native = { id: 'command', type: 'commandExecution', command: "/bin/bash -lc 'cat src/main.ts'", cwd: '/workspace',
            commandActions: [{ type: 'read', name: 'main.ts', path: '/workspace/src/main.ts' }], status: 'inProgress', aggregatedOutput: null, exitCode: null };
        history.acceptItem(session, 'turn', native, false);
        const before = entries(index), originalCall = before.find(value => value.event.type === 'tool/call')!;
        assert.equal(before.some(value => value.event.type === 'tool/result'), false);
        history.acceptItem(session, 'turn', { ...native, status: 'completed', aggregatedOutput: 'Permission denied', exitCode: 2, durationMs: 75 }, true);
        const after = entries(index), calls = after.filter(value => value.event.type === 'tool/call');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], originalCall, 'completion reuses the original call and source coordinates');
        assert.equal(calls[0]!.event.type, 'tool/call');
        if (calls[0]!.event.type !== 'tool/call') throw new Error('Expected the validated call');
        assert.deepEqual(JSON.parse(calls[0]!.event.data.arguments).commandActions, native.commandActions);
        const result = after.find(value => value.event.type === 'tool/result')!;
        if (result.event.type !== 'tool/result') throw new Error('Expected the validated result');
        assert.deepEqual(JSON.parse(textOf(result.event.data.message.content)), { output: 'Permission denied', exitCode: 2, durationMs: 75 });
        assert.equal(result.event.data.message.isError, true);
        history.acceptItem(session, 'turn', native, false);
        assert.deepEqual(entries(index), after, 'late started notifications cannot erase an exit code or completed output');
    } finally { index.dispose(); }
});

test('native file changes and subagent activity reach structured official tool nodes', () => {
    const { index, history } = fixture();
    try {
        const changes = [{ path: '/workspace/src/main.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }];
        history.acceptItem(session, 'turn', { id: 'patch', type: 'fileChange', changes, status: 'completed' }, true);
        history.acceptItem(session, 'turn', { id: 'activity-call-id', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child-thread',
            agentPath: '/root/checker', model: 'fixture-model', reasoningEffort: 'high' }, true);
        const page = entries(index), calls = page.flatMap(value => value.event.type === 'tool/call' ? [value.event.data] : []);
        assert.deepEqual(JSON.parse(calls[0]!.arguments).changes, changes);
        assert.equal(calls[1]!.name, 'codex.subAgentActivity');
        assert.equal(JSON.parse(calls[1]!.arguments).agentPath, '/root/checker');
        assert.equal(JSON.parse(calls[1]!.arguments).kind, 'completed');
        assert.equal(page.some(value => value.event.type === 'assistant/message'
            && value.event.data.message.content.some(part => part.type === 'text' && part.text.includes('[Native'))), false,
            'an activity never becomes a placeholder paragraph in the assistant answer');
    } finally { index.dispose(); }
});

test('MCP and dynamic tools preserve readable content and native failures', () => {
    const { index, history } = fixture();
    try {
        history.acceptItem(session, 'turn', { id: 'mcp', type: 'mcpToolCall', server: 'files', tool: 'read', arguments: { path: '/fixture' },
            status: 'failed', result: null, error: { message: 'File unavailable' } }, true);
        history.acceptItem(session, 'turn', { id: 'dynamic', type: 'dynamicToolCall', namespace: 'fixture', tool: 'lookup', arguments: { query: 'record' },
            status: 'completed', success: false, contentItems: [{ type: 'inputText', text: 'No matching record' }] }, true);
        history.acceptItem(session, 'turn', { id: 'structured', type: 'mcpToolCall', server: 'fixtures', tool: 'stats', arguments: {},
            status: 'completed', result: { content: [{ type: 'text', text: 'One record found' }], structuredContent: { count: 1 } } }, true);
        const results = entries(index).flatMap(value => value.event.type === 'tool/result' ? [value.event.data.message] : []);
        assert.deepEqual(results.slice(0, 2).map(message => textOf(message.content)), ['File unavailable', 'No matching record']);
        assert.deepEqual(results.slice(0, 2).map(message => message.isError), [true, true]);
        assert.match(textOf(results[2]!.content), /One record found/);
        assert.match(textOf(results[2]!.content), /"count": 1/);
    } finally { index.dispose(); }
});

test('late image preparation enriches the existing user and read_image result without new message identities', () => {
    const index = new SourceEventIndex(':memory:', session);
    let prepared: ContentBlock[] | undefined;
    const history = new CodexHistory(index, { userContent: () => prepared, toolContent: () => prepared });
    const user = { id: 'user', type: 'userMessage', content: [{ type: 'localImage', path: '/fixture/image.png' }] };
    const view = { id: 'view', type: 'imageView', path: '/fixture/image.png' };
    try {
        history.acceptItem(session, 'turn', user, true);
        history.acceptItems(session, [{ turnId: 'turn', item: view, startedAtMs: 2000, completedAtMs: 7000 }], true);
        const before = entries(index), seqs = before.map(value => value.event.seq);
        const call = before.find(value => value.event.type === 'tool/call')!;
        if (call.event.type !== 'tool/call') throw new Error('Expected read_image');
        assert.equal(call.event.data.name, 'read_image', 'the official read_image entry owns its attachment-gallery slot');
        assert.deepEqual(JSON.parse(call.event.data.arguments), { file_path: '/fixture/image.png' });
        prepared = [{ type: 'text', text: 'Prepared attachment fixture' }];
        history.acceptItem(session, 'turn', user, true);
        history.acceptItem(session, 'turn', view, true);
        const after = entries(index);
        assert.deepEqual(after.map(value => value.event.seq), seqs);
        assert.deepEqual(after.map(value => value.event.time), before.map(value => value.event.time), 'loading a preview preserves the source completion timestamp');
        const contents = after.flatMap(value => value.event.type === 'user/message' ? [value.event.data.content]
            : value.event.type === 'tool/result' ? [value.event.data.message.content] : []);
        assert.deepEqual(contents, [prepared, prepared]);
        assert.equal(JSON.stringify(after).includes('[Native image'), false);
    } finally { index.dispose(); }
});

test('generated image transport bytes and known non-tool records never become raw placeholder paragraphs', () => {
    const { index, history } = fixture();
    try {
        history.acceptItem(session, 'turn', { id: 'generation', type: 'imageGeneration', status: 'completed', result: 'base64-transport-bytes', revisedPrompt: 'A synthetic image', savedPath: '/fixture/generated.png', failure: null }, true);
        history.acceptItem(session, 'turn', { id: 'review', type: 'exitedReviewMode', review: 'No findings.' }, true);
        history.acceptItem(session, 'turn', { id: 'hook', type: 'hookPrompt', fragments: [{ text: 'Source context', hookRunId: 'hook-id' }] }, true);
        const wire = JSON.stringify(entries(index));
        assert.equal(wire.includes('base64-transport-bytes'), false);
        assert.equal(wire.includes('[Native'), false);
        assert.ok(wire.includes('No findings.'));
        assert.ok(wire.includes('Source context'));
    } finally { index.dispose(); }
});
