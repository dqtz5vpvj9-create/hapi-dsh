import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeCreation, type NativeCreationTransport } from '../src/hapi/native-creation.ts'
import { HapiClient, type SpawnSessionInput, type SpawnSessionResponse } from '../src/hapi/client.ts'
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts'
import { bindingFor, nativeSessionId } from '../src/codex/native.ts'
import { writeDurableJson } from '../src/codex/durable-file.ts'
import type { NativeControlAgent, NativeControlSessions } from '../src/hapi/native-control.ts'
import { createNativeSessionSchema, type CreateNativeSession } from '../src/codex/creation-types.ts'

/** Protocol fixture for HAPI's durable spawn response and eventual thread metadata. */
class CreationFixture implements NativeCreationTransport, NativeControlSessions {
  readonly hubId = 'creation-fixture-hub'
  readonly source: HapiSession = {
    id: 'reserved-source-session', namespace: 'fixture', seq: 1, createdAt: 100, updatedAt: 100,
    active: true, activeAt: 100, thinking: false, thinkingAt: 100, metadataVersion: 1, agentStateVersion: 1,
    metadata: { path: '/project', host: 'Runner', machineId: 'machine-one', flavor: 'codex' }, agentState: {},
  }
  response: SpawnSessionResponse = { type: 'success', sessionId: this.source.id }
  spawnError: Error | undefined
  beforeSpawn: (() => Promise<void>) | undefined
  readonly spawns: Array<{ machineId: string; input: SpawnSessionInput }> = []
  reads = 0
  attaches = 0
  readyAfter = Infinity
  generation = 0
  readError: Error | undefined
  homes: Array<{ id: string; label: string; path: string; official?: boolean }> = [{ id: 'official', label: 'Official', path: '/runner/home', official: true }]
  get(): NativeControlAgent | undefined { return undefined }
  makeReady(): void {
    Object.assign(this.source.metadata!, { codexNativeSession: true, codexNativeConnection: 'attached', codexSessionId: 'original-native-thread',
      codexHome: '/runner/home', codexHomeId: 'native-home' })
  }
  async spawnSession(machineId: string, input: SpawnSessionInput): Promise<SpawnSessionResponse> {
    this.spawns.push({ machineId, input: structuredClone(input) })
    await this.beforeSpawn?.()
    if (this.spawnError) throw this.spawnError
    return structuredClone(this.response)
  }
  async request(path: string, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (path === '/api/machines/machine-one/codex-homes') return { success: true, homes: this.homes }
    assert.equal(path, '/api/sessions/reserved-source-session')
    assert.ok(options.timeoutMs && options.timeoutMs <= 1500, 'Metadata reads have an explicit bounded transport budget')
    this.reads++
    if (this.reads >= this.readyAfter) this.makeReady()
    if (this.readError) throw this.readError
    return { session: structuredClone(this.source) }
  }
  async attach(sourceId: string): Promise<NativeControlAgent> {
    assert.equal(sourceId, this.source.id)
    assert.equal(this.source.metadata?.codexNativeSession, true, 'No native adapter is attached before source metadata identifies its engine')
    this.attaches++
    const logicalSessionId = nativeSessionId(this.hubId, sourceId)
    return { id: this.generation ? `${logicalSessionId}-r${this.generation}` : logicalSessionId,
      logicalSessionId, binding: bindingFor(this.hubId, this.source), sourceSession: this.source, projection: { readOnly: false },
      async refresh() {}, resolveForkBoundary: () => undefined }
  }
}

const launch = (): CreateNativeSession => ({ requestId: randomUUID(), machineId: 'machine-one', directory: '/project',
  model: 'native-model', modelReasoningEffort: 'high', codexHome: '/runner/home', sessionType: 'simple' })
const options = { maxReadAttempts: 3, pollIntervalMs: 0, readRequestTimeoutMs: 50 }

async function fixture(run: (source: CreationFixture, directory: string, creation: NativeCreation) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-creation-'))
  const source = new CreationFixture()
  const creation = new NativeCreation(source, source, directory, options)
  try { await run(source, directory, creation) } finally { await creation.settled(); await rm(directory, { recursive: true, force: true }) }
}

test('accepted native launch waits for source metadata and attaches the same reserved session without another spawn', async () => {
  await fixture(async (source, _directory, creation) => {
    source.readyAfter = 2
    const request = launch()
    const ready = await creation.create(request)
    assert.equal(ready.status, 'ready')
    assert.equal(ready.sourceSessionId, source.source.id)
    assert.equal(ready.nativeThreadId, 'original-native-thread')
    assert.equal(ready.sessionId, nativeSessionId(source.hubId, source.source.id))
    assert.equal(source.reads, 2)
    assert.equal(source.attaches, 1)
    assert.equal(source.spawns.length, 1)
    assert.deepEqual(source.spawns[0]?.input, { requestId: request.requestId, directory: '/project', agent: 'codex', startingMode: 'remote',
      model: 'native-model', modelReasoningEffort: 'high', codexHome: '/runner/home', sessionType: 'simple' })
    await creation.create(request)
    assert.equal(source.spawns.length, 1)
  })
})

test('bounded readiness remains accepted, survives observer restart and recovers the original source identity', async () => {
  await fixture(async (source, directory, creation) => {
    const request = launch()
    const waiting = await creation.create(request)
    assert.equal(waiting.status, 'accepted')
    assert.equal(waiting.sourceSessionId, source.source.id)
    assert.equal(waiting.sessionId, null)
    assert.equal(source.reads, 3)
    assert.equal(source.attaches, 0)
    const restarted = new NativeCreation(source, source, directory, options)
    assert.deepEqual(restarted.list()[0]?.request, request)
    assert.equal(restarted.list()[0]?.status, 'accepted')
    await restarted.create(request)
    assert.equal(source.spawns.length, 1)
    source.makeReady(); source.generation = 2
    const recovered = await restarted.operation({ requestId: request.requestId, action: 'reconcile' })
    assert.equal(recovered.status, 'ready')
    assert.equal(recovered.sessionId, `${nativeSessionId(source.hubId, source.source.id)}-r2`)
    assert.equal(source.spawns.length, 1, 'An accepted source uses reads even for explicit reconciliation')
    await assert.rejects(restarted.create({ ...request, directory: '/other' }), /immutable launch intent/)
  })
})

test('native launch preserves bounded account and key-profile selectors and rejects a source-declared isolated account home', async () => {
  await fixture(async (source, _directory, creation) => {
    source.makeReady()
    const request = { ...launch(), codexAccountId: 'runner-account', codexKeyProfileId: 'runner-key-profile' }
    const ready = await creation.create(request)
    assert.equal(ready.status, 'ready')
    assert.equal(source.spawns[0]?.input.codexAccountId, 'runner-account')
    assert.equal(source.spawns[0]?.input.codexKeyProfileId, 'runner-key-profile')
    assert.equal('credentials' in source.spawns[0]!.input, false)
    source.homes = [{ id: 'isolated', label: 'Isolated', path: '/isolated' }]
    const conflict = await creation.create({ ...request, requestId: randomUUID(), codexHome: '/isolated' })
    assert.equal(conflict.status, 'rejected'); assert.match(conflict.message!, /isolated/)
    assert.equal(source.spawns.length, 1)
    assert.equal(createNativeSessionSchema.safeParse({ ...request, codexAccountId: 'x'.repeat(129) }).success, false)
    assert.equal(createNativeSessionSchema.safeParse({ ...request, credentials: 'not-an-authorized-selector' }).success, false)
    await creation.create(request); assert.equal(source.spawns.length, 1)
  })
})

test('spawn_outcome_unknown preserves its reserved source and only observes a late native registration', async () => {
  await fixture(async (source, _directory, creation) => {
    source.response = { type: 'error', code: 'spawn_outcome_unknown', message: 'RPC reply lost', sessionId: source.source.id, childStarted: true }
    const request = launch()
    const unknown = await creation.create(request)
    assert.equal(unknown.status, 'indeterminate')
    assert.equal(unknown.sourceSessionId, source.source.id)
    assert.equal(unknown.sourceCode, 'spawn_outcome_unknown')
    source.makeReady()
    const ready = await creation.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(ready.status, 'ready')
    assert.equal(source.spawns.length, 1)
  })
})

test('a lost or masked 401 spawn reply never replays automatically; explicit receipt recovery keeps the exact durable request', async () => {
  await fixture(async (source, directory, creation) => {
    source.spawnError = new HapiRequestError('Upstream authentication wrapper masked a post-dispatch failure', 'indeterminate', 401)
    const request = launch()
    const unknown = await creation.create(request)
    assert.equal(unknown.status, 'indeterminate')
    assert.equal(unknown.sourceSessionId, null)
    const restarted = new NativeCreation(source, source, directory, options)
    await restarted.create(request)
    await restarted.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(source.spawns.length, 1)
    assert.equal(source.reads, 0)
    source.spawnError = undefined; source.makeReady()
    const recovered = await restarted.operation({ requestId: request.requestId, action: 'reconcile' })
    assert.equal(recovered.status, 'ready')
    assert.equal(source.spawns.length, 2)
    assert.deepEqual(source.spawns[1], source.spawns[0], 'Only the exact same upstream durable claim may recover an unrecorded reply')
  })
})

test('only a source no-child proof or explicit pre-admission refusal makes native creation rejected', async () => {
  await fixture(async (source, _directory, creation) => {
    source.response = { type: 'error', message: 'No child was launched', childStarted: false }
    const denied = await creation.create(launch())
    assert.equal(denied.status, 'rejected')
    assert.equal(source.reads, 0)
    await creation.operation({ requestId: denied.requestId, action: 'reconcile' })
    assert.equal(source.spawns.length, 1)
    source.response = { type: 'error', message: 'Unclassified runner failure' }
    const unknown = await creation.create(launch())
    assert.equal(unknown.status, 'indeterminate')
    await creation.operation({ requestId: unknown.requestId, action: 'read' })
    assert.equal(source.spawns.length, 2)
  })
})

test('source metadata must confirm the original machine, requested home and stable native thread before opening', async () => {
  await fixture(async (source, directory, creation) => {
    source.makeReady()
    source.source.metadata!.machineId = 'another-machine'
    const request = launch()
    const wrong = await creation.create(request)
    assert.equal(wrong.status, 'accepted')
    assert.equal(wrong.sessionId, null)
    assert.equal(source.attaches, 0)
    source.source.metadata!.machineId = 'machine-one'
    const ready = await creation.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(ready.status, 'ready')
    const restarted = new NativeCreation(source, source, directory, options)
    source.source.metadata!.codexSessionId = 'different-native-thread'
    const changed = await restarted.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(changed.sessionId, null)
    assert.equal(changed.nativeThreadId, 'original-native-thread')
    assert.equal(source.attaches, 1)
    assert.equal(source.spawns.length, 1)
  })
})

test('concurrent creation controls share the same native launch flight', async () => {
  await fixture(async (source, _directory, creation) => {
    let release: (() => void) | undefined
    source.beforeSpawn = () => new Promise<void>(resolve => { release = resolve })
    source.makeReady()
    const request = launch()
    const first = creation.create(request)
    const duplicate = creation.create(request)
    const read = creation.operation({ requestId: request.requestId, action: 'read' })
    assert.equal(source.spawns.length, 1)
    assert.ok(release); release()
    assert.deepEqual(await first, await duplicate)
    assert.equal((await read).status, 'ready')
    assert.equal(source.reads, 1)
    assert.equal(source.spawns.length, 1)
  })
})

test('real HAPI HTTP client preserves spawn_outcome_unknown identity and child-start proof fields', async () => {
  const response: SpawnSessionResponse = { type: 'error', code: 'spawn_outcome_unknown', message: 'Still waiting', sessionId: 'reserved-id', childStarted: true, agent: 'codex' }
  const client = new HapiClient({ hubId: 'fixture-hub', url: 'http://127.0.0.1:39091', token: 'fixture-token', fetch: async input =>
    new Response(JSON.stringify(String(input).endsWith('/auth') ? { token: 'fixture-jwt' } : response), { headers: { 'Content-Type': 'application/json' } }) })
  try {
    assert.deepEqual(await client.spawnSession('machine', { requestId: randomUUID(), directory: '/project', agent: 'codex' }), response)
  } finally { await client.close() }
})

test('failed atomic journal replacement cleans its temporary file and preserves the prior target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-journal-'))
  try {
    const destination = join(directory, 'occupied.json')
    await mkdir(destination)
    await writeFile(join(destination, 'original'), 'preserved')
    assert.throws(() => writeDurableJson(destination, { operation: 'fixture' }))
    assert.deepEqual(await readdir(directory), ['occupied.json'])
    assert.equal(await readFile(join(destination, 'original'), 'utf8'), 'preserved')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
