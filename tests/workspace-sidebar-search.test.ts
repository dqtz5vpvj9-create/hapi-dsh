/** Original source search semantics, including exact field boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSidebarSearchIndex, collectSidebarSearchFields, compareSidebarSearch, hasSidebarSearchBoundary, matchesSidebarSearch, type SidebarSearchRow } from '../src/workspace/sidebar-search.ts'
const row = (id: string, patch: Partial<SidebarSearchRow> = {}): SidebarSearchRow => ({ id: id as SidebarSearchRow['id'], displayTitle: id, updatedAt: 0, ...patch })
const location = () => ({ engine: 'codex', machineName: 'Laptop' })

test('source title/boundary/exact phrase rank ahead of newer incidental path and machine matches', () => {
    const rows = [row('path', { displayTitle: 'Other work', cwd: '/home/me/project', updatedAt: 900 }),
        row('scrambled', { displayTitle: 'Assistant for Home', updatedAt: 1000 }), row('title', { displayTitle: 'Home Assistant', updatedAt: 10 }),
        row('substring', { displayTitle: 'homelab', updatedAt: 2000 })]
    const one = buildSidebarSearchIndex(rows, 'home', location)
    assert.deepEqual([...rows].sort((a, b) => compareSidebarSearch(a, b, one)).map(row => row.id), ['scrambled', 'title', 'substring', 'path'])
    const phrase = buildSidebarSearchIndex(rows, 'Home Assistant', location)
    assert.deepEqual([...phrase.matchedIds], ['scrambled', 'title'])
    assert.equal([...rows].sort((a, b) => compareSidebarSearch(a, b, phrase))[0]?.id, 'title')
    assert.equal(hasSidebarSearchBoundary('home-lab', 'home'), true)
    assert.equal(hasSidebarSearchBoundary('homelab', 'home'), false)
    assert.equal(matchesSidebarSearch('homelab', 'home'), true)
})

test('AND terms search current published paths and exact native/source identities without retired projections', () => {
    const value = row('display-id', { displayTitle: 'Fresh feature', cwd: '/src/ledger.ts', sourceSessionId: 'source-identity',
        projectionValues: { hapi: { hapiSessionId: 'retired-identity' } } as never })
    const index = buildSidebarSearchIndex([value], 'ledger laptop codex', location)
    assert.equal(index.matchedIds.has(value.id), true)
    assert.equal(buildSidebarSearchIndex([value], 'ledger missing', location).matchedIds.size, 0)
    assert.equal(buildSidebarSearchIndex([value], 'source-identity', location).matchedIds.size, 1)
    assert.equal(buildSidebarSearchIndex([value], 'retired-identity', location).matchedIds.size, 0)
    assert.equal(buildSidebarSearchIndex([value], 'runtime-thread', () => ({ ...location(), nativeId: 'runtime-thread' })).matchedIds.size, 1)
})

test('wildcards match whole individual fields, preserve Unicode ?, and never interpret regex syntax', () => {
    for (const [text, pattern, expected] of [['src/file.ts', '*.ts', true], ['src/file.ts.bak', '*.ts', false], ['file-01.ts', 'file-??.ts', true],
        ['file-001.ts', 'file-??.ts', false], ['file+.ts', 'file+.ts', true], ['fileX.ts', 'file+.ts', false], ['x😀y', 'x?y', true],
        ['a'.repeat(1000), '*a*a*a*a*a*a*b', false]] as const) assert.equal(matchesSidebarSearch(text, pattern), expected)
    const value = row('worktree', { cwd: '/repo/main' })
    assert.equal(buildSidebarSearchIndex([value], '*repo/main', location).matchedIds.size, 1)
    assert.equal(buildSidebarSearchIndex([value], '*main laptop*', location).matchedIds.size, 0)
})

test('directory search uses the published path verbatim without inventing another source root', () => {
    const value = row('label', { cwd: 'C:\\source\\tree\\' })
    const fields = collectSidebarSearchFields(value, location())
    assert.deepEqual(fields.path, ['C:\\source\\tree\\'])
    assert.deepEqual(collectSidebarSearchFields(row('plain'), location()).path, [])
})
