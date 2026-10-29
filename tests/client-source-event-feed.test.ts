import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SourceFrame } from '../src/shared/source-frames.ts'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const contractEvents = join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')),
  'lib/types/client/contract/events.js')
let runtime: any

before(async () => {
  const built = await build({
    stdin: { contents: [
      `export { SourceEventFeed } from ${JSON.stringify(join(root, 'src/client/source-event-feed.ts'))}`,
      `export { SourceWindowStore } from ${JSON.stringify(join(root, 'src/client/source-window-store.ts'))}`,
    ].join('\n'), resolveDir: root, sourcefile: 'source-event-feed-entry.ts', loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': contractEvents },
    bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, logLevel: 'silent',
  })
  runtime = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`)
})

function frame(id: number, text = String(id)): SourceFrame {
  return { key: `message-${id}`, source: { messageId: `source-${id}`, at: id, seq: id }, turnKey: `turn-${id}`,
    event: { type: 'user/message', seq: id, time: id,
      data: { turn: 1, message: { id: `message-${id}`, role: 'user', content: [{ type: 'text', text }] } } } as unknown as SourceFrame['event'] }
}

test('source pages and live batches publish as one incremental event-window update each', () => {
  const store = new runtime.SourceWindowStore(), feed = new runtime.SourceEventFeed(), updates: SessionEventWindow[] = []
  feed.subscribe(() => updates.push(feed.getSnapshot()))
  const publish = (frames: SourceFrame[], hasMore: boolean) => {
    store.apply({ kind: 'merge', frames }); feed.update(store.entries, hasMore)
  }
  publish([frame(2), frame(3)], true)
  const resident = [...feed.getSnapshot().entries]
  updates.length = 0
  publish([frame(0), frame(1)], false)
  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.change.kind, 'prepend')
  assert.equal(updates[0]!.change.entries.length, 2)
  assert.deepEqual(updates[0]!.entries.slice(2), resident)
  assert.equal(updates[0]!.entries[2], resident[0])
  assert.equal(updates[0]!.hasMore, false)
  publish([frame(4), frame(5)], false)
  assert.equal(updates.length, 2, 'a multi-row live batch produces one commit, not one render per event')
  assert.equal(updates[1]!.change.kind, 'append')
  assert.equal(updates[1]!.change.entries.length, 2)
  const snapshot = feed.getSnapshot()
  store.apply({ kind: 'merge', frames: [] }); feed.update(store.entries, false)
  assert.equal(feed.getSnapshot(), snapshot, 'an unchanged source commit must not restart reading or rebuild Conversation')
  feed.update(store.entries, true)
  assert.equal(updates.length, 3)
  assert.deepEqual(feed.getSnapshot().change, { kind: 'prepend', entries: [] },
    'history availability changes without replacing the existing Conversation body')
  assert.equal(feed.getSnapshot().hasMore, true)
  assert.deepEqual(feed.getSnapshot().entries, store.entries)
  assert.equal(feed.getSnapshot().entries[0], store.entries[0], 'resident entry identities remain shared after metadata updates')
  feed.update(store.entries, true)
  assert.equal(updates.length, 3, 'repeated metadata must not manufacture another commit')
})

test('a revised body, removed prefix, and explicit history reset remain visible to Conversation', () => {
  const store = new runtime.SourceWindowStore(), feed = new runtime.SourceEventFeed(), updates: SessionEventWindow[] = []
  feed.subscribe(() => updates.push(feed.getSnapshot()))
  store.apply({ kind: 'replace', frames: [frame(1), frame(2), frame(3)] }); feed.replace(store.entries, false)
  store.apply({ kind: 'merge', frames: [frame(2, 'corrected')] }); feed.update(store.entries, false)
  assert.equal(updates.at(-1)!.change.kind, 'replace')
  assert.equal((updates.at(-1)!.entries[1]!.event.data as { message: { content: { text: string }[] } }).message.content[0]!.text, 'corrected')
  store.retain(store.entries.slice(1)); feed.update(store.entries, true)
  assert.equal(updates.at(-1)!.change.kind, 'replace')
  assert.equal(updates.at(-1)!.entries.length, 2)
  const beforeReset = feed.getSnapshot().revision
  feed.replace(store.entries, true)
  assert.equal(feed.getSnapshot().revision, beforeReset + 1, 'matching rows cannot conceal an authoritative reset')
  assert.equal(updates.length, 4)
})

test('interleaved historical rows publish as incremental additions and retain resident entries', () => {
  const store = new runtime.SourceWindowStore(), feed = new runtime.SourceEventFeed(), updates: SessionEventWindow[] = []
  feed.subscribe(() => updates.push(feed.getSnapshot()))
  const left = frame(10), right = frame(30)
  store.apply({ kind: 'replace', frames: [left, right] }); feed.replace(store.entries, true)
  const resident = [...feed.getSnapshot().entries]
  const inserted = frame(20)
  store.apply({ kind: 'merge', frames: [inserted] }); feed.update(store.entries, false)

  const change = updates.at(-1)!
  const messageId = (entry: SessionEventWindow['entries'][number]) =>
    (entry.event.data as { message?: { id?: string } }).message?.id
  assert.equal(change.change.kind, 'prepend')
  assert.deepEqual(change.change.entries.map(messageId), ['message-20'])
  assert.equal(change.entries.length, 3)
  assert.deepEqual(change.entries.map(messageId), ['message-10', 'message-20', 'message-30'],
    'the full event snapshot remains sequence ordered after an interleaved incremental commit')
  assert.equal(change.entries.find(entry => messageId(entry) === 'message-10'), resident[0])
  assert.equal(change.entries.find(entry => messageId(entry) === 'message-30'), resident[1])
  assert.equal(change.hasMore, false)
})

test('replacement tracing skips expensive window metrics unless the observer requests them', () => {
  const store = new runtime.SourceWindowStore(), feed = new runtime.SourceEventFeed()
  store.apply({ kind: 'replace', frames: [frame(1)] }); feed.replace(store.entries, true)
  store.apply({ kind: 'merge', frames: [frame(1, 'corrected')] })
  const original = JSON.stringify
  const global = globalThis as typeof globalThis & {
    __hapiDshSourceFeedTrace?: ((change: string, metrics?: unknown) => void) & { captureMetrics?: boolean }
  }
  const previousTrace = global.__hapiDshSourceFeedTrace
  let serializations = 0
  let traceCalls = 0, tracedMetrics: unknown = null
  global.__hapiDshSourceFeedTrace = (_change, metrics) => { traceCalls++; tracedMetrics = metrics }
  Reflect.set(JSON, 'stringify', function (this: typeof JSON, ...args: Parameters<typeof JSON.stringify>) {
    serializations++
    return original.apply(this, args)
  })
  try {
    feed.update(store.entries, true)
    assert.equal(feed.getSnapshot().change.kind, 'replace')
    assert.equal(traceCalls, 1, 'the observer still receives the change kind')
    assert.equal(tracedMetrics, undefined, 'the observer must opt in before metrics are built')
    assert.equal(serializations, 0, 'default trace callbacks must not serialize resident event payloads')
  } finally {
    Reflect.set(JSON, 'stringify', original)
    if (previousTrace) global.__hapiDshSourceFeedTrace = previousTrace
    else delete global.__hapiDshSourceFeedTrace
  }
})
