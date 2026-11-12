/** Actual offline layout conversion and private recovery journal; no live browser or source. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createApplicationStage, type ApplicationMigrationOptions } from '../scripts/migrations/hapi-offline/application.ts'
import { offlineDomainFixture } from './helpers/hhpi-offline-domain-fixture.ts'
import { panes, type WorkspaceState } from '../src/client/model.ts'
import { sessionResourceId } from '../src/shared/session-resource-id.ts'
const scope = { accountId: 'migration-account', origin: 'https://workspace.example' }
const target = { kind: 'hhpi' as const, hostId: 'foreign', sessionId: 'hhpi:machine:codex:codex:native', identity: { machineId: 'machine', sourceId: 'codex', engine: 'codex', nativeId: 'native' } }
const state = (sessionId = 'old-display'): WorkspaceState => ({ schemaVersion: 1, revision: 7,
    windows: [{ id: 'window', name: 'My layout', root: { type: 'split', id: 'split', axis: 'horizontal', weights: [2, 1], children: [
        { type: 'pane', id: 'chat', resource: { kind: 'chat', sessionId } }, { type: 'pane', id: 'empty', resource: { kind: 'empty' } },
    ] } }], activeWindowId: 'window', focused: { window: 'chat' }, zoomed: { window: true } })
const options = (): ApplicationMigrationOptions => ({ scope, current: [target], inputs: [{ inputId: 'layout', kind: 'workspace' }], aliases: { version: 1, scope,
    entries: [{ legacy: { kind: 'hapi-display', hostId: 'local', displayId: 'old-display' }, target, recovery: [] }] } })

test('exact alias conversion preserves layout, focus and weights without inferring a title or revision suffix', async t => {
    const f = await offlineDomainFixture(t, { layout: { revision: 9, state: state(), operationId: 'last-original-write' } }, createApplicationStage(options()))
    const row = f.objects.find(row => row.id !== '["report","application"]')!
    const converted = row.body.value.converted as { state: WorkspaceState; clearDisplayAnchors: boolean; install: string }
    assert.equal(f.index.status, 'complete'); assert.equal(converted.install, 'explicit-cas'); assert.equal(converted.clearDisplayAnchors, true)
    assert.deepEqual(converted.state.focused, state().focused); assert.deepEqual(converted.state.zoomed, state().zoomed)
    assert.deepEqual(converted.state.windows[0]!.root, { ...state().windows[0]!.root,
        children: [{ type: 'pane', id: 'chat', resource: { kind: 'chat', sessionId: sessionResourceId('foreign', target.sessionId) } },
            { type: 'pane', id: 'empty', resource: { kind: 'empty' } }] })
    assert.equal((row.body.value.original as { operationId: string }).operationId, 'last-original-write')
})

test('missing or ambiguous source keeps the exact unresolved pane and never opens a similarly named target', async t => {
    const original = state('old-display-r2'), config = options()
    const f = await offlineDomainFixture(t, { layout: original }, createApplicationStage(config))
    assert.equal(f.index.status, 'needs-review')
    const value = f.objects.find(row => row.id !== '["report","application"]')!.body.value.converted as { state: WorkspaceState; unresolved: unknown[] }
    assert.deepEqual(panes(value.state.windows[0]!.root)[0]!.resource, panes(original.windows[0]!.root)[0]!.resource)
    assert.equal(value.unresolved.length, 1)
    const second = { ...target, hostId: 'other-host' }
    const ambiguous = createApplicationStage({ ...config, current: [target, second], aliases: { ...config.aliases, entries: [...config.aliases.entries,
        { ...config.aliases.entries[0]!, target: second }] } })
    const both = await offlineDomainFixture(t, { layout: state() }, ambiguous)
    assert.equal(both.index.status, 'needs-review')
})

test('legacy v2 geometry without an original Hub cannot inherit an identically named ordinary source', async t => {
    const config = options(), original = { schemaVersion: 2, revision: 1, workspaces: [{ id: 'w', name: 'Old', root: { type: 'pane', id: 'p', resource: { kind: 'chat', sessionId: 'old-display' } } }] }
    const f = await offlineDomainFixture(t, { layout: original }, createApplicationStage({ ...config, inputs: [{ inputId: 'layout', kind: 'workspace-v2' }] }))
    assert.equal(f.index.status, 'needs-review')
    assert.deepEqual(f.objects.find(row => row.id !== '["report","application"]')!.body.value.original, original)
})

test('old read coordinates and Push endpoints stay offline and cannot replay notifications or manufacture a watermark', async t => {
    const config = options(), reads = { seenAt: 900, displaySeq: 50 }, push = { endpoint: 'https://push.example/private-capability', enabled: true }
    const f = await offlineDomainFixture(t, { reads, push }, createApplicationStage({ ...config, inputs: [{ inputId: 'reads', kind: 'read-state' }, { inputId: 'push', kind: 'notification-preferences' }] }))
    const read = f.objects.find(row => row.inputId === 'reads' && row.id !== '["report","application"]')!
    assert.deepEqual(read.body.value.original, reads); assert.equal((read.body.value.converted as { automaticWrite: boolean }).automaticWrite, false)
    const notification = f.objects.find(row => row.inputId === 'push')!
    assert.deepEqual(notification.body.value.original, push)
    assert.deepEqual(notification.body.value.converted, { scope, resubscribe: true, sendHistoricalEvents: false, restoreEndpoint: false })
    assert.throws(() => createApplicationStage({ ...config, aliases: { ...config.aliases, scope: { ...scope, accountId: 'other-account' } } }), /another account/)
})
