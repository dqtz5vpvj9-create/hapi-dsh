import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DirectDshConfig, SourceOperation } from '../src/remote/protocol.ts'
import { DshOwnerConnection } from '../src/remote/dsh-owner.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import type { HapiQueuedState, HapiSession } from '../src/codex/contracts.ts'

const config: DirectDshConfig = {
  id: 'dsh-source', machineId: 'machine-one', engine: 'dsh', root: '/fixture/dsh',
  owner: { hubId: 'owner-hub', url: 'http://hapi.fixture', tokenEnv: 'DSH_OWNER_TOKEN' },
}
const token = 'fixture-owner-token'

function makeSession(patch: Partial<HapiSession> & { id?: string; machineId?: string; nativeId?: string; flavor?: string } = {}): HapiSession {
  const { id = 'legacy-hapi-session', machineId = 'machine-one', nativeId = 'native-dsh-session', flavor = 'dsh', ...rest } = patch
  return {
    id, namespace: 'fixture', seq: 1, createdAt: 100, updatedAt: 200,
    active: true, activeAt: 180, thinking: true, thinkingAt: 190, metadataVersion: 1, agentStateVersion: 1,
    metadata: { path: '/repo', name: 'Native DSH session', machineId, flavor, dshSessionId: nativeId,
      dshCapabilities: { control: true, steering: true, resume: true, images: false } },
    execution: { owner: 'runner', generation: 'generation-1', sequence: 3, status: 'active', waitingOn: [],
      turnId: 'turn-one', startedAt: 190, completedAt: null },
    agentState: {},
    ...rest,
  }
}

class OwnerFixture {
  readonly sessions = new Map<string, HapiSession>()
  readonly detailOverrides = new Map<string, HapiSession>()
  readonly detailFailures = new Map<string, number>()
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = []
  listSummaryStrippedNativeId = false
  loseSendAck = false
  listFailure: number | undefined
  queuedState: HapiQueuedState = { queuedLocalIds: [], invokedLocalMessages: [] }

  fetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    this.calls.push({ method, path: url.pathname, ...(body === undefined ? {} : { body }) })

    if (url.pathname === '/api/auth' && method === 'POST') return Response.json({ token: 'fixture-hapi-session-token' })
    if (url.pathname === '/api/sessions' && this.listFailure) return Response.json({ error: 'Synthetic catalog failure' }, { status: this.listFailure })
    if (url.pathname === '/api/sessions' && method === 'GET') return Response.json({ sessions: [...this.sessions.values()].map(session => {
      const summary = structuredClone(session)
      if (summary.metadata) {
        this.listSummaryStrippedNativeId ||= typeof summary.metadata.dshSessionId === 'string'
        delete summary.metadata.dshSessionId
      }
      return summary
    }) })
    const match = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
    if (match && method === 'GET') {
      const id = decodeURIComponent(match[1]!)
      const failure = this.detailFailures.get(id)
      if (failure) return Response.json({ error: 'Synthetic detail failure' }, { status: failure })
      const session = this.detailOverrides.get(id) ?? this.sessions.get(id)
      return session ? Response.json({ session: structuredClone(session) }) : Response.json({ error: 'not found' }, { status: 404 })
    }
    if (url.pathname.endsWith('/messages/queued-state') && method === 'POST') return Response.json(this.queuedState)
    if (url.pathname.endsWith('/messages') && method === 'POST') {
      if (this.loseSendAck) throw new Error('connection reset after write')
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith('/abort') && method === 'POST') return Response.json({ ok: true })
    if (/\/permissions\/[^/]+\/(approve|deny)$/.test(url.pathname) && method === 'POST') return Response.json({ ok: true })
    throw new Error(`Unexpected owner request: ${method} ${url.pathname}`)
  }

  connection(now?: () => number): DshOwnerConnection {
    return new DshOwnerConnection(config, { env: { DSH_OWNER_TOKEN: token }, fetch: this.fetch, ...(now ? { now } : {}) })
  }
}

function operation(kind: SourceOperation['kind'], patch: Partial<SourceOperation> = {}): SourceOperation {
  return {
    sessionId: sourceSessionId({ sourceId: config.id, machineId: config.machineId, engine: 'dsh', nativeId: 'native-dsh-session' }),
    operationId: 'operation-1', kind, text: 'continue the task', turnId: 'turn-one', ...patch,
  }
}

test('catalog advertises only DSH sessions owned by the configured machine and never reads HAPI message bodies', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('valid-owner', makeSession({ id: 'valid-owner' }))
  fixture.sessions.set('wrong-machine', makeSession({ id: 'wrong-machine', machineId: 'another-machine', nativeId: 'other-dsh' }))
  fixture.sessions.set('wrong-flavor', makeSession({ id: 'wrong-flavor', flavor: 'claude', nativeId: 'claude-session' }))
  fixture.sessions.set('missing-native-id', makeSession({ id: 'missing-native-id', nativeId: '' }))
  const owner = fixture.connection()
  try {
    const rows = await owner.catalog()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.nativeId, 'native-dsh-session')
    assert.deepEqual(rows[0]?.legacyOrigin, { hubId: 'owner-hub', sessionId: 'valid-owner' })
    assert.equal(rows[0]?.capabilities.steer, false)
    assert.equal(fixture.listSummaryStrippedNativeId, true, 'the HAPI summary omits dshSessionId; the detail response supplies it')
    assert.equal(fixture.calls.filter(call => call.path.includes('/messages')).length, 0)
  } finally { await owner.dispose() }
})

test('send writes through the exact original HAPI owner and uses operationId as localId', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('legacy-hapi-session', makeSession())
  const owner = fixture.connection()
  try {
    const request = operation('send')
    const receipt = await owner.operate('native-dsh-session', request)
    assert.deepEqual(receipt, {
      operationId: request.operationId, sessionId: request.sessionId, status: 'accepted',
      message: 'The original HAPI owner accepted the message into its queue; this does not mean the DSH turn completed.',
    })
    const write = fixture.calls.find(call => call.method === 'POST' && call.path === '/api/sessions/legacy-hapi-session/messages')
    assert.deepEqual(write?.body, { text: 'continue the task', localId: 'operation-1', deliveryMode: 'queue' })
    assert.equal(fixture.calls.some(call => call.path.includes('/messages?')), false)
  } finally { await owner.dispose() }
})

test('a changed owner machine or native DSH ID prevents all writes', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('legacy-hapi-session', makeSession())
  fixture.detailOverrides.set('legacy-hapi-session', makeSession({ machineId: 'machine-one', nativeId: 'replacement-dsh-session' }))
  const owner = fixture.connection()
  try {
    await assert.rejects(owner.operate('native-dsh-session', operation('send')), /no longer advertises|no longer owns/i)
    await assert.rejects(owner.operate('different-native-id', operation('send')), /does not belong to this native DSH owner/i)
    assert.equal(fixture.calls.some(call => call.method !== 'GET' && call.path !== '/api/auth'), false)
  } finally { await owner.dispose() }
})

test('a lost HAPI send acknowledgement stays indeterminate and is never reported as accepted', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('legacy-hapi-session', makeSession())
  fixture.loseSendAck = true
  const owner = fixture.connection()
  try {
    const request = operation('send')
    const receipt = await owner.operate('native-dsh-session', request)
    assert.equal(receipt.operationId, request.operationId)
    assert.equal(receipt.sessionId, request.sessionId)
    assert.equal(receipt.status, 'indeterminate')
    assert.match(receipt.message, /connection ended|verify native state/i)
  } finally { await owner.dispose() }
})

test('steer is rejected because HAPI does not preserve DSH live-turn steer semantics', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('legacy-hapi-session', makeSession())
  const owner = fixture.connection()
  try {
    const rows = await owner.catalog()
    assert.equal(rows[0]?.capabilities.steer, false)
    await assert.rejects(owner.operate('native-dsh-session', operation('steer')), /cannot safely steer/i)
    assert.equal(fixture.calls.some(call => call.method !== 'GET' && call.path !== '/api/auth'), false)
  } finally { await owner.dispose() }
})

test('cancel and approval use the current exact owner, turn, and HAPI request identity', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('legacy-hapi-session', makeSession({ agentState: { requests: {
    'permission-7': { tool: 'commandExecution', toolCallId: 'call-7', blocking: true, arguments: { command: 'npm test' } },
  } } }))
  const owner = fixture.connection()
  try {
    const cancel = await owner.operate('native-dsh-session', operation('cancel'))
    assert.equal(cancel.status, 'accepted')
    assert.ok(fixture.calls.some(call => call.method === 'POST' && call.path === '/api/sessions/legacy-hapi-session/abort'))
    await assert.rejects(owner.operate('native-dsh-session', operation('cancel', { turnId: 'stale-turn' })), /changed|no longer cancellable/i)

    const approval = operation('approve', { requestId: 'permission-7', decision: 'acceptForSession' })
    const receipt = await owner.operate('native-dsh-session', approval)
    assert.equal(receipt.status, 'accepted')
    const answer = fixture.calls.find(call => call.method === 'POST' && call.path.endsWith('/permissions/permission-7/approve'))
    assert.deepEqual(answer?.body, { decision: 'approved_for_session' })
    const decline = operation('approve', { requestId: 'permission-7', decision: 'decline' })
    await owner.operate('native-dsh-session', decline)
    const deny = fixture.calls.find(call => call.method === 'POST' && call.path.endsWith('/permissions/permission-7/deny'))
    assert.deepEqual(deny?.body, { decision: 'denied' })
  } finally { await owner.dispose() }
})

test('verified reading survives a temporary owner outage without extending its authorization lease', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('legacy-hapi-session', makeSession())
  let now = 100
  const owner = fixture.connection(() => now)
  try {
    const [verified] = await owner.catalog()
    fixture.listFailure = 503
    const calls = fixture.calls.length
    assert.equal(await owner.readingSession('native-dsh-session'), verified)
    assert.equal(fixture.calls.length, calls, 'local reads do not issue an owner request')
    await assert.rejects(owner.readingSession('unknown-native-session'))
    await assert.rejects(owner.operate('native-dsh-session', operation('send')))
    assert.equal(fixture.calls.some(call => call.path.endsWith('/messages')), false, 'a read lease never authorizes a native write')
    now += 15 * 60_000
    await assert.rejects(owner.readingSession('native-dsh-session'))
    assert.throws(() => owner.assertReadingSession('native-dsh-session'), /no longer authorizes/)
    fixture.listFailure = undefined
    assert.equal((await owner.readingSession('native-dsh-session')).nativeId, 'native-dsh-session')
  } finally { await owner.dispose() }
})

test('DSH disconnect preserves known execution and capabilities until a fresh native observation', async () => {
  const fixture = new OwnerFixture(), native = makeSession()
  fixture.sessions.set(native.id, native)
  let now = 100
  const owner = fixture.connection(() => now)
  try {
    const [initial] = await owner.catalog()
    assert.equal(initial?.status, 'running')
    fixture.sessions.set(native.id, { ...native, active: false, execution: { ...native.execution!, status: 'disconnected' } })
    now = 200
    const [offline] = await owner.catalog()
    assert.equal(offline?.connection?.state, 'offline')
    assert.equal(offline?.status, 'running')
    assert.equal(offline?.activeTurnId, initial?.activeTurnId)
    assert.deepEqual(offline?.capabilities, initial?.capabilities)
    assert.equal((await owner.readingSession(native.metadata!.dshSessionId as string)).connection?.state, 'offline')
    await assert.rejects(owner.operate('native-dsh-session', operation('send')), { code: 'TARGET_UNAVAILABLE' })
    assert.equal(fixture.calls.some(call => call.method === 'POST' && call.path !== '/api/auth'), false, 'retained capabilities never authorize writes during disconnection')
    fixture.sessions.set(native.id, { ...native, thinking: false, execution: null })
    now = 300
    const [recovered] = await owner.catalog()
    assert.equal(recovered?.connection?.state, 'online')
    assert.equal(recovered?.status, 'idle', 'only a fresh native observation can settle execution')
    assert.equal(recovered?.activeTurnId, null)
    assert.deepEqual((await owner.catalog())[0]?.connection, recovered?.connection, 'unchanged polls do not manufacture connection revisions')
  } finally { await owner.dispose() }
})

test('a fresh disconnected native owner blocks all controls even when no prior descriptor exists', async () => {
  for (const status of ['disconnected', 'systemError'] as const) for (const active of [false, true]) {
    const fixture = new OwnerFixture(), native = makeSession({ active, agentState: { requests: {
      'permission-7': { tool: 'commandExecution', toolCallId: 'call-7', arguments: {} },
    } } })
    fixture.sessions.set(native.id, { ...native, execution: { ...native.execution!, status } })
    const owner = fixture.connection()
    try {
      for (const request of [operation('send'), operation('cancel'), operation('approve', { requestId: 'permission-7', decision: 'accept' })]) {
        await assert.rejects(owner.operate('native-dsh-session', request), { code: 'TARGET_UNAVAILABLE' })
      }
      assert.equal(fixture.calls.some(call => call.method === 'POST' && call.path !== '/api/auth'), false, `${status} with active=${active} never dispatches a native control`)
    } finally { await owner.dispose() }
  }
})

test('a reused HAPI owner locator cannot transfer execution or approvals to a new native identity', async () => {
  const fixture = new OwnerFixture(), native = makeSession({ agentState: { requests: {
    'old-permission': { tool: 'commandExecution', toolCallId: 'old-call', arguments: {} },
  } } })
  fixture.sessions.set(native.id, native)
  const owner = fixture.connection()
  try {
    const [initial] = await owner.catalog()
    assert.equal(initial?.activeTurnId, 'turn-one')
    assert.equal(initial?.pendingRequests.length, 1)
    fixture.sessions.set(native.id, makeSession({ nativeId: 'replacement-native', active: false, thinking: false,
      execution: { ...native.execution!, status: 'disconnected' }, agentState: {} }))
    const [replacement] = await owner.catalog()
    assert.equal(replacement?.nativeId, 'replacement-native')
    assert.equal(replacement?.connection?.state, 'offline')
    assert.equal(replacement?.status, 'idle')
    assert.equal(replacement?.activeTurnId, null)
    assert.deepEqual(replacement?.pendingRequests, [])
    assert.equal(replacement?.capabilities.cancel, false)
    assert.equal(replacement?.capabilities.approve, false)
    assert.throws(() => owner.assertReadingSession('native-dsh-session'), { code: 'TARGET_UNAVAILABLE' })
  } finally { await owner.dispose() }
})

test('partial detail outages keep healthy sources readable while deletion and access revocation invalidate cached identities', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('healthy', makeSession({ id: 'healthy' }))
  fixture.sessions.set('flaky', makeSession({ id: 'flaky', nativeId: 'other-native' }))
  const owner = fixture.connection()
  try {
    await owner.catalog()
    fixture.detailFailures.set('flaky', 503)
    fixture.sessions.set('new-unverified', makeSession({ id: 'new-unverified', nativeId: 'unverified' }))
    fixture.detailFailures.set('new-unverified', 503)
    assert.deepEqual((await owner.catalog()).map(row => row.nativeId).sort(), ['native-dsh-session', 'other-native'])
    assert.equal((await owner.readingSession('native-dsh-session')).legacyOrigin?.sessionId, 'healthy')
    await assert.rejects(owner.readingSession('unverified'), { code: 'TARGET_UNAVAILABLE' })

    fixture.sessions.delete('healthy')
    await owner.catalog()
    assert.throws(() => owner.assertReadingSession('native-dsh-session'), { code: 'TARGET_UNAVAILABLE' })
    await assert.rejects(owner.readingSession('native-dsh-session'), { code: 'TARGET_UNAVAILABLE' })
    fixture.listFailure = 403
    await assert.rejects(owner.catalog(), { code: 'UNSUPPORTED' })
    assert.throws(() => owner.assertReadingSession('other-native'), { code: 'TARGET_UNAVAILABLE' })
  } finally { await owner.dispose() }
})

test('owner admission reads an exact durable localId without claiming native execution or reading transcript bodies', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('legacy-hapi-session', makeSession({ active: false }))
  const owner = fixture.connection(), request = operation('send')
  try {
    const states = [
      { value: { queuedLocalIds: [request.operationId], invokedLocalMessages: [] }, expected: 'queued' },
      { value: { queuedLocalIds: [], dispatchingLocalIds: [request.operationId], invokedLocalMessages: [] }, expected: 'dispatching' },
      { value: { queuedLocalIds: [], indeterminateLocalIds: [request.operationId], invokedLocalMessages: [] }, expected: 'indeterminate' },
      { value: { queuedLocalIds: [], invokedLocalMessages: [{ localId: request.operationId, invokedAt: 123 }] }, expected: 'consumed' },
    ] satisfies Array<{ value: HapiQueuedState; expected: string }>
    for (const { value, expected } of states) {
      fixture.queuedState = value
      assert.deepEqual(await owner.readAdmission('native-dsh-session', request), { localId: request.operationId, state: expected })
    }
    assert.deepEqual(fixture.calls.filter(call => call.path.includes('/messages')), states.map(() => ({
      method: 'POST', path: '/api/sessions/legacy-hapi-session/messages/queued-state', body: { localIds: [request.operationId] },
    })), 'only the owner queue read endpoint is called; no native write, transcript read, resume, or queue mutation')

    fixture.queuedState = { queuedLocalIds: ['someone-else'], invokedLocalMessages: [] }
    assert.equal(await owner.readAdmission('native-dsh-session', request), undefined, 'another localId is not this operation')
    fixture.queuedState = { queuedLocalIds: [request.operationId], invokedLocalMessages: [{ localId: request.operationId, invokedAt: 123 }] }
    assert.equal(await owner.readAdmission('native-dsh-session', request), undefined, 'contradictory queue evidence fails closed')
  } finally { await owner.dispose() }
})

test('owner admission revalidates exact ownership and cannot use a cached reading lease after identity changes', async () => {
  const fixture = new OwnerFixture()
  fixture.sessions.set('legacy-hapi-session', makeSession())
  fixture.queuedState = { queuedLocalIds: ['operation-1'], invokedLocalMessages: [] }
  const owner = fixture.connection(), request = operation('send')
  try {
    await owner.catalog()
    fixture.detailOverrides.set('legacy-hapi-session', makeSession({ nativeId: 'replacement-dsh-session' }))
    await assert.rejects(owner.readAdmission('native-dsh-session', request), { code: 'TARGET_UNAVAILABLE' })
    assert.equal(fixture.calls.some(call => call.path.includes('/messages')), false)
    const beforeInvalid = fixture.calls.length
    await assert.rejects(owner.readAdmission('wrong-native', request), { code: 'INVALID_REQUEST' })
    await assert.rejects(owner.readAdmission('native-dsh-session', request, AbortSignal.abort()), { name: 'AbortError' })
    assert.equal(fixture.calls.length, beforeInvalid)
    assert.equal(await owner.readAdmission('native-dsh-session', operation('cancel')), undefined, 'queue evidence never settles another operation kind')
    assert.equal(fixture.calls.length, beforeInvalid)
  } finally { await owner.dispose() }
  await assert.rejects(owner.readAdmission('native-dsh-session', request), { code: 'DISPOSED' })
})
