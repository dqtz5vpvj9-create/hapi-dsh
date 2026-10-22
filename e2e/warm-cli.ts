/** Persistent official-runtime development loop. Synthetic sources only. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WarmOfficialSession } from './warm-session.ts'
import { runWarmSmoke, type WarmReport } from './warm-smoke.ts'
import { requestWarm, warmDirectory, warmRepository, warmSocket, type WarmCommand } from './warm-control.ts'

const safe = (value: unknown) => String(value).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
const command = process.argv[2] ?? 'status'
const publicCommands = ['status', 'check', 'rebuild-client', 'restart', 'reload', 'stop'] as const

async function compile(clientOnly: boolean): Promise<number> {
  const started = performance.now()
  const child = spawn(process.execPath, [clientOnly ? 'scripts/build-client.mjs' : 'scripts/build.mjs'], {
    cwd: warmRepository, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  })
  let output = ''
  child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-15_000) })
  child.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-15_000) })
  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
  try {
    const [code] = await once(child, 'close')
    if (code !== 0) throw new Error(`Build failed; existing warm Host retained. ${safe(output)}`)
  } finally { clearTimeout(timer) }
  return Math.round(performance.now() - started)
}

async function serve(): Promise<void> {
  process.chdir(warmRepository)
  await mkdir(warmDirectory, { recursive: true, mode: 0o700 })
  const info = await lstat(warmDirectory)
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new Error('Unsafe warm fixture IPC directory')
  await chmod(warmDirectory, 0o700)
  try { await requestWarm('status'); throw new Error('A warm fixture is already running; use status/check/rebuild-client/stop') }
  catch (error) {
    if (!String(error).includes('No warm fixture is running')) throw error
    await rm(warmSocket, { force: true })
  }
  const fixture = new WarmOfficialSession(process.argv.includes('--headed'))
  let queue: Promise<unknown> = Promise.resolve(), closing = false, restartRequired = false, ownsSocket = false
  let watcher: FSWatcher | undefined, debounce: NodeJS.Timeout | undefined
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  const revision = async (): Promise<string> => {
    const connection = fixture.connection()
    const admission = await fetch(connection.launchUrl, { redirect: 'manual' })
    const cookie = admission.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    await admission.body?.cancel()
    const response = await fetch(`${connection.origin}/hapi-dsh/bootstrap`, { headers: { cookie } })
    if (!response.ok) throw new Error(`Warm bootstrap refused: ${response.status}`)
    const payload = await response.json() as { graph: { entries: Array<{ id: string; rev: string }> } }
    const row = payload.graph.entries.find(row => row.id === 'hapi-dsh')
    if (!row) throw new Error('The official graph does not contain hapi-dsh')
    return row.rev
  }
  const reload = async (): Promise<void> => {
    const page = await fixture.currentPage()
    if (page) { await page.reload(); await page.locator('[data-hapi-workspace]').waitFor({ state: 'visible', timeout: 45_000 }) }
  }
  const rebuildClient = async () => {
    const started = performance.now(), previousRevision = await revision()
    const buildMs = await compile(true)
    let publishedRevision = previousRevision
    const deadline = Date.now() + 15_000
    while (publishedRevision === previousRevision && Date.now() < deadline) { await delay(150); publishedRevision = await revision() }
    if (publishedRevision === previousRevision) throw new Error('Official HMR did not publish the rebuilt client; restart is required')
    await reload()
    return { ...fixture.status(), buildMs, durationMs: Math.round(performance.now() - started), officialHmrPublished: true, restartRequired }
  }
  const dispatch = async (action: WarmCommand): Promise<unknown> => {
    if (closing) throw new Error('Warm fixture is stopping')
    if (action === 'status') return { ...fixture.status(), restartRequired, watching: !!watcher }
    if (action === 'connection') return fixture.connection()
    if (action === 'rebuild-client') return await rebuildClient()
    if (action === 'reload') { await reload(); return fixture.status() }
    if (action === 'restart') {
      const buildMs = await compile(false)
      await fixture.restart(); restartRequired = false
      return { ...fixture.status(), buildMs, restartRequired }
    }
    if (action === 'check') {
      if (restartRequired) throw new Error('Host/shared source changed; run npm run e2e:warm -- restart before checking')
      let report: WarmReport
      try { report = await runWarmSmoke(fixture) }
      catch (error) { await fixture.restart(); throw error }
      if (!report.passed) { await fixture.restart(); return { ...report, resetAfterFailure: true } }
      return report
    }
    if (action === 'stop') { setImmediate(() => { void shutdown() }); return { stopping: true } }
    throw new Error('Unknown warm fixture command')
  }
  const server = createServer((request, response) => {
    const action = request.url?.slice(1) as WarmCommand
    if (request.method !== 'POST' || ![...publicCommands, 'connection'].includes(action)) {
      response.writeHead(404); response.end(); return
    }
    const operation = action === 'status' || action === 'connection' ? dispatch(action) : enqueue(() => dispatch(action))
    void operation.then(result => {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    }, error => {
      response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: safe(error) }))
    })
  })
  async function shutdown(): Promise<void> {
    if (closing) return
    closing = true
    watcher?.close(); clearTimeout(debounce)
    await queue
    await fixture.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    if (ownsSocket) await rm(warmSocket, { force: true })
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  try {
    await fixture.start()
    if (closing) { await fixture.close(); return }
    server.listen(warmSocket)
    await once(server, 'listening')
    ownsSocket = true
    await chmod(warmSocket, 0o600)
    if (process.argv.includes('--watch')) {
      watcher = watch(join(warmRepository, 'src'), { recursive: true }, (_event, filename) => {
        if (!filename) return
        const path = filename.toString().replaceAll('\\', '/')
        if (!path.startsWith('client/')) {
          if (!restartRequired) print({ restartRequired: true, reason: 'Host/shared source changed; run npm run e2e:warm -- restart' })
          restartRequired = true
          return
        }
        clearTimeout(debounce)
        debounce = setTimeout(() => { void enqueue(rebuildClient).then(result => print({ rebuilt: result }), error => print({ rebuildError: safe(error) })) }, 250)
      })
    }
    print({ ready: true, ...fixture.status(), watching: !!watcher, command: 'npm run e2e:warm -- check' })
  } catch (error) { await shutdown(); throw error }
}

try {
  if (command === 'serve') await serve()
  else if ((publicCommands as readonly string[]).includes(command)) {
    const result = await requestWarm(command as WarmCommand)
    print(result)
    if (command === 'check' && !(result as WarmReport).passed) process.exitCode = 1
  } else throw new Error('Usage: npm run e2e:warm -- serve [--watch] [--headed] | status | check | rebuild-client | restart | reload | stop')
} catch (error) { process.stderr.write(safe(error) + '\n'); process.exitCode = 1 }
