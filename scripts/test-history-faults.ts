/** Execute the full journey first, then restore each historical defect only
 * inside its esbuild test bundle. Count only the intended behavior assertion. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const file = 'tests/history-reading-journey.test.ts'
const journey = 'continuous history survives older-page commits and a down/up round trip'
const faults = [
  { name: 'short-client-page', test: journey,
    assertion: 'each interactive history request uses HAPI’s normal 50-row page budget' },
  { name: 'replace-on-prepend', test: journey,
    assertion: 'one bounded page reaches the official Conversation as one prepend' },
  { name: 'evict-resident-history', test: journey,
    assertion: 'a committed page never evicts previously loaded source rows' },
] as const
const env = { ...process.env }
delete env.HAPI_DSH_HISTORY_FAULT
function run(fault?: typeof faults[number], selectJourney = fault !== undefined) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap',
    ...(selectJourney ? ['--test-name-pattern', `^${journey}$`] : []), file], {
    cwd: root, env: { ...env, ...(fault ? { HAPI_DSH_HISTORY_FAULT: fault.name } : {}) },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  })
}
const baseline = run(undefined, true), baselineOutput = `${baseline.stdout}\n${baseline.stderr}`
assert.ok(!baseline.error && baseline.status === 0 && /# tests 1\b/.test(baselineOutput) && /# fail 0\b/.test(baselineOutput),
  `History journey baseline failed; no injected faults counted.\n${baselineOutput}\n${baseline.error?.message ?? ''}`)
console.log('History journey baseline: continuous paging and return-to-tail passed.')
for (const fault of faults) {
  const started = performance.now(), result = run(fault), output = `${result.stdout}\n${result.stderr}`
  assert.ok(!result.error && result.status === 1 && /# tests 1\b/.test(output) && /# fail 1\b/.test(output)
    && output.includes(`not ok 1 - ${fault.test}`) && output.includes(fault.assertion)
    && /ERR_ASSERTION/.test(output) && !/timed out|ERR_TEST_TIMEOUT|Cannot find|Failed to (?:load|resolve)|SyntaxError/.test(output),
    `${fault.name}: failure must be its one expected behavior assertion, not loading, timeout or an unselected test.\n${output}\n${result.error?.message ?? ''}`)
  console.log(`Detected ${fault.name}: ${fault.assertion} (${Math.round(performance.now() - started)} ms).`)
}
console.log(`All ${faults.length} historical defects were detected. Production files were not modified.`)
