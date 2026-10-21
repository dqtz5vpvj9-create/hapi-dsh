import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { WorkspaceFiles, type Config, type WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import { TYPERT } from '@deepseek-ai/dsh-api-workspace-files/typert'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { RemoteError, remoteMethods, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { NativeWorkbench } from '../src/hapi/workbench.ts'
import NativeAwareWorkspaceFiles from '../src/hapi/workspace-files.ts'
import type { HapiClient } from '../src/hapi/client.ts'
import type { HapiSession } from '../src/codex/contracts.ts'
import { officialDelegateFixture } from './official-provider-fixture.ts'

const nativeId = SessionId(`hapi-codex-${'b'.repeat(32)}`)
const source = { sourceSessionId: 'native-source', sourceHubId: 'fixture-hub', machineId: 'remote-machine' }
const signal = (): AbortSignal => new AbortController().signal
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

async function fixture(limits: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-official-files-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: directory })
  ctx.provide('sandboxPolicy', { workspaceRoot: directory } as never)
  new RemoteAccessService(ctx)
  const session: HapiSession = { id: source.sourceSessionId, active: true, thinking: false, activeAt: 1, updatedAt: 1, metadataVersion: 1, agentStateVersion: 1,
    metadata: { path: '/source/project', machineId: source.machineId }, namespace: 'fixture', seq: 1, createdAt: 1, thinkingAt: 0, agentState: null }
  const files = new Map<string, Uint8Array>([['/source/project/notes.txt', Buffer.from('first\nsecond\nthird\n')], ['/source/project/image.bin', new Uint8Array([0, 1, 2, 3])]])
  const denied = new Set<string>()
  const requests: string[] = []
  const client: Pick<HapiClient, 'hubId' | 'getSession' | 'request' | 'readBinary'> = {
    hubId: source.sourceHubId,
    getSession: async () => structuredClone(session),
    request: async raw => {
      requests.push(raw)
      const url = new URL(raw, 'http://fixture.invalid'), path = url.searchParams.get('path') ?? ''
      assert.ok(raw.startsWith('/api/sessions/native-source/'))
      if (denied.has(path)) return { success: false, error: 'Path is outside workspace roots' }
      if (url.pathname.endsWith('/directory')) return path === '/source/project' ? { success: true, entries: [...files].map(([name, bytes]) => ({ name: posix.basename(name), type: 'file', size: bytes.byteLength, modified: hash(bytes) })) .map(entry => ({ ...entry, modified: parseInt(String(entry.modified).slice(0, 8), 16) })) } : { success: false, error: 'Not a directory' }
      const bytes = files.get(path)
      if (url.pathname.endsWith('/file-info')) return { success: true, entries: [{ path, ...(bytes ? { size: bytes.byteLength, modified: parseInt(hash(bytes).slice(0, 8), 16) } : {}) }] }
      if (!bytes) return { success: false, code: 'not-found', error: 'Missing source file' }
      if (url.pathname.endsWith('/file')) return { success: true, path, content: Buffer.from(bytes).toString('base64'), size: bytes.byteLength, hash: hash(bytes), writable: path.startsWith('/source/project/') }
      return { success: true, entry: { path, name: posix.basename(path), type: path.endsWith('link') ? 'symlink' : 'file', size: bytes.byteLength, modified: 1, revision: hash(bytes), entryCount: 1 } }
    },
    readBinary: async raw => {
      requests.push(raw)
      const path = new URL(raw, 'http://fixture.invalid').searchParams.get('path')!
      return { data: files.get(path)!, fileName: posix.basename(path), mimeType: 'application/octet-stream', status: 200, headers: {} }
    },
  }
  const workbench = new NativeWorkbench(client)
  ctx.provide('hapi', {
    nativeWorkbench: workbench,
    workbenchSource: (id: string) => {
      if (id === nativeId) return source
      if (id.startsWith('hapi-codex-')) throw new RemoteError('hapi/request', 'Unknown source display', { outcome: 'rejected', sourceCode: 'source_unavailable' })
      return undefined
    },
  } as unknown as Context['hapi'])
  const localId = SessionId('ordinary-local')
  ctx.sessions.create(nativeId, { meta: { cwd: session.metadata!.path } })
  ctx.sessions.create(localId, { meta: { cwd: directory } })
  const config = { ...WorkspaceFiles.Config(), ...limits }
  new WorkspaceFiles(officialDelegateFixture(ctx, 'workspace-files', config), config)
  ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-workspace-files', TYPERT))
  await ctx.plugin({ inject: NativeAwareWorkspaceFiles.inject, apply(scope: Context) {
    new NativeAwareWorkspaceFiles(scope, WorkspaceFiles.Config(), { pollIntervalMs: 5 })
  } })
  const service = ctx.get('workspaceFiles') as unknown as NativeAwareWorkspaceFiles
  const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
  const nativeScope: WorkspaceFileScope = { sessionId: nativeId, workspaceRoot: session.metadata!.path }
  const localScope: WorkspaceFileScope = { sessionId: localId, workspaceRoot: directory }
  const peer: PeerScope = { id: 'files-fixture' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal: signal(), dispose: async () => {} }
  return { ctx, service, gateway, peer, nativeScope, localScope, files, denied, requests, directory, session,
    close: async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

test('official WorkspaceFiles composition retains Remote metadata, schemas, one original lookup, and ordinary local reads', async () => {
  const f = await fixture()
  try {
    const base = new Context()
    const official = new WorkspaceFiles(base, WorkspaceFiles.Config())
    assert.deepEqual(remoteMethods(f.service), remoteMethods(official))
    assert.equal(NativeAwareWorkspaceFiles.Config, WorkspaceFiles.Config)
    assert.ok(f.ctx.typert.getPackage('@deepseek-ai/dsh-api-workspace-files', 'host'))
    await writeFile(join(f.directory, 'local.txt'), 'ordinary DSH\n')
    assert.equal((await f.service.read(f.localScope, 'local.txt', {}, signal())).text, 'ordinary DSH')
    assert.equal(f.requests.length, 0)
    await base.fiber.dispose()
  } finally { await f.close() }
})

test('native official reads preserve source revisions, line windows, binary bytes, and base-file resolution', async () => {
  const f = await fixture({ maxLines: 2 })
  try {
    const page = await f.service.read(f.nativeScope, 'notes.txt', { offset: 2, limit: 1 }, signal())
    assert.deepEqual(page, { absolutePath: '/source/project/notes.txt', version: hash(f.files.get('/source/project/notes.txt')!), bytes: 19, offset: 2, text: 'second', lines: 1, eof: false })
    const binary = await f.service.readBytes(f.nativeScope, 'image.bin', { baseFile: 'notes.txt', range: { offset: 1, length: 2 } }, signal())
    assert.deepEqual([...binary.data], [1, 2]); assert.equal(binary.eof, false)
    assert.equal(binary.absolutePath, '/source/project/image.bin')
    const eof = await f.service.readBytes(f.nativeScope, 'image.bin', { range: { offset: 4 } }, signal())
    assert.equal(eof.data.length, 0); assert.equal(eof.eof, true)
    await assert.rejects(f.service.read(f.nativeScope, 'image.bin', {}, signal()), (error: unknown) => error instanceof RemoteError && error.code === 'workspace-file/not-text')
    await assert.rejects(f.service.readBytes(f.nativeScope, '/image.bin', { baseFile: 'notes.txt' }, signal()), (error: unknown) => error instanceof RemoteError && error.code === 'gateway/bad-request')
  } finally { await f.close() }
})

test('native listing uses the source Runner, explicit truncation, and source authority failures without local fallback', async () => {
  const f = await fixture({ maxEntries: 1 })
  try {
    assert.deepEqual(await f.service.list(f.nativeScope, '.', signal()), { path: '', entries: [{ name: 'image.bin', type: 'file', size: 4 }], truncated: true })
    await assert.rejects(f.service.list(f.nativeScope, '..', signal()), (error: unknown) => error instanceof RemoteError && error.code === 'workspace-file/outside-workspace')
    const calls = f.requests.length
    f.session.metadata!.machineId = 'different-owner'
    await assert.rejects(f.service.stat(f.nativeScope, 'notes.txt', signal()), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    assert.equal(f.requests.length, calls)
    await assert.rejects(f.service.stat({ ...f.nativeScope, sessionId: SessionId(`${nativeId}-r1`) }, 'notes.txt', signal()), /Unknown source display/)
  } finally { await f.close() }
})

test('official Gateway dispatches native file calls through the original delegate lookup and authorization', async () => {
  const f = await fixture()
  try {
    const result = await f.gateway.invoke({ peer: f.peer, namespace: 'workspaceFiles', method: 'stat', args: { workspaceFileScopeId: nativeId, path: 'notes.txt' } })
    assert.equal((result as { absolutePath: string }).absolutePath, '/source/project/notes.txt')
    await assert.rejects(f.gateway.invoke({ peer: f.peer, namespace: 'workspaceFiles', method: 'stat', args: { workspaceFileScopeId: 'missing-session', path: 'notes.txt' } }))
    assert.ok(f.requests.every(path => path.startsWith('/api/sessions/native-source/')))
    assert.ok(f.requests.some(path => path.includes('/file?')))
  } finally { await f.close() }
})

test('native watch initializes before ready, reports actual source changes and deletion, and cancels polling', async () => {
  const f = await fixture()
  const abort = new AbortController()
  try {
    const stream = f.service.changes(f.nativeScope, 'notes.txt', abort.signal)[Symbol.asyncIterator]()
    assert.deepEqual((await stream.next()).value, { kind: 'ready' })
    f.files.set('/source/project/notes.txt', Buffer.from('edited on source'))
    assert.deepEqual((await stream.next()).value, { kind: 'change', change: { absolutePath: '/source/project/notes.txt', version: hash('edited on source') } })
    f.files.delete('/source/project/notes.txt')
    assert.deepEqual((await stream.next()).value, { kind: 'change', change: { absolutePath: '/source/project/notes.txt', absent: true } })
    abort.abort(); assert.equal((await stream.next()).done, true)
  } finally { abort.abort(); await f.close() }
})

test('native byte and line caps reject oversize requests without truncating or fetching their data', async () => {
  const f = await fixture({ maxBytes: 4, maxFileBytes: 8 })
  try {
    await assert.rejects(f.service.read(f.nativeScope, 'notes.txt', { limit: 1 }, signal()), (error: unknown) => error instanceof RemoteError && error.code === 'workspace-file/too-large')
    const before = f.requests.length
    await assert.rejects(f.service.readBytes(f.nativeScope, 'notes.txt', {}, signal()), (error: unknown) => error instanceof RemoteError && error.code === 'workspace-file/too-large')
    assert.equal(f.requests.length, before)
    await assert.rejects(f.service.readBytes(f.nativeScope, 'image.bin', { range: { length: 5 } }, signal()), (error: unknown) => error instanceof RemoteError && error.code === 'workspace-file/too-large')
    assert.equal(f.requests.length, before)
  } finally { await f.close() }
})

test('official document preview reads an authorized file outside cwd even when its chat is inactive', async () => {
  const f = await fixture()
  const path = '/source/reports/review.md'
  const abort = new AbortController()
  try {
    f.files.set(path, Buffer.from('# Original source document\n'))
    f.session.active = false
    const bytes = await f.service.readBytes(f.nativeScope, path, {}, abort.signal)
    assert.equal(Buffer.from(bytes.data).toString(), '# Original source document\n')
    assert.equal(bytes.absolutePath, path)
    const text = await f.service.read(f.nativeScope, path, {}, abort.signal)
    assert.equal(text.text, '# Original source document')
    assert.equal(text.version, bytes.version)
    assert.equal(f.requests.some(value => value.includes('/filesystem/')), false, 'read authority must not depend on active-session management')
    const watch = f.service.changes(f.nativeScope, path, abort.signal)[Symbol.asyncIterator]()
    assert.deepEqual((await watch.next()).value, { kind: 'ready' })
    f.files.set(path, Buffer.from('# Source changed\n'))
    assert.deepEqual((await watch.next()).value, { kind: 'change', change: { absolutePath: path, version: hash('# Source changed\n') } })
    abort.abort(); assert.equal((await watch.next()).done, true)
    await assert.rejects(f.service.list(f.nativeScope, '/source/reports', signal()), (error: unknown) => error instanceof RemoteError && error.code === 'workspace-file/outside-workspace')
  } finally { abort.abort(); await f.close() }
})

test('document browse-root denial stays a denial and never selects the Host filesystem', async () => {
  const f = await fixture()
  try {
    const path = join(f.directory, 'notes.txt')
    await writeFile(path, 'host bytes must not be used')
    f.denied.add(path)
    await assert.rejects(f.service.readBytes(f.nativeScope, path, {}, signal()), /outside workspace roots/)
    assert.equal(f.requests.some(value => value.includes('/file?')), false)
    assert.equal(f.requests.some(value => value.includes('/filesystem/')), false)
  } finally { await f.close() }
})
