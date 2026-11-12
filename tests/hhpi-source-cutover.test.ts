import assert from 'node:assert/strict'
import test from 'node:test'
import { bindSourceAliases } from '../src/workspace/legacy.ts'
import { parseWorkspaceState, panes } from '../src/client/model.ts'
import { parseSources } from '../src/remote/config.ts'

function state() {
    return parseWorkspaceState({ schemaVersion: 1, revision: 7, windows: [{ id: 'window', name: 'Original',
        root: { type: 'pane', id: 'pane', resource: { kind: 'chat', sessionId: 'hapi-observed-old', sourceSessionId: 'old-source', sourceHubId: 'old-hub' } } }],
        activeWindowId: 'window', focused: { window: 'pane' }, zoomed: {} })
}
test('a saved DSH pane uses its authorized official alias while preserving pane and original draft identity', () => {
    const before = state(), after = bindSourceAliases(before, reference => {
        assert.deepEqual(reference, { kind: 'hapi-session', hubId: 'old-hub', sessionId: 'old-source' })
        return { kind: 'local-dsh', hostId: 'local', sessionId: 'native-original' }
    })
    const pane = panes(after.windows[0]!.root)[0]!
    assert.equal(pane.id, 'pane')
    assert.deepEqual(pane.resource, { kind: 'chat', sessionId: 'native-original',
        draftOrigin: { sessionId: 'hapi-observed-old', sourceSessionId: 'old-source', sourceHubId: 'old-hub' } })
    assert.equal(after.activeWindowId, before.activeWindowId)
    assert.equal(bindSourceAliases(after, () => undefined), after)
})
test('missing finite mapping preserves the complete saved reference without manufacturing an HHPI DSH writer', () => {
    const before = state()
    assert.equal(bindSourceAliases(before, () => undefined), before)
    assert.deepEqual(panes(before.windows[0]!.root)[0]!.resource, { kind: 'chat', sessionId: 'hapi-observed-old', sourceSessionId: 'old-source', sourceHubId: 'old-hub' })
})
test('retired HAPI-owned DSH configuration requires offline aliases and the original official Host', () => {
    const config = { id: 'dsh-native', machineId: 'machine', engine: 'dsh', root: '/synthetic/sessions',
        owner: { hubId: 'old-hub', url: 'http://127.0.0.1:3006', tokenEnv: 'SOURCE_OWNER_TOKEN' } }
    const before = structuredClone(config)
    assert.throws(() => parseSources([config]), /retired.*original DSH Host/)
    assert.deepEqual(config, before, 'refusal must not rewrite the original recovery information')
})
