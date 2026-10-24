import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { independentStreamDelta } from '../src/shared/stream-text.js'
import { streamProjector } from './fixtures/source-stream-projector.js'

test('independent stream deltas preserve every UTF-16 code unit', () => {
  const text = Array.from({ length: 65_536 }, (_, unit) => String.fromCharCode(unit)).join('')
  for (const offset of [0, 1, 13, 0xd800, 0xdc00, text.length]) assert.equal(independentStreamDelta(text, offset), text.slice(offset))
})

for (const kind of ['native', 'observed'] as const) for (const reasoning of [false, true]) {
  test(`${kind} ${reasoning ? 'reasoning' : 'text'} retains exact live and durable stream chunks, including the final tail`, () => {
    const frames: AssistantStreamFrame[] = [], fixture = streamProjector(kind, frame => frames.push(frame))
    const deltas = ['start\0\n' + '甲'.repeat(48) + '\ud83d', '\ude80' + '乙'.repeat(48) + '\ud800',
      '\n' + '丙'.repeat(48) + '\udc00', 'final\0\r\n' + '丁'.repeat(48) + '\ud83d\ude80']
    let cumulative = ''
    for (const [index, delta] of deltas.entries()) {
      cumulative += delta
      fixture.apply(cumulative, index === deltas.length - 1, reasoning)
    }
    const chunks = frames.flatMap(frame => frame.type === 'chunk' ? [frame.chunk] : [])
    assert.deepEqual(chunks.flatMap(chunk => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? [chunk.text] : []), deltas)
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end'), [{ type: 'block-end', index: 0,
      block: { type: reasoning ? 'reasoning' : 'text', text: cumulative } }])
    const messages = fixture.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    assert.equal(messages.length, 1)
    const message = messages[0]
    assert.ok(message)
    assert.deepEqual(message.data.message.content, [{ type: reasoning ? 'reasoning' : 'text', text: cumulative }])
    assert.deepEqual(message.data.stream.flatMap(record => record.type === 'chunk' ? [record.chunk] : []), chunks)
    assert.equal(frames.filter(frame => frame.type === 'end' && frame.outcome.kind === 'committed').length, 1)
  })
}

interface MemorySample { mode: string; snapshots: number; finalTextBytes: number; cumulativeTextBytes: number; liveGrowthBytes: number; committedGrowthBytes: number }
test('retained projector streams grow with final text rather than cumulative snapshot prefixes', { timeout: 30_000 }, t => {
  const samples: MemorySample[] = []
  for (const snapshots of [512, 1024]) for (const mode of ['sliced-control', 'native', 'observed']) {
    const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx',
      fileURLToPath(new URL('./fixtures/source-stream-memory.ts', import.meta.url)), mode, String(snapshots)], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, `${mode}: ${result.error?.message ?? result.stderr}`)
    samples.push(JSON.parse(result.stdout) as MemorySample)
  }
  t.diagnostic(JSON.stringify(samples))
  const controls = samples.filter(sample => sample.mode === 'sliced-control')
  assert.equal(controls.length, 2)
  assert.ok(controls[1]!.liveGrowthBytes > 32 * 1024 * 1024, 'negative control must reproduce retained cumulative snapshots')
  assert.ok(controls[1]!.liveGrowthBytes > 2.5 * controls[0]!.liveGrowthBytes, 'doubling the old sliced stream demonstrates superlinear retention')
  for (const sample of samples.filter(sample => sample.mode !== 'sliced-control')) {
    const budget = 2 * 1024 * 1024 + sample.finalTextBytes * 32
    assert.ok(sample.liveGrowthBytes < budget, `${sample.mode} live stream retained ${sample.liveGrowthBytes} bytes; budget ${budget}`)
    assert.ok(sample.committedGrowthBytes < budget, `${sample.mode} durable stream retained ${sample.committedGrowthBytes} bytes; budget ${budget}`)
  }
})
