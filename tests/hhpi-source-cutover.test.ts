import assert from 'node:assert/strict'
import test from 'node:test'
import { bindSourceResources } from '../src/workspace/legacy.ts'
import { parseWorkspaceState, panes } from '../src/client/model.ts'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'
import { parseSources } from '../src/remote/config.ts'

const native: SourceSession = { id: '', machineId: 'machine', sourceId: 'dsh-native', engine: 'dsh', nativeId: 'native-original',
    title: 'Same title', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null,
    capabilities: { send: true, steer: false, cancel: true, approve: true, files: false }, pendingRequests: [],
    legacyOrigin: { hubId: 'old-hub', sessionId: 'old-source' } }
native.id = sourceSessionId(native)
function state() {
    return parseWorkspaceState({ schemaVersion: 1, revision: 7, windows: [{ id: 'window', name: 'Original',
        root: { type: 'pane', id: 'pane', resource: { kind: 'chat', sessionId: 'hapi-observed-old', sourceSessionId: 'old-source', sourceHubId: 'old-hub' } } }],
        activeWindowId: 'window', focused: { window: 'pane' }, zoomed: {} })
}
function rows(sources: SourceSession[]) {
    return Object.fromEntries(sources.map(source => [source.id, { id: source.id, sourceSessionId: source.id, hostId: 'local',
        projectionValues: { hhpiSource: source } } as WorkspaceCatalogRow]))
}
test('a saved DSH pane follows its exact verified native owner while keeping its pane and draft origin', () => {
    const before = state(), after = bindSourceResources(before, rows([native]), { requireHub: true, primaryHubId: 'new-display-host' })
    const pane = panes(after.windows[0]!.root)[0]!
    assert.equal(pane.id, 'pane')
    assert.deepEqual(pane.resource, { kind: 'chat', sessionId: native.id,
        draftOrigin: { sessionId: 'hapi-observed-old', sourceSessionId: 'old-source', sourceHubId: 'old-hub' } })
    assert.equal(after.activeWindowId, before.activeWindowId)
    assert.equal(bindSourceResources(after, rows([native])), after, 'refresh never migrates or resurrects the old draft again')
})
test('same titles, foreign Hub identities and ambiguous owners cannot migrate a saved pane', () => {
    const before = state()
    const foreign = { ...native, legacyOrigin: { hubId: 'different-hub', sessionId: 'old-source' } }
    assert.equal(bindSourceResources(before, rows([foreign])), before)
    const other = { ...native, sourceId: 'other-owner' }; other.id = sourceSessionId(other)
    assert.equal(bindSourceResources(before, rows([native, other])), before)
    const unadvertised = { ...native, id: 'hhpi:fake:unrelated:dsh:native' }
    assert.equal(bindSourceResources(before, rows([unadvertised])), before)
})
test('native DSH source configuration declares official storage and a server-only owner without enabling legacy body rendering', () => {
    const config = { id: 'dsh-native', machineId: 'machine', engine: 'dsh', root: '/synthetic/sessions',
        owner: { hubId: 'old-hub', url: 'http://127.0.0.1:3006', tokenEnv: 'SOURCE_OWNER_TOKEN' } }
    assert.deepEqual(parseSources([config]), [config])
    assert.throws(() => parseSources([{ ...config, root: '../sessions' }]), /absolute/)
    assert.throws(() => parseSources([{ ...config, owner: { ...config.owner, url: 'http://secret@host' } }]), /credentials/)
    assert.throws(() => parseSources([{ ...config, owner: { ...config.owner, token: 'must-not-store-inline' } }]))
})
