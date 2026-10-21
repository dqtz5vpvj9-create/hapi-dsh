/** Official Cordis/Remote services are real; the HAPI HTTP responses below are explicit source fixtures. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import FileReferenceService, { type FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'
import LocalFileReferenceService, { type Config } from '@deepseek-ai/dsh-file-reference-local'
import { SessionFileReferences } from '@deepseek-ai/dsh-api-session-controller'
import { TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { principalOf, RemoteError, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import plugin, { SourceAwareFileReferences } from '../src/hapi/file-references.ts'
import { NativeWorkbench } from '../src/hapi/workbench.ts'
import type { HapiClient } from '../src/hapi/client.ts'
import type { HapiSession } from '../src/codex/contracts.ts'
import type { WorkbenchResponse, WorkbenchSource } from '../src/workbench-types.ts'
import { officialDelegateFixture } from './official-provider-fixture.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'file-reference-fixture': { kind: 'file-reference-fixture' } }
}
const nativeId = SessionId(`hapi-codex-${'c'.repeat(32)}`)
const observedId = SessionId(`hapi-observed-${'d'.repeat(32)}`)
const windowsId = SessionId(`hapi-codex-${'e'.repeat(32)}`)
type Request = { path: string; options: Parameters<HapiClient['request']>[1] }
type Entry = WorkbenchResponse<'nativeDirectory'>['entries'][number]
class RecordingOrdinary extends FileReferenceService {
  readonly calls: { agent: Agent; query: string; signal: AbortSignal; principal: Principal | undefined }[] = []
  override async list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    this.calls.push({ agent, query, signal, principal: principalOf(this.ctx.invocation) })
    return [{ path: query, kind: 'file' }]
  }
}

async function mount(config: Config = {}, original: 'local' | 'recording' | 'later' = 'local') {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-file-reference-'))
  await writeFile(join(directory, 'hub-only.txt'), 'Explicit Hub filesystem fixture, never a source file')
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(TypertRegistry)
  new RemoteAccessService(ctx)
  const localLookups: Agent[] = []
  ctx.provide('workingDirectory', { ensure: async (agent: Agent, signal: AbortSignal) => {
    signal.throwIfAborted(); localLookups.push(agent); return directory
  } } as unknown as Context['workingDirectory'])
  const sources = new Map<string, WorkbenchSource>([
    [nativeId, { sourceHubId: 'fixture-hub', sourceSessionId: 'source-alpha', machineId: 'machine-alpha' }],
    [observedId, { sourceHubId: 'fixture-hub', sourceSessionId: 'source-beta', machineId: 'machine-beta' }],
    [windowsId, { sourceHubId: 'fixture-hub', sourceSessionId: 'source-windows', machineId: 'machine-windows' }],
  ])
  const sessions = new Map<string, HapiSession>([...sources.values()].map(source => [source.sourceSessionId, {
    id: source.sourceSessionId, active: true, thinking: false, activeAt: 1, updatedAt: 1, metadataVersion: 1, agentStateVersion: 1,
    metadata: { machineId: source.machineId!, path: source.sourceSessionId === 'source-windows' ? 'C:\\source\\project' : '/source/project' },
    namespace: 'authorized-fixture', seq: 1, createdAt: 1, thinkingAt: 0, agentState: null,
  }]))
  const entries = new Map<string, Entry[]>([...sources.values()].map(source => [source.sourceSessionId, [
    { name: `${source.sourceSessionId}.txt`, type: 'file' }, { name: 'source.txt', type: 'file' },
    { name: 'src', type: 'directory' }, { name: 'node_modules', type: 'directory' }, { name: '.hidden', type: 'file' },
    { name: 'link', type: 'other', isSymbolicLink: true },
  ]]))
  const searchPaths = new Map<string, string[]>([...sources.values()].map(source => [source.sourceSessionId, ['src/source.ts', 'source.txt']]))
  const requests: Request[] = [], reads: string[] = []
  let response = async (request: Request): Promise<unknown> => {
    const url = new URL(request.path, 'http://fixture.invalid')
    const id = decodeURIComponent(url.pathname.split('/')[3]!)
    if (url.pathname.endsWith('/directory')) return { success: true, entries: entries.get(id) ?? [] }
    if (url.pathname.endsWith('/files')) return { success: true, files: (searchPaths.get(id) ?? []).map(path => ({
      fileName: posix.basename(path), filePath: posix.dirname(path), fullPath: path, fileType: 'file',
    })) }
    throw new Error('Unexpected source route')
  }
  const client: Pick<HapiClient, 'hubId' | 'getSession' | 'request' | 'readBinary'> = {
    hubId: 'fixture-hub',
    getSession: async id => { reads.push(id); const value = sessions.get(id); if (!value) throw new Error('Unknown source session'); return structuredClone(value) },
    request: async (path, options) => { const request = { path, options }; requests.push(request); return response(request) },
    readBinary: async () => { throw new Error('Reference discovery cannot read file contents') },
  }
  const workbench = new NativeWorkbench(client)
  ctx.provide('hapi', { nativeWorkbench: workbench, workbenchSource: (id: string) => {
    const source = sources.get(id)
    if (source) return { ...source }
    if (id.startsWith('hapi-codex-') || id.startsWith('hapi-observed-')) {
      throw new RemoteError('hapi/request', 'Unknown or replaced source display', { outcome: 'rejected', status: 404 })
    }
    return undefined
  } } as Context['hapi'])
  const isolated = officialDelegateFixture(ctx, 'file-reference-local', config), entry = [...ctx.loader.entries()][0]!
  const originalFiber = original === 'local' ? await isolated.plugin(LocalFileReferenceService, config)
    : original === 'recording' ? await isolated.plugin(RecordingOrdinary) : undefined
  function agent(id: string) {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/must-not-be-used-as-source-cwd' } })
    const value = { id: session.id, session, ctx: ctx.extend(), status: 'idle' } as unknown as Agent
    const leave = ctx.agents.enter(value, undefined)
    return { value, leave }
  }
  const native = agent(nativeId), observed = agent(observedId), windows = agent(windowsId), ordinary = agent('ordinary')
  if (original !== 'later') await ctx.plugin(plugin)
  return { ctx, isolated, entry, originalFiber, agent, native, observed, windows, ordinary, directory,
    sources, sessions, entries, searchPaths, requests, reads, localLookups, workbench,
    get service() { return ctx.get('fileReferences')! },
    respond(handler: typeof response) { response = handler },
    async close() { await ctx.fiber.dispose(); await workbench.close(); await rm(directory, { recursive: true, force: true }) },
  }
}

test('one official local provider retains ordinary discovery and source Agents never touch its filesystem', async () => {
  const app = await mount()
  try {
    assert.ok(app.isolated.get('fileReferences') instanceof LocalFileReferenceService)
    assert.ok(app.service instanceof SourceAwareFileReferences)
    const signal = new AbortController().signal
    assert.deepEqual(await app.service.list(app.ordinary.value, '', signal), [{ path: 'hub-only.txt', kind: 'file' }])
    // Even an identical path on the Hub must not change the source result.
    app.sessions.get('source-alpha')!.metadata!.path = app.directory
    const found = await app.service.list(app.native.value, '', signal)
    assert.ok(found.some(row => row.path === 'source-alpha.txt'))
    assert.ok(found.every(row => row.path !== 'hub-only.txt'))
    assert.deepEqual(app.localLookups, [app.ordinary.value])
    assert.equal(app.requests[0]!.path, `/api/sessions/source-alpha/directory?path=${encodeURIComponent(app.directory)}`)
  } finally { await app.close() }
})

test('native and observed candidates follow exact source IDs and same-path machines stay independent', async () => {
  const app = await mount()
  try {
    const signal = new AbortController().signal
    const alpha = await app.service.list(app.native.value, '', signal)
    const beta = await app.service.list(app.observed.value, '', signal)
    assert.ok(alpha.some(row => row.path === 'source-alpha.txt')); assert.ok(alpha.every(row => row.path !== 'source-beta.txt'))
    assert.ok(beta.some(row => row.path === 'source-beta.txt')); assert.ok(beta.every(row => row.path !== 'source-alpha.txt'))
    assert.ok(alpha.every(row => !['node_modules', '.hidden', 'link'].includes(row.path)))
    assert.deepEqual(app.requests.map(row => new URL(row.path, 'http://fixture.invalid').pathname), [
      '/api/sessions/source-alpha/directory', '/api/sessions/source-beta/directory',
    ])
    assert.ok(app.requests.every(row => row.options?.signal === signal))
    assert.equal(app.localLookups.length, 0)
  } finally { await app.close() }
})

test('directory drilldown uses source Windows semantics, preserves quoted names, and confines paths', async () => {
  const app = await mount({ excludedDirectories: ['vendor'], maxResults: 3 })
  try {
    const signal = new AbortController().signal
    app.entries.set('source-windows', [{ name: 'a "quoted" name.ts', type: 'file' }, { name: 'a\\escape', type: 'file' },
      { name: '../escape', type: 'file' }, { name: 'a-link', type: 'file', isSymbolicLink: true }, { name: 'another', type: 'directory' }])
    assert.deepEqual(await app.service.list(app.windows.value, 'src\\a', signal), [
      { path: 'src/another', kind: 'directory' }, { path: 'src/a "quoted" name.ts', kind: 'file' },
    ])
    assert.equal(new URL(app.requests.at(-1)!.path, 'http://fixture.invalid').searchParams.get('path'), 'C:\\source\\project\\src')
    const count = app.requests.length
    for (const query of ['../', '/outside/', 'D:/outside/', 'vendor/']) assert.deepEqual(await app.service.list(app.windows.value, query, signal), [])
    assert.equal(app.requests.length, count)
    app.entries.set('source-alpha', [{ name: 'file\\name.ts', type: 'file' }, { name: '.env', type: 'file' }])
    assert.deepEqual(await app.service.list(app.native.value, '', signal), [{ path: 'file\\name.ts', kind: 'file' }])
    assert.deepEqual(await app.service.list(app.native.value, './.e', signal), [{ path: './.env', kind: 'file' }])
    assert.equal(app.localLookups.length, 0)
  } finally { await app.close() }
})

test('bounded source search retains upstream query/ignore authority and filters malformed or excluded results', async () => {
  const app = await mount({ maxResults: 3, maxEntries: 7, excludedDirectories: ['vendor'] })
  try {
    const signal = new AbortController().signal
    app.searchPaths.set('source-alpha', ['src/source.ts', 'source.txt', 'vendor/source.ts', '.cache/source.ts', 'src/source.ts'])
    const candidates = await app.service.list(app.native.value, 'source', signal)
    assert.deepEqual(candidates, [{ path: 'source-alpha.txt', kind: 'file' }, { path: 'source.txt', kind: 'file' }, { path: 'src/source.ts', kind: 'file' }])
    const search = app.requests.find(row => new URL(row.path, 'http://fixture.invalid').pathname.endsWith('/files'))!
    assert.equal(new URL(search.path, 'http://fixture.invalid').search, '?query=source&limit=7')
    assert.equal(search.options?.signal, signal)
    app.searchPaths.set('source-alpha', ['../outside.txt'])
    await assert.rejects(app.service.list(app.native.value, 'outside', signal), (error: unknown) => error instanceof RemoteError
      && error.code === 'hapi/request' && error.details.sourceCode === 'protocol_mismatch')
    app.respond(async () => ({ success: false, error: 'Sensitive upstream diagnostic must not reach this tooltip' }))
    await assert.rejects(app.service.list(app.native.value, '', signal), (error: unknown) => error instanceof RemoteError
      && !error.message.includes('Sensitive') && error.details.sourceCode === 'source_unavailable')
    assert.equal(app.localLookups.length, 0)
  } finally { await app.close() }
})

test('stale, child, replaced or inactive source Agents fail without ordinary fallback', async () => {
  const app = await mount()
  try {
    const signal = new AbortController().signal
    await assert.rejects(app.service.list({ ...app.native.value } as Agent, '', signal), /replaced/)
    const child = app.agent(`${nativeId}-child-${'f'.repeat(24)}`)
    await assert.rejects(app.service.list(child.value, '', signal), /Unknown or replaced/)
    app.native.leave()
    await assert.rejects(app.service.list(app.native.value, '', signal), /replaced/)
    app.sessions.get('source-beta')!.active = false
    await assert.rejects(app.service.list(app.observed.value, '', signal), /offline/)
    app.sessions.get('source-windows')!.metadata!.machineId = 'wrong-machine'
    await assert.rejects(app.service.list(app.windows.value, '', signal), /another source machine/)
    assert.equal(app.requests.length, 0); assert.equal(app.localLookups.length, 0)
  } finally { await app.close() }
})

test('source discovery honors cancellation before dispatch and during actual source GETs', async () => {
  const app = await mount()
  try {
    const pre = new AbortController(); pre.abort(new Error('Before dispatch'))
    await assert.rejects(app.service.list(app.native.value, '', pre.signal), /Before dispatch/)
    assert.equal(app.reads.length, 0)
    const abort = new AbortController(), reason = new Error('Replaced completion query')
    let dispatched!: () => void
    const started = new Promise<void>(resolve => { dispatched = resolve })
    app.respond(async request => {
      const signal = request.options?.signal!
      assert.equal(signal, abort.signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        if (request.path.includes('/files?')) dispatched()
      })
    })
    const result = app.service.list(app.native.value, 'source', abort.signal)
    await started; abort.abort(reason)
    await assert.rejects(result, error => error === reason)
    assert.equal(app.requests.length, 2); assert.equal(app.localLookups.length, 0)
  } finally { await app.close() }
})

test('retiring an Agent while a source response is pending cannot publish stale candidates', async () => {
  const app = await mount()
  try {
    app.respond(async () => {
      app.native.leave()
      return { success: true, entries: [{ name: 'source.txt', type: 'file' }] }
    })
    await assert.rejects(app.service.list(app.native.value, '', new AbortController().signal), /replaced/)
    assert.equal(app.localLookups.length, 0)
  } finally { await app.close() }
})

test('public Loader realm and dependency lifecycle gate the wrapper before it becomes available', async () => {
  const app = await mount({}, 'later')
  try {
    // The official Session Controller creates this child before our source
    // service is available in a real profile. Its early dependency waiter
    // must be notified when the public provider becomes active.
    const consumer = await app.ctx.plugin(SessionFileReferences)
    assert.equal(app.ctx.get('sessionFileReferences'), undefined)
    const realm = app.entry.realm
    Reflect.deleteProperty(app.entry, 'realm')
    await app.ctx.plugin(plugin)
    assert.equal(app.ctx.get('fileReferences'), undefined)
    app.entry.realm = realm
    app.ctx.waterfall('loader/patch-context', app.entry, () => {})
    assert.equal(app.ctx.get('fileReferences'), undefined)
    const original = await app.isolated.plugin(RecordingOrdinary)
    await app.ctx.fiber.await()
    assert.ok(app.ctx.get('fileReferences') instanceof SourceAwareFileReferences)
    await consumer.await()
    assert.ok(app.ctx.get('sessionFileReferences') instanceof SessionFileReferences)
    await original.dispose(); await app.ctx.fiber.await()
    assert.equal(app.ctx.get('fileReferences'), undefined)
    assert.equal(app.ctx.get('sessionFileReferences'), undefined)
    const replacement = await app.isolated.plugin(RecordingOrdinary)
    await app.ctx.fiber.await()
    assert.ok(app.ctx.get('fileReferences') instanceof SourceAwareFileReferences)
    await consumer.await()
    assert.ok(app.ctx.get('sessionFileReferences') instanceof SessionFileReferences)
    await replacement.dispose()
  } finally { await app.close() }
})

test('the original SessionFileReferences Remote preserves exact Agent authorization and caller Invocation', async () => {
  const app = await mount({}, 'recording')
  try {
    app.ctx.typert.resources.register('session', { field: 'sessionId' })
    app.ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-session-controller', TYPERT))
    await app.ctx.plugin(SessionFileReferences)
    const gateway = new TypertGatewayService(app.ctx, TypertGatewayService.Config({}))
    app.ctx.remoteAccess.registerPolicy('file-reference-fixture', { bindings: () => [
      { role: { name: 'Selected original', resource: 'session', actions: ['fileReferences/list'] }, resource: { kind: 'session', id: app.ordinary.value.id } },
      { role: { name: 'Selected source', resource: 'session', actions: ['fileReferences/list'] }, resource: { kind: 'session', id: nativeId } },
    ] })
    const principal: Principal = { kind: 'file-reference-fixture' }
    const signal = new AbortController().signal
    const peer: PeerScope = { id: 'file-reference-fixture-peer' as PeerId, ctx: app.ctx, principal, signal, interactions: 'answer', dispose: async () => {} }
    const invoke = (agent: Agent, query: string) => gateway.invoke({ peer, namespace: 'fileReferences', method: 'list', args: { agentId: agent.id, query } })
    assert.deepEqual(await invoke(app.ordinary.value, 'exact\\ordinary query'), [{ path: 'exact\\ordinary query', kind: 'file' }])
    const original = app.isolated.get('fileReferences') as RecordingOrdinary
    assert.equal(original.calls[0]!.agent, app.ordinary.value)
    assert.equal(original.calls[0]!.query, 'exact\\ordinary query')
    assert.deepEqual(original.calls[0]!.principal, principal)
    const source = await invoke(app.native.value, '') as FileReferenceCandidate[]
    assert.ok(source.some(row => row.path === 'source-alpha.txt'))
    const before = app.requests.length
    await assert.rejects(invoke(app.observed.value, ''), (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied')
    assert.equal(app.requests.length, before); assert.equal(original.calls.length, 1)
  } finally { await app.close() }
})
