/** Actual source picker over published catalog facts; no remote history is loaded. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkspaceCatalog, WorkspaceCatalogRow } from '../src/client/controller.ts'
import { CatalogDiscovery } from '../src/workspace/catalog-discovery.ts'
import { captureSharePicker, filterSharePicker, resolveShareCandidate, resolveShareCandidates, shareFileSize, sharePreviewText, shareTargetForRow } from '../src/workspace/share-picker.ts'
import { sidebarTimeRange, localDayKey } from '../src/workspace/sidebar-time.ts'

function row(id: string, patch: Partial<WorkspaceCatalogRow> = {}): WorkspaceCatalogRow {
    return { id: id as WorkspaceCatalogRow['id'], sourceSessionId: id, displayTitle: id, updatedAt: 1, running: false, retainedBy: {}, blank: false,
        hostId: 'local', hostLabel: 'Main DSH', hostOnline: true, archived: false, pinned: false, ...patch }
}
function source(id: string, patch: Partial<WorkspaceCatalogRow> & { offline?: boolean } = {}): WorkspaceCatalogRow {
    const { offline, ...fields } = patch, sourceId = fields.sourceSessionId ?? `hhpi:machine-one:source:codex:native-${id}`
    return row(id, { sourceSessionId: sourceId, cwd: '/source/repo', ...fields,
        projectionValues: fields.projectionValues ?? { hhpiSource: { id: sourceId, machineId: 'machine-one', sourceId: 'source', engine: 'codex', nativeId: `native-${id}`,
            title: id, cwd: fields.cwd ?? '/source/repo', updatedAt: fields.updatedAt ?? 1, status: offline ? 'offline' : 'idle', activeTurnId: null,
            capabilities: { send: true, steer: true, cancel: true, approve: true, files: false }, pendingRequests: [] } } })
}
function catalog(rows: readonly WorkspaceCatalogRow[]): WorkspaceCatalog {
    return { ids: rows.map(value => value.id), byId: Object.fromEntries(rows.map(value => [value.id, value])), phase: 'ready', projectionsBySession: {} }
}

test('recent active preview uses the original cap and source recency; search includes inactive sessions without a cap', () => {
    const rows = Array.from({ length: 12 }, (_, index) => source(`session-${index}`, { updatedAt: index + 1 }))
    rows.push(source('inactive', { offline: true, updatedAt: 1000 }))
    const snapshot = captureSharePicker(catalog(rows))
    const recent = filterSharePicker(snapshot, '', null, 8)
    assert.deepEqual(recent.candidates.map(value => value.id), ['session-11', 'session-10', 'session-9', 'session-8', 'session-7', 'session-6', 'session-5', 'session-4'])
    assert.equal(recent.hiddenActive, 4); assert.equal(recent.searching, false)
    assert.equal(filterSharePicker(snapshot, '', null, 3).hiddenActive, 9)
    assert.equal(filterSharePicker(snapshot, '', null, 1.5).candidates.length, 8)
    assert.equal(filterSharePicker(snapshot, '', null, 200).candidates.length, 12)
    assert.equal(filterSharePicker(snapshot, '  *  ', null, 1).candidates.length, 13)
    assert.equal(filterSharePicker(snapshot, 'inactive', null, 1).candidates[0]?.id, 'inactive')
    assert.equal(filterSharePicker(snapshot, 'session', null, 1).hiddenActive, 0)
    const nativeTime = captureSharePicker(catalog([source('older-display', { updatedAt: 900 }), source('actual-recent', { updatedAt: 200 })]))
    assert.deepEqual(nativeTime.candidates.map(value => value.id), ['older-display', 'actual-recent'])
})

test('search uses original AND/wildcard fields with snapshotted custom machine labels and always keeps recency order', () => {
    const rows = [source('older', { updatedAt: 10, displayTitle: 'Alpha Beta worktree', cwd: '/base/project' }),
        source('newer', { updatedAt: 20, displayTitle: 'Alpha exact title' })]
    const snapshot = captureSharePicker(catalog(rows), [{ id: 'machine-one', label: 'Classroom Laptop', online: true }])
    assert.deepEqual(filterSharePicker(snapshot, 'alpha', null, 8).candidates.map(value => value.id), ['newer', 'older'], 'share sorting is recency, not main-sidebar relevance')
    assert.deepEqual(filterSharePicker(snapshot, 'ALPHA classroom /base', null, 8).candidates.map(value => value.id), ['older'])
    assert.deepEqual(filterSharePicker(snapshot, '*Worktree', null, 8).candidates.map(value => value.id), ['older'])
    assert.deepEqual(filterSharePicker(snapshot, 'native-olde?', null, 8).candidates.map(value => value.id), ['older'])
    assert.equal(filterSharePicker(snapshot, 'alpha missing', null, 8).candidates.length, 0)
    assert.equal(filterSharePicker(snapshot, '[alpha]', null, 8).candidates.length, 0)
})

test('date filtering uses whole local dates, includes inactive matches and advertises activity beyond the preview', () => {
    const first = new Date(2026, 9, 1, 0, 0).getTime(), second = new Date(2026, 9, 2, 0, 0).getTime()
    const snapshot = captureSharePicker(catalog([source('start', { updatedAt: first, offline: true }), source('late', { updatedAt: second - 1 }), source('tomorrow', { updatedAt: second })]))
    assert.deepEqual(filterSharePicker(snapshot, '', sidebarTimeRange('2026-10-01', '2026-10-01'), 1).candidates.map(value => value.id), ['late', 'start'])
    assert.equal(snapshot.activityDates.has(localDayKey(first)), true); assert.equal(snapshot.activityDates.has(localDayKey(second)), true)
    assert.equal(filterSharePicker(snapshot, '', sidebarTimeRange('2026-10-01', ''), 1).searching, false)
    assert.equal(filterSharePicker(snapshot, '', sidebarTimeRange('2026-10-02', '2026-10-01'), 1).searching, false)
})

test('live SSE edits cannot mutate an already captured candidate list, labels, fields or source address', () => {
    const mutable = source('original', { displayTitle: 'Original title', updatedAt: 10, cwd: '/old-directory' })
    const current = catalog([mutable]), snapshot = captureSharePicker(current)
    current.byId.original = source('original', { displayTitle: 'Changed live', updatedAt: 1000, offline: true, cwd: '/new-directory' })
    current.ids.push('later' as never); current.byId.later = source('later')
    assert.deepEqual(snapshot.candidates.map(value => value.title), ['Original title'])
    assert.equal(snapshot.candidates[0]?.active, true); assert.equal(snapshot.candidates[0]?.updatedAt, 10)
    assert.deepEqual(filterSharePicker(snapshot, 'old', null, 8).candidates.map(value => value.id), ['original'])
    assert.equal(filterSharePicker(snapshot, 'new', null, 8).candidates.length, 0)
    assert.equal(Object.isFrozen(snapshot.candidates[0]?.fields.path), true)
})

test('full source routes preserve owning Host, machine and native identity without legacy placeholder inference', () => {
    const base = source('base')
    const rows = [base, source('host-two', { hostId: 'other-host', sourceSessionId: base.sourceSessionId }),
        source('machine-two', { sourceSessionId: 'hhpi:machine-two:source:codex:native-base' }),
        source('source-two', { sourceSessionId: 'hhpi:machine-one:other-source:codex:native-base' }),
        source('native-two'), row('ordinary-blank', { blank: true })]
    assert.equal(captureSharePicker(catalog(rows)).candidates.length, 6)
    assert.equal(shareTargetForRow(row(`hapi-codex-${'a'.repeat(32)}`)), null)
    const target = shareTargetForRow(source('same', { projectionValues: { hapi: { hubId: 'unrelated', hapiSessionId: 'other' } } as never }))
    assert.equal(target?.kind, 'hhpi'); assert.equal(target?.sessionId, 'hhpi:machine-one:source:codex:native-same')
})

test('selection revalidates exact source ownership across display generations and refuses missing/offline/ambiguous/reused addresses', () => {
    const initial = source('original'), candidate = captureSharePicker(catalog([initial])).candidates[0]!
    const next = source('new-generation', { sourceSessionId: initial.sourceSessionId, projectionValues: initial.projectionValues! })
    const resolved = resolveShareCandidate(candidate, catalog([next]))
    assert.equal(resolved.status, 'ready'); if (resolved.status === 'ready') { assert.equal(resolved.row.id, 'new-generation'); assert.deepEqual(resolved.target, { kind: 'hhpi', hostId: 'local', sessionId: initial.sourceSessionId, identity: { machineId: 'machine-one', sourceId: 'source', engine: 'codex', nativeId: 'native-original' } }) }
    assert.equal(resolveShareCandidate(candidate, catalog([source('original', { sourceSessionId: 'hhpi:other-machine:source:codex:native-original' })])).status, 'missing')
    assert.equal(resolveShareCandidate(candidate, catalog([source('original', { hostId: 'different-graph' })])).status, 'missing')
    assert.equal(resolveShareCandidate(candidate, catalog([source('original', { hostOnline: false })])).status, 'offline')
    assert.equal(resolveShareCandidate(candidate, catalog([initial, next])).status, 'ambiguous')
    const onlyFallback = catalog([]); onlyFallback.byId.original = initial
    assert.equal(resolveShareCandidate(candidate, onlyFallback).status, 'missing', 'retained fallback is not Host catalog membership')
    assert.equal(resolveShareCandidates([candidate], catalog([next])).get(candidate.id)?.status, 'ready')
})

test('catalog readiness observes source/Host completion and source bindings; a failed or offline Host never waits forever', () => {
    const discovery = new CatalogDiscovery()
    assert.equal(discovery.snapshot(true).phase, 'pending', 'an empty ready local catalog is not a completed federation discovery')
    discovery.observe([{ id: 'remote', label: 'Remote machine', online: true }, { id: 'offline', label: 'Offline machine', online: false }], true)
    assert.equal(discovery.snapshot(true).phase, 'pending')
    discovery.hostReady('remote', 'Remote machine')
    assert.equal(discovery.snapshot(true, 1).phase, 'pending', 'published source targets must hydrate their own actual display identities')
    assert.equal(discovery.snapshot(true).phase, 'partial')
    discovery.observe([{ id: 'remote', label: 'Remote machine', online: true }], true)
    discovery.hostFailed('remote', 'Remote machine', 'Disconnected')
    assert.equal(discovery.snapshot(true).phase, 'partial')
    discovery.sourceFailed('Cannot reach catalog')
    assert.equal(discovery.snapshot(true).sourceError, 'Cannot reach catalog')
    assert.equal(discovery.snapshot(true).phase, 'partial', 'ordinary loaded DSH remains selectable on source failure')
    assert.equal(discovery.snapshot(false).phase, 'pending')
    discovery.observe([{ id: 'remote', label: 'Renamed', online: true }], true)
    assert.equal(discovery.snapshot(true).hosts.find(host => host.id === 'remote')?.phase, 'unavailable', 'a background retry does not forget a known failure')
    discovery.hostReady('remote', 'Renamed')
    assert.equal(discovery.snapshot(true).hosts.find(host => host.id === 'remote')?.phase, 'ready')
})

test('preview truncation and binary sizes never alter the original full payload', () => {
    const payload = { text: `  ${'x'.repeat(200)} original tail  `, title: 'Title', url: 'https://example.invalid/original' }
    assert.equal(sharePreviewText(payload), `${'x'.repeat(200)}…`)
    assert.ok(payload.text.endsWith('original tail  '))
    assert.equal(sharePreviewText({ text: '', url: 'https://example.invalid', title: 'Title' }), 'https://example.invalid')
    assert.equal(sharePreviewText({ text: '', url: '', title: '  Title  ' }), 'Title')
    assert.deepEqual([shareFileSize(1), shareFileSize(1023), shareFileSize(1024), shareFileSize(1536), shareFileSize(1048576)], ['1 B', '1023 B', '1.0 KB', '1.5 KB', '1.0 MB'])
})
