import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeControl, mergeNativeForkReceipt, type NativeControlAgent, type NativeControlSessions, type NativeControlTransport } from '../src/hapi/native-control.ts'
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts'
import { bindingFor, nativeSessionId } from '../src/codex/native.ts'
import { nativeForkRequestSchema, nativeSettingChangeSchema, type NativeForkBoundary, type NativeForkReceipt, type NativeForkRequest, type NativeSettingChange } from '../src/codex/control-types.ts'

/** Explicit protocol fixtures; these tests do not claim a native Codex process. */
class SourceAgent implements NativeControlAgent {
  readonly binding
  readonly logicalSessionId
  readonly id
  readonly projection = { readOnly: false }
  readonly boundaries = new Map<string, NativeForkBoundary>()
  refreshes = 0
  refreshError: Error | undefined
  constructor(readonly sourceSession: HapiSession) {
    this.binding = bindingFor('fixture-hub', sourceSession)
    this.id = this.logicalSessionId = nativeSessionId('fixture-hub', sourceSession.id)
  }
  async refresh(): Promise<void> { this.refreshes++; if (this.refreshError) throw this.refreshError }
  resolveForkBoundary(id: string): NativeForkBoundary | undefined { return this.boundaries.get(id) }
}

class NativeFixture implements NativeControlTransport, NativeControlSessions {
  readonly hubId = 'fixture-hub'
  readonly source = new SourceAgent(sourceSession())
  readonly agents = new Map<string, SourceAgent>([[this.source.id, this.source]])
  readonly calls: Array<{ path: string; method: string; body?: unknown }> = []
  readonly attached: string[] = []
  handler: (path: string, method: string, body: unknown) => Promise<unknown> = async path => {
    if (path.endsWith('/codex-models')) return models()
    throw new HapiRequestError('Fixture receipt not found', 'rejected', 404)
  }
  get(id: string) { return this.agents.get(id) }
  async attach(id: string) { this.attached.push(id); return [...this.agents.values()].find(agent => agent.binding.hapiSessionId === id) }
  async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const method = options.method ?? 'GET'
    this.calls.push({ path, method, ...(options.body === undefined ? {} : { body: structuredClone(options.body) }) })
    return this.handler(path, method, options.body)
  }
  addChild(receipt: NativeForkReceipt, changes: Partial<NonNullable<HapiSession['metadata']>> = {}) {
    assert.equal(receipt.status, 'created')
    if (receipt.status !== 'created') throw new Error('Fixture requires a created receipt')
    const child = sourceSession(receipt.childSessionId)
    child.metadata = { ...child.metadata!, codexSessionId: receipt.nativeThreadId, ...changes }
    const agent = new SourceAgent(child)
    this.agents.set(agent.id, agent)
    return agent
  }
}

function sourceSession(id = 'source-session'): HapiSession {
  return {
    id, namespace: 'fixture', seq: 1, createdAt: 100, updatedAt: 200, active: true, activeAt: 200, thinking: false, thinkingAt: 200,
    metadataVersion: 1, agentStateVersion: 1, model: 'native-model-a', modelReasoningEffort: 'medium',
    permissionMode: 'default', collaborationMode: 'default', serviceTier: 'standard',
    metadata: { path: '/workspace/fixture', host: 'fixture-runner', machineId: 'machine', flavor: 'codex',
      codexSessionId: 'native-thread', codexHome: '/fixture/codex', codexHomeId: 'fixture-home',
      codexNativeSession: true, codexNativeConnection: 'attached' },
    agentState: { requests: {}, completedRequests: {} },
  }
}

function models() {
  return { success: true, models: [{ id: 'native-model-a', displayName: 'Native model A', isDefault: true,
    supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', serviceTiers: ['standard', 'fast'] }] }
}

function forkReceipt(operationId: string, overrides: Partial<NativeForkReceipt> = {}): NativeForkReceipt {
  return { operationId, sourceSessionId: 'source-session', childSessionId: `child-${operationId}`, sourceRevision: 1,
    status: 'running', message: 'Native owner admitted the fork', updatedAt: 100, ...overrides } as NativeForkReceipt
}

async function fixture(run: (fixture: NativeFixture, directory: string, control: NativeControl) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-control-'))
  const source = new NativeFixture()
  const control = new NativeControl(source, source, directory)
  try { await run(source, directory, control) } finally { await control.settled(); await rm(directory, { recursive: true, force: true }) }
}

test('native settings use authentic owner routes, observed values and exactly one durable submission', async () => {
  await fixture(async (source, directory, control) => {
    const changes: Array<[NativeSettingChange, string, Record<string, string>]> = [
      [{ kind: 'model', value: 'native-model-b' }, 'model', { model: 'native-model-b' }],
      [{ kind: 'reasoningEffort', value: 'high' }, 'model-reasoning-effort', { modelReasoningEffort: 'high' }],
      [{ kind: 'permissionMode', value: 'read-only' }, 'permission-mode', { mode: 'read-only' }],
      [{ kind: 'collaborationMode', value: 'plan' }, 'collaboration-mode', { mode: 'plan' }],
      [{ kind: 'serviceTier', value: 'fast' }, 'service-tier', { serviceTier: 'fast' }],
    ]
    source.handler = async (path, method, body) => {
      if (method === 'GET') return models()
      const expected = changes.find(([, suffix]) => path.endsWith(`/${suffix}`))
      assert.ok(expected)
      assert.deepEqual(body, expected[2])
      const key = expected[0].kind === 'reasoningEffort' ? 'modelReasoningEffort' : expected[0].kind
      Object.assign(source.source.sourceSession, { [key]: expected[0].value })
      return { ok: true }
    }
    for (const [change, suffix] of changes) {
      const input = { sessionId: source.source.id, operationId: randomUUID(), change }
      const receipt = await control.applySetting(input)
      assert.equal(receipt.status, 'confirmed')
      assert.equal(receipt.observed?.[change.kind], change.value)
      await control.applySetting(input)
      const restarted = new NativeControl(source, source, directory)
      await restarted.applySetting(input)
      assert.equal(source.calls.filter(call => call.method === 'POST' && call.path.endsWith(`/${suffix}`)).length, 1)
    }
    const state = await control.settings(source.source.id)
    assert.equal(state.models[0]?.defaultReasoningEffort, 'medium')
    assert.equal(state.operations.length, 5)
    assert.equal(state.values.permissionMode, 'read-only')
    assert.equal(state.readOnly, false)
  })
})

test('native HTTP 409 settings timeout stays unknown after restart and only source observation settles it', async () => {
  await fixture(async (source, directory, control) => {
    source.handler = async (_path, method) => {
      if (method === 'POST') throw new HapiRequestError('Native settings notification timeout', 'rejected', 409)
      return models()
    }
    const input = { sessionId: source.source.id, operationId: randomUUID(), change: { kind: 'model', value: 'native-model-b' } as const }
    const initial = await control.applySetting(input)
    assert.equal(initial.status, 'indeterminate')
    const restarted = new NativeControl(source, source, directory)
    assert.equal((await restarted.applySetting(input)).status, 'indeterminate')
    assert.equal(source.calls.filter(call => call.method === 'POST').length, 1)
    source.source.sourceSession.model = 'native-model-b'
    const observed = await restarted.applySetting(input)
    assert.equal(observed.status, 'observed')
    assert.equal(observed.observed?.model, 'native-model-b')
    assert.equal(source.calls.filter(call => call.method === 'POST').length, 1)
    await assert.rejects(restarted.applySetting({ ...input, change: { kind: 'model', value: 'different' } }), /cannot be reused/)
  })
})

test('masked 401 settings and fork failures stay indeterminate without any automatic mutation replay', async () => {
  await fixture(async (source, directory, control) => {
    source.handler = async (_path, method) => {
      if (method === 'POST') throw new HapiRequestError('Masked post-dispatch authentication failure', 'indeterminate', 401)
      throw new HapiRequestError('No source receipt visible yet', 'rejected', 404)
    }
    const setting = { sessionId: source.source.id, operationId: randomUUID(), change: { kind: 'model', value: 'native-model-b' } as const }
    const fork = { sessionId: source.source.id, operationId: randomUUID(), expectedForkRevision: 0 }
    assert.equal((await control.applySetting(setting)).status, 'indeterminate')
    assert.equal((await control.fork(fork)).submission, 'indeterminate')
    const restarted = new NativeControl(source, source, directory)
    assert.equal((await restarted.applySetting(setting)).status, 'indeterminate')
    assert.equal((await restarted.fork(fork)).submission, 'indeterminate')
    assert.equal(source.calls.filter(call => call.method === 'POST').length, 2)
  })
})

test('default native effort resolves from the native catalog and concurrent same-UUID requests cannot duplicate it', async () => {
  await fixture(async (source, _directory, control) => {
    let release: (() => void) | undefined
    const waiting = new Promise<void>(resolve => { release = resolve })
    source.handler = async (_path, method, body) => {
      if (method === 'GET') { await waiting; return models() }
      assert.deepEqual(body, { modelReasoningEffort: 'medium' })
      return { ok: true }
    }
    const input = { sessionId: source.source.id, operationId: randomUUID(), change: { kind: 'reasoningEffort', value: null } as const }
    const first = control.applySetting(input)
    const duplicate = control.applySetting(input)
    await assert.rejects(control.applySetting({ ...input, operationId: randomUUID() }), /still being submitted/)
    assert.ok(release); release()
    assert.deepEqual(await duplicate, await first)
    assert.equal(source.calls.filter(call => call.method === 'POST').length, 1)
  })
})

test('unadvertised effort defaults and unsupported settings fail before native mutation', async () => {
  await fixture(async (source, _directory, control) => {
    source.handler = async () => ({ success: true, models: [] })
    const input = { sessionId: source.source.id, operationId: randomUUID(), change: { kind: 'reasoningEffort', value: null } as const }
    assert.equal((await control.applySetting(input)).status, 'rejected')
    assert.equal(source.calls.filter(call => call.method === 'POST').length, 0)
    assert.equal(nativeSettingChangeSchema.safeParse({ kind: 'model', value: null }).success, false)
    assert.equal(nativeSettingChangeSchema.safeParse({ kind: 'permissionMode', value: 'safe-yolo' }).success, false)
    source.source.projection.readOnly = true
    await assert.rejects(control.applySetting({ ...input, operationId: randomUUID(), change: { kind: 'model', value: 'native-model-b' } }), /Reconnect/)
  })
})

test('lost native fork acknowledgement and 404 observation never cause an automatic native replay', async () => {
  await fixture(async (source, directory, control) => {
    source.handler = async (_path, method) => { throw new HapiRequestError(method === 'POST' ? 'Response lost' : 'No receipt visible yet', 'indeterminate', method === 'POST' ? undefined : 404) }
    const input: NativeForkRequest = { sessionId: source.source.id, operationId: randomUUID(), expectedForkRevision: 0 }
    const initial = await control.fork(input)
    assert.equal(initial.submission, 'indeterminate')
    assert.equal(initial.operation, null)
    const restarted = new NativeControl(source, source, directory)
    await restarted.fork(input)
    await restarted.forkOperation({ sessionId: source.source.id, operationId: input.operationId, action: 'read' })
    assert.equal(source.calls.filter(call => call.method === 'POST' && call.path.endsWith('/fork')).length, 1)
    const receipt = forkReceipt(input.operationId)
    source.handler = async () => ({ operation: receipt })
    const observed = await restarted.fork(input)
    assert.equal(observed.submission, 'acknowledged')
    assert.equal(observed.operation?.status, 'running')
    assert.equal(observed.sessionId, null)
    assert.equal(source.attached.length, 0)
    assert.equal(source.calls.filter(call => call.method === 'POST' && call.path.endsWith('/fork')).length, 1)
    await assert.rejects(restarted.fork({ ...input, expectedForkRevision: 1 }), /cannot be reused/)
  })
})

test('native fork attaches only a source-verified ready child and never regresses known creation', async () => {
  await fixture(async (source, directory, control) => {
    const input: NativeForkRequest = { sessionId: source.source.id, operationId: randomUUID(), expectedForkRevision: 0 }
    let receipt = forkReceipt(input.operationId, { status: 'created', nativeThreadId: 'native-child', binding: 'pending' })
    source.handler = async () => ({ operation: receipt })
    const created = await control.fork(input)
    assert.equal(created.operation?.status, 'created')
    assert.equal(created.sessionId, null)
    assert.equal(source.attached.length, 0)
    receipt = forkReceipt(input.operationId, { status: 'created', nativeThreadId: 'native-child', binding: 'ready', updatedAt: 200 })
    const child = source.addChild(receipt)
    const ready = await control.forkOperation({ sessionId: source.source.id, operationId: input.operationId, action: 'reconcile' })
    assert.equal(ready.sessionId, child.id)
    assert.ok(source.calls.some(call => call.path.endsWith('/reconcile') && call.method === 'POST'))
    receipt = forkReceipt(input.operationId, { updatedAt: 500 }) // Newer clock, older evidence.
    const stale = await control.forkOperation({ sessionId: source.source.id, operationId: input.operationId, action: 'read' })
    assert.equal(stale.operation?.status, 'created')
    assert.equal(stale.sessionId, child.id)
    const restarted = new NativeControl(source, source, directory)
    const restored = await restarted.fork(input)
    assert.equal(restored.sessionId, child.id)
    assert.equal(source.calls.filter(call => call.path.endsWith('/fork')).length, 1)
  })
})

test('native child identity mismatch retains the durable created receipt without entering the wrong conversation', async () => {
  await fixture(async (source, _directory, control) => {
    const input: NativeForkRequest = { sessionId: source.source.id, operationId: randomUUID(), expectedForkRevision: 0 }
    const receipt = forkReceipt(input.operationId, { status: 'created', nativeThreadId: 'native-child', binding: 'ready' })
    source.addChild(receipt, { codexHomeId: 'wrong-home' })
    source.handler = async () => ({ operation: receipt })
    const result = await control.fork(input)
    assert.equal(result.submission, 'acknowledged')
    assert.equal(result.operation?.status, 'created')
    assert.equal(result.sessionId, null)
    assert.match(result.message ?? '', /child exists/)
    assert.equal(source.calls.filter(call => call.path.endsWith('/fork')).length, 1)
  })
})

test('native fork receipt source, UUID, revision and child identity must remain consistent', async () => {
  await fixture(async (source, _directory, control) => {
    const input: NativeForkRequest = { sessionId: source.source.id, operationId: randomUUID(), expectedForkRevision: 2 }
    let receipt = forkReceipt(input.operationId, { sourceRevision: 1 })
    source.handler = async () => ({ operation: receipt })
    const mismatched = await control.fork(input)
    assert.equal(mismatched.operation, null)
    assert.equal(mismatched.submission, 'indeterminate')
    receipt = forkReceipt(input.operationId, { sourceRevision: 3 })
    const valid = await control.forkOperation({ sessionId: source.source.id, operationId: input.operationId, action: 'read' })
    assert.equal(valid.operation?.sourceRevision, 3)
    receipt = { ...receipt, childSessionId: 'another-child' }
    const changed = await control.forkOperation({ sessionId: source.source.id, operationId: input.operationId, action: 'read' })
    assert.equal(changed.operation?.childSessionId, `child-${input.operationId}`)
    assert.match(changed.message ?? '', /identity changed/)
  })
})

test('fork from an official displayed message forwards only its committed native boundary', async () => {
  await fixture(async (source, _directory, control) => {
    const boundary = { threadId: 'native-thread', turnId: 'turn-native', itemId: 'item-native' }
    source.source.boundaries.set('official-message-id', boundary)
    const input: NativeForkRequest = { sessionId: source.source.id, operationId: randomUUID(), expectedForkRevision: 0, displayMessageId: 'official-message-id' }
    source.handler = async (_path, _method, body) => {
      assert.deepEqual(body, { operationId: input.operationId, expectedForkRevision: 0, nativeBoundary: boundary })
      return { operation: forkReceipt(input.operationId) }
    }
    await control.fork(input)
    await assert.rejects(control.fork({ ...input, operationId: randomUUID(), displayMessageId: 'uncommitted-message' }), /no committed source-native/)
    assert.equal(source.calls.filter(call => call.path.endsWith('/fork')).length, 1)
    assert.equal(nativeForkRequestSchema.safeParse({ ...input, messageLocalId: 'not-a-display-id' }).success, false)
    assert.equal(nativeForkRequestSchema.safeParse({ ...input, duplicateRiskOf: randomUUID() }).success, false)
  })
})

test('close-unadmitted requires the native exact no-dispatch proof and never invents one from an outage', async () => {
  await fixture(async (source, _directory, control) => {
    const operationId = randomUUID()
    let receipt = forkReceipt(operationId, { status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_closed_unadmitted', updatedAt: 300 })
    source.handler = async (_path, method, body) => {
      assert.equal(method, 'POST')
      assert.deepEqual(body, { expectedForkRevision: 1 })
      return { operation: receipt, sourceState: { revision: 1, operation: receipt }, closure: 'closed' }
    }
    const request = { sessionId: source.source.id, operationId, expectedForkRevision: 1 }
    const closed = await control.forkClose(request)
    assert.equal(closed.closure, 'closed')
    assert.equal(closed.view.operation?.status, 'rejected')
    assert.equal(closed.source.revision, 1)
    receipt = forkReceipt(operationId, { status: 'indeterminate' })
    await assert.rejects(control.forkClose(request), /no-dispatch closure proof/)
    assert.equal(source.attached.length, 0)
  })
})

test('native fork evidence and explicit duplicate-risk attempts preserve identity independently of wall-clock order', () => {
  const id = randomUUID()
  const prior = forkReceipt(id, { status: 'indeterminate', updatedAt: 200 })
  assert.equal(mergeNativeForkReceipt(prior, forkReceipt(id, { updatedAt: 500 })), prior)
  const ready = forkReceipt(id, { status: 'created', nativeThreadId: 'child-native', binding: 'ready', updatedAt: 50 })
  assert.equal(mergeNativeForkReceipt(prior, ready), ready)
  assert.equal(mergeNativeForkReceipt(ready, forkReceipt(id, { status: 'indeterminate', updatedAt: 900 })), ready)
  const rejected = forkReceipt(id, { status: 'rejected', rejectionProof: 'not_dispatched', updatedAt: 100 })
  assert.equal(mergeNativeForkReceipt(rejected, forkReceipt(id, { updatedAt: 1000 })), rejected)
  const valid = { sessionId: 'source', operationId: randomUUID(), expectedForkRevision: 1, duplicateRiskOf: id }
  assert.equal(nativeForkRequestSchema.safeParse(valid).success, true)
  assert.equal(nativeForkRequestSchema.safeParse({ ...valid, messageLocalId: 'another-boundary' }).success, false)
  assert.equal(nativeForkRequestSchema.safeParse({ ...valid, operationId: id }).success, false)
})
