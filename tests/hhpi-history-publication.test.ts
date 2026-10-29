import assert from 'node:assert/strict'
import test from 'node:test'
import type { HistorySnapshotV1 } from '@deepseek-ai/dsh-api-session-controller/client'
import { HistoryPublication } from '../src/client/history-publication.ts'
const snapshot = (version: string): HistorySnapshotV1 => ({ version, entries: [], before: null, after: null, hasBefore: false, hasAfter: false })

test('prepared history does not become published until the official reader accepts it', () => {
  const accepted: string[] = [], discarded: string[] = []
  const publication = new HistoryPublication<null>(() => {}, record => { accepted.push(record.snapshot.version) }, record => { discarded.push(record.snapshot.version) })
  const a = snapshot('a'), b = snapshot('b')
  publication.stage(a, null, 10); publication.accept('a')
  publication.stage(b, null, 10)
  assert.equal(publication.published?.snapshot, a)
  publication.discard('b')
  assert.equal(publication.published?.snapshot, a)
  assert.deepEqual(accepted, ['a']); assert.deepEqual(discarded, ['b'])
  publication.discard('b'); publication.discard('a')
  assert.deepEqual(discarded, ['b'])
})

test('publication rejects superseded source generations and old candidates before side effects', () => {
  let generation = 1
  const accepted: string[] = []
  const publication = new HistoryPublication<number>(record => {
    if (record.metadata !== generation) throw Object.assign(new Error('Source changed'), { code: 'STALE_VERSION' })
  }, record => { accepted.push(record.snapshot.version) }, () => {})
  publication.stage(snapshot('old'), 1, 10); generation = 2
  assert.throws(() => publication.accept('old'), { code: 'STALE_VERSION' })
  assert.deepEqual(accepted, [])
  publication.stage(snapshot('new'), 2, 10); publication.accept('new'); publication.accept('new')
  assert.deepEqual(accepted, ['new'])
  assert.throws(() => publication.accept('old'), { code: 'STALE_VERSION' })
})

test('proposal pressure cannot release the displayed window', () => {
  const publication = new HistoryPublication<null>(() => {}, () => {}, () => {}, { snapshots: 3, bytes: 30 })
  const displayed = snapshot('displayed'); publication.stage(displayed, null, 10); publication.accept('displayed')
  for (let index = 0; index < 8; index++) publication.stage(snapshot(`candidate-${index}`), null, 10)
  assert.equal(publication.published?.snapshot, displayed)
  assert.equal(publication.windows().length, 3)
  publication.validate('displayed')
  assert.throws(() => publication.validate('candidate-0'), { code: 'STALE_VERSION' })
  publication.accept('candidate-7')
  assert.equal(publication.published?.snapshot.version, 'candidate-7')
  publication.dispose()
  assert.throws(() => publication.validate('candidate-7'), { code: 'DISPOSED' })
})
