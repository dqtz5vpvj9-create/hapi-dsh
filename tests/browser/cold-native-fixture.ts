/** Actual native SQLite and DirectCodexAdapter; only native RPC bodies are synthetic.
 * The projection starts empty. No SourceEventIndex is seeded by the browser lab. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DirectCodexAdapter } from '../../src/remote/codex-adapter.ts'
import type { CodexRpc } from '../../src/remote/codex-rpc.ts'
import { sourceSessionId } from '../../src/remote/protocol.ts'

export async function coldNativeFixture() {
  const home = await mkdtemp('/mnt/cache/data-cache/hhpi-browser-native-')
  const nativeId = 'synthetic-only', turns = 2048
  const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'))
  db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER,rollout_end_ordinal INTEGER,error_json TEXT);
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,updated_at_ordinal INTEGER,item_type TEXT);
    CREATE INDEX item_order ON thread_items(thread_id,rollout_ordinal); CREATE INDEX turn_order ON thread_turns(thread_id,rollout_end_ordinal); BEGIN`)
  for (let i = 0; i < turns; i++) {
    const start = i * 4 + 1
    db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?)').run(nativeId, `turn-${i}`, 'completed', i + 1, i + 2, start, start + 3, null)
    for (let item = 0; item < 2; item++) db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)')
      .run(nativeId, `turn-${i}`, `item-${item}`, start + item + 1, 1000, 1000, 2000, start + item + 1, item === 0 ? 'userMessage' : 'agentMessage')
  }
  db.exec('COMMIT')
  const calls: Array<{ method: string; turnId?: string; limit?: number }> = []
  let loaded = false, clock = Date.now()
  const thread = { id: nativeId, cwd: home, name: 'Cold source-native browser conversation', createdAt: 1, updatedAt: 2, status: { type: 'idle' } }
  const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: home }), dispose: async () => {},
    onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}), ...(typeof params.limit === 'number' ? { limit: params.limit } : {}) })
      if (method === 'thread/read') return { thread }
      if (method === 'thread/loaded/list') return { data: loaded ? [nativeId] : [], nextCursor: null }
      if (method === 'thread/list') return { data: [thread], nextCursor: null }
      if (method !== 'thread/items/list') throw new Error(`Cold first paint must not dispatch ${method}`)
      const cursor = params.cursor as { itemId: string } | undefined
      const first = cursor ? Number(cursor.itemId.slice(5)) + 1 : 0
      return { data: Array.from({ length: Math.min(Number(params.limit), 2 - first) }, (_, offset) => {
        const index = first + offset, number = Number(String(params.turnId).slice(5)) * 2 + index
        return { turnId: params.turnId, item: index === 0 ? { id: `item-${index}`, type: 'userMessage', content: [{ type: 'text', text: `native-body-${number} source-native question ${number}` }] }
          : { id: `item-${index}`, type: 'agentMessage', text: `native-body-${number} source-native answer ${number}\n\n${'Readable source-native content. '.repeat(12)}` } }
      }), nextCursor: null }
    },
  } as unknown as CodexRpc
  const adapter = new DirectCodexAdapter({ id: 'native-fixture', machineId: 'browser-fixture', engine: 'codex', ownership: 'shared' }, join(home, 'projection'), { rpc, pollMs: 60_000, now: () => clock })
  const sessionId = sourceSessionId({ machineId: 'browser-fixture', sourceId: 'native-fixture', engine: 'codex', nativeId })
  let session = await adapter.resolve(sessionId)
  return { adapter, get session() { return session },
    async writable(value = true) { loaded = value; clock += 60_001; session = (await adapter.list()).find(value => value.id === sessionId)! },
    stats: () => ({ nativeCalls: calls, nativeTurns: turns, nativeItems: turns * 2, seededDisplayEvents: 0,
      bodyReads: calls.filter(call => call.method === 'thread/items/list').length, writes: [] }),
    async dispose() { await adapter.dispose(); db.close(); await rm(home, { recursive: true, force: true }) } }
}
