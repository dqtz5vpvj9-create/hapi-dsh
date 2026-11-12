/** Closed temporary threads disappear only after exact native + persistence proof. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts'
import { CodexRpcError, type CodexRpc, type NativeNotification } from '../src/remote/codex-rpc.ts'
import { CreationLedger, OperationLedger } from '../src/remote/operation-ledger.ts'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'

const createdAt = 1794351600
const clockHex = (createdAt * 1000).toString(16).padStart(12, '0')
const threadId = (n: number) => `${clockHex.slice(0, 8)}-${clockHex.slice(8)}-7000-8000-${n.toString(16).padStart(12, '0')}`
async function fixture(t: TestContext) {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-catalog-lifecycle-'), directory = join(home, 'adapter')
    const db = new DatabaseSync(join(home, 'state_5.sqlite')); db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)')
    let notify: (value: NativeNotification) => void = () => {}, clock = Date.now()
    const failures = new Set<string>(), loaded = new Set<string>(), calls: string[] = []
    const rpc = { online: true, currentGeneration: 1,
        connect: async () => ({ codexHome: home, userAgent: 'fixture', platformFamily: 'unix', platformOs: 'linux' }),
        onNotification(listener: typeof notify) { notify = listener; return () => {} }, onRequest: () => () => {}, onDisconnect: () => () => {}, dispose: async () => {},
        async request(method: string, params: Record<string, unknown>, options?: { write?: boolean }) {
            assert.ok(!options?.write, 'catalog cleanup never executes native writes'); calls.push(method)
            if (method === 'thread/list') return { data: [], nextCursor: null }
            if (method === 'thread/loaded/list') return { data: [...loaded], nextCursor: null }
            if (method === 'thread/read') throw new CodexRpcError(-32600, failures.has(String(params.threadId)) ? 'read unavailable' : `thread not loaded: ${params.threadId}`)
            throw new Error(`Unexpected RPC ${method}`)
        },
    } as unknown as CodexRpc
    const adapter = new DirectCodexAdapter({ id: 'native', machineId: 'machine', engine: 'codex' }, directory, { rpc, pollMs: 60_000, now: () => clock })
    t.after(async () => { await adapter.dispose(); db.close(); await rm(home, { recursive: true, force: true }) })
    const start = (n: number, extra = {}) => {
        const id = threadId(n)
        // Desktop's original shape need not have path or turns fields.
        notify({ method: 'thread/started', params: { threadId: id, thread: { id, cwd: home, createdAt, updatedAt: createdAt, preview: '', status: { type: 'idle' }, ...extra } } })
        notify({ method: 'thread/closed', params: { threadId: id } })
        return id
    }
    return { home, directory, db, failures, start, calls, async catalog() { clock += 60_000; return adapter.list() } }
}

test('five expired desktop shapes retire, persisted empty/history/HHPI-created and uncertain writes remain', async t => {
    const f = await fixture(t), expired = [1, 2, 3, 4, 5].map(n => f.start(n))
    const persisted = f.start(6), rollout = f.start(7), created = f.start(8), pending = f.start(9), failed = f.start(10)
    f.db.prepare('INSERT INTO threads VALUES (?)').run(persisted)
    const day = join(f.home, 'sessions', '2026', '11', '11'); await mkdir(day, { recursive: true })
    await writeFile(join(day, `rollout-${rollout}.jsonl`), 'history need not be replayed')
    f.failures.add(failed)
    const identity = { machineId: 'machine', sourceId: 'native', engine: 'codex', nativeId: created }, id = sourceSessionId(identity)
    const creations = new CreationLedger(join(f.directory, 'creations'), JSON.stringify(['machine', 'native', 'codex']))
    await creations.run({ sourceId: 'native', operationId: 'owned-create' }, async () => ({ status: 'accepted', message: 'created', operationId: 'owned-create', sourceId: 'native', session: { ...identity, id } as SourceSession }))
    const pendingId = sourceSessionId({ ...identity, nativeId: pending })
    await new OperationLedger(join(f.directory, 'operations')).run({ sessionId: pendingId, operationId: 'pending', kind: 'send', text: 'retained' }, async () => ({ status: 'accepted', message: 'queued', sessionId: pendingId, operationId: 'pending' }))
    const rows = await f.catalog(), ids = rows.map(row => row.nativeId)
    for (const id of expired) assert.ok(!ids.includes(id), id)
    for (const id of [persisted, rollout, created, pending, failed]) assert.ok(ids.includes(id), id)
    const reads = f.calls.filter(method => method === 'thread/read').length
    await f.catalog()
    assert.equal(f.calls.filter(method => method === 'thread/read').length - reads, 5, 'retired rows do not cause repeated native lifecycle reads')
})

test('unknown native persistence or an uncertain creation keeps every original row', async t => {
    const f = await fixture(t), id = f.start(1)
    const creations = new CreationLedger(join(f.directory, 'creations'), JSON.stringify(['machine', 'native', 'codex']))
    await creations.run({ sourceId: 'native', operationId: 'unknown-create' }, async () => ({ status: 'indeterminate', message: 'uncertain', operationId: 'unknown-create', sourceId: 'native' }))
    assert.ok((await f.catalog()).some(row => row.nativeId === id))
})
