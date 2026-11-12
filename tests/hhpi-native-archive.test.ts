/** Actual source adapter/receipt ledger; only native RPC and clock are controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts'
import type { CodexRpc } from '../src/remote/codex-rpc.ts'
import type { NativeThread } from '../src/remote/codex-native.ts'

test('the source hides confirmed native archives while retaining an unconfirmed catalog omission', async t => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-archive-contract-')
  const thread = (id: string): NativeThread => ({ id, cwd: directory, createdAt: 1, updatedAt: 1, status: { type: 'idle' } })
  const parent = thread('parent'), omitted = thread('omitted')
  let active = [parent, omitted], archived: NativeThread[] = [], now = 1000, archiveReads = 0
  let holdArchive = false, archiveRequested!: () => void, finishArchive!: () => void
  const archiveWaiting = new Promise<void>(resolve => { archiveRequested = resolve })
  const rpc = { online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
    onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/loaded/list') return { data: [], nextCursor: null }
      if (method === 'thread/list') {
        if (params.archived) archiveReads++
        const data = [...(params.archived ? archived : active)]
        if (params.archived && holdArchive) { archiveRequested(); await new Promise<void>(resolve => { finishArchive = resolve }) }
        return { data, nextCursor: null }
      }
      if (method === 'thread/read' && params.threadId === parent.id) return { thread: parent }
      if (method === 'thread/archive') { active = active.filter(x => x.id !== parent.id); archived = [parent]; return {} }
      if (method === 'thread/unarchive') { active = [parent]; archived = []; return { thread: parent } }
      throw new Error(`Unexpected native method ${method}`)
    } } as unknown as CodexRpc
  const adapter = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex', ownership: 'shared', writerLock: 'native' }, directory, { rpc, now: () => now })
  t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true }) })
  assert.deepEqual((await adapter.list()).map(x => x.nativeId), ['parent', 'omitted'])
  active = []; archived = [parent]; now += 16000
  const observed = await adapter.list()
  assert.deepEqual(observed.map(x => x.nativeId), ['omitted'])
  assert.equal(observed[0]?.connection?.state, 'offline', 'omission without an archive fact keeps the last-known thread')
  assert.equal(archiveReads, 1, 'the native archived directory, not absence alone, confirms the archive')
  const call = (method: string, operationId: string) => adapter.nativeAccess.call({ sourceId: 'source', method, params: { threadId: parent.id }, operationId })
  assert.equal((await call('thread/unarchive', 'restore')).status, 'accepted')
  assert.ok((await adapter.list()).some(x => x.nativeId === parent.id))
  assert.equal((await call('thread/archive', 'archive')).status, 'accepted')
  assert.ok(!(await adapter.list()).some(x => x.nativeId === parent.id))
  assert.equal((await call('thread/unarchive', 'restore-before-race')).status, 'accepted')
  active = []; archived = []; now += 16000
  assert.equal((await adapter.list()).find(x => x.nativeId === parent.id)?.connection?.state, 'online', 'the exact restored rollout remains readable before its native state-db entry reappears')
  active = []; archived = [parent]; holdArchive = true; now += 16000
  const staleCatalog = adapter.list()
  await archiveWaiting
  assert.equal((await call('thread/unarchive', 'restore-during-old-catalog')).status, 'accepted')
  finishArchive()
  const current = (await staleCatalog).find(x => x.nativeId === parent.id)
  assert.ok(current, 'an older archived directory cannot hide the source-confirmed restore')
  assert.equal(current.connection?.state, 'online', 'an older omission cannot replace the confirmed restore with offline metadata')
})
