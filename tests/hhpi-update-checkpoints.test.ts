/** Production reading cache and file editor; browser storage, journal and source IO are controlled boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SourceReadingCache } from '../src/client/remote-reading-cache.ts'
import { createWorkspaceUpdatePreparations } from '../src/client/update-preparation.ts'
import { SourceFileEdit } from '../src/client/source-file-edit.ts'
import { documentJournalFixture, fileContext } from './source-file-context-fixture.ts'
import type { NativeDocumentJournal } from '../src/client/native-document-journal.ts'
import type { SourceEntry, SourcePage, SourceSession } from '../src/remote/protocol.ts'

class BrowserStorage implements Storage {
    readonly values = new Map<string, string>()
    beforeWrite: ((key: string) => void) | undefined
    get length() { return this.values.size }
    key(index: number) { return [...this.values.keys()][index] ?? null }
    getItem(key: string) { return this.values.get(key) ?? null }
    setItem(key: string, value: string) { this.beforeWrite?.(key); this.values.set(key, value) }
    removeItem(key: string) { this.values.delete(key) }
    clear() { this.values.clear() }
}
const session: SourceSession = { id: 'hhpi:machine:source:codex:native', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native', title: 'Synthetic checkpoint', cwd: '/source', updatedAt: 1,
    status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: true, files: true } }
const entry = (seq: number, text = 'synthetic content'): SourceEntry => ({ type: 'event', event: { type: 'user/message', seq: SessionSeq(seq), time: 1, surfaceOp: 'append',
    data: { id: MessageId(`message-${seq}`), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } })
const page = (epoch = 'original'): SourcePage => ({ session, epoch, version: 1, before: 1, after: 2, hasBefore: false, hasAfter: false, context: [], entries: [1, 2].map(seq => entry(seq)) })
const position = { anchorKey: 'message-2', anchorTop: 4, scrollTop: 400 }

test('optional flush still tolerates quota but explicit reading checkpoint rejects and can recover without losing the anchor', () => {
    const storage = new BrowserStorage(), access = { storage, scope: 'account-a-host-a' }, cache = new SourceReadingCache(access), head = page()
    try {
        cache.write({ session, epoch: head.epoch, version: 1, head, windows: [{ viewId: 'pane-a', page: head }] })
        cache.writePosition(session.id, 'pane-a', position, 2)
        storage.beforeWrite = () => { throw new Error('reading storage quota') }
        assert.doesNotThrow(() => cache.flush())
        assert.throws(() => cache.checkpoint(), /reading storage quota/)
        assert.deepEqual(cache.readAnchor(session.id, 'pane-a'), { epoch: 'original', seq: 2 })
        storage.beforeWrite = undefined; cache.checkpoint()
        const reopened = new SourceReadingCache(access)
        try { assert.deepEqual(reopened.readPosition(session.id, 'pane-a'), position); assert.deepEqual(reopened.readAnchor(session.id, 'pane-a'), { epoch: 'original', seq: 2 }) } finally { reopened.dispose() }
    } finally { storage.beforeWrite = undefined; cache.dispose() }
})

test('an index-only persistence failure blocks update even if reading bytes were written', async () => {
    const storage = new BrowserStorage(), cache = new SourceReadingCache({ storage, scope: 'owner' }), head = page(), updates = createWorkspaceUpdatePreparations()
    cache.write({ session, epoch: head.epoch, version: 1, head, windows: [] })
    storage.beforeWrite = key => { if (key.endsWith(':index')) throw new Error('index denied') }
    updates.registerCheckpoint({ kind: 'reading', label: 'Reading position', revision: () => cache.revision, current: () => true, save: () => cache.checkpoint() })
    try {
        await assert.rejects(updates.checkpoint(), /Reading position: index denied/)
        storage.beforeWrite = undefined; await updates.checkpoint()
    } finally { storage.beforeWrite = undefined; cache.dispose(); updates.dispose() }
})

test('explicit update keeps the original native anchor after optional large-body compaction drops its window', () => {
    const storage = new BrowserStorage(), access = { storage, scope: 'owner' }, cache = new SourceReadingCache(access), head = page()
    const huge: SourcePage = { ...head, entries: [entry(20, 'x'.repeat(2 * 1024 * 1024))], before: 20, after: 20 }
    try {
        cache.write({ session, epoch: head.epoch, version: 1, head, windows: [{ viewId: 'pane-a', page: huge }] })
        cache.writePosition(session.id, 'pane-a', { ...position, anchorKey: 'native-tool-20' }, 20)
        cache.flush(); assert.equal(cache.readAnchor(session.id, 'pane-a'), undefined, 'ordinary cache compaction retains its existing optional behavior')
        cache.checkpoint()
        const reopened = new SourceReadingCache(access)
        try {
            assert.deepEqual(reopened.readAnchor(session.id, 'pane-a'), { epoch: 'original', seq: 20 })
            assert.equal(reopened.readPosition(session.id, 'pane-a'), null, 'the exact native anchor survives; no missing body or DOM position is fabricated')
        } finally { reopened.dispose() }
    } finally { cache.dispose() }
})

test('an oversized first body can checkpoint its exact native anchor without pretending the body was cached', () => {
    const storage = new BrowserStorage(), access = { storage, scope: 'owner' }, cache = new SourceReadingCache(access), head = page()
    head.entries = [entry(2, 'x'.repeat(2 * 1024 * 1024))]
    try {
        cache.write({ session, epoch: head.epoch, version: 1, head, windows: [] }); cache.writePosition(session.id, 'pane-a', position, 2)
        cache.flush(); cache.checkpoint(); cache.flush()
        const reopened = new SourceReadingCache(access)
        try { assert.equal(reopened.read(session.id), undefined); assert.deepEqual(reopened.readAnchor(session.id, 'pane-a'), { epoch: 'original', seq: 2 }) } finally { reopened.dispose() }
    } finally { cache.dispose() }
})

test('a changed reader or disposed account cannot be marked saved by an older checkpoint', () => {
    const storage = new BrowserStorage(), access = { storage, scope: 'account-a' }, cache = new SourceReadingCache(access), head = page()
    cache.write({ session, epoch: head.epoch, version: 1, head, windows: [] }); cache.writePosition(session.id, 'pane-a', position, 2)
    storage.beforeWrite = () => { storage.beforeWrite = undefined; cache.writePosition(session.id, 'pane-a', { ...position, anchorKey: 'message-1' }, 1) }
    assert.throws(() => cache.checkpoint(), /changed while saving/)
    cache.checkpoint()
    cache.dispose(); assert.throws(() => cache.checkpoint(), /cache is closed/)
    const other = new SourceReadingCache({ storage, scope: 'account-b' })
    try { assert.equal(other.read(session.id), undefined) } finally { other.dispose() }
})

test('the actual file editor participates without a source save, preserving text, cursor and CAS baseline on partial failure', async () => {
    const context = fileContext(), journal = documentJournalFixture(), gate = Promise.withResolvers<void>()
    let blocked = false, fail = false, writes = 0, sourceWrites = 0
    const durable: NativeDocumentJournal = { read: key => journal.read(key), async write(key, expected, draft) {
        writes++; if (blocked) await gate.promise; if (fail) throw new Error('document quota')
        return journal.write(key, expected, draft)
    } }
    context.services.mutations!.save = async () => { sourceWrites++; throw new Error('Update must not save the source file') }
    const editor = new SourceFileEdit(context, '/source/file.txt', durable), updates = createWorkspaceUpdatePreparations()
    await editor.load(); blocked = true; fail = true
    editor.edit('update checkpoint keeps local text', { start: 1, end: 5, direction: 'backward' })
    let current = true, revision = 1
    updates.registerCheckpoint({ kind: 'document', label: 'Document draft', revision: () => revision, current: () => current, save: () => editor.checkpoint() })
    const pending = updates.checkpoint(); await Promise.resolve(); gate.resolve()
    try {
        await assert.rejects(pending, /document quota/)
        assert.equal(editor.getSnapshot().text, 'update checkpoint keeps local text'); assert.equal(editor.getSnapshot().base?.version, 'stat:initial')
        assert.deepEqual(editor.getSnapshot().selection, { start: 1, end: 5, direction: 'backward' }); assert.equal(sourceWrites, 0)
        fail = false; blocked = false; revision++; editor.edit('retained after retry'); await updates.checkpoint()
        assert.ok(writes >= 2); assert.equal(sourceWrites, 0)
        current = false; await assert.rejects(updates.checkpoint(), /source or account changed/)
    } finally { updates.dispose() }
})
