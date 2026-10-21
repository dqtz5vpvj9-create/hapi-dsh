import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SourceLifecycle, type SourceLifecycleAgent, type SourceLifecycleSessions, type SourceLifecycleTransport } from '../src/hapi/source-lifecycle.ts'
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts'
import { observedBinding, observedCapabilities, observedSessionId } from '../src/hapi-agent/identity.ts'
import type { DeliveryView } from '../src/codex/projection-types.ts'
import type { NativeForkReceipt } from '../src/codex/control-types.ts'
import { sourceOperationSchema, type SourceAction, type SourceOperation } from '../src/hapi-agent/lifecycle-types.ts'

/** Pinned HAPI lifecycle protocol fixture, with explicit source facts rather than a model process. */
class LifecycleFixture implements SourceLifecycleTransport, SourceLifecycleSessions {
  readonly hubId = 'lifecycle-fixture'
  isConnected = true
  readonly sources = new Map<string, HapiSession>()
  readonly agents = new Map<string, SourceLifecycleAgent>()
  readonly requests: Array<{ path: string; method: string; body: unknown }> = []
  deliveries: DeliveryView[] = []
  failure: HapiRequestError | undefined
  failAfterApply = false
  childReadable = true
  beforeWrite: (() => Promise<void>) | undefined
  forkReceipt: NativeForkReceipt | undefined
  forkRevision = 4
  children = 0
  reconciliations = 0
  sourceReads = 0
  readonly root: SourceLifecycleAgent
  constructor(flavor = 'claude', shared = false) {
    this.addSource('source', flavor, shared)
    this.root = this.attach('source')
  }
  private addSource(id: string, flavor: string, shared: boolean, forkedFrom?: string): HapiSession {
    const source: HapiSession = { id, namespace: 'fixture', seq: 1, createdAt: 100, updatedAt: 100,
      active: true, activeAt: 100, thinking: false, thinkingAt: 100, metadataVersion: 1, agentStateVersion: 1,
      metadata: { path: '/project', host: 'Fixture Runner', machineId: 'machine', flavor, lifecycleState: 'running',
        capabilities: { concurrentClients: shared, conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
        ...(forkedFrom ? { forkedFrom } : {}), ...(flavor === 'codex' ? { codexSessionId: `${id}-thread`, codexStoreId: 'store' }
          : flavor === 'pi' ? { piSessionId: `${id}-thread` } : { claudeSessionId: `${id}-thread` }) }, agentState: {} }
    this.sources.set(id, source); return source
  }
  private attach(sourceId: string, revision = 0): SourceLifecycleAgent {
    const source = this.sources.get(sourceId)!
    const logical = observedSessionId(this.hubId, sourceId), owner = this
    const binding = observedBinding(this.hubId, source)
    const agent: SourceLifecycleAgent = {
      id: revision ? `${logical}-r${revision}` : logical, logicalSessionId: logical, binding,
      get sourceSession() { return owner.sources.get(sourceId) ?? source },
      get projection() { const current = this.sourceSession; return {
        connection: owner.isConnected ? 'connected' as const : 'disconnected' as const, readOnly: !owner.isConnected || !current.active || current.agentState?.controlledByUser === true,
        capabilities: observedCapabilities(current), delivery: owner.deliveries,
      } },
      async refresh() {},
      resolveRewindLocalId: id => id === 'official-message-id' ? 'original-local-id' : undefined,
      resolveRewindLocalIdAtSeq: seq => seq === 9 ? 'original-local-id' : undefined,
    }
    this.agents.set(sourceId, agent); return agent
  }
  get(id: string) { return [...this.agents.values()].find(agent => agent.id === id || agent.logicalSessionId === id) }
  async reconcileSource(sourceId: string) {
    this.reconciliations++
    if (!this.sources.has(sourceId)) throw new HapiRequestError('Missing source', 'rejected', 404)
    return this.agents.get(sourceId) ?? this.attach(sourceId)
  }
  async detachSource(sourceId: string) { this.agents.delete(sourceId) }
  async getSession(sourceId: string) {
    this.sourceReads++
    const source = this.sources.get(sourceId)
    if (!source || !this.childReadable && sourceId !== 'source') throw new HapiRequestError('Source not available', 'rejected', 404)
    return structuredClone(source)
  }
  async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const method = options.method ?? 'GET', body = options.body as Record<string, unknown> | undefined
    this.requests.push({ path, method, body: structuredClone(body) })
    if (path.endsWith('/fork-operations')) return { revision: this.forkRevision, ...(this.forkReceipt ? { operation: this.forkReceipt } : {}) }
    if (path.includes('/fork-operations/')) {
      assert.ok(this.forkReceipt)
      if (path.endsWith('/reconcile')) this.forkReceipt = { ...this.forkReceipt, status: 'created', nativeThreadId: 'child-1-thread', binding: 'ready' }
      return { operation: structuredClone(this.forkReceipt) }
    }
    await this.beforeWrite?.()
    if (this.failure && !this.failAfterApply) throw this.failure
    const source = this.sources.get('source')!
    let result: unknown = { ok: true }
    if (path.endsWith('/fork') || path.endsWith('/clear')) {
      const childId = `child-${++this.children}`
      this.addSource(childId, source.metadata!.flavor!, sharedCodexFixture(source), path.endsWith('/fork') ? source.id : undefined)
      if (typeof body?.operationId === 'string') {
        assert.equal(body.expectedForkRevision, this.forkRevision)
        this.forkReceipt = { operationId: body.operationId, sourceSessionId: source.id, childSessionId: childId,
          sourceRevision: ++this.forkRevision, status: 'created', nativeThreadId: `${childId}-thread`, binding: 'pending',
          message: 'Child native creation confirmed; binding pending', updatedAt: Date.now() }
        result = { operation: structuredClone(this.forkReceipt) }
      } else result = { sessionId: childId }
    } else if (path.endsWith('/rewind')) {
      assert.deepEqual(body, { messageLocalId: 'original-local-id' }); this.attach('source', 1); result = { success: true }
    } else if (path.endsWith('/summary')) source.metadata!.summary = { text: String(body?.text) }
    else if (path.endsWith('/pin')) { source.pinned = body?.mode === 'project'; source.globalPinned = body?.mode === 'global' }
    else if (path.endsWith('/archive')) { source.active = false; source.metadata!.lifecycleState = 'archived' }
    else if (path.endsWith('/resume') || path.endsWith('/reopen')) { source.active = true; source.metadata!.lifecycleState = 'running'; result = { ok: true, sessionId: source.id } }
    else if (path.endsWith('/restart')) source.active = false
    else if (method === 'DELETE') this.sources.delete('source')
    if (this.failure) throw this.failure
    return result
  }
}
const sharedCodexFixture = (source: HapiSession) => source.metadata?.flavor === 'codex' && source.metadata?.capabilities?.concurrentClients === true
const action = (source: LifecycleFixture, change: SourceAction): SourceOperation => ({
  operationId: randomUUID(), sessionId: source.root.id, action: change,
})
async function fixture(run: (source: LifecycleFixture, control: SourceLifecycle, directory: string) => Promise<void>, flavor = 'claude', shared = false) {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-source-lifecycle-')), source = new LifecycleFixture(flavor, shared)
  const control = new SourceLifecycle(source, source, directory)
  try { await run(source, control, directory) } finally { await control.settled(); await rm(directory, { recursive: true, force: true }) }
}

test('legacy source fork uses only the real invoked user local ID, preserves engine lineage and never uses the Codex-only operation protocol', async () => {
  await fixture(async (source, control) => {
    const request = action(source, { kind: 'fork', displayMessageSeq: 9 })
    const receipt = await control.operate(request)
    assert.equal(receipt.status, 'confirmed'); assert.equal(receipt.canReconcile, false)
    assert.deepEqual(source.requests, [{ path: '/api/sessions/source/fork', method: 'POST', body: { messageLocalId: 'original-local-id' } }])
    assert.deepEqual(receipt.result, { sourceSessionId: 'child-1', sessionId: observedSessionId(source.hubId, 'child-1'), displayReady: true, nativeId: 'child-1-thread' })
    await control.operate(request); await control.read({ operationId: request.operationId })
    assert.equal(source.children, 1)
    await assert.rejects(control.operate({ ...request, action: { kind: 'fork' } }), /immutable/)
    const forged = await control.operate(action(source, { kind: 'fork', displayMessageSeq: 8 }))
    assert.equal(forged.status, 'rejected'); assert.equal(source.children, 1)
  })
})

test('legacy fork unknown response remains unknown over restart and reads; another fork needs an explicit duplicate-risk intent', async () => {
  await fixture(async (source, control, directory) => {
    source.failure = new HapiRequestError('Auth wrapper masked the reply after native creation', 'indeterminate', 401)
    source.failAfterApply = true
    const request = action(source, { kind: 'fork' }), unknown = await control.operate(request)
    assert.equal(unknown.status, 'indeterminate'); assert.equal(source.children, 1)
    const restarted = new SourceLifecycle(source, source, directory)
    await restarted.operate(request)
    await restarted.read({ operationId: request.operationId })
    await restarted.read({ operationId: request.operationId, action: 'reconcile' })
    assert.equal(source.children, 1); assert.equal(source.requests.length, 1)
    const blocked = await restarted.operate(action(source, { kind: 'fork' }))
    assert.equal(blocked.status, 'rejected'); assert.equal(source.children, 1)
    source.failure = undefined
    const conscious = await restarted.operate(action(source, { kind: 'fork', duplicateRiskOf: request.operationId }))
    assert.equal(conscious.status, 'confirmed'); assert.equal(source.children, 2)
    assert.deepEqual(source.requests.at(-1)?.body, {}, 'Local risk acknowledgment is not fabricated as an unsupported legacy source body field')
  }, 'pi')
})

test('managed shared Codex uses its real durable fork receipt and waits for source ready before entering the child', async () => {
  await fixture(async (source, control) => {
    const request = action(source, { kind: 'fork', displayMessageId: 'official-message-id' })
    const pending = await control.operate(request)
    assert.equal(pending.status, 'submitted'); assert.equal(pending.canReconcile, true)
    assert.equal(source.agents.has('child-1'), false)
    assert.deepEqual(source.requests[1]?.body, { operationId: request.operationId, expectedForkRevision: 4, messageLocalId: 'original-local-id' })
    await control.read({ operationId: request.operationId })
    assert.equal(source.agents.has('child-1'), false)
    const ready = await control.read({ operationId: request.operationId, action: 'reconcile' })
    assert.equal(ready.status, 'confirmed')
    assert.equal((ready.result as { sessionId: string }).sessionId, observedSessionId(source.hubId, 'child-1'))
    assert.equal(source.children, 1)
    const prior = source.forkReceipt!
    source.forkReceipt = { operationId: prior.operationId, sourceSessionId: prior.sourceSessionId,
      childSessionId: prior.childSessionId, sourceRevision: prior.sourceRevision, status: 'running', message: 'Delayed old read', updatedAt: 1 }
    assert.equal((await control.read({ operationId: request.operationId })).status, 'confirmed')
    assert.equal(source.requests.filter(value => value.path.endsWith('/fork')).length, 1)
  }, 'codex', true)
})

test('source state can confirm an uncertain metadata edit without dispatching it again; HTTP outcome classification is preserved', async () => {
  await fixture(async (source, control, directory) => {
    source.failure = new HapiRequestError('Reply masked after summary commit', 'indeterminate', 401); source.failAfterApply = true
    const request = action(source, { kind: 'summary', text: 'Original summary' })
    assert.equal((await control.operate(request)).status, 'indeterminate')
    const restarted = new SourceLifecycle(source, source, directory)
    assert.equal((await restarted.read({ operationId: request.operationId })).status, 'confirmed')
    assert.equal(source.requests.length, 1)
    source.failAfterApply = false; source.failure = new HapiRequestError('Forbidden before mutation', 'rejected', 403)
    assert.equal((await restarted.operate(action(source, { kind: 'pin', mode: 'global' }))).status, 'rejected')
    source.failure = new HapiRequestError('Ambiguous bad response', 'indeterminate', 400)
    assert.equal((await restarted.operate(action(source, { kind: 'pin', mode: 'project' }))).status, 'indeterminate')
    assert.equal(sourceOperationSchema.safeParse(action(source, { kind: 'summary', text: 'x'.repeat(256) })).success, false)
    assert.equal(sourceOperationSchema.safeParse(action(source, { kind: 'summary', text: '   ' })).success, false)
  })
})

test('lifecycle controls follow source capabilities, exact routes and current display generation', async () => {
  await fixture(async (source, control) => {
    assert.equal((await control.sessionTools(source.root.id)).capabilities.clear, false)
    assert.equal((await control.operate(action(source, { kind: 'clear' }))).status, 'rejected')
    const rewind = await control.operate(action(source, { kind: 'rewind', displayMessageSeq: 9 }))
    assert.equal(rewind.status, 'confirmed')
    assert.equal((rewind.result as { sessionId: string }).sessionId, `${source.root.logicalSessionId}-r1`)
    await assert.rejects(control.operate(action(source, { kind: 'archive' })), /current source display/)
    const current = source.agents.get('source')!
    const request = (change: SourceAction) => ({ operationId: randomUUID(), sessionId: current.id, action: change })
    assert.equal((await control.operate(request({ kind: 'archive' }))).status, 'confirmed')
    const archived = await control.sessionTools(current.id)
    assert.equal(archived.capabilities.resume, false); assert.equal(archived.capabilities.reopen, true)
    assert.equal(archived.capabilities.delete, true); assert.equal(archived.readOnly, true)
    assert.equal((await control.operate(request({ kind: 'reopen' }))).status, 'confirmed')
    assert.equal((await control.operate(request({ kind: 'restart' }))).status, 'confirmed')
    assert.equal((await control.operate(request({ kind: 'resume', permissionMode: 'acceptEdits' }))).status, 'confirmed')
    assert.deepEqual(source.requests.at(-1)?.body, { permissionMode: 'acceptEdits' })
    await control.operate(request({ kind: 'pin', mode: 'global' }))
    assert.equal((await control.sessionTools(current.id)).pinMode, 'global')
    await control.operate(request({ kind: 'archive' }))
    const deleted = await control.operate(request({ kind: 'delete' }))
    assert.equal(deleted.status, 'confirmed'); assert.equal(source.agents.has('source'), false)
    assert.equal(source.requests.at(-1)?.method, 'DELETE')
  })
})

test('source queues, local control, historical Gemini and a generic concurrent flag do not authorize unsupported actions', async () => {
  await fixture(async (source, control) => {
    source.deliveries = [{ localId: 'queued', messageId: 'queued', text: 'Waiting', mode: 'queue', state: 'queued', createdAt: 1, error: null }]
    assert.equal((await control.sessionTools(source.root.id)).capabilities.forkCurrent, false)
    assert.equal((await control.operate(action(source, { kind: 'fork' }))).status, 'rejected')
    source.deliveries = []; source.sources.get('source')!.agentState!.controlledByUser = true
    assert.equal((await control.operate(action(source, { kind: 'rewind', displayMessageSeq: 9 }))).status, 'rejected')
    assert.equal((await control.operate(action(source, { kind: 'archive' }))).status, 'confirmed', 'Explicit archive may stop the local source owner')
  })
  await fixture(async (source, control) => {
    source.sources.get('source')!.active = false
    const state = await control.sessionTools(source.root.id)
    assert.equal(state.capabilities.resume, false); assert.equal(state.capabilities.reopen, false)
    assert.equal(state.capabilities.summary, true)
  }, 'gemini')
  await fixture(async (source, control) => {
    assert.equal((await control.sessionTools(source.root.id)).capabilities.clear, false)
  }, 'dsh', true)
})

test('a confirmed source child survives a temporary display read failure and is attached by read without another fork', async () => {
  await fixture(async (source, control, directory) => {
    source.childReadable = false
    const request = action(source, { kind: 'fork' }), receipt = await control.operate(request)
    assert.equal(receipt.status, 'confirmed')
    assert.deepEqual(receipt.result, { sourceSessionId: 'child-1', sessionId: null, displayReady: false })
    source.childReadable = true
    const restarted = new SourceLifecycle(source, source, directory)
    const ready = await restarted.read({ operationId: request.operationId })
    assert.equal((ready.result as { displayReady: boolean }).displayReady, true)
    assert.equal(source.children, 1); assert.equal(source.requests.length, 1)
  })
})
