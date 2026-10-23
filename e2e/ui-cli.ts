/** One isolated Host/browser lifetime for CI; local iteration uses the warm daemon. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const directory = process.env.HAPI_DSH_TEST_ROOT ?? '/mnt/cache/data-cache'
await mkdir(directory, { recursive: true })
process.env.TMPDIR = directory
const { WarmOfficialSession } = await import('./warm-session.ts')
const { runUiAcceptance } = await import('./ui-acceptance.ts')
const session = new WarmOfficialSession()
try {
  await session.start()
  const report = await runUiAcceptance(session, process.argv.includes('--perf') ? 5 : 1)
  const path = join(directory, `hapi-ui-acceptance-${Date.now()}.json`)
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 })
  process.stdout.write(JSON.stringify({ passed: report.passed, checks: report.checks.length,
    failures: report.checks.filter(row => !row.passed), durationMs: report.durationMs, reportPath: path }, null, 2) + '\n')
  if (!report.passed) process.exitCode = 1
} finally { await session.close() }
