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
