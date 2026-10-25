import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
interface Sample { mode: string; snapshots: number; growthBytes: number; handled: number }
test('real source services retain bounded history and latest queued prefix instead of every cumulative snapshot', { timeout: 60_000 }, t => {
  const samples: Sample[] = []
  for (const snapshots of [512, 1024]) for (const mode of ['chain-control', 'native', 'observed']) {
    const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx',
      fileURLToPath(new URL('./fixtures/source-event-queue-memory.ts', import.meta.url)), mode, String(snapshots)], { encoding: 'utf8', timeout: 15_000 })
    assert.equal(result.status, 0, `${mode}: ${result.error?.message ?? result.stderr}`)
    samples.push(JSON.parse(result.stdout) as Sample)
  }
  t.diagnostic(JSON.stringify(samples))
  const controls = samples.filter(sample => sample.mode === 'chain-control')
  assert.ok(controls[1]!.growthBytes > 128 * 1024 * 1024)
  assert.ok(controls[1]!.growthBytes > controls[0]!.growthBytes * 2.5)
  for (const sample of samples.filter(sample => sample.mode !== 'chain-control')) {
    assert.ok(sample.growthBytes < 20 * 1024 * 1024, `${sample.mode} retained ${sample.growthBytes} bytes`)
    assert.equal(sample.handled, 2)
  }
})
