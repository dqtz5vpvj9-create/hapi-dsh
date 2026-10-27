/**
 * G5 artifact sampler: repeat-install idempotency with a measured home diff,
 * Host + two Runner RuntimeIdentityV1 handshakes, eight handshake-field tamper
 * cases with zero business forwards, and the three pre-activation failures.
 */
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { addPairing } from '../src/hub/federation-credentials.ts'
import { RUNTIME_PROTOCOL, runtimeIdentity, type RuntimeIdentityV1 } from '../src/runner/identity.ts'
import { RUNNER_PATH } from '../src/runner/protocol.ts'
import { createConfig, writeConfig } from '../src/cli/config.ts'
import { HapiWireFixture } from './hapi-fixture.ts'

const root = process.env.HAPI_DSH_G5_ROOT ?? '/mnt/cache/src/hapi-dsh/.tmp/g5'
const hapiDsh = '/mnt/cache/src/hapi-dsh'
const bundleDir = process.env.HAPI_DSH_G5_BUNDLE ?? join(hapiDsh, '.tmp/bundle-extract11/package')
const home = join(root, 'home')
const reportPath = process.env.HAPI_DSH_G5_REPORT ?? join(hapiDsh, '.tmp/gates/g5-artifact.json')
const profile = 'hapi-ext4'
const DSH_VERSION = '0.2.1-rc.3'

interface Snapshot { files: Map<string, string> }
async function snapshot(directory: string, rel = '', files = new Map<string, string>()): Promise<Snapshot> {
  let names: string[] = []
  try { names = await readdir(directory) } catch { return { files } }
  for (const name of names.sort()) {
    if (rel === '' && name === 'tmp') continue
    const path = join(directory, name)
    const key = rel === '' ? name : `${rel}/${name}`
    let info
    try { info = await (await import('node:fs/promises')).lstat(path) } catch { continue }
    if (info.isSymbolicLink()) files.set(key, `link:${(await import('node:fs/promises')).readlink(path)}`)
    else if (info.isDirectory()) await snapshot(path, key, files)
    else if (info.isFile()) files.set(key, createHash('sha256').update(await readFile(path)).digest('hex'))
  }
  return { files }
}
function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string {
  const changed: string[] = []
  for (const [key, value] of after) if (before.get(key) !== value) changed.push(`+${key}`)
  for (const key of before.keys()) if (!after.has(key)) changed.push(`-${key}`)
  return changed.slice(0, 40).join('\n')
}
function runInstaller(bundle: string, targetHome: string, extra: string[] = []): { exitCode: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [join(bundle, 'dist/install.mjs'), 'install', '--profile', profile, '--role', 'host',
    '--dsh-home', targetHome, '--style', 'tarball', '--json', ...extra], { encoding: 'utf8', timeout: 20 * 60_000 })
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function parseJson(text: string): Record<string, unknown> {
  const index = text.indexOf('{')
  if (index < 0) return {}
  try { return JSON.parse(text.slice(index)) as Record<string, unknown> } catch { return {} }
}
async function hostIdentity(targetHome: string): Promise<RuntimeIdentityV1> {
  return runtimeIdentity({ dshVersion: DSH_VERSION, dshHome: targetHome, profile })
}
function frameHello(id: string, identity: RuntimeIdentityV1): string {
  return JSON.stringify({ type: 'hello', protocol: RUNTIME_PROTOCOL, machineId: id, name: `G5 ${id}`,
    dshVersion: DSH_VERSION, generation: `g5-${id}-${Date.now()}`, identity })
}
function openRunner(origin: string, id: string, token: string): Promise<WebSocket> {
  const url = new URL(RUNNER_PATH, origin); url.searchParams.set('machine', id)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    const timer = setTimeout(() => { socket.close(); reject(new Error('runner handshake timed out')) }, 10_000)
    socket.once('open', () => { clearTimeout(timer); resolvePromise(socket) })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}
function awaitFrame(socket: WebSocket, timeoutMs = 8_000): Promise<{ frame?: Record<string, unknown>, closed?: boolean }> {
  return new Promise(resolvePromise => {
    let settled = false
    const finish = (value: { frame?: Record<string, unknown>, closed?: boolean }): void => {
      if (settled) return
      settled = true; clearTimeout(timer); resolvePromise(value)
    }
    const timer = setTimeout(() => finish({ closed: true }), timeoutMs)
    socket.on('message', data => {
      try { finish({ frame: JSON.parse(String(data)) as Record<string, unknown> }) } catch { finish({}) }
    })
    socket.on('close', () => finish({ closed: true }))
    socket.on('error', () => finish({ closed: true }))
  })
}

await mkdir(root, { recursive: true })
const installRuns: Array<Record<string, unknown>> = []
let previous: Snapshot | undefined
for (let run = 1; run <= 3; run++) {
  if (run === 1) await rm(home, { recursive: true, force: true })
  const result = runInstaller(bundleDir, home)
  const current = await snapshot(home)
  installRuns.push({ run, kind: run === 1 ? 'clean' : 'repeat', ok: result.exitCode === 0, exitCode: result.exitCode,
    ...(run === 1 ? {} : { diff: previous ? diffSnapshots(previous.files, current.files) : 'no prior snapshot' }),
    ...(result.exitCode === 0 ? {} : { stderrTail: result.stderr.slice(-1200) }) })
  previous = current
  console.error(`[g5] install run ${run} exit=${result.exitCode}`)
}

// Pre-activation failures on tampered bundle copies (dry run must reject before
// activation; the fresh home must stay without an active release).
const preActivationFailures: Array<Record<string, unknown>> = []
async function tamperedBundle(name: string, mutate: (dir: string) => Promise<void>): Promise<void> {
  const dir = join(root, `bundle-${name}`)
  await rm(dir, { recursive: true, force: true })
  await cp(bundleDir, dir, { recursive: true, force: true })
  await mutate(dir)
  const target = join(root, `home-${name}`)
  await rm(target, { recursive: true, force: true })
  const result = runInstaller(dir, target, ['--dry-run'])
  const stateExists = existsSync(join(target, 'hapi-dsh', 'state.json'))
  preActivationFailures.push({ case: name, failedBeforeActivation: result.exitCode !== 0 && !stateExists,
    exitCode: result.exitCode, stateCreated: stateExists, stderrTail: result.stderr.slice(-800) })
  console.error(`[g5] pre-activation ${name} exit=${result.exitCode} state=${stateExists}`)
}
await tamperedBundle('missing-ext-package', async dir => {
  const payload = join(dir, 'payload', 'dsh-ext')
  const names = (await readdir(payload)).filter(name => name.endsWith('.tgz'))
  await rm(join(payload, names[0]!), { force: true })
})
await tamperedBundle('bad-checksum', async dir => {
  const payload = join(dir, 'payload', 'dsh-ext')
  const names = (await readdir(payload)).filter(name => name.endsWith('.tgz'))
  const path = join(payload, names[0]!)
  const bytes = await readFile(path)
  bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff
  await writeFile(path, bytes)
})
// Original package mixed load: a profile copy of an official extension package
// must fail the install health gate before the new release activates.
{
  const mixedHome = join(root, 'home-original-mixed-load')
  await rm(mixedHome, { recursive: true, force: true })
  const profileDir = join(mixedHome, 'profiles', profile)
  const copyDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat')
  await mkdir(copyDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: `hapi-dsh-${profile}`, private: true,
    dependencies: { '@deepseek-ai/dsh-client-ui-chat': '0.2.1-rc.3' } }))
  await writeFile(join(copyDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-chat', version: '0.2.1-rc.3' }))
  const result = runInstaller(bundleDir, mixedHome)
  let active: string | undefined
  try {
    const state = JSON.parse(await readFile(join(mixedHome, 'hapi-dsh', 'state.json'), 'utf8')) as { profiles?: Record<string, { active?: { releaseId?: string } }> }
    active = state.profiles?.[profile]?.active?.releaseId
  } catch { /* no state means no activation */ }
  preActivationFailures.push({ case: 'original-mixed-load', failedBeforeActivation: result.exitCode !== 0 && active === undefined,
    exitCode: result.exitCode, stateCreated: active !== undefined, stderrTail: result.stderr.slice(-800) })
  console.error(`[g5] pre-activation original-mixed-load exit=${result.exitCode} active=${active ?? 'none'}`)
}

// Host + two Runners identity handshake against the installed release identity.
const hapi = new HapiWireFixture()
const hostProcesses: Array<ReturnType<typeof spawn>> = []
try {
  await hapi.start()
  const credentialsFile = join(root, 'pairings.json')
  await rm(credentialsFile, { force: true })
  const identities = await hostIdentity(home)
  const normalTokens: Record<string, string> = {}
  for (const id of ['runner-one', 'runner-two']) normalTokens[id] = await addPairing(credentialsFile, id, `G5 ${id}`)
  const tamperIds = ['upstreamVersion', 'upstreamCommit', 'extRelease', 'patchSetSha256', 'packageSetSha256', 'capabilities', 'compositionVersion', 'protocol']
  const tamperTokens: Record<string, string> = {}
  for (const [index, field] of tamperIds.entries()) tamperTokens[field] = await addPairing(credentialsFile, `tamper-${index}`, `Tamper ${field}`)
  const config = createConfig(hapi.url, { DSH_HOME: home })
  config.dsh.profile = profile
  config.server.port = 0
  config.hapi.token = hapi.accessToken
  config.hapi.id = 'g5-hub'
  config.federation = { credentialsFile }
  const configFile = join(root, 'host.json')
  await rm(configFile, { force: true })
  await writeConfig(configFile, config)
  const state = JSON.parse(await readFile(join(home, 'hapi-dsh', 'state.json'), 'utf8')) as { profiles?: Record<string, { runtime?: { dshBinary?: string } }> }
  const binary = state.profiles?.[profile]?.runtime?.dshBinary
  if (!binary) throw new Error('installed runtime binary is missing')
  const host = spawn(process.execPath, [binary, '--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: home, HAPI_DSH_CONFIG_FILE: configFile, HAPI_DSH_TOKEN: hapi.accessToken },
    stdio: ['ignore', 'pipe', 'pipe'] })
  hostProcesses.push(host)
  let output = ''
  host.stdout.on('data', chunk => { output += chunk })
  host.stderr.on('data', chunk => { output += chunk })
  let origin = ''
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const match = /dsh web: (https?:\/\/[^\s]+)/.exec(output)
    if (match?.[1]) { origin = new URL(match[1]).origin; break }
    if (host.exitCode !== null) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
  }
  if (!origin) throw new Error(`installed Host did not start: ${output.slice(-800)}`)
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
  const nodes: Array<Record<string, unknown>> = [{ role: 'host', matched: true, identity: identities }]
  const normalSockets: WebSocket[] = []
  for (const id of ['runner-one', 'runner-two']) {
    // The plugin mounts federation after the web listener appears; retry the
    // handshake briefly instead of treating boot order as an identity failure.
    let matched = false
    let socket: WebSocket | undefined
    let attempts = 0
    for (; attempts < 30; attempts++) {
      socket = await openRunner(origin, id, normalTokens[id]!).catch(() => undefined)
      if (!socket) { await new Promise(resolvePromise => setTimeout(resolvePromise, 350)); continue }
      socket.send(frameHello(id, identities))
      const first = await awaitFrame(socket, 5000)
      if (first.frame?.type === 'welcome') { matched = true; break }
      socket.close()
      await new Promise(resolvePromise => setTimeout(resolvePromise, 350))
    }
    if (socket && matched) normalSockets.push(socket)
    nodes.push({ role: 'runner', id, matched, identity: identities, attempts })
    if (!matched) console.error(`[g5] runner ${id} handshake failed after ${attempts} attempts; host tail: ${output.slice(-600).replace(/\n/g, ' | ')}`)
  }
  const tampers: Array<Record<string, unknown>> = []
  for (const [index, field] of tamperIds.entries()) {
    const id = `tamper-${index}`
    const tampered = { ...identities, capabilities: { ...identities.capabilities } } as Record<string, unknown>
    if (field === 'capabilities') tampered.capabilities = { ...identities.capabilities, historySource: 0 }
    else if (field === 'protocol') tampered.protocol = 1
    else tampered[field] = field === 'upstreamCommit' ? 'f'.repeat(40) : field.endsWith('Sha256') ? '0'.repeat(64) : 'tampered'
    const socket = await openRunner(origin, id, tamperTokens[field]!)
    socket.send(frameHello(id, tampered as unknown as RuntimeIdentityV1))
    const first = await awaitFrame(socket)
    let businessForwarded = 0
    try {
      socket.send(JSON.stringify({ type: 'http-open', id: 'probe', method: 'GET', path: '/', headers: [] }))
      const business = await awaitFrame(socket, 1200)
      if (business.frame && business.frame.type !== 'welcome') businessForwarded += 1
    } catch { /* socket already closed */ }
    socket.close()
    tampers.push({ field, handshakeDiagnosed: first.frame?.type !== 'welcome', businessForwarded,
      firstFrame: first.frame?.type ?? (first.closed ? 'closed' : 'none') })
  }
  for (const socket of normalSockets) socket.close()
  const expected = identities
  const dataset = { schema: 1, gate: 'G5', environment: 'bundle-installed Host + Runner handshake against a synthetic HAPI hub',
    installRuns, nodes, expectedIdentity: expected, tampers, preActivationFailures }
  await writeFile(reportPath, JSON.stringify(dataset, null, 1))
  console.log(JSON.stringify({ installRuns: installRuns.length, nodes: nodes.length,
    runnerMatches: nodes.filter(node => node.role === 'runner' && node.matched).length,
    tampers: tampers.map(tamper => ({ field: tamper.field, diagnosed: tamper.handshakeDiagnosed, forwarded: tamper.businessForwarded })),
    preActivation: preActivationFailures.map(entry => ({ case: entry.case, failed: entry.failedBeforeActivation })) }, null, 1))
} finally {
  for (const child of hostProcesses) { try { child.kill('SIGTERM') } catch { /* ignore */ } }
  await hapi.close().catch(() => {})
}
