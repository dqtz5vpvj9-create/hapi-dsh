import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DirectDshConfig, SourceOperation } from '../src/remote/protocol.ts'
import { DshOwnerConnection } from '../src/remote/dsh-owner.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import type { HapiSession } from '../src/codex/contracts.ts'

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
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = []
  listSummaryStrippedNativeId = false
  loseSendAck = false

  fetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    this.calls.push({ method, path: url.pathname, ...(body === undefined ? {} : { body }) })

    if (url.pathname === '/api/auth' && method === 'POST') return Response.json({ token: 'fixture-hapi-session-token' })
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
      const session = this.detailOverrides.get(id) ?? this.sessions.get(id)
      return session ? Response.json({ session: structuredClone(session) }) : Response.json({ error: 'not found' }, { status: 404 })
    }
    if (url.pathname.endsWith('/messages') && method === 'POST') {
      if (this.loseSendAck) throw new Error('connection reset after write')
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith('/abort') && method === 'POST') return Response.json({ ok: true })
    if (/\/permissions\/[^/]+\/(approve|deny)$/.test(url.pathname) && method === 'POST') return Response.json({ ok: true })
    throw new Error(`Unexpected owner request: ${method} ${url.pathname}`)
  }

  connection(): DshOwnerConnection {
    return new DshOwnerConnection(config, { env: { DSH_OWNER_TOKEN: token }, fetch: this.fetch })
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
