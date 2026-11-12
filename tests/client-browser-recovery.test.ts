/** Real codec and key selection; IDB enumeration is the browser boundary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { browserRecoverySummary, captureBrowserRecovery, encodeBrowserRecovery, type BrowserRecoverySnapshot } from '../src/client/source-browser-recovery.tsx'

test('local recovery preserves the original file bytes, metadata and unassigned draft key', async () => {
    const bytes = Uint8Array.from({ length: 70001 }, (_, i) => i % 251)
    const file = new File([bytes], '旧草稿.png', { type: 'image/png', lastModified: 123 })
    const snapshot: BrowserRecoverySnapshot = { version: 1, origin: 'https://example.test', createdAt: 1,
        localStorage: [{ key: 'hapi-dsh:composer-draft:v1:["dsh","other-machine","old-session"]', value: '{"text":"unsent original"}' }],
        databases: [{ name: 'hapi-dsh-composer-attachments', version: 1, stores: [{ name: 'drafts', records: [{ key: ['old-session'], value: { files: [{ file }] } }] }] }] }
    const summary = browserRecoverySummary(snapshot)
    assert.equal(summary.records, 2); assert.ok(summary.bytes >= bytes.length)
    const encoded = await encodeBrowserRecovery(snapshot) as typeof snapshot
    const original = encoded.databases[0]!.stores[0]!.records[0]!.value as { files: Array<{ file: { $hhpiBlob: number; data: string; type: string; name: string; lastModified: number } }> }
    assert.equal(original.files[0]!.file.$hhpiBlob, 1)
    assert.deepEqual(Buffer.from(original.files[0]!.file.data, 'base64'), Buffer.from(bytes))
    assert.equal(original.files[0]!.file.name, '旧草稿.png'); assert.equal(original.files[0]!.file.lastModified, 123)
    assert.equal(original.files[0]!.file.type, 'image/png')
    assert.deepEqual(encoded.localStorage, snapshot.localStorage)
    assert.equal((snapshot.databases[0]!.stores[0]!.records[0]!.value as { files: Array<{ file: File }> }).files[0]!.file, file)
    assert.equal('accountId' in encoded, false, 'export must not adopt an unknown draft into the current account')
})

test('checking old data selects only documented draft/layout keys and never opens an unrelated database', async () => {
    const values = new Map([['auth-token', 'never-export'], ['hhpi:composer-draft:v2:account', 'current'],
        ['hapi-dsh:composer-draft:v1:old', '{"text":"old"}'], ['dsh.conversation.old', '{"draft":"native"}'],
        ['hapi-dsh:host:machine:panel-token', 'never-export'],
        ['hapi-dsh:host:machine:pane:p1:dsh.conversation.old', '{"draft":"other pane"}'],
        ['hapi.scratchlist.v1.old', 'unsaved note'], ['hapi-dsh:schedule:["hub","session"]:pane', 'unsent schedule']])
    let writes = 0, opened = 0
    const storage: Storage = { get length() { return values.size }, key: i => [...values.keys()][i] ?? null,
        getItem: key => values.get(key) ?? null, setItem() { writes++ }, removeItem() { writes++ }, clear() { writes++ } }
    const factory = { databases: async () => [{ name: 'credential-store', version: 1 }], open() { opened++; throw new Error('unrelated database opened') } } as unknown as IDBFactory
    const result = await captureBrowserRecovery(storage, factory, 'https://example.test')
    assert.deepEqual(result.localStorage.map(row => row.key), ['hapi-dsh:composer-draft:v1:old', 'dsh.conversation.old',
        'hapi-dsh:host:machine:pane:p1:dsh.conversation.old', 'hapi.scratchlist.v1.old', 'hapi-dsh:schedule:["hub","session"]:pane'])
    assert.equal(opened, 0); assert.equal(writes, 0)
    assert.equal(JSON.stringify(result).includes('never-export'), false)
})
