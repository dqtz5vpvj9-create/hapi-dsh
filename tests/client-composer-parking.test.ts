import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposerParkingController, parkingSnapshotMatches, type ComposerParkingStore, type ComposerParkingJournal, type ParkedComposerSnapshot } from '../src/client/composer-parking.ts';
import type { SessionExtrasApi, SourceNote, WorkbenchSource } from '../src/client-api.ts';

const source: WorkbenchSource = { sourceHubId: 'hub', sourceSessionId: 'session', machineId: 'alpha' };
const snapshot: ParkedComposerSnapshot = { viewId: 'original-view', text: 'A source-owned parked draft', revision: 7, attachmentIds: [] };
function fixture() {
    const storage = new Map<string, ComposerParkingJournal>(), notes = new Map<string, SourceNote>();
    const state = { uploads: [] as string[], writes: 0, reads: 0, removed: [] as string[], readFails: false, loseNoteReply: false, failUpload: '', clearCount: 0, storageFails: false };
    const store: ComposerParkingStore = { read: async key => structuredClone(storage.get(key) ?? null), write: async (key, value) => {
        if (state.storageFails) throw new Error('quota exceeded'); if (value) storage.set(key, structuredClone(value)); else storage.delete(key);
    } };
    const api: Pick<SessionExtrasApi, 'sourceNotes' | 'sourceNoteUpload' | 'sourceNoteWrite'> = {
        sourceNotes: async () => { state.reads++; if (state.readFails) throw new Error('source disconnected'); return { ok: true, value: { entries: [...notes.values()], attachmentUrls: {},
            limits: { maxBytesPerFile: 1024, maxAttachmentsPerEntry: 5, maxBytesPerEntry: 2048, maxBytesPerSession: 4096, allowedMimeTypes: ['text/plain'] } } }; },
        sourceNoteUpload: async input => {
            state.uploads.push(input.filename); if (state.failUpload === input.filename) throw new Error('upload reply lost');
            const bytes = Buffer.from(input.content, 'base64');
            assert.equal(bytes.toString(), `Original ${input.filename} bytes`);
            return { ok: true, value: { attachment: { id: `upload-${state.uploads.length}`, filename: input.filename, mimeType: input.mimeType, size: bytes.length, path: `/source/notes/upload-${state.uploads.length}` } } };
        },
        sourceNoteWrite: async input => {
            if (input.action.kind === 'delete-attachment') { state.removed.push(input.action.attachmentId); return { ok: true, value: { ok: true } }; }
            if (input.action.kind !== 'create') throw new Error('Unexpected note operation');
            state.writes++; const action = input.action;
            const entry = notes.get(action.entryId) ?? { entryId: action.entryId, text: action.text.trim(), createdAt: action.createdAt!, updatedAt: Date.now(), attachments: action.attachments };
            notes.set(action.entryId, entry); if (state.loseNoteReply) { state.readFails = true; throw new Error('note reply lost'); }
            return { ok: true, value: { entry } };
        },
    };
    return { storage, state, store, api, notes, create: (clear = () => { state.clearCount++; return true; }) => new ComposerParkingController(api, source, 'pane/source', clear, store) };
}
const file = (id: string, name: string) => ({ id, file: new File([`Original ${name} bytes`], name, { type: 'text/plain' }) });

test('parking copies original bytes to source note storage, clears only after a verified note, and never sends chat', async () => {
    const env = fixture(), controller = env.create(); await controller.load();
    await controller.start({ ...snapshot, attachmentIds: ['one'] }, [file('one', 'one.txt')]);
    const state = controller.getSnapshot(); assert.equal(state.journal?.state, 'saved'); assert.equal(state.cleared, true);
    assert.equal(env.state.clearCount, 1); assert.equal(env.state.writes, 1); assert.deepEqual(env.state.uploads, ['one.txt']);
    assert.equal([...env.notes.values()][0]?.attachments[0]?.filename, 'one.txt');
});
test('a lost note reply reloads the same ID and recovers by reading without reuploading or recreating', async () => {
    const env = fixture(), controller = env.create(); await controller.load(); env.state.loseNoteReply = true;
    await controller.start({ ...snapshot, attachmentIds: ['one'] }, [file('one', 'one.txt')]);
    const originalId = controller.getSnapshot().journal?.entryId;
    assert.equal(controller.getSnapshot().journal?.state, 'submitting'); assert.equal(env.state.clearCount, 0);
    env.state.readFails = false; const recovered = env.create(() => false); await recovered.load();
    assert.equal(recovered.getSnapshot().journal?.entryId, originalId); assert.equal(recovered.getSnapshot().journal?.state, 'saved');
    assert.equal(recovered.getSnapshot().cleared, false); assert.equal(env.state.writes, 1); assert.deepEqual(env.state.uploads, ['one.txt']);
});
test('an unfinished upload retains all blobs and confirmed receipts, and only an explicit retry uploads the missing file', async () => {
    const env = fixture(), controller = env.create(); await controller.load(); env.state.failUpload = 'two.txt';
    await controller.start({ ...snapshot, attachmentIds: ['one', 'two'] }, [file('one', 'one.txt'), file('two', 'two.txt')]);
    assert.equal(env.state.writes, 0); assert.equal(env.state.clearCount, 0);
    const recovered = env.create(); await recovered.load();
    assert.deepEqual(env.state.uploads, ['one.txt', 'two.txt']);
    assert.equal(await recovered.getSnapshot().journal?.files[1]?.blob.text(), 'Original two.txt bytes');
    env.state.failUpload = ''; await recovered.retry();
    assert.deepEqual(env.state.uploads, ['one.txt', 'two.txt', 'two.txt']); assert.equal(env.state.writes, 1);
    assert.equal([...env.notes.values()][0]?.attachments[0]?.id, 'upload-1');
});
test('changed editor revisions, attachments, submitting phases and reloaded graphs cannot be cleared', async () => {
    const env = fixture(); let input = { draft: snapshot.text, draftRev: 7, attachmentIds: [] as string[], phase: 'plain' };
    const controller = env.create(() => parkingSnapshotMatches(snapshot, input, 'original-view'));
    await controller.load(); input = { ...input, draft: 'Newer unsent task', draftRev: 8 }; await controller.start(snapshot, []);
    assert.equal(controller.getSnapshot().journal?.state, 'saved'); assert.equal(controller.getSnapshot().cleared, false);
    assert.equal(parkingSnapshotMatches(snapshot, { ...input, draft: snapshot.text, draftRev: 7 }, 'reloaded-view'), false);
    assert.equal(parkingSnapshotMatches(snapshot, { ...input, draft: snapshot.text, draftRev: 7, attachmentIds: ['new'] }, 'original-view'), false);
    assert.equal(parkingSnapshotMatches(snapshot, { ...input, draft: snapshot.text, draftRev: 7, phase: 'submitting' }, 'original-view'), false);
});
test('durable quota failure and a mismatched source receipt preserve the original composer', async () => {
    const env = fixture(), controller = env.create(); await controller.load(); env.state.storageFails = true; await controller.start(snapshot, []);
    assert.equal(env.state.writes, 0); assert.equal(env.state.uploads.length, 0); assert.equal(env.state.clearCount, 0);
    env.state.storageFails = false;
    const wrongApi = { ...env.api, sourceNoteWrite: async (input: Parameters<SessionExtrasApi['sourceNoteWrite']>[0]) => {
        if (input.action.kind !== 'create') throw new Error('Unexpected action');
        return { ok: true as const, value: { entry: { entryId: input.action.entryId, text: 'An unrelated old note', createdAt: input.action.createdAt!, updatedAt: 1, attachments: [] } } };
    } };
    const wrong = new ComposerParkingController(wrongApi, source, 'pane/source', () => { env.state.clearCount++; return true; }, env.store); await wrong.load(); await wrong.start(snapshot, []);
    assert.equal(env.state.clearCount, 0); assert.equal(wrong.getSnapshot().journal?.state, 'submitting'); assert.match(wrong.getSnapshot().error ?? '', /different note/);
});
test('discarding an unsubmitted failed park removes only its known temporary attachments and keeps source notes untouched', async () => {
    const env = fixture(), controller = env.create(); await controller.load(); env.state.failUpload = 'two.txt';
    await controller.start({ ...snapshot, attachmentIds: ['one', 'two'] }, [file('one', 'one.txt'), file('two', 'two.txt')]);
    await controller.discard(); assert.equal(controller.getSnapshot().journal, null);
    assert.deepEqual(env.state.removed, ['upload-1']); assert.equal(env.state.writes, 0); assert.equal(env.state.clearCount, 0);
});
