/**
 * Continuous history contract for the public client sessions facade.
 *
 * Constructed source relationships are explicit: the 1,700-row fixtures make
 * each source row render three sibling events; the 3,500-row fixture makes one
 * event per distinct source row. Fake pages never contain more than 200 source
 * rows. This is adapter-level Node evidence, not a real browser or Host run.
 *
 * The current SourceSessions implementation is bundled with the installed
 * official MutableSessionEventSource. Only the public SessionFace facade is
 * used; the original ISessions/API are synthetic fixtures.
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const controllerRoot = dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
const contractEvents = join(controllerRoot, 'lib/types/client/contract/events.js')
const SESSION_ID = 'hapi-codex-00000000000000000000000000000099'
const MAX_PAGE_ROWS = 200

interface SourcePosition { messageId: string; at: number; seq: number }
interface ApiRequest {
  messageId?: string
  fromOldest?: boolean
  beforeAt?: number
  beforeSeq?: number
  afterAt?: number
  afterSeq?: number
}
interface Runtime {
  SourceSessions: new (original: unknown) => {
    attach(api: unknown): void
    retain(id: string, options: { source: string }): {
      ready: Promise<unknown>
      binding: { session: any; eventSource: any }
      release(): void
    }
  }
  MutableSessionEventSource: new () => any
}
interface Harness {
  face: any
  eventSource: any
  requests: ApiRequest[]
  release(): void
}
interface WindowPage {
  ok: true
  value: {
    records: unknown[]
    hasMoreBefore: boolean
    hasMoreAfter: boolean
    before: SourcePosition
    after: SourcePosition
  }
}

let runtime: Runtime

before(async () => {
  const contents = [
    `export { SourceSessions } from ${JSON.stringify(join(root, 'src/client/source-sessions.ts'))}`,
    "export { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'",
  ].join('\n')
  const built = await build({
    stdin: { contents, resolveDir: root, sourcefile: 'source-window-retention-entry.ts', loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': join(root, 'tests/fixtures/client-session-contract.ts') },
    bundle: true, platform: 'node', target: 'node24', format: 'esm',
    write: false, sourcemap: false, legalComments: 'none', logLevel: 'silent',
  })
  const source = built.outputFiles[0]?.text
  assert.ok(source, 'esbuild produced the SourceSessions retention bundle')
  runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as unknown as Runtime
})

class ValueSource<T> {
  private readonly value: T
  constructor(value: T) { this.value = value }
  getSnapshot = (): T => this.value
  subscribe = (_listener: () => void): (() => void) => () => {}
}

function entry(index: number, source: SourcePosition, text: string, testId: string): unknown {
  return {
    type: 'event',
    event: { type: 'user/message', seq: index + 1, time: index + 1, data: { turn: 0, id: testId, text } },
    source,
    testId,
  }
}

function page(records: readonly unknown[], hasMoreBefore: boolean, hasMoreAfter: boolean,
  before: SourcePosition, after: SourcePosition): WindowPage {
  return { ok: true, value: { records: [...records], hasMoreBefore, hasMoreAfter, before, after } }
}

async function harness(handler: (request: ApiRequest) => WindowPage, initialTail: unknown[] = []): Promise<Harness> {
  const eventSource = new runtime.MutableSessionEventSource()
  if (initialTail.length > 0) eventSource.replace(initialTail, true)
  const outline = new ValueSource<readonly unknown[]>([])
  const requests: ApiRequest[] = []
  const snapshot = {
    sessionId: SESSION_ID, running: false, removed: false, openState: 'open', openError: null,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
    pendingSubmissions: [], promptError: null, hasMore: false, loadingOlder: false, subagent: null,
  }
  const session = {
    sessionId: SESSION_ID,
    projections: { faceOf: (key: string) => key === 'turnOutline' ? outline : new ValueSource(undefined) },
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    loadOlder: () => Promise.resolve(),
    loadThrough: () => Promise.resolve(),
  }
  const binding = { sessionId: SESSION_ID, session, eventSource, ctx: {} }
  const reference = { sessionId: SESSION_ID, binding, ready: Promise.resolve(binding), release() {} }
  const original = {
    retain: () => reference,
    retainInfo: () => new ValueSource({ referenceCount: 1, retainedBy: {} }),
    binding: () => binding,
  }
  const facade = new runtime.SourceSessions(original)
  facade.attach({
    sourceHistoryOutline: async () => ({ ok: true, value: {
      entries: [], seedIndex: 0, firstTurn: 0, epoch: 1, complete: true,
    } }),
    sourceReadingAnchor: async () => ({ ok: true, value: { sourceMessageId: 'm1' } }),
    sourceHistoryWindowPage: async (request: ApiRequest) => {
      requests.push(request)
      return handler(request)
    },
  })
  const retained = facade.retain(SESSION_ID, { source: 'mainView' })
  await retained.ready
  return {
    face: retained.binding.session,
    eventSource: retained.binding.eventSource,
    requests,
    release: () => retained.release(),
  }
}

function utf8Bytes(entries: readonly any[]): number {
  return entries.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value), 'utf8'), 0)
}

function maxRows(pageRows: readonly number[]): number {
  return pageRows.reduce((max, rows) => Math.max(max, rows), 0)
}

function siblingWorld(text: string): {
  harness: Promise<Harness>
  expected: string[]
  pageRows: number[]
  fill(): Promise<void>
  revisit(): Promise<{ neverSeen: string[]; retained: number; bytes: number }>
} {
  const rows = 1_700, perRow = 3, tailRows = 200
  const position = (row: number): SourcePosition => ({ messageId: `m${row}`, at: 1000 + row * 10, seq: row + 1 })
  const full = Array.from({ length: rows }, (_, row) => [0, 1, 2].map(sibling =>
    entry(row * perRow + sibling, position(row), text, `m${row}-e${sibling}`))).flat()
  const expected = full.map((value: any) => value.testId as string)
  const tailStart = rows - tailRows
  const pageRows: number[] = []
  const sourcePage = (startRow: number, endRow: number): WindowPage => {
    assert.ok(startRow <= endRow, 'the fake source page must contain at least one row')
    const count = endRow - startRow + 1
    assert.ok(count <= MAX_PAGE_ROWS, `the fake source page exceeded ${MAX_PAGE_ROWS} rows: ${count}`)
    pageRows.push(count)
    return page(full.slice(startRow * perRow, (endRow + 1) * perRow),
      startRow > 0, endRow < rows - 1, position(startRow), position(endRow))
  }
  const harnessed = harness(request => {
    if (request.afterAt !== undefined) {
      const row = (request.afterSeq ?? 1) - 1
      const start = row + 1
      return sourcePage(start, Math.min(rows - 1, start + MAX_PAGE_ROWS - 1))
    }
    if (request.beforeAt !== undefined) {
      const row = (request.beforeSeq ?? 1) - 1
      return sourcePage(Math.max(0, row - MAX_PAGE_ROWS), row - 1)
    }
    return sourcePage(Math.max(0, tailStart - MAX_PAGE_ROWS), tailStart - 1)
  }, full.slice(tailStart * perRow))
  return {
    harness: harnessed,
    expected,
    pageRows,
    async fill() {
      const h = await harnessed
      for (let index = 0; index < Math.ceil((rows - tailRows) / MAX_PAGE_ROWS); index += 1) await h.face.loadOlder()
    },
    async revisit() {
      const h = await harnessed
      const seen = new Set<string>()
      const capture = (): void => { for (const value of h.eventSource.getSnapshot().entries) seen.add(value.testId) }
      // A new reading pass after eviction: seeing an event previously does not
      // prove it can be fetched again.
      capture()
      for (let attempt = 0; attempt < Math.ceil(rows / MAX_PAGE_ROWS) + 1; attempt += 1) {
        const changed = await h.face.loadAfter()
        capture()
        if (!changed) break
      }
      const retained = h.eventSource.getSnapshot().entries
      return {
        neverSeen: expected.filter(value => !seen.has(value)),
        retained: retained.length,
        bytes: utf8Bytes(retained),
      }
    },
  }
}

test('history above the resident window stays retrievable when reading back to the tail', { timeout: 30_000 }, async () => {
  const world = siblingWorld('x')
  const h = await world.harness
  try {
    await world.fill()
    const result = await world.revisit()
    console.log(JSON.stringify({ case: 'event-count', pageRows: world.pageRows, maxPageRows: maxRows(world.pageRows),
      retained: result.retained, bytes: result.bytes, neverSeen: result.neverSeen }))
    assert.ok(maxRows(world.pageRows) <= MAX_PAGE_ROWS, 'every fake source page must be at most 200 rows')
    assert.ok(result.retained <= 2_400, 'the live projection stays near HAPI\'s 800-message history window')
    assert.deepEqual(result.neverSeen, [], 'every event must be retrievable again after event-count eviction')
  } finally { h.release() }
})

test('history above the byte budget stays retrievable when reading back to the tail', { timeout: 30_000 }, async () => {
  const world = siblingWorld('你'.repeat(1_200))
  const h = await world.harness
  try {
    await world.fill()
    const result = await world.revisit()
    console.log(JSON.stringify({ case: 'byte-driven', pageRows: world.pageRows, maxPageRows: maxRows(world.pageRows),
      retained: result.retained, bytes: result.bytes, neverSeen: result.neverSeen }))
    assert.ok(maxRows(world.pageRows) <= MAX_PAGE_ROWS, 'every fake source page must be at most 200 rows')
    assert.ok(result.bytes <= 8 * 1024 * 1024, 'resident body bytes stay within the source-window budget')
    assert.deepEqual(result.neverSeen, [], 'every event must be retrievable again after byte-driven eviction')
  } finally { h.release() }
})

test('large distinct source rows round-trip from the bounded resident window', { timeout: 30_000 }, async () => {
  const count = 3_500, tailRows = 200
  const payload = '你'.repeat(3_000)
  const position = (row: number): SourcePosition => ({ messageId: `byte-${row}`, at: 1000 + row, seq: row + 1 })
  const full = Array.from({ length: count }, (_, row) => entry(row, position(row), payload, `byte-${row}`))
  const expected = new Set(full.map((value: any) => value.testId as string))
  const tailStart = count - tailRows
  const pageRows: number[] = []
  const sourcePage = (start: number, end: number): WindowPage => {
    assert.ok(start <= end, 'the fake source page must contain at least one row')
    const rows = end - start + 1
    assert.ok(rows <= MAX_PAGE_ROWS, `the fake source page exceeded ${MAX_PAGE_ROWS} rows: ${rows}`)
    pageRows.push(rows)
    return page(full.slice(start, end + 1), start > 0, end < count - 1, position(start), position(end))
  }
  const h = await harness(request => {
    const end = request.beforeSeq === undefined ? tailStart - 1 : request.beforeSeq - 2
    return sourcePage(Math.max(0, end - MAX_PAGE_ROWS + 1), end)
  }, full.slice(tailStart))
  try {
    const seen = new Map<string, any>()
    const capture = (): void => { for (const value of h.eventSource.getSnapshot().entries) seen.set(value.testId, value) }
    for (let index = 0; index < Math.ceil((count - tailRows) / MAX_PAGE_ROWS); index += 1) {
      await h.face.loadOlder(); capture()
    }
    for (let index = 0; index < Math.ceil(count / MAX_PAGE_ROWS) + 2; index += 1) {
      if (!await h.face.loadAfter()) break
      capture()
    }
    const retained = h.eventSource.getSnapshot().entries
    const bytes = utf8Bytes(retained)
    console.log(JSON.stringify({ case: 'distinct-source-utf8', pageRows, maxPageRows: maxRows(pageRows),
      retained: retained.length, bytes }))
    assert.ok(maxRows(pageRows) <= MAX_PAGE_ROWS, 'every fake source page must be at most 200 rows')
    assert.ok(retained.length <= 800, 'only the 800 nearest source rows remain projected')
    assert.equal(seen.size, count, 'the reader can traverse every source row after old pages leave the resident window')
    assert.ok(bytes <= 8 * 1024 * 1024, 'the resident source projection stays within its byte budget')
    for (const value of retained) {
      assert.ok(expected.has(value.testId), `retained an event outside the constructed source set: ${String(value.testId)}`)
      assert.equal(value.event.data.text, payload, `retained event content changed for ${String(value.testId)}`)
    }
  } finally { h.release() }
})

for (const kind of ['event-count', 'bytes'] as const) {
  test(`an oversized source page stays intact (${kind})`, async () => {
    const small = { messageId: 'm1', at: 1, seq: 1 }
    const large = { messageId: 'large', at: 2, seq: 2 }
    const count = kind === 'event-count' ? 5_100 : 3
    const text = kind === 'bytes' ? 'x'.repeat(5 * 1024 * 1024) : 'large'
    const group = Array.from({ length: count }, (_, index) => entry(index + 10, large, text, `large-${index}`))
    const h = await harness(request => request.afterAt === undefined
      ? page([entry(1, small, 'neighbor', 'small')], false, true, small, small)
      : page(group, true, false, large, large))
    try {
      // Start from a detached older source window. Loading before the live
      // tail is already at source head and correctly has no forward gap.
      await h.face.loadThrough(1)
      assert.equal(await h.face.loadAfter(), true)
      const retained = h.eventSource.getSnapshot().entries
      const largeRows = retained.filter((row: any) => row.source?.messageId === 'large')
      assert.equal(largeRows.length, count, 'the page remains complete even when one source turn exceeds the budget')
      assert.ok(largeRows.every((row: any) => row.event.data.text === text))
      if (kind === 'event-count') assert.ok(retained.some((row: any) => row.source?.messageId === 'm1'))
    } finally { h.release() }
  })
}
