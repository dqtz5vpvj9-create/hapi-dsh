/** Pure source/catalog fixtures. Actual official Web/IDB/composer coverage is in e2e/share-picker.spec.ts. */
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
function source(id: string, patch: Partial<WorkspaceCatalogRow> = {}): WorkspaceCatalogRow {
    return row(id, { sourceActive: true, cwd: '/source/repo', projectionValues: { hapi: { engine: 'codex', hubId: 'original-hub',
        hapiSessionId: `source-${id}`, machineId: 'machine-one', nativeId: `native-${id}`, nativeConnection: 'attached' } } as never,
        sourceListFacts: { metadataPresent: true, flavor: 'codex', agentSessionId: `native-${id}`, codexStoreId: '/home/original', hasTitleSignal: true, hasConversationContent: true }, ...patch })
}
function catalog(rows: readonly WorkspaceCatalogRow[]): WorkspaceCatalog {
    return { ids: rows.map(value => value.id), byId: Object.fromEntries(rows.map(value => [value.id, value])), phase: 'ready', projectionsBySession: {} }
}

test('recent active preview uses the original cap and source recency; search includes inactive sessions without a cap', () => {
    const rows = Array.from({ length: 12 }, (_, index) => source(`session-${index}`, { updatedAt: index + 1 }))
    rows.push(source('inactive', { sourceActive: false, updatedAt: 1000 }))
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
    const nativeTime = captureSharePicker(catalog([source('older-display', { updatedAt: 900, sourceLastActiveAt: 1 }), source('actual-recent', { updatedAt: 2, sourceLastActiveAt: 100 })]))
    assert.deepEqual(nativeTime.candidates.map(value => value.id), ['actual-recent', 'older-display'])
})

test('search uses original AND/wildcard fields with snapshotted custom machine labels and always keeps recency order', () => {
    const rows = [source('older', { updatedAt: 10, displayTitle: 'Alpha exact title', sourceSummary: 'A detailed source summary',
        sourceWorktree: { name: 'Beta worktree', basePath: '/base/project', worktreePath: '/trees/feature' }, sourceSubagentSearch: ['Review Agent', '/agent/a'] }),
    source('newer', { updatedAt: 20, displayTitle: 'Other title', sourceSummary: 'Alpha exact title' })]
    const snapshot = captureSharePicker(catalog(rows), [{ id: 'machine-one', label: 'Classroom Laptop', online: true }])
    assert.deepEqual(filterSharePicker(snapshot, 'alpha', null, 8).candidates.map(value => value.id), ['newer', 'older'], 'share sorting is recency, not main-sidebar relevance')
    assert.deepEqual(filterSharePicker(snapshot, 'ALPHA classroom review /base', null, 8).candidates.map(value => value.id), ['older'])
    assert.deepEqual(filterSharePicker(snapshot, '*Worktree', null, 8).candidates.map(value => value.id), ['older'])
    assert.deepEqual(filterSharePicker(snapshot, 'native-olde?', null, 8).candidates.map(value => value.id), ['older'])
    assert.equal(filterSharePicker(snapshot, 'alpha missing', null, 8).candidates.length, 0)
    assert.equal(filterSharePicker(snapshot, '[alpha]', null, 8).candidates.length, 0)
})

test('date filtering uses whole local dates, includes inactive matches and advertises activity beyond the preview', () => {
    const first = new Date(2026, 9, 1, 0, 0).getTime(), second = new Date(2026, 9, 2, 0, 0).getTime()
    const snapshot = captureSharePicker(catalog([source('start', { updatedAt: first, sourceActive: false }), source('late', { updatedAt: second - 1 }), source('tomorrow', { updatedAt: second })]))
    assert.deepEqual(filterSharePicker(snapshot, '', sidebarTimeRange('2026-10-01', '2026-10-01'), 1).candidates.map(value => value.id), ['late', 'start'])
    assert.equal(snapshot.activityDates.has(localDayKey(first)), true); assert.equal(snapshot.activityDates.has(localDayKey(second)), true)
    assert.equal(filterSharePicker(snapshot, '', sidebarTimeRange('2026-10-01', ''), 1).searching, false)
    assert.equal(filterSharePicker(snapshot, '', sidebarTimeRange('2026-10-02', '2026-10-01'), 1).searching, false)
})

test('live SSE edits cannot mutate an already captured candidate list, labels, fields or source address', () => {
    const mutable = source('original', { displayTitle: 'Original title', updatedAt: 10, sourceSubagentSearch: ['Old agent'] })
    const current = catalog([mutable]), snapshot = captureSharePicker(current)
    current.byId.original = source('original', { displayTitle: 'Changed live', updatedAt: 1000, sourceActive: false, sourceSubagentSearch: ['New agent'] })
    current.ids.push('later' as never); current.byId.later = source('later')
    assert.deepEqual(snapshot.candidates.map(value => value.title), ['Original title'])
    assert.equal(snapshot.candidates[0]?.active, true); assert.equal(snapshot.candidates[0]?.updatedAt, 10)
    assert.deepEqual(filterSharePicker(snapshot, 'old', null, 8).candidates.map(value => value.id), ['original'])
    assert.equal(filterSharePicker(snapshot, 'new', null, 8).candidates.length, 0)
    assert.equal(Object.isFrozen(snapshot.candidates[0]?.fields.subagent), true)
})

test('source preparation uses actual native identity, prefers connected/pinned originals, and preserves graph/Hub/machine/store boundaries', () => {
    const facts = source('base').sourceListFacts!
    const same = (id: string, patch: Partial<WorkspaceCatalogRow> = {}) => source(id, { sourceListFacts: facts, sourceActive: false, ...patch })
    const inactiveNew = same('inactive-new', { updatedAt: 1000, pinned: true, sourcePinMode: 'global' })
    const connectedOld = same('connected-old', { updatedAt: 1, sourceActive: true })
    assert.deepEqual(captureSharePicker(catalog([inactiveNew, connectedOld])).candidates.map(value => value.id), ['connected-old'])
    const global = same('global', { sourcePinMode: 'global', pinned: true, updatedAt: 1 })
    assert.deepEqual(captureSharePicker(catalog([same('new', { updatedAt: 900 }), global])).candidates.map(value => value.id), ['global'])
    const shared = { hapi: { engine: 'codex', hubId: 'original-hub', hapiSessionId: 'different-source', machineId: 'machine-two', nativeId: facts.agentSessionId, nativeConnection: 'attached' } } as never
    const distinct = [connectedOld, same('store-two', { sourceListFacts: { ...facts, codexStoreId: '/different/store' } }), same('machine-two', { projectionValues: shared }),
        same('host-two', { hostId: 'other-host' }), same('hub-two', { projectionValues: { hapi: { engine: 'codex', hubId: 'different-hub', hapiSessionId: 'source-hub-two', machineId: 'machine-one' } } as never })]
    assert.equal(captureSharePicker(catalog(distinct)).candidates.length, 5)
})

test('only positively identified empty source placeholders are hidden; unknown facts and ordinary blank DSH survive', () => {
    const empty = { metadataPresent: false, flavor: null, agentSessionId: null, codexStoreId: null, hasTitleSignal: false, hasConversationContent: false }
    const rows = [source('stub', { sourceActive: false, sourceListFacts: empty }),
        source('unknown-content', { sourceActive: false, sourceListFacts: { ...empty, hasConversationContent: null } }),
        source('kept-pin', { sourceActive: false, sourceListFacts: empty, pinned: true }),
        source('kept-native-id', { sourceActive: false, sourceListFacts: { ...empty, agentSessionId: 'source-native' } }),
        row('ordinary-blank', { blank: true })]
    const snapshot = captureSharePicker(catalog(rows))
    assert.deepEqual(snapshot.candidates.map(value => value.id), ['unknown-content', 'kept-pin', 'kept-native-id', 'ordinary-blank'])
    assert.deepEqual(filterSharePicker(snapshot, 'ordinary', null, 8).candidates.map(value => value.id), ['ordinary-blank'])
    assert.equal(shareTargetForRow(row('hapi-codex-cold')), null)
    assert.equal(shareTargetForRow(source('missing-hub', { projectionValues: { hapi: { hapiSessionId: 'source' } } as never })), null)
    assert.equal(captureSharePicker(catalog([source('child', { projectionValues: { hapiObserved: { sidechain: { rootSessionId: 'parent' } } } as never })])).candidates.length, 0)
})

test('selection revalidates exact source ownership across display generations and refuses missing/offline/ambiguous/reused addresses', () => {
    const initial = source('original'), candidate = captureSharePicker(catalog([initial])).candidates[0]!
    const next = source('new-generation', { projectionValues: initial.projectionValues! })
    const resolved = resolveShareCandidate(candidate, catalog([next]))
    assert.equal(resolved.status, 'ready'); if (resolved.status === 'ready') { assert.equal(resolved.row.id, 'new-generation'); assert.deepEqual(resolved.target, { kind: 'hapi', hubId: 'original-hub', sessionId: 'source-original' }) }
    assert.equal(resolveShareCandidate(candidate, catalog([source('original', { projectionValues: { hapi: { hubId: 'other-hub', hapiSessionId: 'source-original' } } as never })])).status, 'missing')
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
    assert.equal(discovery.snapshot(true, 1).phase, 'pending', 'published HAPI targets must hydrate their own actual display identities')
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
