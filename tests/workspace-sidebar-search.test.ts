/** Original source search semantics, including exact field boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSidebarSearchIndex, collectSidebarSearchFields, compareSidebarSearch, hasSidebarSearchBoundary, matchesSidebarSearch, sourceWorktreeLabel, type SidebarSearchRow } from '../src/workspace/sidebar-search.ts'
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

test('AND terms can match different source fields; original source and native identities stay searchable', () => {
    const value = row('display-id', { displayTitle: 'Fresh feature', sourceSummary: 'Resolve ledger races',
        sourceSubagentSearch: ['reviewer', 'src/ledger.ts', 'native-child'], projectionValues: { hapi: { hapiSessionId: 'source-identity' } } as never })
    const index = buildSidebarSearchIndex([value], 'ledger laptop codex', location)
    assert.equal(index.matchedIds.has(value.id), true)
    assert.equal(buildSidebarSearchIndex([value], 'ledger missing', location).matchedIds.size, 0)
    assert.equal(buildSidebarSearchIndex([value], 'native-child', location).matchedIds.size, 1)
    assert.equal(buildSidebarSearchIndex([value], 'source-identity', location).matchedIds.size, 1)
    assert.equal(buildSidebarSearchIndex([value], 'runtime-thread', () => ({ ...location(), nativeId: 'runtime-thread' })).matchedIds.size, 1)
})

test('wildcards match whole individual fields, preserve Unicode ?, and never interpret regex syntax', () => {
    for (const [text, pattern, expected] of [['src/file.ts', '*.ts', true], ['src/file.ts.bak', '*.ts', false], ['file-01.ts', 'file-??.ts', true],
        ['file-001.ts', 'file-??.ts', false], ['file+.ts', 'file+.ts', true], ['fileX.ts', 'file+.ts', false], ['x😀y', 'x?y', true],
        ['a'.repeat(1000), '*a*a*a*a*a*a*b', false]] as const) assert.equal(matchesSidebarSearch(text, pattern), expected)
    const value = row('worktree', { cwd: '/repo/worktrees/task', sourceWorktree: { name: 'task', basePath: '/repo/main', branch: 'feat/task', worktreePath: '/repo/worktrees/task' } })
    assert.equal(buildSidebarSearchIndex([value], '*repo/main', location).matchedIds.size, 1)
    assert.equal(buildSidebarSearchIndex([value], '*main laptop*', location).matchedIds.size, 0)
})

test('worktree labels use actual source names or actual paths without inventing a worktree path', () => {
    const value = row('label', { cwd: 'C:\\source\\tree\\', sourceWorktree: { name: '', basePath: 'C:\\source', branch: 'feature' } })
    assert.equal(sourceWorktreeLabel(value), 'tree')
    const fields = collectSidebarSearchFields(value, location())
    assert.deepEqual(fields.path, ['C:\\source\\tree\\', 'C:\\source'])
    assert.deepEqual(fields.worktreeLabel, ['tree'])
    assert.equal(sourceWorktreeLabel(row('plain', { cwd: '/source/tree' })), null)
})
