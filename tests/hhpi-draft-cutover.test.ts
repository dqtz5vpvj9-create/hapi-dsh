import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateCutoverDraft } from '../src/client/draft-cutover.ts'
import { composerDraftKey, composerRecoveryKey } from '../src/client/composer-autosave.ts'
import { parsePaneResource } from '../src/client/model.ts'
import { sessionLocation } from '../src/client/controller.ts'

const origin = { sessionId: 'hapi-codex-old', sourceSessionId: 'original', sourceHubId: 'hub' }
const next = 'hhpi:machine:source:codex:native'
const suffix = JSON.stringify([next, 'pane'])
function storage() {
    const values = new Map<string, string>()
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}
test('cutover restores an unsent semantic draft into its new pane without routing through the old Hub', () => {
    const store = storage(), draft = { text: '继续 @file', references: [{ source: 'files', ref: '/file', offset: 3, length: 5, label: 'file', clipboardText: '@file' }] }
    const oldKey = composerDraftKey('local', origin.sessionId, { hubId: 'hub', hapiSessionId: 'original' })
    store.setItem(oldKey, JSON.stringify({ version: 1, draft }))
    migrateCutoverDraft(store, origin, next, 'pane', 'local')
    assert.deepEqual(JSON.parse(store.getItem(`dsh.conversation.${suffix}`)!).draft, draft)
    assert.deepEqual(JSON.parse(store.getItem(composerDraftKey('local', suffix))!).draft, draft)
    assert.ok(store.getItem(oldKey))
    const resource = parsePaneResource({ kind: 'chat', sessionId: next, draftOrigin: origin })
    assert.deepEqual(resource, { kind: 'chat', sessionId: next, draftOrigin: origin })
    assert.ok(!('sourceSessionId' in resource), 'historical draft identity must not enable HAPI resolution')
    // Clearing a migrated draft must not resurrect the old draft on remount.
    store.setItem(`dsh.conversation.${suffix}`, JSON.stringify({ draft: '' }))
    migrateCutoverDraft(store, origin, next, 'pane', 'local')
    assert.equal(JSON.parse(store.getItem(`dsh.conversation.${suffix}`)!).draft, '')
})
test('cutover preserves an existing new draft and exposes the old copy in recovery', () => {
    const store = storage(), draft = { text: '原草稿', references: [] }, key = composerDraftKey('local', suffix)
    store.setItem(`dsh.conversation.${origin.sessionId}`, JSON.stringify({ draft }))
    const current = JSON.stringify({ draft: { text: '新草稿', references: [] }, view: 'chat' })
    store.setItem(`dsh.conversation.${suffix}`, current)
    migrateCutoverDraft(store, origin, next, 'pane', 'local')
    assert.equal(store.getItem(`dsh.conversation.${suffix}`), current)
    assert.deepEqual(JSON.parse(store.getItem(composerRecoveryKey(key))!), [draft])
    assert.ok(store.getItem(`dsh.conversation.${origin.sessionId}`))
})
test('HHPI sidebar locations keep native machine and engine identities', () => {
    assert.deepEqual(sessionLocation({ projectionValues: { hhpiSource: { machineId: 'native-machine', engine: 'codex', nativeId: 'native' } } }),
        { engine: 'codex', machineId: 'native-machine', nativeId: 'native' })
})
