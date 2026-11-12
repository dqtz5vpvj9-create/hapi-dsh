import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

const script = fileURLToPath(import.meta.url)
const defaults = ['tsconfig.host.json', 'tsconfig.client.json', 'tsconfig.experience.json']
const queries = ['readFile', 'fileExists', 'directoryExists', 'getDirectories', 'readDirectory', 'realpath']
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => hash(JSON.stringify(value === undefined ? null : value))
const readJSON = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
const fileHash = file => { try { return hash(readFileSync(file)) } catch { return null } }

function atomicJSON(file, value) {
  const temporary = `/mnt/cache/data-cache/hhpi-typecheck-${randomUUID()}.json`
  mkdirSync(dirname(temporary), { recursive: true })
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file) }
  finally { rmSync(temporary, { force: true }) }
}

function identity(root, compiler, compilerPackage) {
  // These are the process settings read by Node/TypeScript, rather than volatile
  // npm/profile invocation IDs. No environment values are persisted.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(NODE_OPTIONS|NODE_PATH|NODE_ENV|TZ|LANG|LC_.*|TSC_.*)$/.test(key)).sort(([a], [b]) => a.localeCompare(b)))
  const flags = []
  for (let index = 0; index < process.execArgv.length; index++) {
    const flag = process.execArgv[index]
    if (['-e', '--eval', '-p', '--print'].includes(flag)) { index++; continue }
    if (/^--(?:input-type|eval|print|test)(?:=|-|$)/.test(flag)) continue
    flags.push(flag)
  }
  return digest({ root, compiler, compilerHash: fileHash(compiler), compilerPackage: fileHash(compilerPackage), script: fileHash(script),
    node: realpathSync(process.execPath), nodeHash: fileHash(process.execPath), versions: process.versions,
    platform: process.platform, arch: process.arch, flags, environment,
    package: fileHash(join(root, 'package.json')), lock: fileHash(join(root, 'package-lock.json')) })
}

function buildInfoValid(file, record) {
  if (!record?.buildInfoHash || fileHash(file) !== record.buildInfoHash) return false
  const value = readJSON(file)
  return !!value && typeof value.version === 'string' && Array.isArray(value.fileNames) && Array.isArray(value.fileInfos)
}

function validRecord(record, project, buildInfo) {
  return !!record && record.project === project && record.buildInfo === buildInfo &&
    typeof record.output === 'string' && [0, 1].includes(record.exitCode) &&
    ['passed', 'failed', 'stale'].includes(record.status) && Array.isArray(record.probes)
}

function tracker(ts, root, cache) {
  const observations = new Map()
  let changed = false
  const system = { ...ts.sys, getCurrentDirectory: () => root }
  for (const method of queries) {
    if (!ts.sys[method]) continue
    system[method] = (...args) => {
      const value = ts.sys[method](...args)
      // Compiler state is an output, never a source input.
      const path = resolve(root, args[0])
      if (path === cache || path.startsWith(cache + '/')) return value
      const key = JSON.stringify([method, args])
      const fingerprint = digest(value)
      if (observations.has(key) && observations.get(key).fingerprint !== fingerprint) changed = true
      // System query arguments use undefined, never null; JSON must preserve
      // omitted readDirectory depth/extension arguments when replayed.
      observations.set(key, { method, args: args.map(argument => argument ?? null), fingerprint })
      return value
    }
  }
  return { system, observations, get changed() { return changed } }
}

function matches(ts, probes) {
  if (!Array.isArray(probes) || !probes.length) return false
  try { return probes.every(probe => queries.includes(probe.method) && Array.isArray(probe.args) &&
    typeof probe.args[0] === 'string' && typeof probe.fingerprint === 'string' &&
    digest(ts.sys[probe.method](...probe.args.map(argument => argument ?? undefined))) === probe.fingerprint) }
  catch { return false }
}

async function acquire(cache, token, onWait) {
  // SQLite releases this process lock even after SIGKILL; PID reuse and races
  // between multiple stale-lock removers cannot start competing compilers.
  const database = new DatabaseSync(join(cache, 'coordination.sqlite'))
  database.exec('PRAGMA busy_timeout=0')
  const ownerFile = join(cache, 'owner.json')
  const waitedFor = new Set()
  const deadline = Date.now() + 300_000
  for (;;) {
    try {
      database.exec('BEGIN IMMEDIATE')
      atomicJSON(ownerFile, { pid: process.pid, token })
      return { waitedFor, release: () => { database.exec('ROLLBACK'); database.close() } }
    } catch (error) {
      if (error.errcode !== 5) { database.close(); throw error }
    }
    const owner = readJSON(ownerFile)
    if (owner?.token) waitedFor.add(owner.token)
    if (onWait) await onWait()
    if (Date.now() >= deadline) { database.close(); throw new Error('Timed out waiting for the active typecheck') }
    await delay(40)
  }
}

function compile(ts, root, cache, project, buildInfo) {
  const tracked = tracker(ts, root, cache)
  const diagnostics = []
  const config = ts.getParsedCommandLineOfConfigFile(project, { incremental: true, noEmit: true, tsBuildInfoFile: buildInfo },
    { ...tracked.system, onUnRecoverableConfigFileDiagnostic: diagnostic => diagnostics.push(diagnostic) })
  const started = performance.now()
  let exitCode = 1
  if (config) {
    const host = ts.createIncrementalCompilerHost(config.options, tracked.system)
    // Only buildinfo is emitted. Never write product outputs during a check.
    host.writeFile = (file, text) => {
      if (resolve(file) !== buildInfo) throw new Error(`Unexpected typecheck output: ${file}`)
      const temporary = `/mnt/cache/data-cache/hhpi-typecheck-${randomUUID()}.tsbuildinfo`
      try { writeFileSync(temporary, text); renameSync(temporary, file) }
      finally { rmSync(temporary, { force: true }) }
    }
    exitCode = ts.performIncrementalCompilation({ host, system: tracked.system, rootNames: config.fileNames,
      options: config.options, projectReferences: config.projectReferences,
      configFileParsingDiagnostics: config.errors, reportDiagnostic: diagnostic => diagnostics.push(diagnostic) })
  }
  const output = ts.formatDiagnostics(diagnostics, { getCanonicalFileName: file => file,
    getCurrentDirectory: () => root, getNewLine: () => '\n' })
  return { exitCode: exitCode === 0 ? 0 : 1, output, probes: [...tracked.observations.values()],
    changed: tracked.changed, durationMs: performance.now() - started }
}

/** Actual installed compiler; successful checks and their exact filesystem observations are reusable. */
export async function runTypecheck({ root = process.cwd(), projects = defaults, cacheDirectory,
  onProject, onWait } = {}) {
  root = realpathSync(root)
  projects = projects.map(project => resolve(root, project))
  const cache = resolve(root, cacheDirectory || 'artifacts/development/typecheck')
  mkdirSync(cache, { recursive: true })
  const token = randomUUID()
  const started = performance.now()
  const lock = await acquire(cache, token, onWait)
  try {
    const require = createRequire(join(root, 'package.json'))
    const compiler = require.resolve('typescript')
    const compilerPackage = require.resolve('typescript/package.json')
    const inputIdentity = identity(root, compiler, compilerPackage)
    const ts = (await import(pathToFileURL(compiler).href)).default
    const last = readJSON(join(cache, 'attempt.json'))
    if (last && Array.isArray(last.projects) && lock.waitedFor.has(last.token) && last.identity === inputIdentity &&
      JSON.stringify(last.projects.map(project => project.project)) === JSON.stringify(projects) &&
      last.stable && last.projects.every(project => validRecord(project, project.project, project.buildInfo) && matches(ts, project.probes) &&
        (buildInfoValid(project.buildInfo, project) || project.exitCode !== 0 && !project.buildInfoHash))) {
      return { ...last, coalesced: true, executed: 0, durationMs: performance.now() - started }
    }
    const results = []
    for (const project of projects) {
      const key = hash(project).slice(0, 24)
      const stateFile = join(cache, `${key}.json`)
      const buildInfo = join(cache, `${key}.tsbuildinfo`)
      const candidate = readJSON(stateFile)
      const previous = validRecord(candidate, project, buildInfo) ? candidate : null
      const incremental = previous?.identity === inputIdentity && buildInfoValid(buildInfo, previous)
      if (!incremental) rmSync(buildInfo, { force: true })
      let result
      if (incremental && previous.status === 'passed' && previous.exitCode === 0 && matches(ts, previous.probes)) {
        result = { ...previous, reused: true, durationMs: 0 }
      } else {
        const checked = compile(ts, root, cache, project, buildInfo)
        result = { ...checked, project, buildInfo, buildInfoHash: fileHash(buildInfo),
          identity: inputIdentity, incremental, reused: false, status: checked.exitCode === 0 ? 'passed' : 'failed' }
      }
      results.push(result)
      if (onProject) await onProject(result)
    }
    // A project checked early can change while later projects are running.
    // Validate the complete batch before publishing any reusable success.
    const stable = identity(root, compiler, compilerPackage) === inputIdentity &&
      results.every(result => !result.changed && matches(ts, result.probes))
    for (const result of results) {
      if (!stable) result.status = 'stale'
      atomicJSON(join(cache, `${hash(result.project).slice(0, 24)}.json`), result)
    }
    const report = { token, identity: inputIdentity, stable, projects: results,
      exitCode: stable && results.every(result => result.exitCode === 0) ? 0 : 1,
      executed: results.filter(result => !result.reused).length, coalesced: false, durationMs: performance.now() - started }
    atomicJSON(join(cache, 'attempt.json'), report)
    return report
  } finally { lock.release() }
}

export async function main(args = process.argv.slice(2)) {
  const options = { projects: [] }
  let json = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') json = true
    else if (['--root', '--project', '--cache-dir'].includes(args[index]) && args[index + 1]) {
      const value = args[++index]
      if (args[index - 1] === '--project') options.projects.push(value)
      else options[args[index - 1] === '--root' ? 'root' : 'cacheDirectory'] = value
    } else throw new Error(`Unknown typecheck argument: ${args[index]}`)
  }
  if (!options.projects.length) options.projects = defaults
  const report = await runTypecheck(options)
  // JSON is intentionally a compact public report: probes stay in the local,
  // ignored cache rather than flooding logs with dependency paths.
  const summary = { exitCode: report.exitCode, stable: report.stable, executed: report.executed,
    coalesced: report.coalesced, durationMs: Math.round(report.durationMs),
    projects: report.projects.map(({ project, reused, incremental, exitCode, durationMs, output }) =>
      ({ project: relative(options.root || process.cwd(), project), reused, incremental, exitCode,
        durationMs: Math.round(durationMs), output })) }
  if (json) console.log(JSON.stringify(summary))
  else {
    for (const project of summary.projects) {
      console.log(`[typecheck] ${project.project}: ${report.coalesced ? 'coalesced' : project.reused ? 'reused' : project.incremental ? 'incremental' : 'checked'} (${project.durationMs}ms)`)
      if (project.output) process.stdout.write(project.output)
    }
    if (!report.stable) console.log('[typecheck] Inputs changed during checking; results are not reusable. Run again after edits settle.')
    console.log(`[typecheck] ${report.executed} compiler runs, ${summary.durationMs}ms total; ${report.exitCode === 0 ? 'passed' : 'failed'}`)
  }
  return report.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().then(code => { process.exitCode = code }, error => { console.error(`[typecheck] ${error.message}`); process.exitCode = 1 })
}
