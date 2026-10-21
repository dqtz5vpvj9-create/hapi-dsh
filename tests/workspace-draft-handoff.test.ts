/** Explicit endpoint/storage fakes test transaction boundaries. Official
 * composer, references and actual browser persistence are covered in E2E. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceDraftHandoffs, handoffDraftMatches, type HandoffAddress, type HandoffDraft, type HandoffEndpoint, type HandoffEntry, type HandoffRecord, type HandoffStorage } from '../src/client/draft-handoff.ts';
import { createPaneRetention } from '../src/client/pane-retention.ts';
import { handoffDetectEnd } from '../src/client/draft-handoff-receiver.tsx';

const from: HandoffAddress = { hubId: 'original-hub', sessionId: 'old-source', displayId: 'old-display', hostId: 'local' };
const to: HandoffAddress = { ...from, sessionId: 'confirmed-new-source', displayId: 'new-display' };
const file = new File(['original bytes'], 'original.txt', { type: 'text/plain' });
const draft = (paneId: string, text = ''): HandoffDraft => ({ paneId, bindingId: `${paneId}-binding`, revision: 1, text, attachmentIds: [], references: [], files: [] });
class Memory implements HandoffStorage {
    entry: HandoffEntry | null = null;
    states: Array<HandoffRecord['status'] | null> = [];
    afterWrite: ((record: HandoffRecord | null) => void) | undefined;
    failure: HandoffRecord['status'] | undefined;
    async read() { return this.entry; }
    async write(_owner: string, previous: string | null, record: HandoffRecord | null) {
        assert.equal(previous, this.entry?.revision ?? null);
        if (this.failure && record?.status === this.failure) throw new Error('durable storage failure');
        this.entry = { revision: crypto.randomUUID(), record }; this.states.push(record?.status ?? null); this.afterWrite?.(record); return this.entry;
    }
}
function endpoint(address: HandoffAddress, initial: HandoffDraft) {
    let current = initial, holds = 0, inserted = 0, clears = 0;
    let duringInsert: (() => void | Promise<void>) | undefined;
    const api: HandoffEndpoint = { address, paneId: initial.paneId,
        retain() { holds++; let released = false; return () => { if (!released) { released = true; holds--; } }; },
        capture: () => current,
        writable: () => true,
        async insert(value, expected) {
            assert.ok(handoffDraftMatches(current, expected)); inserted++;
            await duringInsert?.();
            const files = [...current.files, ...value.files.map(({ file }, index) => ({ file, id: `target-${index}` }))];
            current = { ...current, text: `${current.text}${current.text && value.text ? '\n\n' : ''}${value.text}`, revision: current.revision + 1,
                attachmentIds: files.map(file => file.id), files }; return current;
        },
        clear(expected) { if (!handoffDraftMatches(current, expected)) return false; clears++; current = draft(current.paneId); return true; },
        focus() {},
    };
    return { api, get current() { return current; }, set(value: HandoffDraft) { current = value; }, during(value: () => void | Promise<void>) { duringInsert = value; },
        get holds() { return holds; }, get inserted() { return inserted; }, get clears() { return clears; } };
}
async function setup(targetText = '') {
    const storage = new Memory(), handoffs = new WorkspaceDraftHandoffs('this-window', storage);
    const original = endpoint(from, { ...draft('old-pane', 'Original unsent text'), attachmentIds: ['original-attachment'], files: [{ id: 'original-attachment', file }] });
    const target = endpoint(to, draft('new-pane', targetText));
    handoffs.register(original.api); handoffs.register(target.api);
    await handoffs.prepare(from, to);
    return { storage, handoffs, original, target };
}

test('a durable copy proof precedes exact source cleanup; original attachment bytes get new target identities', async () => {
    const { handoffs, original, target, storage } = await setup();
    assert.equal(original.holds, 1); assert.equal(original.clears, 0); assert.equal(handoffs.blocksSource(from), true); assert.equal(handoffs.blocksSource(to), true);
    target.during(() => { assert.equal(original.current.text, 'Original unsent text'); assert.equal(storage.entry?.record?.status, 'writing'); });
    storage.afterWrite = record => { if (record?.status === 'copied') assert.equal(original.clears, 0); };
    await handoffs.transfer(target.current, false);
    assert.deepEqual(storage.states, ['prepared', 'writing', 'copied', 'complete']);
    assert.equal(handoffs.getSnapshot().record?.cleared, true); assert.equal(original.current.text, ''); assert.equal(original.clears, 1);
    assert.equal(target.current.text, 'Original unsent text'); assert.equal(target.current.files[0]?.file, file);
    assert.deepEqual(target.current.attachmentIds, ['target-0']); assert.equal(original.holds, 0); assert.equal(target.holds, 0);
    assert.equal(handoffs.blocksSource(to), false); handoffs.dispose();
});

test('an existing target requires explicit append and a later target revision invalidates the reviewed choice', async () => {
    const { handoffs, target, original } = await setup('Existing target draft');
    await handoffs.transfer(target.current, false);
    assert.equal(target.inserted, 0); assert.equal(original.clears, 0); assert.match(handoffs.getSnapshot().error!, /Explicitly choose/);
    const reviewed = target.current; target.set({ ...reviewed, revision: 2, text: 'New target edit' });
    await handoffs.transfer(reviewed, true); assert.equal(target.inserted, 0);
    await handoffs.transfer(target.current, true);
    assert.equal(target.current.text, 'New target edit\n\nOriginal unsent text'); assert.equal(original.clears, 1); handoffs.dispose();
});

test('source edits and replacement attachment objects prevent cleanup even after successful insertion', async () => {
    const { handoffs, target, original } = await setup();
    target.during(() => original.set({ ...original.current, files: [{ id: 'original-attachment', file: new File(['changed bytes'], 'original.txt') }] }));
    await handoffs.transfer(target.current, false);
    assert.equal(target.inserted, 1); assert.equal(original.clears, 0); assert.equal(handoffs.getSnapshot().record?.cleared, false);
    assert.equal(original.current.text, 'Original unsent text'); handoffs.dispose();
});

test('a target binding change during proof persistence preserves the old draft', async () => {
    const { handoffs, target, original, storage } = await setup();
    storage.afterWrite = record => { if (record?.status === 'copied') target.set({ ...target.current, bindingId: 'another-actual-binding' }); };
    await handoffs.transfer(target.current, false);
    assert.equal(original.clears, 0); assert.equal(handoffs.getSnapshot().record?.cleared, false); handoffs.dispose();
});

test('uncertain proof persistence is durable no-replay recovery and never clears the original', async () => {
    const { handoffs, target, original, storage } = await setup(); storage.failure = 'copied';
    await handoffs.transfer(target.current, false);
    assert.equal(target.inserted, 1); assert.equal(original.clears, 0); assert.equal(storage.entry?.record?.status, 'unknown');
    handoffs.dispose(); const restored = new WorkspaceDraftHandoffs('this-window', storage); restored.register(target.api);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(restored.getSnapshot().record?.status, 'unknown');
    await restored.transfer(target.current, true); assert.equal(target.inserted, 1); restored.dispose();
});

test('the original pane is released when preparing fails, with no editor mutation', async () => {
    const storage = new Memory(); storage.failure = 'prepared';
    const handoffs = new WorkspaceDraftHandoffs('this-window', storage), original = endpoint(from, draft('original', 'Keep me'));
    handoffs.register(original.api);
    await assert.rejects(handoffs.prepare(from, to), /durable storage/);
    assert.equal(original.holds, 0); assert.equal(original.clears, 0); assert.equal(original.current.text, 'Keep me'); handoffs.dispose();
});

test('different source Hub or ambiguous original drafts do not choose a source implicitly', async () => {
    const { handoffs, original, target } = await setup(); await handoffs.keepBoth();
    await assert.rejects(handoffs.prepare(from, { ...to, hubId: 'different-hub' }), /same Hub/);
    handoffs.register(endpoint(from, draft('another-pane', 'Different draft')).api);
    await assert.rejects(handoffs.prepare(from, to), /Several views/);
    assert.equal(original.clears, 0); assert.equal(target.inserted, 0); handoffs.dispose();
});

test('a retired source graph hides immediately but disposes only after the transfer hold; Host close overrides holds', async () => {
    let hidden = 0, disposed = 0;
    const retention = createPaneRetention(() => { hidden++; }, async () => { disposed++; });
    const release = retention.retain(), stopped = retention.stop();
    await Promise.resolve(); assert.equal(hidden, 1); assert.equal(disposed, 0); assert.throws(() => retention.retain(), /retired/);
    release(); release(); await stopped; assert.equal(disposed, 1);
    const another = createPaneRetention(() => {}, async () => { disposed++; }); const held = another.retain();
    await another.stop(true); held(); assert.equal(disposed, 2);
});

test('Done waits for actual editor durability and retains the backup on a failed checkpoint or concurrent target edit', async () => {
    const storage = new Memory(), original = endpoint(from, draft('source', 'Keep until durable')), target = endpoint(to, draft('target'));
    let checkpoint: () => Promise<void> = async () => { throw new Error('Attachment write failed'); };
    const handoffs = new WorkspaceDraftHandoffs('window', storage, () => checkpoint());
    handoffs.register(original.api); handoffs.register(target.api); await handoffs.prepare(from, to); await handoffs.transfer(target.current, false);
    await assert.rejects(handoffs.keepBoth(), /Attachment write/); assert.equal(storage.entry?.record?.status, 'complete');
    checkpoint = async () => { target.set({ ...target.current, revision: target.current.revision + 1, text: 'Newer input' }); };
    await assert.rejects(handoffs.keepBoth(), /target draft changed/); assert.equal(storage.entry?.record?.status, 'complete');
    checkpoint = async () => {};
    await handoffs.keepBoth(); assert.equal(storage.entry?.record, null); assert.equal(target.current.text, 'Newer input'); handoffs.dispose();
});

test('public mutation coordinates collapse each semantic reference and command to its actual one-cell span', () => {
    assert.equal(handoffDetectEnd({ draft: 'A @path B', occurrences: [{ source: 'file', ref: '/path', label: 'path', clipboardText: '@path', occurrenceId: 1, offset: 2, length: 5 }] }), 5);
    assert.equal(handoffDetectEnd({ draft: '/compact arg', occurrences: [], claim: { name: 'compact', token: '/compact ', hint: '' } }), 5);
});
