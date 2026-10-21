/** Pinned HAPI event protocol fixtures; no model or remote owner is simulated as real execution. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HapiMessage } from '../src/codex/contracts.ts'
import { NativeObservations, parseNativeObservation } from '../src/codex/observations.ts'
import type { NativeBinding } from '../src/codex/native.ts'

const binding: NativeBinding = { hubId: 'fixture-hub', hapiSessionId: 'fixture-source', threadId: 'fixture-thread', home: null, homeId: null, machineId: null }
function row(id: string, data: Record<string, unknown>, createdAt = 1000): HapiMessage {
  return { id: `hub:${id}`, localId: id, seq: 1, createdAt,
    content: { role: 'agent', content: { type: 'codex', data: { id, ...data } } } }
}

test('source observation parsing excludes child and unrelated-thread usage and refuses malformed token counts', () => {
  const data = { type: 'token_count', thread_id: binding.threadId, info: { last: { inputTokens: 42, outputTokens: 7, cachedInputTokens: 30 } } }
  assert.equal(parseNativeObservation(row('valid', data), binding)?.kind, 'usage')
  assert.equal(parseNativeObservation(row('child', { ...data, scope: { role: 'child' } }), binding), undefined)
  assert.equal(parseNativeObservation(row('foreign', { ...data, thread_id: 'another-thread' }), binding), undefined)
  assert.equal(parseNativeObservation(row('negative', { ...data, info: { last: { inputTokens: -5, outputTokens: 7 } } }), binding), undefined)
  assert.equal(parseNativeObservation(row('fractional', { ...data, info: { last: { inputTokens: 42.1, outputTokens: 7 } } }), binding), undefined)
  const compact = parseNativeObservation(row('compact', { type: 'context_compacted', thread_id: binding.threadId }), binding)
  assert.ok(compact?.kind === 'notice')
  assert.equal(compact.value.kind, 'context-compacted')
  assert.equal(compact.value.turnId, null)
})

test('native observation cache cannot regress current usage to a stale history counter and bounds retained source notices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-observation-cache-'))
  try {
    const cache = new NativeObservations(directory, 'fixture-view', binding)
    const usage = (id: string, createdAt: number, inputTokens: number) => row(id, { type: 'token_count',
      thread_id: binding.threadId, info: { last_token_usage: { input_tokens: inputTokens, output_tokens: 9 } } }, createdAt)
    cache.observe([usage('latest', 2000, 20)])
    cache.observe([usage('older', 1000, 100)])
    assert.equal(cache.usage?.inputTokens, 20)
    cache.observe(Array.from({ length: NativeObservations.noticeLimit + 3 }, (_, i) => row(`error-${i}`, { type: 'error', message: `Native source error ${i}` }, i)))
    assert.equal(cache.notices.length, NativeObservations.noticeLimit)
    assert.equal(cache.notices[0]?.id, 'error-3')
    const restored = new NativeObservations(directory, 'fixture-view', binding)
    assert.equal(restored.usage?.inputTokens, 20)
    assert.equal(restored.notices.length, NativeObservations.noticeLimit)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
