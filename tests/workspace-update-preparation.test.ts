/** Public embedding update contract; plugins below are explicit callback fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceUpdatePreparations } from '../src/client/update-preparation.ts';

test('all editor writes finish before verification and concurrent update clicks share one transaction', async () => {
    const updates = createWorkspaceUpdatePreparations(), calls: string[] = [];
    let resolve!: () => void;
    updates.register('file', async () => { calls.push('file-start'); await new Promise<void>(done => { resolve = done; }); calls.push('file-saved'); });
    updates.register('conversation', () => { calls.push('conversation-saved'); });
    updates.register('verify', () => { assert.ok(calls.includes('file-saved')); assert.ok(calls.includes('conversation-saved')); calls.push('verified'); }, 'verify');
    const first = updates.checkpoint(), second = updates.checkpoint();
    assert.equal(first, second); await Promise.resolve(); resolve(); await first;
    assert.equal(calls.filter(value => value === 'file-start').length, 1); assert.equal(calls.at(-1), 'verified'); updates.dispose();
});

test('storage failure and a new or closed editor prevent a reload checkpoint from succeeding', async () => {
    const failed = createWorkspaceUpdatePreparations(); let verified = false;
    failed.register('Attachment bytes', () => { throw new Error('quota exhausted'); });
    failed.register('verify', () => { verified = true; }, 'verify');
    await assert.rejects(failed.checkpoint(), /Attachment bytes: quota exhausted/u); assert.equal(verified, false); failed.dispose();
    const changed = createWorkspaceUpdatePreparations(); let first = true;
    changed.register('Composer', () => { if (first) { first = false; changed.register('new pane', () => {}); } });
    await assert.rejects(changed.checkpoint(), /open views changed/u); await changed.checkpoint(); changed.dispose();
    await assert.rejects(changed.checkpoint(), /workspace is closed/u);
});

test('an unresponsive plugin releases the update dialog without reporting its unsaved draft as ready', async () => {
    const updates = createWorkspaceUpdatePreparations({ timeoutMs: 10 });
    let ready = false, verified = false;
    updates.register('Third-party editor', () => ready ? undefined : new Promise<void>(() => {}));
    updates.register('verify', () => { verified = true; }, 'verify');
    await assert.rejects(updates.checkpoint(), /Third-party editor: Saving has not finished/u);
    assert.equal(verified, false); ready = true; await updates.checkpoint(); assert.equal(verified, true); updates.dispose();
});

test('typed message, attachment, document and reading participants all settle before update verification', async () => {
    const updates = createWorkspaceUpdatePreparations(), bytes = Promise.withResolvers<void>(), file = Promise.withResolvers<void>(), calls: string[] = [];
    for (const kind of ['message', 'attachment', 'document', 'reading'] as const) updates.registerCheckpoint({ kind, label: kind, revision: () => 1, current: () => true,
        async save() { calls.push(`${kind}:start`); if (kind === 'attachment') await bytes.promise; if (kind === 'document') await file.promise; calls.push(`${kind}:saved`); } });
    updates.register('final consistency', () => { for (const kind of ['message', 'attachment', 'document', 'reading']) assert.ok(calls.includes(`${kind}:saved`)); calls.push('verified'); }, 'verify');
    try {
        const pending = updates.checkpoint(); await Promise.resolve(); bytes.resolve(); await Promise.resolve(); assert.ok(!calls.includes('verified'));
        file.resolve(); await pending; assert.equal(calls.at(-1), 'verified');
    } finally { updates.dispose(); }
});

test('edits or account revocation during a delayed checkpoint prevent update activation', async () => {
    for (const change of ['revision', 'account'] as const) {
        const updates = createWorkspaceUpdatePreparations(), wait = Promise.withResolvers<void>(); let revision = 1, current = true, verified = false;
        updates.registerCheckpoint({ kind: 'document', label: 'Document draft', revision: () => revision, current: () => current, save: () => wait.promise });
        updates.register('activate', () => { verified = true; }, 'verify');
        const pending = updates.checkpoint(); await Promise.resolve(); if (change === 'revision') revision++; else current = false;
        wait.resolve(); await assert.rejects(pending, change === 'revision' ? /changed while saving/ : /source or account changed/);
        assert.equal(verified, false); updates.dispose();
    }
});

test('a participant changing after its own save is caught by final verification', async () => {
    const updates = createWorkspaceUpdatePreparations(), delayed = Promise.withResolvers<void>(); let revision = 1;
    updates.registerCheckpoint({ kind: 'message', label: 'Message draft', revision: () => revision, current: () => true, save() {} });
    updates.registerCheckpoint({ kind: 'attachment', label: 'Attachment bytes', revision: () => 1, current: () => true, save: () => delayed.promise });
    const pending = updates.checkpoint(); await new Promise(resolve => setImmediate(resolve)); revision++; delayed.resolve();
    await assert.rejects(pending, /Message draft: The draft or reading position changed/); updates.dispose();
});

test('timed-out participants receive cancellation and a late old completion cannot prepare a new attempt', async () => {
    const updates = createWorkspaceUpdatePreparations({ timeoutMs: 5 }), late = Promise.withResolvers<void>(); let calls = 0, oldSignal: AbortSignal | undefined;
    updates.registerCheckpoint({ kind: 'attachment', label: 'Original bytes', revision: () => 1, current: () => true, save(signal) { calls++; if (calls === 1) { oldSignal = signal; return late.promise; } } });
    await assert.rejects(updates.checkpoint(), /Saving has not finished/); assert.equal(oldSignal?.aborted, true);
    await updates.checkpoint(); late.resolve(); await Promise.resolve(); await updates.checkpoint(); assert.equal(calls, 3); updates.dispose();
});

test('actual-owner capture precedes the frozen revision and account loss during capture prevents saving', async () => {
    const updates = createWorkspaceUpdatePreparations(), calls: string[] = [];
    let revision = 1;
    updates.registerCheckpoint({ kind: 'reading', label: 'Actual reader', current: () => true, revision: () => revision,
        capture() { calls.push('reader sampled'); revision++; }, save() { assert.equal(revision, 2); calls.push('cache saved'); } });
    await updates.checkpoint(); assert.deepEqual(calls, ['reader sampled', 'cache saved']); updates.dispose();
    const revoked = createWorkspaceUpdatePreparations(), sample = Promise.withResolvers<void>(); let current = true, saved = false;
    revoked.registerCheckpoint({ kind: 'reading', label: 'Original reader', current: () => current, revision: () => 1,
        capture: () => sample.promise, save() { saved = true; } });
    const pending = revoked.checkpoint(); await Promise.resolve(); current = false; sample.resolve();
    await assert.rejects(pending, /source or account changed/); assert.equal(saved, false); revoked.dispose();
});
