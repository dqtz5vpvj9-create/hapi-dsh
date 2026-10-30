/** Baseline must pass; each deliberate fault must fail its named DOM assertion.
 * A loader error, timeout, or missing test is NOT a detected regression. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { faults } from '../tests/experience/faults.ts'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const directory = await mkdtemp(join(existsSync('/mnt/cache/data-cache') ? '/mnt/cache/data-cache' : tmpdir(), 'hapi-dsh-faults-'))
const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: directory }
delete env.HAPI_DSH_TEST_FAULT
const vitest = 'node_modules/vitest/vitest.mjs'
// Fault mutations must transform fresh modules; Vitest's persistent cache can reuse the baseline transform.
const run = (args: string[], fault?: string) => spawnSync(process.execPath, [vitest, 'run', ...args, '--no-fsModuleCache'], {
  env: { ...env, ...(fault ? { HAPI_DSH_TEST_FAULT: fault } : {}) }, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
})
try {
  const baseline = run([])
  if (baseline.error || baseline.status !== 0) throw new Error(`Baseline failed; no faults counted.\n${baseline.stdout}\n${baseline.stderr}`)
  console.log('Baseline: all experience tests passed.')
  for (const [name, fault] of Object.entries(faults)) {
    const reportPath = join(directory, `${name}.json`), started = performance.now()
    const result = run([fault.testFile, '-t', fault.testName, '--reporter=json', `--outputFile=${reportPath}`], name)
    if (result.error || result.status !== 1) throw new Error(`${name}: expected an assertion failure, got ${result.error?.message ?? result.status}`)
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      numFailedTests: number; testResults: Array<{ assertionResults: Array<{ title: string; status: string; failureMessages: string[] }> }>
    }
    const failed = report.testResults.flatMap(value => value.assertionResults).filter(value => value.status === 'failed')
    if (report.numFailedTests !== 1 || failed.length !== 1 || failed[0]?.title !== fault.testName
      || !failed[0].failureMessages.some(message => /AssertionError|expected .*|expect\(/s.test(message))
      || failed[0].failureMessages.some(message => /timed out|Cannot find|Failed to (load|resolve)/i.test(message))) {
      throw new Error(`${name}: failure did not match the intended behavior assertion.\n${result.stdout}\n${result.stderr}`)
    }
    console.log(`Detected ${name}: ${fault.testName} (${Math.round(performance.now() - started)} ms)`)
  }
  console.log('All 3 injected regressions detected. Source files were not modified.')
} finally {
  await rm(directory, { recursive: true, force: true })
}
