import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectChangedFiles, discoverTests, selectTests } from './test-impact.mjs'

export const fastTests = [
  'tests/history-reading-journey.test.ts',
  'tests/hapi-dsh-children.test.ts',
  'tests/client-source-live-window.test.ts',
  'tests/client-source-window-races.test.ts',
  'tests/client-queued-edit.test.ts',
  'tests/client-composer-autosave.test.ts',
  'tests/client-display-leases.test.ts',
  'tests/client-display-leases-cancellation.test.ts',
  'tests/source-history-window.test.ts',
  'tests/client-history-window-progress.test.ts',
  'tests/client-draft-ownership.test.ts',
]

export function parseOptions(args) {
  const options = { mode: 'fast', list: false, timeoutMs: undefined, files: undefined, since: undefined, report: undefined }
  if (args[0] && !args[0].startsWith('--')) options.mode = args.shift()
  if (!['fast', 'full', 'changed'].includes(options.mode)) throw new Error('Mode must be fast, full or changed')
  for (let index = 0; index < args.length; index++) {
    const option = args[index]
    if (option === '--list') options.list = true
    else if (option === '--files') {
      options.files = []
      while (args[index + 1] && !args[index + 1].startsWith('--')) options.files.push(args[++index])
      if (!options.files.length) throw new Error('--files requires at least one repository-relative path')
    } else if (['--since', '--report', '--timeout'].includes(option)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
      if (option === '--timeout') {
        const seconds = Number(value)
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be positive seconds per phase')
        options.timeoutMs = seconds * 1000
      } else options[option.slice(2)] = value
    } else throw new Error(`Unknown option: ${option}`)
  }
  if (options.files && options.since) throw new Error('--files and --since cannot be combined')
  if (options.mode !== 'changed' && (options.files || options.since)) throw new Error('--files and --since require changed mode')
  return options
}

export async function runStage(name, args, { root, files = [], timeoutMs, stdio = 'inherit' }) {
  const started = performance.now()
  const temporary = existsSync('/mnt/cache/data-cache') ? '/mnt/cache/data-cache' : tmpdir()
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: root, stdio, detached: process.platform !== 'win32',
      env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    })
    let timedOut = false
    let interrupted
    let spawnError
    const terminate = () => {
      if (!child.pid) return
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL') }
      }
    }
    const interrupt = () => { interrupted = 'SIGINT'; terminate() }
    const stop = () => { interrupted = 'SIGTERM'; terminate() }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', stop)
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    child.once('error', error => { spawnError = error.message })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', stop)
      resolve({ name, files, durationMs: Math.round(performance.now() - started),
        exitCode: timedOut ? 124 : interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : code ?? 1,
        signal, timedOut, ...(interrupted ? { interrupted } : {}), ...(spawnError ? { error: spawnError } : {}) })
    })
  })
}

// Compact Node reporter: retain actionable failures and the actual test totals.
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type === 'test:stdout' || event.type === 'test:stderr') yield event.data.message
    if (event.type === 'test:fail') yield `FAIL ${event.data.name}\n${inspect(event.data.details.error, { colors: false, depth: 5 })}\n`
    if (event.type === 'test:diagnostic' && !/^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d/.test(event.data.message)) {
      yield `Diagnostic: ${event.data.message}\n`
    }
    if (event.type === 'test:summary' && !event.data.file) {
      const counts = event.data.counts
      yield `Node tests: ${counts.passed} passed, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.skipped} skipped\n`
    }
  }
}

export async function main(args = process.argv.slice(2), root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/test-suite.mjs fast|full|changed [--since REF | --files PATH...] [--list] [--timeout SECONDS] [--report PATH]')
    return 0
  }
  const options = parseOptions([...args])
  const started = performance.now()
  const inventory = discoverTests(root)
  let plan
  if (options.mode === 'changed') plan = selectTests(root, collectChangedFiles(root, options))
  else if (options.mode === 'full') plan = { selection: 'full', reason: 'All Node and experience tests.', ...inventory, warnings: [] }
  else {
    const missing = fastTests.filter(file => !inventory.node.includes(file))
    if (missing.length) throw new Error(`Fast suite contains missing files: ${missing.join(', ')}`)
    plan = { selection: 'fast', reason: 'Continuous reading and core behavior contracts plus all component experience tests.', node: fastTests, experience: inventory.experience, warnings: [] }
  }
  const report = { mode: options.mode, startedAt: new Date().toISOString(), plan, phases: [], status: 'not-run' }
  console.log(`[tests:${options.mode}] ${plan.node.length} Node files, ${plan.experience.length} experience files. ${plan.reason}`)
  for (const warning of plan.warnings) console.log(`Note: ${warning}`)
  let exitCode = 0
  if (options.list) {
    for (const file of [...plan.node, ...plan.experience]) console.log(file)
    report.status = 'listed'
  } else if (!plan.node.length && !plan.experience.length) report.status = 'no-tests'
  else {
    const phases = [
      { name: 'node', files: plan.node, args: ['--import', 'tsx', '--test', '--test-isolation=none',
        `--test-reporter=${pathToFileURL(path.join(root, 'scripts/test-suite.mjs')).href}`, ...plan.node] },
      { name: 'experience', files: plan.experience, args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', ...plan.experience] },
    ]
    for (const phase of phases) {
      if (!phase.files.length) continue
      console.log(`[${phase.name}] running ${phase.files.length} files`)
      const outcome = await runStage(phase.name, phase.args, { root, files: phase.files,
        timeoutMs: options.timeoutMs ?? (options.mode === 'full' || plan.selection === 'full' ? 300_000 : 120_000) })
      report.phases.push(outcome)
      console.log(`[${phase.name}] ${(outcome.durationMs / 1000).toFixed(2)}s, exit ${outcome.exitCode}${outcome.timedOut ? ' (timeout; not retried)' : ''}`)
      if (outcome.exitCode !== 0) { exitCode = outcome.exitCode; break }
    }
    report.status = exitCode ? 'failed' : 'passed'
  }
  report.durationMs = Math.round(performance.now() - started)
  report.finishedAt = new Date().toISOString()
  if (options.report) {
    const destination = path.resolve(root, options.report)
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Report: ${destination}`)
  }
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
