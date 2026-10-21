import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { SourceAdminController } from '../src/client/source-admin-state.ts';
import type { SourceAdminApi, SourceAdminReceipt } from '../src/source-admin-types.ts';

test('a browser quota failure cannot dispatch a Hub setting mutation', async () => {
    let submissions = 0;
    const api = { sourceAdminOperation: async () => { submissions++; throw new Error('should not dispatch'); } } as unknown as SourceAdminApi;
    const controller = new SourceAdminController(api, 'hub', { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } });
    assert.equal(await controller.run({ kind: 'settings', values: { sessionSummaryInChat: true } }), null);
    assert.equal(submissions, 0); assert.match(controller.getSnapshot().error ?? '', /quota/);
    assert.equal(controller.canRun({ kind: 'settings', values: { sessionSummaryInChat: true } }), true);
});

test('closing and reopening settings recovers an unknown Runner restart without another POST', async () => {
    const memory = new Map<string, string>(), saved = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    const operationId = randomUUID(); let posts = 0, reads = 0;
    const receipt: SourceAdminReceipt = { operationId, hubId: 'hub', action: { kind: 'restart-runner', machineId: 'machine' }, status: 'indeterminate',
        createdAt: 1, updatedAt: 2, message: 'Lost source reply', settings: null, bundles: null, machine: null };
    const api = { sourceAdminOperation: async () => { posts++; throw new Error('browser disconnected'); },
        sourceAdminOperationRead: async () => { reads++; return { ok: true, value: receipt }; } } as unknown as SourceAdminApi;
    const controller = new SourceAdminController(api, 'hub', saved, () => operationId);
    await controller.run(receipt.action);
    const restored = new SourceAdminController(api, 'hub', saved); await restored.recover();
    assert.equal(posts, 1); assert.equal(reads, 2); assert.equal(restored.canRun(receipt.action), false);
    assert.equal(restored.canRun({ kind: 'machine-name', machineId: 'machine', displayName: 'a different setting' }), true);
    receipt.status = 'observed'; receipt.updatedAt = 3; await restored.inspect(operationId);
    assert.equal(restored.canRun(receipt.action), true); assert.equal(posts, 1);
});
