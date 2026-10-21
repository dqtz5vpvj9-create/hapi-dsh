import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts'
import { HapiClient, type SpawnSessionInput, type SpawnSessionResponse } from '../src/hapi/client.ts'
import { SourceCreation, type SourceCreationAgent, type SourceCreationSessions, type SourceCreationTransport } from '../src/hapi/source-creation.ts'
import { observedBinding, observedSessionId } from '../src/hapi-agent/identity.ts'
import { createSourceSessionSchema, SOURCE_CREATION_FLAVORS, type CreateSourceSession } from '../src/hapi-agent/creation-types.ts'

/** Exact pinned HAPI spawn/read protocol fixture; it does not start a model or an agent binary. */
class SourceCreationFixture implements SourceCreationTransport, SourceCreationSessions {
  readonly hubId = 'source-creation-fixture'
  source: HapiSession = {
    id: 'reserved-source', namespace: 'fixture', seq: 1, createdAt: 100, updatedAt: 100,
    active: false, activeAt: 100, thinking: false, thinkingAt: 100, metadataVersion: 1, agentStateVersion: 1,
    metadata: { path: '/project', host: 'Fixture Runner', machineId: 'machine-one', flavor: 'claude' }, agentState: {},
  }
  response: SpawnSessionResponse = { type: 'success', sessionId: 'reserved-source' }
  spawnError: Error | undefined
  beforeSpawn: (() => Promise<void>) | undefined
  reads = 0
  attaches = 0
  generation = 0
  registerAt = Infinity
  readonly spawns: Array<{ machineId: string; input: SpawnSessionInput }> = []
  async spawnSession(machineId: string, input: SpawnSessionInput): Promise<SpawnSessionResponse> {
    this.spawns.push({ machineId, input: structuredClone(input) })
    this.source.metadata!.flavor = input.agent
    await this.beforeSpawn?.()
    if (this.spawnError) throw this.spawnError
    return structuredClone(this.response)
  }
  async request(path: string, options: { timeoutMs?: number } = {}): Promise<unknown> {
    assert.equal(path, '/api/sessions/reserved-source')
    assert.ok(options.timeoutMs && options.timeoutMs <= 1500)
    this.reads++
    if (this.reads >= this.registerAt) this.source.active = true
    return { session: structuredClone(this.source) }
  }
  async reconcileSource(sourceId: string): Promise<SourceCreationAgent> {
    assert.equal(sourceId, this.source.id)
    this.attaches++
    const logical = observedSessionId(this.hubId, sourceId)
    return { id: this.generation ? `${logical}-r${this.generation}` : logical,
      binding: observedBinding(this.hubId, this.source), sourceSession: this.source }
  }
}
const options = { maxReadAttempts: 3, pollIntervalMs: 0, readRequestTimeoutMs: 50 }
const launch = (patch: Partial<CreateSourceSession> = {}): CreateSourceSession => ({
  requestId: randomUUID(), machineId: 'machine-one', directory: '/project', agent: 'claude', ...patch,
})
async function fixture(run: (source: SourceCreationFixture, directory: string, creation: SourceCreation) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-source-create-'))
  const source = new SourceCreationFixture()
  const creation = new SourceCreation(source, source, directory, options)
  try { await run(source, directory, creation) }
  finally { await creation.settled(); await rm(directory, { recursive: true, force: true }) }
}

test('a source preallocated row with matching flavor and machine is not a registered Runner; accepted intent survives restart', async () => {
  await fixture(async (source, directory, creation) => {
    const request = launch({ model: 'source-model', effort: 'high', permissionMode: 'acceptEdits', startingMode: 'remote' })
    const waiting = await creation.create(request)
    assert.equal(waiting.status, 'accepted')
    assert.equal(waiting.sourceSessionId, source.source.id)
    assert.equal(waiting.registrationObservedAt, null)
    assert.equal(waiting.sessionId, null)
    assert.equal(source.attaches, 0)
    assert.equal(source.reads, 3)
    const restarted = new SourceCreation(source, source, directory, options)
    await restarted.create(request)
    await restarted.operation({ requestId: request.requestId, action: 'reconcile' })
    assert.equal(source.spawns.length, 1, 'Known source identities never redispatch, including explicit reconcile')
    source.source.active = true; source.generation = 2
    const ready = await restarted.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.sessionId, `${observedSessionId(source.hubId, source.source.id)}-r2`)
    assert.equal(ready.nativeId, null, 'Claude can register before its first native message creates a locator')
    assert.ok(ready.registrationObservedAt)
    assert.equal(source.spawns.length, 1)
    const { machineId, ...exactInput } = request
    assert.deepEqual(source.spawns, [{ machineId, input: exactInput }])
    await assert.rejects(restarted.create({ ...request, agent: 'pi' }), /immutable launch intent|permission mode|effort/)
  })
})

test('every other pinned creatable source engine is sent unchanged; native Codex and historical Gemini cannot enter this path', async () => {
  await fixture(async (source, _directory, creation) => {
    source.source.active = true
    for (const agent of SOURCE_CREATION_FLAVORS) {
      const request = launch({ agent, model: `${agent}/model-id`, sessionType: 'worktree', worktreeName: 'feature-work' })
      const state = await creation.create(request)
      assert.equal(state.status, 'ready')
      assert.equal(source.spawns.at(-1)?.input.agent, agent)
      assert.equal(source.spawns.at(-1)?.input.model, `${agent}/model-id`)
    }
    assert.equal(createSourceSessionSchema.safeParse({ ...launch(), agent: 'codex' }).success, false)
    assert.equal(createSourceSessionSchema.safeParse({ ...launch(), agent: 'gemini' }).success, false)
    assert.equal(createSourceSessionSchema.safeParse(launch({ agent: 'qoder', startingMode: 'pty' })).success, false)
    assert.equal(createSourceSessionSchema.safeParse(launch({ agent: 'pi', permissionMode: 'default' })).success, false)
    assert.equal(createSourceSessionSchema.safeParse(launch({ agent: 'copilot', copilotAgentMode: 'autopilot', startingMode: 'pty' })).success, true)
    assert.equal(createSourceSessionSchema.safeParse(launch({ agent: 'opencode', modelReasoningEffort: 'source-variant' })).success, true)
  })
})

test('a masked 401 or lost launch reply cannot automatically replay; explicit recovery keeps one exact source durable claim', async () => {
  await fixture(async (source, directory, creation) => {
    source.spawnError = new HapiRequestError('The auth wrapper masked a post-dispatch failure', 'indeterminate', 401)
    const request = launch({ agent: 'pi', model: 'provider/model', effort: 'high' })
    const unknown = await creation.create(request)
    assert.equal(unknown.status, 'indeterminate')
    assert.equal(unknown.sourceSessionId, null)
    const restarted = new SourceCreation(source, source, directory, options)
    await restarted.create(request)
    await restarted.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(source.spawns.length, 1)
    assert.equal(source.reads, 0)
    source.spawnError = undefined
    source.response = { type: 'error', code: 'spawn_outcome_unknown', sessionId: source.source.id, childStarted: true, message: 'Late registration pending' }
    const reserved = await restarted.operation({ requestId: request.requestId, action: 'reconcile' })
    assert.equal(reserved.status, 'indeterminate')
    assert.equal(reserved.sourceSessionId, source.source.id)
    assert.deepEqual(source.spawns[1], source.spawns[0])
    source.source.active = true; source.source.metadata!.piSessionId = 'original-pi-session'
    const ready = await restarted.operation({ requestId: request.requestId, action: 'reconcile' })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.nativeId, 'original-pi-session')
    assert.equal(source.spawns.length, 2, 'Known source only reads; source durable claim handles the explicit lost-receipt recovery')
  })
})

test('source identity and actual registration remain binding after restart, including an inactive source with preserved history', async () => {
  await fixture(async (source, directory, creation) => {
    source.source.metadata!.claudeSessionId = 'original-sdk-thread'
    const request = launch()
    const ready = await creation.create(request)
    assert.equal(ready.status, 'ready', 'A real engine locator proves source registration even when currently inactive')
    assert.equal(ready.nativeId, 'original-sdk-thread')
    const restarted = new SourceCreation(source, source, directory, options)
    source.source.metadata!.machineId = 'other-machine'
    const wrongMachine = await restarted.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(wrongMachine.sessionId, null)
    assert.equal(wrongMachine.status, 'accepted')
    source.source.metadata!.machineId = 'machine-one'; source.source.metadata!.claudeSessionId = 'replacement-sdk-thread'
    const wrongThread = await restarted.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(wrongThread.sessionId, null)
    assert.equal(wrongThread.nativeId, 'original-sdk-thread')
    assert.equal(source.attaches, 1)
    source.source.metadata!.claudeSessionId = 'original-sdk-thread'
    assert.equal((await restarted.operation({ requestId: request.requestId, action: 'read' })).status, 'ready')
    assert.equal(source.spawns.length, 1)
  })
})

test('source no-child proof is final rejection, while concurrent callers share a single submission and registration flight', async () => {
  await fixture(async (source, _directory, creation) => {
    source.response = { type: 'error', childStarted: false, message: 'Binary not installed' }
    const denied = await creation.create(launch())
    assert.equal(denied.status, 'rejected')
    await creation.operation({ requestId: denied.requestId, action: 'reconcile' })
    assert.equal(source.spawns.length, 1)
    assert.equal(source.reads, 0)
    source.response = { type: 'success', sessionId: source.source.id }
    let release: (() => void) | undefined
    source.beforeSpawn = () => new Promise<void>(resolve => { release = resolve })
    source.registerAt = 1
    const request = launch({ agent: 'copilot', copilotAgentMode: 'plan' })
    const create = creation.create(request), duplicate = creation.create(request)
    const read = creation.operation({ requestId: request.requestId, action: 'read' })
    const stopping = creation.settled()
    assert.equal(source.spawns.length, 2)
    assert.ok(release); release()
    const results = await Promise.all([create, duplicate, read])
    await stopping
    assert.equal(results[0]?.status, 'ready')
    assert.deepEqual(results[1], results[0])
    assert.deepEqual(results[2], results[0])
    assert.equal(source.reads, 1)
  })
})

test('the real HTTP client preserves non-Codex engine launch fields and the source receipt', async () => {
  const sent: unknown[] = []
  const client = new HapiClient({ hubId: 'fixture-hub', url: 'http://127.0.0.1:39091', token: 'fixture-token',
    fetch: async (input, init) => {
      if (String(input).endsWith('/auth')) return Response.json({ token: 'fixture-jwt' })
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ type: 'success', sessionId: 'original-source' })
    } })
  const input: SpawnSessionInput = { requestId: randomUUID(), directory: '/project', agent: 'claude',
    model: 'sonnet[1m]', effort: 'high', permissionMode: 'acceptEdits', startingMode: 'pty' }
  try {
    assert.deepEqual(await client.spawnSession('fixture-machine', input), { type: 'success', sessionId: 'original-source' })
    assert.deepEqual(sent, [input])
  } finally { await client.close() }
})
