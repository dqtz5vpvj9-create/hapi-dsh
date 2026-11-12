import { spawn } from 'node:child_process'
import { basename, resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { startSpan, finishSpan } from './profile.mjs'
import { executionDecision } from './execution.mjs'
import { transaction, decode } from './store.mjs'

// Join in an ordinary process; waiting does not require another model turn.
async function joinCheck(store, id, timeoutMs) {
  const started = performance.now()
  while (true) {
    const row = store.db.prepare('SELECT status,data FROM spans WHERE id=?').get(id)
    if (!row) throw new Error('The shared check record is missing')
    const data = decode(row.data)
    if (row.status !== 'running') return { exitCode: data.exitCode ?? (row.status === 'passed' ? 0 : 1), executed: false,
      joined: id, reused: row.status === 'passed' ? id : undefined, durationMs: performance.now() - started }
    if (data.ownerPid) {
      try { process.kill(data.ownerPid, 0) } catch (error) {
        if (error.code !== 'ESRCH') throw error
        transaction(store, () => {
          if (store.db.prepare('SELECT status FROM spans WHERE id=?').get(id)?.status === 'running')
            finishSpan(store, id, { status: 'cancelled', data: { exitCode: 1, ownerExited: true } })
        })
        continue
      }
    }
    if (performance.now() - started >= timeoutMs) return { exitCode: 124, executed: false, joined: id, timedOut: true, durationMs: performance.now() - started }
    await delay(Math.min(200, timeoutMs - (performance.now() - started)))
  }
}

/** Execute argv directly. Arguments, environment and stdout are never persisted in the profile. */
export async function runCommand(store, { run, node, parent, agent = process.env.HHPI_PROFILE_AGENT || 'unattributed', kind = 'command', label,
  command, cwd = process.cwd(), env = {}, timeoutMs = 120_000, stdio = 'inherit', check, inputs, reason }) {
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string')) throw new Error('Command must be a nonempty argv array')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Command needs a positive timeout')
  // The actor persists across profiles; node and parent IDs belong to one run
  // in one database. A nested fixture/new run must not borrow the outer DAG.
  const inheritedScope = process.env.HHPI_PROFILE_RUN === run && process.env.HHPI_PROFILE_DB
    && resolvePath(process.env.HHPI_PROFILE_DB) === resolvePath(store.location)
  if (node === undefined) node = inheritedScope ? process.env.HHPI_PROFILE_NODE || null : null
  if (parent === undefined) parent = inheritedScope ? process.env.HHPI_PROFILE_PARENT || null : null
  // Store a digest, never argv or environment values. A different command,
  // working directory or effective environment cannot borrow an earlier pass.
  const environment = Object.entries({ ...process.env, ...env }).filter(([key]) => !key.startsWith('HHPI_PROFILE_')).sort(([a], [b]) => a.localeCompare(b))
  const identity = createHash('sha256').update(JSON.stringify({ command, cwd: resolvePath(cwd), environment,
    node: process.version, platform: process.platform, arch: process.arch })).digest('hex')
  const decision = transaction(store, () => {
    const decision = executionDecision(store, { run, kind, check, inputs, reason, identity })
    if (decision.reused || decision.joined) return decision
    return { id: startSpan(store, { run, node, agent, parent,
      kind, label: label || basename(command[0]), data: { executable: basename(command[0]), check, inputs, reason, identity, ownerPid: process.pid } }) }
  })
  if (decision.reused) return { exitCode: 0, executed: false, reused: decision.reused, durationMs: 0 }
  if (decision.joined) return joinCheck(store, decision.joined, timeoutMs)
  const id = decision.id
  const started = performance.now()
  return await new Promise(resolve => {
    let timedOut = false, interrupted = null, spawnError = null, killer
    const child = spawn(command[0], command.slice(1), { cwd, stdio, detached: process.platform !== 'win32',
      env: { ...process.env, ...env, HHPI_PROFILE_DB: store.location, HHPI_PROFILE_RUN: run,
        HHPI_PROFILE_NODE: node || '', HHPI_PROFILE_AGENT: agent, HHPI_PROFILE_PARENT: id } })
    const kill = signal => {
      if (!child.pid) return
      try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal) }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const stop = () => { kill('SIGTERM'); killer ||= setTimeout(() => kill('SIGKILL'), 1000) }
    const interrupt = () => { interrupted = 'SIGINT'; stop() }
    const terminate = () => { interrupted = 'SIGTERM'; stop() }
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    child.once('error', error => { spawnError = error.code || 'spawn-error' })
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killer)
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate)
      const exitCode = timedOut ? 124 : interrupted === 'SIGINT' ? 130 : interrupted ? 143 : code ?? 1
      const status = timedOut ? 'timed-out' : interrupted ? 'cancelled' : exitCode === 0 ? 'passed' : 'failed'
      const result = { exitCode, signal, timedOut, interrupted, spawnError, durationMs: performance.now() - started }
      finishSpan(store, id, { status, data: result })
      resolve({ ...result, executed: true, span: id })
    })
  })
}
