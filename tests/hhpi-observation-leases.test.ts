/** Real adapter/index lifetime; only native RPC, metadata and clock are fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts'
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts'
import { nativeMetadataFixture } from './fixtures/hhpi-native-metadata.ts'

test('reader leases stop idle body polling and reopen the durable index without resetting its epoch', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-observation-lease-'))
  let now = 1_000, notify: (frame: NativeNotification) => void = () => {}, metadataReads = 0
  const thread = { id: 'thread', cwd: directory, createdAt: 1, updatedAt: 1, status: { type: 'active' } }
  const rpc = { online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
    onNotification: (listener: typeof notify) => { notify = listener; return () => {} }, onRequest: () => () => {}, onDisconnect: () => () => {},
    request: async (method: string) => {
      if (method === 'thread/list') return { data: [thread], nextCursor: null }
      if (method === 'thread/loaded/list') return { data: ['thread'], nextCursor: null }
      if (method === 'thread/read') return { thread }
      throw new Error(`Unexpected native IO: ${method}`)
    } } as unknown as CodexRpc
  const metadata = nativeMetadataFixture(() => [])
  const adapter = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex' }, directory,
    { rpc, now: () => now, readMetadata: request => { metadataReads++; return metadata(request) } })
  t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }) })
  const [session] = await adapter.list(), head = await adapter.read({ sessionId: session!.id })
  const acceptedReads = metadataReads
  notify({ method: 'item/agentMessage/delta', params: { threadId: thread.id } })
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve))
  assert.equal(metadataReads, acceptedReads, 'running execution without a display reader does not poll body snapshots')
  now += 31_000; t.mock.timers.tick(250)
  const reopened = await adapter.read({ sessionId: session!.id })
  assert.equal(reopened.epoch, head.epoch, 'closing the idle display index preserves durable native identity')
  assert.ok(metadataReads > acceptedReads, 'reentry validates the current sparse tail')
  const reader = new AbortController(), changes = adapter.changes({ sessionId: session!.id, epoch: reopened.epoch, version: reopened.version }, reader.signal)[Symbol.asyncIterator]()
  await changes.next()
  const before = metadataReads
  t.mock.timers.tick(250); await new Promise(resolve => setImmediate(resolve))
  assert.ok(metadataReads > before, 'an actual shared observer activates source polling')
  reader.abort(); await changes.return?.()
})
