import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HapiRequestError, type HapiQueuedState, type HapiSession } from '../src/codex/contracts.ts'
import { bindingFor, nativeSessionId } from '../src/codex/native.ts'
import type { NativeImplementPlan } from '../src/codex/control-types.ts'
import type { NativeControlAgent, NativeControlSessions } from '../src/hapi/native-control.ts'
import { NativePlan, type NativePlanTransport } from '../src/hapi/native-plan.ts'

const PLAN = 'codex-proposed-plan:native-thread:native-turn:native-plan-item'
const LOCAL_ID = `${PLAN}:implement`

/** Native protocol fixtures, without a Codex process or model credential. */
class SourceAgent implements NativeControlAgent {
  readonly sourceSession: HapiSession = {
    id: 'source-session', namespace: 'fixture', seq: 1, createdAt: 100, updatedAt: 200,
    active: true, activeAt: 200, thinking: false, thinkingAt: 200, metadataVersion: 1, agentStateVersion: 1,
    collaborationMode: 'plan', metadata: { path: '/workspace/fixture', host: 'fixture-runner', machineId: 'machine',
      flavor: 'codex', codexSessionId: 'native-thread', codexNativeSession: true, codexNativeConnection: 'attached',
      codexHome: '/fixture/codex', codexHomeId: 'fixture-home' },
    agentState: { requests: {}, completedRequests: {}, codexPlanProposalId: PLAN },
  }
  readonly binding = bindingFor('fixture-hub', this.sourceSession)
  readonly id = nativeSessionId('fixture-hub', this.sourceSession.id)
  readonly logicalSessionId = this.id
  readonly projection = { readOnly: false }
  refreshHook: (() => Promise<void>) | undefined
  async refresh(): Promise<void> { await this.refreshHook?.() }
  async refreshSettings(): Promise<void> { await this.refreshHook?.() }
  resolveForkBoundary() { return undefined }
}

class PlanFixture implements NativePlanTransport, NativeControlSessions {
  readonly hubId = 'fixture-hub'
  readonly source = new SourceAgent()
  readonly calls: Array<{ path: string; method: string; body?: unknown }> = []
  readonly queueReads: Array<{ sourceId: string; localIds: string[] }> = []
  queue: HapiQueuedState = { queuedLocalIds: [], invokedLocalMessages: [] }
  queueFailure: Error | undefined
  handler: () => Promise<unknown> = async () => ({ ok: true })
  get(id: string) { return id === this.source.id ? this.source : undefined }
  async attach() { return undefined }
  async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
    this.calls.push({ path, method: options.method ?? 'GET', body: structuredClone(options.body) })
    return this.handler()
  }
  async getQueuedState(sourceId: string, localIds: string[]): Promise<HapiQueuedState> {
    this.queueReads.push({ sourceId, localIds: [...localIds] })
    if (this.queueFailure) throw this.queueFailure
    return structuredClone(this.queue)
  }
  input(): NativeImplementPlan { return { sessionId: this.source.id, operationId: randomUUID(), planId: PLAN } }
}

async function fixture(run: (source: PlanFixture, directory: string, plan: NativePlan) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-plan-'))
  const source = new PlanFixture()
  const plan = new NativePlan(source, source, directory)
  try { await run(source, directory, plan) }
  finally { await plan.settled(); await rm(directory, { recursive: true, force: true }) }
}

function gate() {
  let resolve: () => void = () => { throw new Error('Gate was not initialized') }
  const promise = new Promise<void>(ready => { resolve = ready })
  return { promise, resolve }
}

test('native plan implementation uses the dedicated owner operation and its exact stable native input identity', async () => {
  await fixture(async (source, directory, plan) => {
    const input = source.input()
    const receipt = await plan.implement(input)
    assert.equal(receipt.status, 'submitted')
    assert.equal(receipt.localId, LOCAL_ID)
    assert.equal(receipt.planId, PLAN)
    assert.deepEqual(source.calls, [{ path: '/api/sessions/source-session/codex/plan/implement', method: 'POST', body: { planId: PLAN } }])
    assert.deepEqual(source.queueReads, [{ sourceId: 'source-session', localIds: [LOCAL_ID] }])
    const state = await plan.state(source.source.id)
    assert.equal(state.planId, PLAN)
    assert.equal(state.operations[0]?.status, 'submitted')
    const restarted = new NativePlan(source, source, directory)
    assert.equal((await restarted.implement(input)).status, 'submitted')
    await assert.rejects(restarted.implement(source.input()), /already has operation/)
    assert.equal(source.calls.length, 1)
  })
})

test('plan preflight requires the currently advertised proposal and the unchanged writable native binding', async () => {
  await fixture(async (source, _directory, plan) => {
    source.source.sourceSession.agentState!.codexPlanProposalId = null
    assert.equal((await plan.implement(source.input())).status, 'rejected')
    source.source.sourceSession.agentState!.codexPlanProposalId = PLAN
    source.source.projection.readOnly = true
    assert.equal((await plan.implement(source.input())).status, 'rejected')
    source.source.projection.readOnly = false
    source.source.refreshHook = async () => { source.source.sourceSession.metadata!.codexSessionId = 'another-thread' }
    assert.equal((await plan.implement(source.input())).status, 'rejected')
    assert.equal(source.calls.length, 0)
  })
})

test('masked 401, unavailable replies and malformed acknowledgement stay unknown across restart without automatic replay', async () => {
  const responses: Array<() => Promise<unknown>> = [
    async () => { throw new HapiRequestError('Masked post-dispatch failure', 'indeterminate', 401) },
    async () => { throw new HapiRequestError('Authentication status is not no-dispatch proof', 'rejected', 401) },
    async () => { throw new HapiRequestError('Lost native reply', 'indeterminate', 503, 'indeterminate') },
    async () => { throw new HapiRequestError('Native outcome is not confirmed', 'indeterminate', 502, 'failed') },
    async () => ({ success: true }),
  ]
  for (const response of responses) await fixture(async (source, directory, plan) => {
    source.handler = response
    const input = source.input()
    assert.equal((await plan.implement(input)).status, 'indeterminate')
    const restarted = new NativePlan(source, source, directory)
    assert.equal((await restarted.implement(input)).status, 'indeterminate')
    assert.equal((await restarted.state(source.source.id)).operations[0]?.status, 'indeterminate')
    await assert.rejects(restarted.implement(source.input()), /already has operation/)
    assert.equal(source.calls.length, 1)
  })
})

test('a vanished proposal and a missing queue row prove no outcome; native invocation alone resolves an unknown implementation', async () => {
  await fixture(async (source, directory, plan) => {
    source.handler = async () => { throw new HapiRequestError('Reply lost', 'indeterminate') }
    const input = source.input()
    await plan.implement(input)
    source.source.sourceSession.agentState!.codexPlanProposalId = null
    const absent = await plan.state(source.source.id)
    assert.equal(absent.planId, null)
    assert.equal(absent.operations[0]?.status, 'indeterminate')
    source.queue = { queuedLocalIds: [], invokedLocalMessages: [{ localId: LOCAL_ID, invokedAt: 300 }] }
    assert.equal((await plan.state(source.source.id)).operations[0]?.status, 'invoked')
    source.queue = { queuedLocalIds: [LOCAL_ID], invokedLocalMessages: [] }
    const restarted = new NativePlan(source, source, directory)
    assert.equal((await restarted.implement(input)).status, 'invoked')
    assert.equal(source.calls.length, 1)
  })
})

test('queue and dispatch uncertainty are actual native states, and invocation cannot regress to a stale queued observation', async () => {
  await fixture(async (source, _directory, plan) => {
    const input = source.input()
    await plan.implement(input)
    source.queue = { queuedLocalIds: [LOCAL_ID], invokedLocalMessages: [] }
    assert.equal((await plan.state(source.source.id)).operations[0]?.status, 'queued')
    source.queue = { queuedLocalIds: [], indeterminateLocalIds: [LOCAL_ID], invokedLocalMessages: [] }
    assert.equal((await plan.state(source.source.id)).operations[0]?.status, 'indeterminate')
    source.queue = { queuedLocalIds: [], dispatchingLocalIds: [LOCAL_ID], invokedLocalMessages: [] }
    const dispatching = (await plan.state(source.source.id)).operations[0]
    assert.equal(dispatching?.status, 'submitted')
    assert.equal(dispatching?.sourceCode, 'native_queue_dispatching')
    source.queue = { queuedLocalIds: [LOCAL_ID], invokedLocalMessages: [{ localId: LOCAL_ID, invokedAt: 300 }] }
    assert.equal((await plan.state(source.source.id)).operations[0]?.status, 'invoked')
    source.queueFailure = new Error('Native owner is disconnected')
    assert.equal((await plan.state(source.source.id)).operations[0]?.status, 'invoked')
    assert.equal(source.calls.length, 1)
  })
})

test('concurrent clicks reserve one operation before the network boundary and a recovered in-flight journal only observes it', async () => {
  await fixture(async (source, directory, plan) => {
    const entered = gate(), release = gate()
    source.handler = async () => { entered.resolve(); await release.promise; return { ok: true } }
    const input = source.input()
    const first = plan.implement(input)
    await entered.promise
    const duplicate = plan.implement(input)
    try {
      await assert.rejects(plan.implement(source.input()), /already has operation/)
      const recovered = new NativePlan(source, source, directory)
      assert.equal((await recovered.implement(input)).status, 'indeterminate')
      assert.equal(source.calls.length, 1)
    } finally { release.resolve() }
    assert.deepEqual(await duplicate, await first)
    assert.equal(source.calls.length, 1)
  })
})

test('native invocation discovered while an HTTP reply is in flight wins over a late masked error', async () => {
  await fixture(async (source, directory, plan) => {
    const entered = gate(), release = gate()
    source.handler = async () => {
      entered.resolve(); await release.promise
      throw new HapiRequestError('Late masked authentication error', 'indeterminate', 401)
    }
    const input = source.input()
    const attempt = plan.implement(input)
    await entered.promise
    try {
      source.queue = { queuedLocalIds: [], invokedLocalMessages: [{ localId: LOCAL_ID, invokedAt: 300 }] }
      assert.equal((await plan.state(source.source.id)).operations[0]?.status, 'invoked')
    } finally { release.resolve() }
    assert.equal((await attempt).status, 'invoked')
    const restarted = new NativePlan(source, source, directory)
    assert.equal((await restarted.implement(input)).status, 'invoked')
    assert.equal(source.calls.length, 1)
  })
})

test('native input already observed during preflight is returned without resubmitting or turning it into a local rejection', async () => {
  await fixture(async (source, _directory, plan) => {
    const entered = gate(), release = gate()
    let reads = 0
    source.source.refreshHook = async () => { if (++reads === 1) { entered.resolve(); await release.promise } }
    const attempt = plan.implement(source.input())
    await entered.promise
    try {
      source.source.sourceSession.agentState!.codexPlanProposalId = null
      source.queue = { queuedLocalIds: [], invokedLocalMessages: [{ localId: LOCAL_ID, invokedAt: 300 }] }
      assert.equal((await plan.state(source.source.id)).operations[0]?.status, 'invoked')
    } finally { release.resolve() }
    assert.equal((await attempt).status, 'invoked')
    assert.equal(source.calls.length, 0)
  })
})

test('only explicit source stale or unavailable rejection permits a new intent, while its original operation identity remains immutable', async () => {
  for (const code of ['stale_plan', 'unavailable'] as const) await fixture(async (source, _directory, plan) => {
    source.handler = async () => { throw new HapiRequestError('Native plan is not actionable', 'rejected', 409, code) }
    const input = source.input()
    assert.equal((await plan.implement(input)).status, 'rejected')
    assert.equal((await plan.implement(input)).status, 'rejected')
    await assert.rejects(plan.implement({ ...input, planId: `${PLAN}:different` }), /cannot be reused/)
    assert.equal(source.calls.length, 1)
    source.handler = async () => ({ ok: true })
    assert.equal((await plan.implement(source.input())).status, 'submitted')
    assert.equal(source.calls.length, 2)
  })
})

test('source-native uncertainty discovered during a successful reply is preserved instead of replaced with generic acceptance', async () => {
  await fixture(async (source, _directory, plan) => {
    const entered = gate(), release = gate()
    source.handler = async () => { entered.resolve(); await release.promise; return { ok: true } }
    const attempt = plan.implement(source.input())
    await entered.promise
    try {
      source.queue = { queuedLocalIds: [], indeterminateLocalIds: [LOCAL_ID], invokedLocalMessages: [] }
      assert.equal((await plan.state(source.source.id)).operations[0]?.status, 'indeterminate')
      source.queue = { queuedLocalIds: [], invokedLocalMessages: [] }
    } finally { release.resolve() }
    const receipt = await attempt
    assert.equal(receipt.status, 'indeterminate')
    assert.equal(receipt.sourceCode, 'native_queue_indeterminate')
    assert.equal(source.calls.length, 1)
  })
})
