/** Original source transport is an explicit fixture; durable files and recovery are real. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SourceBulkActions, sourceBulkTargets } from '../src/hapi/source-bulk.ts';
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts';

const session = (id: string, changes: Partial<HapiSession> & { backgroundTaskCount?: number; pendingRequestKinds?: string[]; blockingRequestKinds?: string[] } = {}): HapiSession => ({
    id, namespace: 'fixture', createdAt: 100, seq: 1, active: true, activeAt: 200, thinking: false, thinkingAt: 0, updatedAt: 200,
    metadata: { flavor: 'codex', name: id, path: '/fixture', machineId: `machine-${id}` }, metadataVersion: 1, agentStateVersion: 1, agentState: {}, ...changes,
});
async function temporary(run: (directory: string) => Promise<void>) { const directory = await mkdtemp(join(tmpdir(), 'hapi-bulk-')); try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); } }

test('bulk Standard selects only confirmed source Fast/priority tiers and reports per-machine failures', () => temporary(async directory => {
    const rows = [session('fast', { serviceTier: 'fast' }), session('offline', { active: false, serviceTier: 'priority' }), session('standard', { serviceTier: 'standard' }), session('unset')];
    let reads = 0; const posts: string[] = [];
    const service = new SourceBulkActions({ hubId: 'original-hub', async listSessions() { reads++; return rows; }, async getSession(id) { return rows.find(row => row.id === id)!; },
        async request(path, options) { posts.push(path); assert.deepEqual(options?.body, { serviceTier: 'standard' }); if (path.includes('/offline/')) throw new HapiRequestError('Offline', 'rejected', 409); return { ok: true }; } }, directory);
    const operationId = randomUUID(), receipt = await service.operation({ operationId, action: 'standard' });
    assert.equal(reads, 1); assert.deepEqual(posts.sort(), ['/api/sessions/fast/service-tier', '/api/sessions/offline/service-tier']);
    assert.deepEqual(receipt.targets.map(row => [row.sourceSessionId, row.status]), [['fast', 'accepted'], ['offline', 'rejected']]);
    await service.operation({ operationId, action: 'standard' }); assert.equal(posts.length, 2); assert.equal(reads, 1);
    await assert.rejects(service.operation({ operationId, action: 'pause' }), /different input/u);
}));

test('Pause uses original activity precedence and includes running children and background tasks', () => {
    const rows = [session('root', { thinking: true }), session('child', { thinking: true, metadata: { path: '/fixture', codexParentThreadId: 'root' } }), session('idle'),
        session('background', { backgroundTaskCount: 2 }), session('permission', { thinking: true, pendingRequestKinds: ['permission'] }),
        session('nonblocking', { thinking: true, pendingRequestKinds: ['permission'], blockingRequestKinds: [] }),
        session('offline', { active: false, thinking: true }), session('error', { thinking: true, execution: { owner: 'fixture', generation: '1', sequence: 1, status: 'systemError', waitingOn: [], turnId: null, startedAt: null, completedAt: null } })];
    assert.deepEqual(sourceBulkTargets(rows, 'pause').map(row => row.id), ['root', 'child', 'background', 'nonblocking']);
});

test('source refresh failure performs no mutations; identity changes are rejected before dispatch', () => temporary(async directory => {
    let posts = 0;
    const service = new SourceBulkActions({ hubId: 'original-hub', async listSessions() { throw new Error('Disconnected'); }, async getSession() { throw new Error('Should not read'); }, async request() { posts++; } }, directory);
    const failed = await service.operation({ operationId: randomUUID(), action: 'pause' }); assert.equal(failed.state, 'failed'); assert.equal(posts, 0);
    const moved = new SourceBulkActions({ hubId: 'another-hub', async listSessions() { return [session('moved', { thinking: true })]; }, async getSession() { return session('moved', { thinking: true, metadata: { path: '/elsewhere', machineId: 'new-owner' } }); }, async request() { posts++; } }, directory);
    const receipt = await moved.operation({ operationId: randomUUID(), action: 'pause' }); assert.equal(receipt.targets[0]?.status, 'rejected'); assert.equal(posts, 0);
}));

test('a blocking approval arriving after selection is retained; a nonblocking request does not hide a running turn', () => temporary(async directory => {
    const running = session('running', { thinking: true }); let posts = 0;
    const service = new SourceBulkActions({ hubId: 'original-hub', async listSessions() { return [running]; },
        async getSession() { return { ...running, agentState: { requests: { approval: { tool: 'exec_command', arguments: {} } } } }; },
        async request() { posts++; return { ok: true }; } }, directory);
    const result = await service.operation({ operationId: randomUUID(), action: 'pause' });
    assert.equal(result.targets[0]?.status, 'skipped'); assert.equal(posts, 0);
    const nonblocking: HapiSession = { ...running, agentState: { requests: { nonblocking: { tool: 'exec_command', arguments: {}, blocking: false } } } };
    assert.equal(sourceBulkTargets([nonblocking], 'pause').length, 1);
}));

test('a missing source acknowledgement stays unknown across Host restart and read recovery never repeats abort', () => temporary(async directory => {
    let posts = 0; const source = session('running', { thinking: true });
    const transport = { hubId: 'original-hub', async listSessions() { return [source]; }, async getSession() { return source; }, async request() { posts++; throw new HapiRequestError('Lost acknowledgement', 'indeterminate', 502); } };
    const first = new SourceBulkActions(transport, directory), operation = { operationId: randomUUID(), action: 'pause' as const };
    assert.equal((await first.operation(operation)).targets[0]?.status, 'unknown');
    const restarted = new SourceBulkActions(transport, directory); assert.equal(restarted.read(operation.operationId)?.targets[0]?.status, 'unknown');
    await restarted.operation(operation); assert.equal(posts, 1);
}));
