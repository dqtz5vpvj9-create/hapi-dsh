import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteMigrationController, parseLegacyNotes } from '../src/client/note-migration.ts';
import type { SessionExtrasApi, SourceAttachment, SourceNote } from '../src/client-api.ts';

const source = { sourceHubId: 'source-hub', sourceSessionId: 'original', machineId: 'runner' };
const attachment: SourceAttachment = { id: 'original-attachment', filename: 'kept.txt', mimeType: 'text/plain', size: 8, path: 'hub-scratchlist:original/kept.txt' };
const note = { id: 'legacy-id', text: '  original local note  ', createdAt: 1234, attachments: [attachment] };
function fixture() {
    const memory = new Map<string, string>(), entries = new Map<string, SourceNote>();
    let posts = 0, lost = false, quota = false, readFault = false;
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota exceeded'); memory.set(key, value); } };
    const api = {
        sourceNotes: async () => { if (readFault) throw new Error('Source unavailable'); return { ok: true, value: { entries: [...entries.values()], limits: {}, attachmentUrls: {} } }; },
        sourceNoteWrite: async ({ action }: { action: { kind: string; entryId: string; text: string; attachments: SourceAttachment[]; createdAt: number } }) => {
            assert.equal(action.kind, 'create'); posts++;
            assert.ok([...memory.values()].some(raw => raw.includes(action.entryId)), 'A stable identity is durable before POST');
            const row = entries.get(action.entryId) ?? { ...action, text: action.text.trim(), updatedAt: 2000 };
            entries.set(action.entryId, row);
            if (lost) throw new Error('Source saved the note but the reply was lost');
            return { ok: true, value: { entry: row } };
        },
    } as unknown as Pick<SessionExtrasApi, 'sourceNotes' | 'sourceNoteWrite'>;
    return { memory, entries, storage, api, posts: () => posts, lose: () => { lost = true; },
        quota: () => { quota = true; }, offline: () => { readFault = true; }, online: () => { readFault = false; } };
}

test('local notes retain IDs, original timestamps and attachments when the Hub is already nonempty', async () => {
    const f = fixture(); f.entries.set('other', { entryId: 'other', text: 'Another device', createdAt: 4, updatedAt: 8, attachments: [] });
    const controller = new NoteMigrationController(f.api, source, f.storage); const raw = JSON.stringify([note]); controller.prepare(raw);
    await controller.import();
    assert.equal(f.posts(), 1); assert.equal(f.entries.size, 2);
    assert.deepEqual(f.entries.get(note.id)?.attachments, [attachment]); assert.equal(f.entries.get(note.id)?.createdAt, 1234);
    assert.equal(controller.getSnapshot().journal?.rows[0]?.state, 'saved'); assert.equal(controller.getSnapshot().journal?.raw, raw);
    assert.equal(f.memory.has('hapi.scratchlist.v1.original'), false, 'The migrator never writes or removes the original cache');
});

test('a lost POST reply is resolved by source read; reload and repeat import do not send another POST', async () => {
    const f = fixture(); f.lose();
    const controller = new NoteMigrationController(f.api, source, f.storage); controller.prepare(JSON.stringify([note])); await controller.import();
    assert.equal(controller.getSnapshot().journal?.rows[0]?.state, 'saved');
    const restored = new NoteMigrationController(f.api, source, f.storage); await restored.inspect(); await restored.import();
    assert.equal(f.posts(), 1); assert.equal(restored.getSnapshot().journal?.raw, JSON.stringify([note]));
});

test('different source content with the same ID requires an explicit stable copy and never an update', async () => {
    const f = fixture(); const current = { entryId: note.id, text: 'Newer Hub note', createdAt: 1234, updatedAt: 4000, attachments: [] };
    f.entries.set(note.id, current);
    const controller = new NoteMigrationController(f.api, source, f.storage); controller.prepare(JSON.stringify([note])); await controller.import();
    assert.equal(f.posts(), 0); assert.equal(controller.getSnapshot().journal?.rows[0]?.state, 'conflict');
    assert.equal(controller.getSnapshot().journal?.rows[0]?.sourceVersion?.text, current.text);
    controller.resolve(note.id, 'separate');
    const copyId = controller.getSnapshot().journal!.rows[0]!.targetId; assert.notEqual(copyId, note.id);
    const restored = new NoteMigrationController(f.api, source, f.storage); await restored.inspect(); assert.equal(f.posts(), 0);
    await restored.import(); assert.equal(f.posts(), 1); assert.equal(f.entries.get(copyId)?.text, note.text.trim()); assert.deepEqual(f.entries.get(note.id), current);
});

test('the operator can keep the source version while retaining a downloadable local original', async () => {
    const f = fixture(); f.entries.set(note.id, { entryId: note.id, text: 'Hub version', createdAt: 1234, updatedAt: 2000, attachments: [] });
    const controller = new NoteMigrationController(f.api, source, f.storage); const raw = JSON.stringify([note]); controller.prepare(raw); await controller.import();
    controller.resolve(note.id, 'keep-source'); controller.dismiss();
    assert.equal(controller.getSnapshot().journal?.dismissed, true); assert.equal(controller.getSnapshot().journal?.raw, raw); assert.equal(f.posts(), 0);
});

test('invalid attachments and duplicate IDs stay in the backup and are not silently stripped', () => {
    const raw = JSON.stringify([note, { ...note, id: 'broken', attachments: [{ filename: 'lost.png' }] }, { ...note, text: 'second copy' }]);
    const result = parseLegacyNotes(raw, 'original'); assert.equal(result.rows.length, 1); assert.equal(result.issues.length, 2);
    const f = fixture(), controller = new NoteMigrationController(f.api, source, f.storage); controller.prepare(raw);
    assert.equal(controller.getSnapshot().journal?.raw, raw);
});

test('original export session identity is checked before accepting its notes', () => {
    assert.throws(() => parseLegacyNotes(JSON.stringify({ session: { id: 'somebody-else' }, scratchlist: [note] }), 'original'), /different original HAPI session/);
    const result = parseLegacyNotes(JSON.stringify({ session: { id: 'original' }, scratchlist: [{ entryId: note.id, text: note.text, createdAt: note.createdAt, attachments: note.attachments }] }), 'original');
    assert.deepEqual(result.rows, [note]);
});

test('storage rejection or failed readback prevents a migration POST', async () => {
    const f = fixture(); const controller = new NoteMigrationController(f.api, source, f.storage); controller.prepare(JSON.stringify([note]));
    f.quota(); await controller.import(); assert.equal(f.posts(), 0); assert.match(controller.getSnapshot().error!, /Quota/);
    const dropping = new NoteMigrationController(f.api, source, { getItem: () => null, setItem: () => {} }); dropping.prepare(JSON.stringify([note]));
    await dropping.import(); assert.equal(f.posts(), 0); assert.match(dropping.getSnapshot().error!, /verified/);
});

test('a source outage keeps the migration pending through reload and no mount auto-writes', async () => {
    const f = fixture(); const controller = new NoteMigrationController(f.api, source, f.storage); controller.prepare(JSON.stringify([note]));
    f.offline(); await controller.import(); assert.equal(f.posts(), 0);
    const restored = new NoteMigrationController(f.api, source, f.storage); f.online(); await restored.inspect();
    assert.equal(f.posts(), 0); assert.equal(restored.getSnapshot().journal?.rows[0]?.state, 'pending');
    await restored.import(); assert.equal(f.posts(), 1);
});
