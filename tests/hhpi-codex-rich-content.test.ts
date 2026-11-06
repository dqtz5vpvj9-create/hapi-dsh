/** Native media fixtures exercise the production projection, grants and immutable image store. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAttachments } from '../src/remote/codex-attachments.ts';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { nativeContentParts } from '../src/remote/codex-content.ts';
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts';
import type { NativeItem } from '../src/remote/codex-native.ts';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
const identity = { machineId: 'fixture', sourceId: 'native', engine: 'codex', nativeId: 'images' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Images', cwd: '/fixture', status: 'idle', updatedAt: 1, activeTurnId: null, pendingRequests: [], capabilities: { send: false, steer: false, cancel: false, approve: false, files: false } };
const cases: NativeItem[] = [
  { id: 'generated', type: 'imageGeneration', savedPath: '/fixture/generated.png', status: 'completed' },
  { id: 'embedded', type: 'imageGeneration', result: PNG, status: 'completed' },
  { id: 'mcp', type: 'mcpToolCall', server: 'fixture', tool: 'image', result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] } },
  { id: 'dynamic', type: 'dynamicToolCall', tool: 'image', contentItems: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${PNG}` }] },
  { id: 'function', type: 'functionCallOutput', name: 'fixture', output: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] },
];
for (const item of cases) test(`${item.type}/${item.id}: image output is readable answer content with a revocable conversation grant`, async () => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-rich-content-');
  const index = new SourceEventIndex(':memory:', session), lifetime = new AbortController(), ready = Promise.withResolvers<void>();
  const reads: string[] = [];
  const attachments = new CodexAttachments(index, join(directory, 'attachments', 'v1'), async path => { reads.push(path); return { dataBase64: PNG }; }, lifetime.signal, ({ turnId, itemId }) => {
    const state = history.itemState(turnId, itemId)!; history.acceptItem(session, turnId, state.item, state.completed); ready.resolve();
  });
  const history = new CodexHistory(index, { toolContent: (turnId, value) => attachments.content(turnId, value) });
  try {
    history.acceptItem(session, 'turn', item, true);
    const page = () => index.read({ sessionId: session.id, limit: 100 }).entries;
    assert.deepEqual(reads, [], 'indexing must not eagerly read image bytes');
    attachments.schedule(page()); await ready.promise;
    const content = page().flatMap(({ event }) => event.type === 'assistant/message' ? event.data.message.content : []);
    const image = content.find(block => block.type === 'image'); assert.ok(image && image.type === 'image');
    const resource = await attachments.read(`attachment:${image.attachment.attachmentId}`);
    assert.ok(resource, 'official gallery can load the authorized image');
    assert.deepEqual(reads, item.id === 'generated' ? ['/fixture/generated.png'] : []);
    await assert.rejects(attachments.read('/fixture/unrelated.png'), /referenced/);
    history.acceptItem(session, 'turn', { id: item.id, type: 'imageGeneration', status: 'failed', failure: 'Removed' }, true);
    await assert.rejects(attachments.read(`attachment:${image.attachment.attachmentId}`));
  } finally { lifetime.abort(); await attachments.dispose(); index.dispose(); await rm(directory, { recursive: true, force: true }); }
});
test('native plans retain an explicit plan marker and ordinary file paths do not create image access', () => {
  const index = new SourceEventIndex(':memory:', session), history = new CodexHistory(index);
  try {
    history.acceptItem(session, 'turn', { id: 'plan', type: 'plan', text: '1. Read\n2. Implement' }, true);
    assert.match(JSON.stringify(index.read({ sessionId: session.id }).entries), /<proposed_plan>/);
    assert.deepEqual(nativeContentParts({ id: 'path', type: 'agentMessage', text: '/fixture/private.png' }), []);
    assert.deepEqual(nativeContentParts({ id: 'tool', type: 'commandExecution', aggregatedOutput: '/fixture/private.png' }), []);
  } finally { index.dispose(); }
});
