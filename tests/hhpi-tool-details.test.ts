/** Real source projection, SQLite byte ranges and native ownership; no browser or native execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { CodexToolDetails } from '../src/remote/codex-tool-details.ts';
import { nativeToolPresentation } from '../src/remote/codex-presentation.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { sourceSessionId, type SourceResource, type SourceSession } from '../src/remote/protocol.ts';
import { TOOL_DETAIL_CHUNK_BYTES, toolDetailEnvelope, toolDetailPageSchema, toolDetailPath, type ToolDetail } from '../src/shared/native-tool-detail.ts';

const identity = { machineId: 'synthetic', sourceId: 'native', engine: 'codex', nativeId: 'thread' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic large tool', cwd: '/synthetic', updatedAt: 2000,
    status: 'idle', activeTurnId: null, capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] };
const decode = (resource: SourceResource) => toolDetailPageSchema.parse(JSON.parse(Buffer.from(resource.content, 'base64').toString('utf8')));
function complete(details: CodexToolDetails, detail: ToolDetail): string {
    const chunks: Buffer[] = []; let offset: number | null = 0;
    while (offset !== null) {
        const page = decode(details.read(toolDetailPath(detail, offset)));
        const data = Buffer.from(page.bytesBase64, 'base64');
        assert.ok(data.length <= TOOL_DETAIL_CHUNK_BYTES);
        assert.equal(page.offset, offset); assert.equal(page.revision, detail.revision);
        chunks.push(data); offset = page.nextOffset;
    }
    return Buffer.concat(chunks).toString('utf8');
}

test('tool input/output larger than4MiB stay readable and their complete context fits a source page', () => {
    const index = new SourceEventIndex(':memory:', session), details = new CodexToolDetails(index);
    const history = new CodexHistory(index, { toolContent: (_turn, item) => nativeToolPresentation(item)?.content, toolPresentation: (turn, item, tool) => details.project(turn, item, tool) });
    const native = { id: 'giant', type: 'commandExecution', command: '输入🙂'.repeat(600_000), cwd: '/synthetic',
        aggregatedOutput: '输出🙂'.repeat(600_000), exitCode: 0, durationMs: 1000 };
    assert.ok(Buffer.byteLength(native.command) > 4 * 1024 * 1024);
    assert.ok(Buffer.byteLength(native.aggregatedOutput) > 4 * 1024 * 1024);
    try {
        history.beginTurn(session, { id: 'turn', status: 'inProgress', startedAt: 1 });
        history.acceptItem(session, 'turn', native, true);
        const result = index.read({ sessionId: session.id }).entries.find(entry => entry.event.type === 'tool/result')!;
        const page = index.read({ sessionId: session.id, around: result.event.seq, limit: 1 });
        assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) < 8 * 1024 * 1024);
        assert.deepEqual(page.entries.map(entry => entry.event.type), ['turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result']);
        const call = page.entries.find(entry => entry.event.type === 'tool/call')!.event;
        if (call.type !== 'tool/call' || result.event.type !== 'tool/result') throw new Error('Missing official tool records');
        const input = toolDetailEnvelope(JSON.parse(call.data.arguments))!;
        const outputText = result.event.data.message.content[0]!;
        if (outputText.type !== 'text') throw new Error('Missing typed tool preview');
        const output = toolDetailEnvelope(JSON.parse(outputText.text))!;
        assert.ok(input && output, 'both sides carry explicit source-authorized detail descriptors');
        assert.ok(Buffer.byteLength(input.preview) <= TOOL_DETAIL_CHUNK_BYTES);
        assert.deepEqual(JSON.parse(complete(details, input._hhpiDetail)), nativeToolPresentation(native)!.input);
        assert.deepEqual(JSON.parse(complete(details, output._hhpiDetail)), nativeToolPresentation(native)!.content);
        assert.deepEqual(history.itemState('turn', 'giant')!.item, native, 'display offloading does not alter the original native item');
        assert.throws(() => details.read(toolDetailPath({ ...input._hhpiDetail, revision: input._hhpiDetail.revision + 1 })), { code: 'STALE_VERSION' });
        const other = new SourceEventIndex(':memory:', { ...session, nativeId: 'other', id: sourceSessionId({ ...identity, nativeId: 'other' }) });
        try { assert.throws(() => new CodexToolDetails(other).read(toolDetailPath(input._hhpiDetail)), { code: 'INVALID_REQUEST' }); }
        finally { other.dispose(); }
        history.invalidateSuffix(session, ['turn']);
        assert.throws(() => details.read(toolDetailPath(input._hhpiDetail)), { code: 'INVALID_REQUEST' }, 'a real history rewrite revokes old detail grants');
        assert.throws(() => details.read('/etc/passwd'), { code: 'INVALID_REQUEST' });
    } finally { index.dispose(); }
});

test('ordinary tool revisions keep normal inline output and revoke replaced detail grants', () => {
    const index = new SourceEventIndex(':memory:', session), details = new CodexToolDetails(index);
    const history = new CodexHistory(index, { toolPresentation: (turn, item, tool) => details.project(turn, item, tool) });
    const native = { id: 'one', type: 'commandExecution', command: 'echo hello', aggregatedOutput: 'x'.repeat(600_000) };
    try {
        history.acceptItem(session, 'turn', native, false);
        // A completed update projects the output preview into a tool/result.
        history.acceptItem(session, 'turn', native, true);
        const result = index.read({ sessionId: session.id }).entries.find(entry => entry.event.type === 'tool/result')!.event;
        if (result.type !== 'tool/result' || result.data.message.content[0]!.type !== 'text') throw new Error('Missing native result');
        const detail = toolDetailEnvelope(JSON.parse(result.data.message.content[0]!.text))!._hhpiDetail;
        history.acceptItem(session, 'turn', { ...native, aggregatedOutput: 'small final correction' }, true);
        assert.match(JSON.stringify(index.read({ sessionId: session.id }).entries), /small final correction/);
        assert.throws(() => details.read(toolDetailPath(detail)), { code: 'INVALID_REQUEST' });
    } finally { index.dispose(); }
});


test('rare unaliased tools use a dedicated detail presentation only when offloaded', () => {
    const index = new SourceEventIndex(':memory:', session), details = new CodexToolDetails(index);
    const history = new CodexHistory(index, { toolPresentation: (turn, item, tool) => details.project(turn, item, tool) });
    try {
        const native = { id: 'image', type: 'imageGeneration', revisedPrompt: 'x'.repeat(600_000), status: 'completed' };
        history.acceptItem(session, 'turn', native, true);
        const page = index.read({ sessionId: session.id });
        const call = page.entries.find(entry => entry.event.type === 'tool/call')!.event;
        if (call.type !== 'tool/call') throw new Error('Missing native call');
        assert.equal(call.data.name, 'hhpi-native-tool-detail');
        const input = JSON.parse(call.data.arguments);
        assert.equal(input._hhpiSourceTool, 'codex.imageGeneration');
        const descriptor = toolDetailEnvelope(input)!._hhpiDetail;
        assert.equal(JSON.parse(complete(details, descriptor)).prompt, native.revisedPrompt);
        history.acceptItem(session, 'turn', { id: 'small', type: 'imageGeneration', revisedPrompt: 'A small image', status: 'completed' }, true);
        assert.ok(index.read({ sessionId: session.id }).entries.some(entry => entry.event.type === 'tool/call' && entry.event.data.name === 'codex.imageGeneration'));
        assert.deepEqual(history.itemState('turn', 'image')!.item, native);
    } finally { index.dispose(); }
});
