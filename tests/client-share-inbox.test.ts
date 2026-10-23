/** Storage/receiver fixtures; browser tests separately exercise IDB and the official composer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceShareInbox } from '../src/client/share-inbox-state.ts';
import { parseShareFields, shareFromFragment, shareSeedText, validateSharePayload, SHARE_FILE_LIMIT, SHARE_TTL, type SharePayload, type ShareRecord, type ShareTarget, type ShareTransfers } from '../src/client/share-transfer.ts';

class Transfers implements ShareTransfers {
    rows = new Map<string, ShareRecord>(); index = 0;
    async read(id: string) { return this.rows.get(id) ?? null; }
    async put(payload: SharePayload) { const id = `share-${++this.index}`; this.rows.set(id, { ...payload, id }); return id; }
    async delete(id: string) { this.rows.delete(id); }
    async update(id: string, change: (row: ShareRecord) => ShareRecord) {
        const row = this.rows.get(id); if (!row) throw new Error('Missing share'); const next = change(row); this.rows.set(id, next); return next;
    }
}
const payload = (): SharePayload => ({ title: 'Title', text: 'Exact shared text', url: 'https://example.invalid/read', files: [{ name: 'shared.txt', type: 'text/plain', blob: new Blob(['actual fixture bytes']) }], createdAt: Date.now() });
const alpha: ShareTarget = { kind: 'hapi', hubId: 'hub-alpha', sessionId: 'same-source-id' }, beta: ShareTarget = { kind: 'hapi', hubId: 'hub-beta', sessionId: 'same-source-id' };
async function settle(until: () => boolean) { for (let step = 0; step < 100; step++) { if (until()) return; await new Promise<void>(resolve => setImmediate(resolve)); } assert.fail('Share operation did not settle'); }
function storage(owner = 'same-browser-window') { return { getItem: () => owner, setItem() {} }; }

test('original notes wait for the named composer and keep existing share receipts unchanged', async () => {
    const inbox = new WorkspaceShareInbox(new Transfers(), storage());
    await inbox.ingest(payload());
    const previous = inbox.getSnapshot(); let calls = 0, wrong = 0, ready = false;
    inbox.register(alpha, { paneId: 'plugin-pane', ready: () => true, async insert() { wrong++; return { afterText: '' }; } });
    inbox.register(beta, { paneId: 'chat-pane', ready: () => true, async insert() { wrong++; return { afterText: '' }; } });
    const content = { ...payload(), text: '  Original note\n' };
    const inserting = inbox.insertOriginal(alpha, 'chat-pane', content, new AbortController().signal);
    inbox.register(alpha, { paneId: 'chat-pane', ready: () => ready, async insert(value, _signal, options) {
        calls++; assert.equal(value.text, content.text); assert.equal(options?.exactText, true);
        assert.equal(await value.files[0]!.blob.text(), 'actual fixture bytes');
        return { afterText: value.text };
    } });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 0);
    ready = true; inbox.wake(); await inserting; inbox.wake();
    assert.equal(calls, 1); assert.equal(wrong, 0); assert.equal(inbox.getSnapshot(), previous);
    inbox.dispose();
});

test('cancelled note insertion never writes when its composer appears later', async () => {
    const inbox = new WorkspaceShareInbox(new Transfers(), storage()), abort = new AbortController(); let calls = 0;
    const inserting = inbox.insertOriginal(alpha, 'chat-pane', payload(), abort.signal);
    abort.abort(); await assert.rejects(inserting, { name: 'AbortError' });
    inbox.register(alpha, { paneId: 'chat-pane', ready: () => true, async insert() { calls++; return { afterText: '' }; } });
    inbox.wake(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 0);
    inbox.dispose();
});

test('share hand-off requires exact Hub/session and a ready target; insertion is claimed before effects', async () => {
    const transfers = new Transfers(), inbox = new WorkspaceShareInbox(transfers, storage()); let ready = false, calls = 0, wrong = 0;
    const id = await inbox.ingest(payload());
    inbox.register(beta, { ready: () => true, async insert() { wrong++; return { afterText: '' }; } });
    inbox.register(alpha, { ready: () => ready, async insert(content) {
        assert.equal((await transfers.read(id))?.hapiDshDelivery?.status, 'inserting'); calls++;
        assert.equal(await content.files[0]!.blob.text(), 'actual fixture bytes'); return { afterText: `Existing mention\n\n${shareSeedText(content)}` };
    } });
    await inbox.select(alpha); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 0); assert.equal(wrong, 0);
    ready = true; inbox.wake(); inbox.wake(); await settle(() => inbox.getSnapshot().phase === 'inserted');
    assert.equal(calls, 1); assert.equal(wrong, 0); assert.ok(await transfers.read(id), 'original files remain recoverable');
    const reopened = new WorkspaceShareInbox(transfers, storage()); reopened.register(alpha, { ready: () => true, async insert() { calls++; return { afterText: '' }; } });
    await reopened.load(id); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 1);
    inbox.dispose(); reopened.dispose();
});

test('an interrupted insertion remains unknown after reopening and never automatically duplicates content', async () => {
    const transfers = new Transfers(), inbox = new WorkspaceShareInbox(transfers, storage()); const id = await inbox.ingest(payload()); let calls = 0;
    inbox.register(alpha, { ready: () => true, async insert() { calls++; throw new Error('The view was closed after its local edit'); } });
    await inbox.select(alpha); await settle(() => inbox.getSnapshot().phase === 'unknown');
    assert.equal((await transfers.read(id))?.hapiDshDelivery?.status, 'unknown'); inbox.dispose();
    const reopened = new WorkspaceShareInbox(transfers, storage()); reopened.register(alpha, { ready: () => true, async insert() { calls++; return { afterText: 'reviewed' }; } });
    await reopened.load(id); reopened.wake(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 1);
    await reopened.select(alpha); assert.equal(calls, 1); assert.match(reopened.getSnapshot().error!, /receipt/u);
    await reopened.select(alpha, true); await settle(() => reopened.getSnapshot().phase === 'inserted'); assert.equal(calls, 2); reopened.dispose();
});

test('another window cannot consume a bound share just by mounting a matching conversation', async () => {
    const transfers = new Transfers(), first = new WorkspaceShareInbox(transfers, storage('first')); const id = await first.ingest(payload()); await first.select(alpha);
    const second = new WorkspaceShareInbox(transfers, storage('second')); let calls = 0;
    second.register(alpha, { ready: () => true, async insert() { calls++; return { afterText: 'chosen explicitly' }; } });
    await second.load(id); second.wake(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 0);
    await second.select(alpha); await settle(() => second.getSnapshot().phase === 'inserted'); assert.equal(calls, 1);
    first.dispose(); second.dispose();
});

test('new-session cancellation retains the share and an unrelated creation cannot claim it', async () => {
    const transfers = new Transfers(), inbox = new WorkspaceShareInbox(transfers, storage()); const id = await inbox.ingest(payload());
    inbox.created(alpha); assert.equal(inbox.getSnapshot().phase, 'pick');
    assert.ok(inbox.beginCreation()); inbox.cancelCreation(); inbox.created(beta); assert.equal(inbox.getSnapshot().phase, 'pick'); assert.ok(await transfers.read(id));
    assert.ok(inbox.beginCreation()); inbox.created(alpha); await settle(() => inbox.getSnapshot().phase === 'waiting');
    assert.deepEqual(inbox.getSnapshot().record?.hapiDshDelivery?.target, alpha); inbox.dispose();
});

test('only this window’s untouched pending share follows a confirmed original-source successor', async () => {
    const transfers = new Transfers(), inbox = new WorkspaceShareInbox(transfers, storage()); const id = await inbox.ingest(payload());
    const from = { hubId: 'hub-alpha', sessionId: 'same-source-id', hostId: 'local', displayId: 'display-before' };
    const to = { ...from, sessionId: 'returned-new-source', displayId: 'display-after' };
    await inbox.select(alpha);
    await assert.rejects(inbox.retargetPending(from, { ...to, hubId: 'hub-beta' }), /unconfirmed Hub/);
    const other = new WorkspaceShareInbox(transfers, storage('other-window')); await other.load(id);
    assert.equal(await other.retargetPending(from, to), false);
    assert.equal(await inbox.retargetPending(from, to), true);
    assert.deepEqual(inbox.getSnapshot().record?.hapiDshDelivery?.target, { kind: 'hapi', hubId: 'hub-alpha', sessionId: 'returned-new-source' });
    let inserted = 0; inbox.register({ kind: 'hapi', hubId: to.hubId, sessionId: to.sessionId }, { ready: () => true, async insert() { inserted++; return { afterText: 'shared' }; } });
    await settle(() => inbox.getSnapshot().phase === 'inserted');
    assert.equal(await inbox.retargetPending(to, { ...to, sessionId: 'yet-another' }), false); assert.equal(inserted, 1);
    inbox.dispose(); other.dispose();
});

test('original fragment format preserves whitespace and reads bounded companion bytes without app credentials', async () => {
    const fields = parseShareFields('#title=Title&text=%20exact%20text%20&url=https%3A%2F%2Fexample.invalid&fileUrl=https%3A%2F%2Fcompanion.invalid%2Fphoto.png&fileName=kept.png');
    const result = await shareFromFragment(fields, new AbortController().signal, async (_url, options) => {
        assert.equal(options?.credentials, 'omit'); assert.equal(options?.mode, 'cors'); assert.equal(options?.referrerPolicy, 'no-referrer');
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    });
    assert.equal(result.text, ' exact text '); assert.equal(result.files[0]?.name, 'kept.png'); assert.deepEqual([...new Uint8Array(await result.files[0]!.blob.arrayBuffer())], [1, 2, 3]);
    await assert.rejects(shareFromFragment({ fileUrl: 'javascript:bad' }, new AbortController().signal), /HTTP/u);
    await assert.rejects(shareFromFragment({ fileUrl: 'https://user:secret@companion.invalid/file' }, new AbortController().signal), /credentials/u);
    await assert.rejects(shareFromFragment({ fileUrl: 'https://companion.invalid/file' }, new AbortController().signal, async () => new Response('no', { headers: { 'content-length': String(SHARE_FILE_LIMIT + 1) } })), /50 MiB/u);
});

test('malformed, expired and over-limit shared payloads are rejected without deleting their originals', () => {
    assert.throws(() => validateSharePayload({ ...payload(), createdAt: Date.now() - SHARE_TTL - 1000 }), /expired/u);
    assert.throws(() => validateSharePayload({ ...payload(), files: [{ name: 'broken', type: 'x', blob: {} }] }), /file/u);
    const oversized = new Blob([]); Object.defineProperty(oversized, 'size', { value: SHARE_FILE_LIMIT + 1 });
    assert.throws(() => validateSharePayload({ ...payload(), files: [{ name: 'too-large', type: 'x', blob: oversized }] }), /50 MiB/u);
    assert.throws(() => validateSharePayload({ ...payload(), title: '', text: '', url: '', files: [] }), /no text/u);
});
