import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { HapiRequestError, type HapiEvent, type HapiMessagesPage, type HapiSession } from '../src/codex/contracts.js'
import { record } from '../src/codex/native.js'
import { CodexService } from '../src/codex/service.js'
import { HapiAgentService, type HapiObservedTransport } from '../src/hapi-agent/index.js'
import { SourceHistory } from '../src/hapi/source-history.js'
import type { PiHistoryEntry, SourceHistoryOperation } from '../src/hapi-agent/history-types.js'

/** Pinned HAPI route/metadata fixtures. Official DSH Sessions, scopes, registries and display generations are real. */
class Fixture implements HapiObservedTransport {
  readonly hubId = 'history-fixture-hub'
  isConnected = true
  readonly sources = new Map<string, HapiSession>()
  readonly listeners = new Set<(event: HapiEvent) => void>()
  readonly writes: Array<{ path: string; body: unknown }> = []
  readonly catalog: PiHistoryEntry[] = []
  readonly failImports = new Set<string>()
  catalogMachine = 'runner'
  loseImport = false
  loseReopen = false
  holdReopen = false
  loseMigration = false
  cursorFailure: HapiRequestError | undefined
  codexFailure: HapiRequestError | undefined
  add(id: string, flavor: string, native = false): HapiSession {
    const source: HapiSession = { id, namespace: 'fixture', seq: 1, createdAt: 1000, updatedAt: 1000,
      active: false, activeAt: 1000, thinking: false, thinkingAt: 1000, metadataVersion: 1, agentStateVersion: 1,
      metadata: { path: '/fixture/project', host: 'fixture-host', machineId: 'runner', flavor, lifecycleState: 'archived',
        ...(flavor === 'codex' ? { codexSessionId: `${id}-thread`, codexHome: '/fixture/source-home', codexHomeId: 'source-home',
          ...(native ? { codexNativeSession: true, codexNativeConnection: 'history' } : {}) } : {}),
        ...(flavor === 'cursor' ? { cursorSessionId: `${id}-thread`, cursorSessionProtocol: 'stream-json' } : {}),
      }, agentState: { requests: {}, completedRequests: {} }, model: 'fixture-model' }
    this.sources.set(id, source); return source
  }
  addPi(id: string): PiHistoryEntry {
    const row: PiHistoryEntry = { id, title: `Original ${id}`, file: `/fixture/pi/${id}.jsonl`, cwd: '/fixture/project',
      modifiedAt: 2000, leafEntryId: `${id}-leaf`, messageCount: 2, model: 'pi-fixture-model' }
    this.catalog.push(row); return row
  }
  imported(id: string): HapiSession | undefined { return [...this.sources.values()].find(row => row.metadata?.flavor === 'pi' && row.metadata.piSessionId === id) }
  async listSessions() { return [...this.sources.values()].map(row => structuredClone(row)) }
  async getSession(id: string) { const source = this.sources.get(id); if (!source) throw new HapiRequestError('Missing fixture source', 'rejected', 404); return structuredClone(source) }
  async readMessages(): Promise<HapiMessagesPage> { return { messages: [], page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
    nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } } }
  async getQueuedState() { return { queuedLocalIds: [], invokedLocalMessages: [] } }
  async sendMessage() { throw new Error('History controls must not send a model message through HAPI') }
  async cancelQueuedMessage(_id: string, localId: string) { return { status: 'cancelled' as const, localId } }
  async steerQueuedMessage(_id: string, localId: string) { return { status: 'steered' as const, localId } }
  async retryIndeterminateMessage(_id: string, localId: string) { return { status: 'retried' as const, localId } }
  async abortSession() { throw new Error('Only the source migration route may stop its original runtime') }
  async approve() { throw new Error('History controls must not resolve approvals') }
  async deny() { throw new Error('History controls must not resolve approvals') }
  subscribe(listener: (event: HapiEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async request(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
    if ((options.method ?? 'GET') === 'GET') {
      if (path.startsWith('/api/pi/sessions')) return { success: true, machineId: this.catalogMachine, sessions: this.catalog.map(row => {
        const source = this.imported(row.id), importState = record(record(source?.metadata)?.piImportState)?.state
        return { ...row, ...(source ? { hapiSessionId: source.id, importState } : {}) }
      }) }
      if (path.endsWith('/codex-homes')) return { success: true, homes: [
        { id: 'source-home', label: 'Source home', path: '/fixture/source-home', official: true },
        { id: 'target-home', label: 'Target home', path: '/fixture/target-home' },
      ] }
      throw new Error(`Unexpected read: ${path}`)
    }
    this.writes.push({ path, body: structuredClone(options.body) })
    const body = record(options.body) ?? {}
    if (path === '/api/pi/import-sessions') {
      assert.ok(Array.isArray(body.sessionIds))
      const results = body.sessionIds.map(id => {
        assert.equal(typeof id, 'string'); const selected = this.catalog.find(row => row.id === id)!; assert.ok(selected)
        const old = this.imported(selected.id), source = old ?? this.add(`hapi-${selected.id}`, 'pi')
        source.metadata!.piSessionId = selected.id
        const failed = this.failImports.has(selected.id)
        Object.assign(source.metadata!, { piImportState: { state: failed ? 'diverged' : 'complete', machineId: 'runner', piSessionId: selected.id,
          sourceFile: selected.file, startedAt: 3000, updatedAt: 4000, leafEntryId: selected.leafEntryId,
          ...(failed ? { error: 'Original Pi branch diverged' } : {}) } })
        source.metadataVersion++
        return { piSessionId: selected.id, hapiSessionId: source.id, ...(failed ? { error: { code: 'transcript_diverged', message: 'Original Pi branch diverged' } }
          : { action: old ? 'unchanged' : 'created', appended: old ? 0 : 2 }) }
      })
      if (this.loseImport) throw new HapiRequestError('Import reply was lost', 'indeterminate', 401)
      return { success: results.every(row => !('error' in row)), machineId: 'runner', results }
    }
    const sourceId = decodeURIComponent(path.split('/')[3] ?? '')
    if (path.endsWith('/reopen')) {
      const source = this.sources.get(sourceId)!; assert.ok(source)
      if (!this.holdReopen) { source.active = true; source.metadata!.lifecycleState = 'running'; source.metadataVersion++ }
      if (this.loseReopen) throw new HapiRequestError('Reopen reply was lost', 'indeterminate')
      return { ok: true, sessionId: sourceId, resumed: true }
    }
    if (path.endsWith('/codex-thread-migrate')) {
      if (this.codexFailure) throw this.codexFailure
      assert.equal(typeof body.sessionId, 'string'); const source = this.sources.get(String(body.sessionId))!; assert.ok(source)
      source.metadata!.codexHome = String(body.targetHome); source.metadata!.codexHomeId = String(body.targetHomeId)
      source.metadata!.codexStoreId = String(body.targetHome); source.active = false; source.metadataVersion++
      if (this.loseMigration) throw new HapiRequestError('Migration response was lost', 'indeterminate')
      return { success: true, threadId: source.metadata!.codexSessionId, journalPath: '/fixture/transfer.json', warnings: ['Fixture transfer warning'], ignoredCredential: 'fixture-secret-never-public' }
    }
    if (path.endsWith('/migrate-to-acp')) {
      if (this.cursorFailure) throw this.cursorFailure
      const source = this.sources.get(sourceId)!; assert.ok(source)
      source.metadata!.cursorSessionProtocol = 'acp'; source.active = false; source.metadataVersion++
      if (this.loseMigration) throw new HapiRequestError('Cursor migration response was lost', 'indeterminate')
      return { ok: true, sessionId: sourceId, acpSessionId: source.metadata!.cursorSessionId,
        replayNotifications: 9, durationMs: 16, lastUsedModelPreserved: source.model, sourceRemoved: body.keepSource !== true,
        ignoredCredential: 'fixture-secret-never-public' }
    }
    throw new Error(`Unexpected mutation: ${path}`)
  }
}

async function mount(source: Fixture, directory: string) {
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime)
  let native: CodexService | undefined, observed: HapiAgentService | undefined, history: SourceHistory | undefined
  await ctx.plugin(Object.assign(async (owner: Context) => {
    native = new CodexService(owner, source, { stateDirectory: directory }); await native.start()
    observed = new HapiAgentService(owner, source, { stateDirectory: directory }); await observed.start()
    history = new SourceHistory(source, { get: id => native!.get(id) ?? observed!.get(id),
      byHapiSession: id => native!.byHapiSession(id) ?? observed!.byHapiSession(id),
      reconcileSource: async id => (await source.getSession(id)).metadata?.codexNativeSession
        ? native!.reconcileSource(id) : observed!.reconcileSource(id),
    }, directory)
  }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
  assert.ok(native && observed && history)
  const services = { native, observed, history }
  return { ctx, ...services, async close() { await services.history.settled(); await services.observed.dispose(); await services.native.dispose(); await ctx.fiber.dispose() } }
}
const pi = (ids: string[], connect = false): SourceHistoryOperation => ({ operationId: randomUUID(), action: { kind: 'pi-import', machineId: 'runner', piSessionIds: ids, connect } })

test('Pi bulk import preserves each source result and attaches successful histories to real official Sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); fixture.addPi('pi-good'); fixture.addPi('pi-diverged'); fixture.failImports.add('pi-diverged')
  const app = await mount(fixture, directory)
  try {
    const catalog = await app.history.pi({ machineId: 'runner' }); assert.equal(catalog.sessions.length, 2)
    const request = pi(['pi-good', 'pi-diverged']), receipt = await app.history.operation(request)
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.items[0]?.action, 'created'); assert.equal(receipt.items[0]?.appended, 2)
    assert.equal(receipt.items[1]?.error?.code, 'transcript_diverged'); assert.equal(receipt.items[1]?.sessionId, null)
    assert.ok(receipt.items[0]?.sessionId); assert.ok(app.ctx.sessions.get(SessionId(receipt.items[0]!.sessionId)))
    assert.equal(app.observed.byHapiSession('hapi-pi-good')?.binding.nativeId, 'pi-good')
    await app.history.operation(request); assert.equal(fixture.writes.length, 1)
    const listed = await app.history.pi({ machineId: 'runner' }); assert.equal(listed.sessions[0]?.displaySessionId, receipt.items[0]?.sessionId)
    fixture.catalogMachine = 'wrong-runner'; await assert.rejects(app.history.pi({ machineId: 'runner' }), /another Runner/)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('one Pi selection imports then reopens the original identity once; repeated requests do not launch another engine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); fixture.addPi('pi-original')
  const app = await mount(fixture, directory)
  try {
    const request = pi(['pi-original'], true)
    const [left, right] = await Promise.all([app.history.operation(request), app.history.operation(request)])
    assert.equal(left.operationId, right.operationId); assert.equal(left.status, 'confirmed'); assert.equal(left.phase, 'complete')
    assert.ok(left.sessionId); assert.equal(left.sourceSessionId, 'hapi-pi-original')
    assert.deepEqual(fixture.writes.map(row => row.path), ['/api/pi/import-sessions', '/api/sessions/hapi-pi-original/reopen'])
    assert.deepEqual(fixture.writes[1]!.body, {}); assert.equal(app.observed.byHapiSession(left.sourceSessionId!)?.binding.nativeId, 'pi-original')
    await app.history.operation(request); await app.history.read({ operationId: request.operationId }); assert.equal(fixture.writes.length, 2)
    await assert.rejects(async () => app.history.operation({ ...request, action: { ...request.action, kind: 'pi-import', machineId: 'runner', piSessionIds: ['other'], connect: true } }), /different immutable/)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('lost Pi import response restores by GET and requires explicit continuation before its first reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); fixture.addPi('pi-original'); fixture.loseImport = true
  let app = await mount(fixture, directory)
  try {
    const request = pi(['pi-original'], true), unknown = await app.history.operation(request)
    assert.equal(unknown.status, 'indeterminate'); assert.equal(fixture.writes.length, 1)
    await app.close(); app = await mount(fixture, directory)
    const read = await app.history.read({ operationId: request.operationId })
    assert.equal(read?.status, 'ready-to-connect'); assert.equal(read.canContinue, true)
    assert.equal(read.items[0]?.confirmation, 'metadata'); assert.equal(read.items[0]?.appended, null)
    assert.equal(fixture.writes.length, 1)
    const ready = await app.history.continue({ operationId: request.operationId })
    assert.equal(ready.status, 'confirmed'); assert.equal(ready.sourceSessionId, 'hapi-pi-original')
    assert.equal(fixture.writes.filter(row => row.path.endsWith('/reopen')).length, 1)
    await app.history.continue({ operationId: request.operationId }); assert.equal(fixture.writes.length, 2)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Pi branch mismatch and an unknown original reopen never authorize a second reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); fixture.addPi('pi-original'); fixture.loseImport = true
  const app = await mount(fixture, directory)
  try {
    const request = pi(['pi-original'], true); await app.history.operation(request)
    const source = fixture.imported('pi-original')!, metadata = record(source.metadata)!, state = record(metadata.piImportState)!
    state.leafEntryId = 'another-branch'
    assert.equal((await app.history.read({ operationId: request.operationId }))?.canContinue, false)
    const refused = await app.history.continue({ operationId: request.operationId })
    assert.equal(refused.canContinue, false); assert.match(refused.message ?? '', /unknown|not ready/)
    assert.equal(fixture.writes.length, 1)
    state.leafEntryId = 'pi-original-leaf'; fixture.loseReopen = true; fixture.holdReopen = true
    await app.history.read({ operationId: request.operationId })
    const unknown = await app.history.continue({ operationId: request.operationId })
    assert.equal(unknown.status, 'indeterminate'); assert.equal(unknown.canContinue, false)
    await app.history.continue({ operationId: request.operationId }); assert.equal(fixture.writes.length, 2)
    source.active = true; source.metadataVersion++
    const observed = await app.history.read({ operationId: request.operationId }); assert.equal(observed?.status, 'confirmed'); assert.ok(observed.sessionId)
    assert.equal(fixture.writes.length, 2)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Codex home migration derives original thread/machine/home and changes the official display generation after source rebind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); fixture.add('native', 'codex', true)
  const app = await mount(fixture, directory)
  try {
    const original = app.native.byHapiSession('native')!, tools = await app.history.tools(original.id)
    assert.equal(tools.codex?.canMigrate, true); assert.equal(tools.codex.sourceHome, '/fixture/source-home')
    const request: SourceHistoryOperation = { operationId: randomUUID(), action: { kind: 'codex-home', sessionId: original.id, targetHomeId: 'target-home', targetProvider: 'fixture-provider', targetModel: 'fixture-model' } }
    const receipt = await app.history.operation(request)
    assert.equal(receipt.status, 'confirmed'); assert.ok(receipt.sessionId); assert.notEqual(receipt.sessionId, original.id)
    assert.equal(receipt.observation?.targetObserved, true); assert.equal(app.native.byHapiSession('native')?.binding.threadId, 'native-thread')
    assert.deepEqual(fixture.writes[0], { path: '/api/machines/runner/codex-thread-migrate', body: {
      sourceHome: '/fixture/source-home', targetHome: '/fixture/target-home', threadId: 'native-thread', sessionId: 'native', stopSource: true,
      targetHomeId: 'target-home', targetProvider: 'fixture-provider', targetModel: 'fixture-model',
    } })
    assert.ok(!JSON.stringify(receipt).includes('ignoredCredential')); assert.ok(!JSON.stringify(receipt).includes('fixture-secret-never-public'))
    await app.history.operation(request); assert.equal(fixture.writes.length, 1)
    await assert.rejects(async () => app.history.operation({ operationId: randomUUID(), action: { kind: 'codex-home', sessionId: original.id, targetHomeId: 'source-home' } }), /current original source display/)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('unknown native migration only observes target metadata across restart and never fabricates file validation success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); fixture.add('native', 'codex', true); fixture.loseMigration = true
  let app = await mount(fixture, directory)
  try {
    const request: SourceHistoryOperation = { operationId: randomUUID(), action: { kind: 'codex-home', sessionId: app.native.list()[0]!.id, targetHomeId: 'target-home' } }
    const unknown = await app.history.operation(request)
    assert.equal(unknown.status, 'indeterminate'); assert.equal(unknown.codexResult, null)
    assert.equal(unknown.observation?.targetObserved, true)
    assert.ok(unknown.sessionId); assert.notEqual(unknown.sessionId, request.action.kind === 'codex-home' ? request.action.sessionId : undefined)
    assert.equal((await app.history.tools(unknown.sessionId)).codex?.sourceHome, '/fixture/target-home')
    await app.close(); app = await mount(fixture, directory)
    const read = await app.history.read({ operationId: request.operationId })
    assert.equal(read?.status, 'indeterminate'); assert.equal(read.observation?.targetObserved, true); assert.equal(read.codexResult, null)
    assert.match(read.message ?? '', /verification outcome remain unknown/)
    await app.history.operation(request); assert.equal(fixture.writes.length, 1)
    await assert.rejects(app.history.operation({ operationId: randomUUID(), action: { kind: 'codex-home', sessionId: app.native.list()[0]!.id, targetHomeId: 'source-home' } }), /unresolved original operation/)
    fixture.sources.get('native')!.metadata!.codexSessionId = 'replacement-thread'; fixture.sources.get('native')!.metadataVersion++
    const replaced = await app.history.read({ operationId: request.operationId }); assert.equal(replaced?.sessionId, null); assert.match(replaced.message ?? '', /identity changed/)
    assert.equal(fixture.writes.length, 1)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('history tools acquire the current display when a source rebind invalidated the old Agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); fixture.add('native', 'codex', true)
  const app = await mount(fixture, directory)
  try {
    const old = app.native.byHapiSession('native')!, source = fixture.sources.get('native')!
    source.metadata!.codexHome = '/fixture/target-home'; source.metadata!.codexHomeId = 'target-home'; source.metadataVersion++
    const tools = await app.history.tools(old.id)
    assert.notEqual(tools.sessionId, old.id); assert.equal(tools.nativeId, old.binding.threadId)
    assert.equal(tools.codex?.sourceHome, '/fixture/target-home'); assert.equal(fixture.writes.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Cursor structured source refusals retain exact reason while stripping unrelated response fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); fixture.add('cursor', 'cursor')
  fixture.cursorFailure = new HapiRequestError('HTTP 500', 'indeterminate', 500, undefined, {
    ok: false, sessionId: 'cursor', reason: 'cross_host_session', message: 'History belongs to another host', durationMs: 7,
    authorization: 'fixture-secret-never-public', privateConfig: { key: 'fixture-secret-never-public' },
  })
  const app = await mount(fixture, directory)
  try {
    const agent = app.observed.list()[0]!, request: SourceHistoryOperation = { operationId: randomUUID(), action: {
      kind: 'cursor-acp', sessionId: agent.id, keepSource: true, forceArchiveRunning: false, skipVerify: false,
    } }
    const receipt = await app.history.operation(request)
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.cursorResult?.ok, false)
    assert.match(receipt.message ?? '', /cross_host_session/)
    assert.deepEqual(fixture.writes[0]?.body, { keepSource: true, forceArchiveRunning: false, skipVerify: false })
    await app.history.operation(request); assert.equal(fixture.writes.length, 1)
    const filename = (await readdir(directory)).find(name => name.endsWith('.json') && name.includes('source-history'))
    assert.equal(filename, undefined, 'Journal names use only opaque Hub hashes')
    const journals = (await readdir(directory)).filter(name => name.endsWith('.json'))
    for (const name of journals) assert.ok(!(await readFile(join(directory, name), 'utf8')).includes('fixture-secret-never-public'))
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Cursor active archival and original store removal require their explicit options; no 401 body can downgrade unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-history-')), fixture = new Fixture(); const source = fixture.add('cursor', 'cursor'); source.active = true
  const app = await mount(fixture, directory)
  try {
    const agent = app.observed.list()[0]!
    const refused = await app.history.operation({ operationId: randomUUID(), action: { kind: 'cursor-acp', sessionId: agent.id, keepSource: true, forceArchiveRunning: false, skipVerify: false } })
    assert.equal(refused.status, 'rejected'); assert.equal(fixture.writes.length, 0)
    const request: SourceHistoryOperation = { operationId: randomUUID(), action: { kind: 'cursor-acp', sessionId: agent.id, keepSource: false, forceArchiveRunning: true, skipVerify: true } }
    fixture.cursorFailure = new HapiRequestError('401 may mask a downstream write', 'indeterminate', 401, undefined,
      { ok: false, sessionId: 'cursor', reason: 'running_refused', message: 'Must not be trusted as proof', durationMs: 0 })
    assert.equal((await app.history.operation(request)).status, 'indeterminate')
    assert.equal((await app.history.read({ operationId: request.operationId }))?.cursorResult, null)
    await app.history.operation(request); assert.equal(fixture.writes.length, 1)
    source.metadata!.cursorSessionProtocol = 'acp'; source.metadataVersion++; source.active = false
    const observed = await app.history.read({ operationId: request.operationId })
    assert.equal(observed?.status, 'indeterminate'); assert.equal(observed.observation?.targetObserved, true)
    assert.equal(observed.cursorResult, null); assert.match(observed.message ?? '', /cleanup result remain unknown/)
    assert.deepEqual(fixture.writes[0]?.body, { keepSource: false, forceArchiveRunning: true, skipVerify: true })
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
