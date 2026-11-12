/** Production search/task read owners; only native RPC replies and account generation are fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeSourceSearch, nativeThreadSummary, type NativeHistoryTarget, type NativeSourceQueryApi } from '../src/client/sidebar-search-query.ts'
import { NativeThreadHistory } from '../src/client/remote-native-history-state.ts'
import type { CodexCall } from '../src/remote/codex-access.ts'
const route = { hostId: 'host-a', machineId: 'machine-a', sourceId: 'codex-a', engine: 'codex' }
const thread = (id: string, parentThreadId: string | null = null) => ({ id, name: 'Same title', preview: '', cwd: '/source/project', createdAt: 1, updatedAt: 2, status: { type: 'notLoaded' }, parentThreadId })
function fixture(reply: (request: CodexCall) => unknown | Promise<unknown>) {
  const calls: CodexCall[] = []
  let current = true
  const api: NativeSourceQueryApi = {
    nativeCapabilities: async () => ({ ok: true, value: { runtime: 'fixture', protocolVersion: '0.165.0', unavailable: {}, methods: Object.fromEntries(['thread/search', 'thread/searchOccurrences', 'thread/read', 'thread/list', 'thread/turns/list'].map(method => [method, 'read' as const])) } }),
    nativeCall: async request => { calls.push(request); return { ok: true, value: { status: 'accepted', message: '', result: await reply(request) } } },
  }
  return { api, calls, current: () => current, revoke: () => { current = false } }
}

test('native subagent titles keep the source task label ahead of random nicknames and internal identity', () => {
  const child = { ...thread('internal-native-id', 'parent'), name: null, preview: '', agentNickname: 'Random nickname',
    source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', agent_path: '/root/check_api', agent_nickname: 'Random nickname', depth: 1 } } } }
  assert.equal(nativeThreadSummary(route, child).title, 'check_api')
  assert.equal(nativeThreadSummary(route, { ...child, preview: 'Inspect the API response' }).title, 'Inspect the API response')
  assert.equal(nativeThreadSummary(route, { ...child, preview: 'Inspect the API response', name: 'Named API task' }).title, 'Named API task')
  const unnamed = nativeThreadSummary(route, { ...child, source: 'appServer' })
  assert.equal(unnamed.title, 'Subtask'); assert.equal(unnamed.nickname, 'Random nickname'); assert.equal(unnamed.nativeId, child.id)
  assert.equal(nativeThreadSummary(route, { ...child, source: { subAgent: { thread_spawn: { agent_path: '/root/11111111-1111-4111-8111-111111111111' } } } }).title, 'Subtask')
  const fork = nativeThreadSummary(route, { ...thread('fork-id'), name: null, preview: '', forkedFromId: 'parent' })
  assert.equal(fork.title, 'Untitled conversation'); assert.equal(fork.parentThreadId, null, 'a fork is not a subagent')
})

test('source full-text pages preserve original cursors and open the exact native occurrence with its origin', async () => {
  const f = fixture(request => {
    const p = request.params!
    if (request.method === 'thread/search') return { data: [{ thread: thread(p.cursor ? 'second' : 'first'), snippet: 'A needle in native text' }], nextCursor: p.cursor ? null : 'thread-page-2' }
    if (request.method === 'thread/searchOccurrences') return { data: [{ turnId: 'native-turn', itemId: p.cursor ? 'item-2' : 'item-1', turnCursor: 'opaque-turn-anchor', snippet: 'A needle here', snippetMatchRange: { start: 2, end: 8 } }], nextCursor: p.cursor ? null : 'matches-2' }
    if (request.method === 'thread/read') return { thread: thread(String(p.threadId)) }
    throw new Error('Unexpected read')
  })
  const controller = new NativeSourceSearch(route, f.api, f.current)
  try {
    await controller.search('needle'); assert.equal(f.calls.length, 2)
    assert.equal(controller.getSnapshot().complete, true, 'one explicit query continues bounded source batches until complete')
    assert.deepEqual(controller.getSnapshot().rows.map(row => row.nativeId), ['first', 'second'])
    assert.deepEqual(f.calls.slice(0, 2).map(call => call.params?.cursor), [null, 'thread-page-2'])
    const row = controller.getSnapshot().rows[1]!
    await controller.select(row); await controller.nextOccurrences()
    const match = controller.getSnapshot().occurrences[1]!, opened: NativeHistoryTarget[] = []
    const origin: NativeHistoryTarget = { hostId: route.hostId, sessionId: 'original-parent', position: { kind: 'native', turnId: 'original-turn', itemId: 'original-item' } }
    await controller.open(row, match, target => { opened.push(target) }, origin)
    assert.deepEqual(opened[0], { hostId: route.hostId, sessionId: row.sessionId, position: { kind: 'native', turnId: 'native-turn', itemId: 'item-2' }, turnCursor: 'opaque-turn-anchor' })
    assert.equal('seq' in opened[0]!.position!, false)
    await controller.returnToOrigin(target => { opened.push(target) })
    assert.deepEqual(opened[1], origin); assert.equal(controller.getSnapshot().query, 'needle')
    assert.ok(f.calls.every(call => call.operationId === undefined), 'these native reads never use a write identity')
  } finally { controller.dispose() }
})

test('late results cannot replace a newer query or survive revoked account scope', async () => {
  const old = Promise.withResolvers<unknown>(), afterRevoke = Promise.withResolvers<unknown>()
  const f = fixture(request => request.params?.searchTerm === 'old' ? old.promise : request.params?.searchTerm === 'revoked' ? afterRevoke.promise : { data: [{ thread: thread('current'), snippet: 'current' }], nextCursor: null })
  const controller = new NativeSourceSearch(route, f.api, f.current)
  try {
    const first = controller.search('old'); await new Promise(resolve => setImmediate(resolve))
    await controller.search('new')
    old.resolve({ data: [{ thread: thread('obsolete'), snippet: 'obsolete' }], nextCursor: null }); await first
    assert.deepEqual(controller.getSnapshot().rows.map(row => row.nativeId), ['current'])
    const pending = controller.search('revoked'); await new Promise(resolve => setImmediate(resolve)); f.revoke()
    afterRevoke.resolve({ data: [{ thread: thread('private-old-account'), snippet: 'private' }], nextCursor: null }); await pending
    assert.equal(controller.getSnapshot().query, ''); assert.deepEqual(controller.getSnapshot().rows, [])
  } finally { controller.dispose() }
})

test('repeating source cursors retain current rows with a visible error and cannot auto-drain', async () => {
  const f = fixture(() => ({ data: [{ thread: thread('one'), snippet: 'match' }], nextCursor: 'same-cursor' }))
  const controller = new NativeSourceSearch(route, f.api, f.current)
  try {
    await controller.search('match')
    assert.match(controller.getSnapshot().error, /did not advance/)
    assert.equal(f.calls.length, 2); assert.equal(controller.getSnapshot().rows.length, 1)
  } finally { controller.dispose() }
})

test('an exact source resolve refusal cannot open a same-title substitute', async () => {
  const f = fixture(request => request.method === 'thread/search' ? { data: [{ thread: thread('wanted'), snippet: '' }], nextCursor: null } : { thread: thread('same-title-other-thread') })
  const controller = new NativeSourceSearch(route, f.api, f.current), opened: unknown[] = []
  try {
    await controller.search('title')
    await assert.rejects(controller.open(controller.getSnapshot().rows[0]!, undefined, target => { opened.push(target) }), /exact native thread/)
    assert.deepEqual(opened, [])
  } finally { controller.dispose() }
})

test('revocation during exact target resolution cannot navigate or retain account results', async () => {
  const pending = Promise.withResolvers<unknown>()
  const f = fixture(request => request.method === 'thread/search' ? { data: [{ thread: thread('wanted'), snippet: 'Private result' }], nextCursor: null } : pending.promise)
  const controller = new NativeSourceSearch(route, f.api, f.current), opened: unknown[] = []
  try {
    await controller.search('private')
    const work = controller.open(controller.getSnapshot().rows[0]!, undefined, target => { opened.push(target) })
    await new Promise(resolve => setImmediate(resolve)); f.revoke(); pending.resolve({ thread: thread('wanted') })
    await assert.rejects(work, /account or connection changed/)
    assert.deepEqual(opened, []); assert.deepEqual(controller.getSnapshot().rows, [])
  } finally { controller.dispose() }
})

test('task history pages include archived children explicitly and report actual last-turn failure', async () => {
  const f = fixture(request => {
    const p = request.params!
    if (request.method === 'thread/read') return { thread: thread(String(p.threadId), p.threadId === 'root' ? 'parent' : p.threadId === 'parent' ? null : 'root') }
    if (request.method === 'thread/list') return { data: [thread(p.archived ? 'archived-child' : p.cursor ? 'second-child' : 'child', 'root')], nextCursor: p.archived || p.cursor ? null : 'children-2' }
    if (request.method === 'thread/turns/list') return { data: [{ id: 'last-native-turn', status: 'failed', error: { message: 'Native child failed its check' } }], nextCursor: null }
    throw new Error('Unexpected read')
  })
  const controller = new NativeThreadHistory(route, f.api, f.current), opened: NativeHistoryTarget[] = []
  try {
    await controller.refresh('root'); assert.equal(controller.getSnapshot().children.length, 1)
    await controller.next(); assert.equal(controller.getSnapshot().children.length, 2)
    await controller.inspect(controller.getSnapshot().children[0]!)
    assert.deepEqual(controller.getSnapshot().detail?.lastTurn, { id: 'last-native-turn', status: 'failed', error: 'Native child failed its check' })
    await controller.parent(target => { opened.push(target) })
    assert.match(opened[0]!.sessionId, /:parent$/)
    await controller.refresh('root', true)
    assert.deepEqual(controller.getSnapshot().children.map(row => row.nativeId), ['archived-child'])
    assert.ok(f.calls.filter(call => call.method === 'thread/list').every(call => call.params?.parentThreadId === 'root'))
    assert.deepEqual(f.calls.filter(call => call.method === 'thread/list').map(call => call.params?.cursor), [null, 'children-2', null])
  } finally { controller.dispose() }
})

test('a source cannot smuggle an unrelated thread into its native child list', async () => {
  const f = fixture(request => request.method === 'thread/read' ? { thread: thread('root') } : { data: [thread('unrelated', 'different-parent')], nextCursor: null })
  const controller = new NativeThreadHistory(route, f.api, f.current)
  try { await controller.refresh('root'); assert.match(controller.getSnapshot().error, /different native parent/); assert.deepEqual(controller.getSnapshot().children, []) }
  finally { controller.dispose() }
})

test('current conversation search reads metadata only and retains exact native occurrence cursors through return', async () => {
  const f = fixture(request => request.method === 'thread/read' ? { thread: thread(String(request.params?.threadId)) }
    : request.method === 'thread/searchOccurrences' ? { data: [{ turnId: 'original-turn', itemId: request.params?.cursor ? 'item-next' : 'original-item', turnCursor: 'source-turn-cursor', snippet: 'known text', snippetMatchRange: { start: 0, end: 5 } }], nextCursor: request.params?.cursor ? null : 'original-search-cursor' }
      : (() => { throw new Error('Conversation search must never start a source-wide scan') })())
  const controller = new NativeSourceSearch(route, f.api, f.current), origin = { hostId: route.hostId, sessionId: 'hhpi:machine-a:codex-a:codex:current' }
  try {
    await controller.searchConversation('known', origin.sessionId)
    assert.equal(controller.getSnapshot().scope, 'conversation')
    assert.deepEqual(f.calls.map(x => [x.method, x.params]), [
      ['thread/read', { threadId: 'current', includeTurns: false }],
      ['thread/searchOccurrences', { threadId: 'current', searchTerm: 'known', cursor: null, limit: 50 }],
    ])
    await controller.nextOccurrences()
    assert.equal(f.calls.at(-1)!.params!.cursor, 'original-search-cursor')
    const snapshot = controller.getSnapshot(), opened: NativeHistoryTarget[] = []
    await controller.open(snapshot.selected!, snapshot.occurrences[1], target => { opened.push(target) }, origin)
    assert.deepEqual(opened[0], { ...origin, position: { kind: 'native', turnId: 'original-turn', itemId: 'item-next' }, turnCursor: 'source-turn-cursor' })
    await controller.returnToOrigin(target => { opened.push(target) })
    assert.deepEqual(opened[1], origin)
    assert(f.calls.every(x => x.method !== 'thread/search' && x.operationId === undefined))
  } finally { controller.dispose() }
})

test('changing conversation search scope cancels its wait without dispatching a source scan or accepting a late match', async () => {
  const pending = Promise.withResolvers<unknown>()
  const f = fixture(request => request.method === 'thread/read' ? { thread: thread('current') } : pending.promise)
  const controller = new NativeSourceSearch(route, f.api, f.current)
  try {
    const work = controller.searchConversation('old', 'hhpi:machine-a:codex-a:codex:current')
    await new Promise(resolve => setImmediate(resolve))
    controller.setScope('source')
    pending.resolve({ data: [{ turnId: 'late', itemId: 'late', turnCursor: 'late', snippet: 'late text', snippetMatchRange: { start: 0, end: 4 } }], nextCursor: null })
    await work
    assert.equal(controller.getSnapshot().scope, 'source')
    assert.deepEqual(controller.getSnapshot().occurrences, [])
    assert.deepEqual(controller.getSnapshot().rows, [])
    assert.equal(controller.getSnapshot().busy, false)
    assert(!f.calls.some(x => x.method === 'thread/search'))
  } finally { controller.dispose() }
})

test('a foreign conversation or unsupported occurrence capability never falls back to full-source search', async () => {
  const f = fixture(request => ({ thread: thread(String(request.params?.threadId)) }))
  f.api.nativeCapabilities = async () => ({ ok: true, value: { runtime: 'fixture', protocolVersion: '0.165.0',
    methods: { 'thread/read': 'read' }, unavailable: { 'thread/searchOccurrences': 'This source cannot search this conversation.' } } })
  const controller = new NativeSourceSearch(route, f.api, f.current)
  try {
    await controller.searchConversation('private', 'hhpi:foreign:codex-a:codex:current')
    assert.match(controller.getSnapshot().error, /another original source/); assert.equal(f.calls.length, 0)
    await controller.searchConversation('known', 'hhpi:machine-a:codex-a:codex:current')
    assert.match(controller.getSnapshot().occurrenceError, /cannot search this conversation/)
    assert.deepEqual(f.calls.map(x => x.method), ['thread/read'])
  } finally { controller.dispose() }
})
