/** Real bridge, adapter and durable receipt files; the native Codex RPC boundary is synthetic. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CodexAccessBridge } from '../src/remote/codex-access-bridge.ts'
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts'
import type { CodexRpc } from '../src/remote/codex-rpc.ts'
import { SourceError } from '../src/remote/errors.ts'
import type { CodexCall } from '../src/remote/codex-access.ts'

const nativeThread = { id: 'exact-created-thread', cwd: '/synthetic', name: 'private native title', preview: 'private native content',
  createdAt: 1, updatedAt: 2, status: { type: 'idle' }, model: 'private-config', turns: [] }
function rpcBoundary(run: (method: string, params: unknown) => Promise<unknown> | unknown): CodexRpc {
  return { currentGeneration: 1, online: true, connect: async () => ({ userAgent: 'Synthetic Codex boundary' }),
    onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
    request: run, respond: async () => {}, dispose: async () => {} } as unknown as CodexRpc
}
async function root(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-native-result-')
  t.after(() => rm(directory, { recursive: true, force: true })); return directory
}
async function receiptFiles(directory: string): Promise<string[]> {
  return Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(name => readFile(join(directory, name), 'utf8')))
}
test('a restarted native carrier recovers the exact fork/start target without response config or credentials', async t => {
  const directory = await root(t); let writes = 0
  const rpc = rpcBoundary(() => { writes++; return { thread: nativeThread, token: 'private-token', configuration: 'private-config' } })
  const make = () => new CodexAccessBridge('source', rpc, directory, async () => {}, () => {}, async () => ({ status: 'accepted', message: 'reply' }))
  for (const method of ['thread/fork', 'thread/start']) {
    const first = make(), request: CodexCall = { sourceId: 'source', operationId: method, method, params: { threadId: 'parent' } }
    const initial = await first.call(request); assert.equal((initial.result as { thread: { id: string } }).thread.id, nativeThread.id); first.dispose()
    const restarted = make(); t.after(() => restarted.dispose())
    const restored = await restarted.call(request, true)
    assert.deepEqual(restored.result, { thread: { id: nativeThread.id } })
    assert.deepEqual((await restarted.call(request)).result, restored.result)
    await assert.rejects(restarted.call({ ...request, params: { threadId: 'another-parent' } }, true), /different arguments/)
  }
  assert.equal(writes, 2)
  for (const raw of await receiptFiles(join(directory, 'native-operations'))) {
    assert.ok(!raw.includes('private-token')); assert.ok(!raw.includes('private-config')); assert.ok(!raw.includes('private native'))
    const receipt = JSON.parse(raw).receipt
    assert.deepEqual(receipt.result, { thread: { id: nativeThread.id } })
  }
})

test('missing and uncertain native receipt lookups never dispatch or adopt matching source metadata', async t => {
  const directory = await root(t); let writes = 0
  const rpc = rpcBoundary(() => { writes++; throw new SourceError('OUTCOME_UNKNOWN', 'Reply lost') })
  const make = () => new CodexAccessBridge('source', rpc, directory, async () => {}, () => {}, async () => ({ status: 'accepted', message: 'reply' }))
  const request = { sourceId: 'source', operationId: 'original', method: 'thread/name/set', params: { threadId: 'parent', name: 'already matching' } }
  const first = make()
  assert.equal((await first.call(request, true)).status, 'indeterminate'); assert.equal(writes, 0)
  assert.deepEqual(await readdir(directory), [], 'receipt lookup does not install a write marker')
  assert.equal((await first.call(request)).status, 'indeterminate'); first.dispose()
  const restarted = make(); t.after(() => restarted.dispose())
  assert.equal((await restarted.call(request, true)).status, 'indeterminate')
  assert.equal((await restarted.call(request)).status, 'indeterminate'); assert.equal(writes, 1)
})

test('creation restart hydrates only the persisted exact native target and never starts another thread', async t => {
  const directory = await root(t), methods: Array<{ method: string; params: unknown }> = []
  let readable = true
  const rpc = rpcBoundary((method, params) => {
    methods.push({ method, params })
    if (method === 'thread/start') return { thread: nativeThread, token: 'private-token' }
    if (method === 'thread/read') {
      assert.equal((params as { threadId: string }).threadId, nativeThread.id)
      if (!readable) throw new SourceError('TARGET_UNAVAILABLE', 'Synthetic source offline')
      return { thread: { ...nativeThread, name: 'current native title' } }
    }
    throw new Error('Unexpected native request ' + method)
  })
  const make = () => new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex', cwd: '/synthetic', ownership: 'exclusive' }, directory,
    { rpc, readMetadata: async () => { throw new Error('Metadata is outside this fixture') } })
  const request = { sourceId: 'source', operationId: 'create-original', cwd: '/synthetic' }
  const first = make(), created = await first.create(request)
  assert.equal(created.status, 'accepted'); assert.equal(created.session?.nativeId, nativeThread.id); await first.dispose()
  const files = await receiptFiles(join(directory, 'creations'))
  assert.equal(files.length, 1)
  const saved = JSON.parse(files[0]!).receipt.session
  assert.deepEqual(Object.keys(saved).sort(), ['engine', 'id', 'machineId', 'nativeId', 'sourceId'])
  assert.ok(!files[0]!.includes('private native')); assert.ok(!files[0]!.includes('private-config')); assert.ok(!files[0]!.includes('private-token'))
  readable = false
  const next = make(); t.after(() => next.dispose())
  assert.equal((await next.create(request)).status, 'indeterminate')
  readable = true
  const recovered = await next.create(request)
  assert.equal(recovered.status, 'accepted'); assert.equal(recovered.session?.id, created.session?.id)
  assert.equal(recovered.session?.title, 'current native title')
  assert.equal(methods.filter(call => call.method === 'thread/start').length, 1)
  assert.equal(methods.filter(call => call.method === 'thread/read').length, 2)
})
