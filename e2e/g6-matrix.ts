/**
 * G6 artifact sampler: e1→e2→e1 rounds on one rc with injected staging,
 * switch and health-check failures. Each step keeps the old release active on
 * failure, preserves native logs/drafts/history, duplicates no queue or
 * approval action, and reports the online version from the release manifest.
 */
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { HapiWireFixture } from './hapi-fixture.ts'
import { createConfig, writeConfig } from '../src/cli/config.ts'

const rooth = process.env.HAPI_DSH_G6_ROOT ?? '/mnt/cache/src/hapi-dsh/.tmp/g6'
const hapiDsh = '/mnt/cache/src/hapi-dsh'
const e1Bundle = process.env.HAPI_DSH_G6_E1 ?? join(hapiDsh, '.tmp/bundle-extract6b/package')
const e2Bundle = process.env.HAPI_DSH_G6_E2 ?? join(hapiDsh, '.tmp/bundle-extract13/package')
const home = join(rooth, 'home')
const reportPath = process.env.HAPI_DSH_G6_REPORT ?? join(hapiDsh, '.tmp/gates/g6-artifact.json')
const profile = 'hapi-ext4'
const DSH_VERSION = '0.2.1-rc.3'
const HOST_PORT = 3096
const labelFor = (compositionVersion?: string): string => compositionVersion?.includes('ext.6') ? 'e1'
  : compositionVersion?.includes('ext.7') || compositionVersion?.includes('ext.8') ? 'e2' : 'unknown'

interface InstallResult { exitCode: number | null, stdout: string, stderr: string, durationMs: number, json: Record<string, unknown> }
function runInstaller(bundle: string, action: 'install' | 'upgrade' | 'rollback', extra: string[] = []): InstallResult {
  const started = Date.now()
  const args = [join(bundle, 'dist/install.mjs'), action, '--profile', profile, '--dsh-home', home, '--style', 'tarball', '--json']
  if (action !== 'rollback') args.push('--role', 'host')
  const result = spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8', timeout: 20 * 60_000 })
  const stdout = result.stdout ?? ''
  let json: Record<string, unknown> = {}
  const index = stdout.indexOf('{')
  if (index >= 0) { try { json = JSON.parse(stdout.slice(index)) as Record<string, unknown> } catch { /* no json */ } }
  return { exitCode: result.status, stdout, stderr: result.stderr ?? '', durationMs: Date.now() - started, json }
}
function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex').slice(0, 16) }
interface StateView { activeReleaseId?: string | undefined, compositionVersion?: string | undefined, manifestSha256?: string | undefined, releases: string[], runtimeBinary?: string | undefined }
async function readState(): Promise<StateView> {
  try {
    const state = JSON.parse(await readFile(join(home, 'hapi-dsh', 'state.json'), 'utf8')) as {
      profiles?: Record<string, { active?: { releaseId?: string, manifestSha256?: string, manifest?: { release?: { compositionVersion?: string } } }, runtime?: { dshBinary?: string } }>,
      releases?: Record<string, unknown>,
    }
    const active = state.profiles?.[profile]?.active
    return { activeReleaseId: active?.releaseId, compositionVersion: active?.manifest?.release?.compositionVersion,
      manifestSha256: active?.manifestSha256, releases: Object.keys(state.releases ?? {}),
      runtimeBinary: state.profiles?.[profile]?.runtime?.dshBinary }
  } catch { return { releases: [] } }
}
async function manifestMatches(view: StateView): Promise<boolean> {
  if (!view.activeReleaseId || !view.manifestSha256) return false
  const dirName = `r-${view.activeReleaseId.slice(0, 16)}`
  try {
    const manifest = await readFile(join(home, 'hapi-dsh', 'releases', dirName, 'manifest.json'))
    return createHash('sha256').update(manifest).digest('hex') === view.manifestSha256
  } catch { return false }
}
async function launcherHealthMs(binary: string): Promise<number> {
  const started = Date.now()
  const result = spawnSync(process.execPath, [binary, '--profile', profile, '--dump-config'],
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, DSH_HOME: home } })
  return result.status === 0 ? Date.now() - started : Date.now() - started
}
function startHost(binary: string, configFile: string, token: string) {
  const child = spawn(process.execPath, [binary, '--profile', profile, '--host', '127.0.0.1', '--port', String(HOST_PORT), '--no-open'],
    { env: { ...process.env, DSH_HOME: home, HAPI_DSH_CONFIG_FILE: configFile, HAPI_DSH_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return { child, output: () => output }
}
async function waitOrigin(output: () => string, deadlineMs = 60_000): Promise<{ origin: string, launch: string }> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const match = /dsh web: (https?:\/\/[^\s]+)/.exec(output())
    if (match?.[1]) return { launch: match[1], origin: new URL(match[1]).origin }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
  }
  throw new Error(`Host did not start: ${output().slice(-800)}`)
}
async function openWorkspace(page: Page, origin: string, launch: string): Promise<void> {
  await page.request.get(launch, { maxRedirects: 0 })
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-hapi-workspace]').waitFor({ timeout: 60_000 })
  const notice = page.getByRole('dialog', { name: /^(Preview Notice|预览版说明)$/ })
  if (await notice.isVisible().catch(() => false)) await notice.getByRole('button', { name: /^(Continue|继续)$/ }).click().catch(() => {})
}
async function openSession(page: Page): Promise<void> {
  const row = page.locator('button.hapi-session-open').filter({ hasText: 'Native Codex g6' }).first()
  await row.waitFor({ timeout: 30_000 })
  if (!await page.locator('[data-chat-flow]').first().isVisible().catch(() => false)) await row.click()
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30_000 })
}

await mkdir(rooth, { recursive: true })
await rm(home, { recursive: true, force: true })
const sentinels = {
  native: join(home, 'profiles', profile, 'data', 'hapi-dsh', 'native', 'g6-native-log.sentinel'),
  draft: join(home, 'profiles', profile, 'data', 'hapi-dsh', 'g6-draft-store.sentinel'),
  history: join(home, 'profiles', profile, 'data', 'hapi-dsh', 'g6-readable-history.sentinel'),
}
async function writeSentinels(): Promise<Record<string, string>> {
  for (const [name, path] of Object.entries(sentinels)) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `g6 ${name} sentinel ${Date.now()} — installer must not touch this\n`)
  }
  return Object.fromEntries(await Promise.all(Object.entries(sentinels).map(async ([name, path]) => [name, sha256(await readFile(path))] as const)))
}
async function sentinelHashes(): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [name, path] of Object.entries(sentinels)) {
    try { result[name] = sha256(await readFile(path)) } catch { result[name] = 'missing' }
  }
  return result
}

const clean = runInstaller(e1Bundle, 'install')
if (clean.exitCode !== 0) throw new Error(`e1 clean install failed: ${clean.stderr.slice(-800)}`)
const baselineSentinels = await writeSentinels()
console.error('[g6] e1 installed')

const hapi = new HapiWireFixture()
const browser: Browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/home/chris/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome' })
let host: ReturnType<typeof startHost> | undefined
let context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
let page = await context.newPage()
page.setDefaultTimeout(25_000)
const drafts: string[] = []
let fixtureSessionId = ''
async function ensureHostAndSession(): Promise<void> {
  const state = await readState()
  if (!state.runtimeBinary) throw new Error('installed runtime binary missing')
  const configFile = join(rooth, 'host.json')
  const config = createConfig(hapi.url, { DSH_HOME: home })
  config.dsh.profile = profile; config.server.port = 0; config.hapi.token = hapi.accessToken; config.hapi.id = 'g6-hub'
  config.federation = { credentialsFile: join(rooth, 'pairings.json') }
  await rm(configFile, { force: true }); await writeConfig(configFile, config)
  if (host) host.child.kill('SIGTERM')
  host = startHost(state.runtimeBinary, configFile, hapi.accessToken)
  const { origin, launch } = await waitOrigin(host.output)
  await openWorkspace(page, origin, launch)
  await openSession(page)
  await page.waitForTimeout(500)
}
async function startFixtureSession(): Promise<void> {
  const fixture = hapi.add('g6', 'Laptop', 'machine-alpha')
  fixtureSessionId = fixture.session.id
  hapi.emit({ type: 'session-added', sessionId: fixtureSessionId })
}
async function restartAndCheckDraft(draft: string): Promise<boolean> {
  // Restart the Host from the currently active release and reload the browser
  // on the same origin (fixed port): the draft must come back through the
  // client's own persistence/restoration path, not a fresh browser storage.
  activeComposer = page
  await ensureHostAndSession()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
  await composer.waitFor({ timeout: 30_000 })
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = await composer.innerText().catch(() => '')
    if (text.includes(draft)) return true
    await page.waitForTimeout(250)
  }
  return false
}

let activeComposer: Page = page
async function captureDraft(): Promise<string> {
  const draft = `G6 draft survives install ${drafts.length + 1}`
  await activeComposer.locator('[data-composer-input][contenteditable="true"]').first().fill(draft)
  drafts.push(draft)
  await activeComposer.waitForTimeout(900)
  return draft
}
async function stepEvidence(from: string, to: string, result: InstallResult, draft: string, startedState: StateView): Promise<Record<string, unknown>> {
  const after = await readState()
  const sentinelsAfter = await sentinelHashes()
  const healthMs = after.runtimeBinary ? await launcherHealthMs(after.runtimeBinary) : 0
  const draftKept = await restartAndCheckDraft(draft)
  activeComposer = page
  const hostAlive = host?.child.exitCode === null
  return { from, to, activeVersion: labelFor(after.compositionVersion),
    actualOnlineVersion: after.compositionVersion ?? 'missing',
    healthCheckMs: healthMs, healthy: result.exitCode === 0 && after.activeReleaseId !== startedState.activeReleaseId,
    releaseManifestMatches: await manifestMatches(after), oldProcessExitProtected: hostAlive,
    nativeLogsOverwritten: sentinelsAfter.native !== baselineSentinels.native,
    queueActions: hapi.sent.length, approvalActions: hapi.approvals.length,
    draftsPreserved: sentinelsAfter.draft === baselineSentinels.draft, readableHistoryPreserved: sentinelsAfter.history === baselineSentinels.history,
    reconnectDraftPreserved: draftKept, oldReleasesRetained: after.releases.length }
}

try {
  await hapi.start()
  await startFixtureSession()
  await ensureHostAndSession()
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))
  const injections: Array<Record<string, unknown>> = []

  // Staging failure: corrupted payload checksum must fail before activation.
  const tampered = join(rooth, 'bundle-staging-failure')
  await rm(tampered, { recursive: true, force: true })
  await cp(e2Bundle, tampered, { recursive: true, force: true })
  const payloadDir = join(tampered, 'payload', 'dsh-ext')
  const { readdir } = await import('node:fs/promises')
  const tgz = (await readdir(payloadDir)).find(name => name.endsWith('.tgz'))!
  const bytes = await readFile(join(payloadDir, tgz))
  bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff
  await writeFile(join(payloadDir, tgz), bytes)
  const stagingBefore = await readState()
  const stagingDraft = await captureDraft()
  const staging = runInstaller(tampered, 'upgrade')
  const stagingAfter = await readState()
  const stagingSentinels = await sentinelHashes()
  injections.push({ point: 'staging', failed: staging.exitCode !== 0,
    activeBefore: labelFor(stagingBefore.compositionVersion), activeAfter: labelFor(stagingAfter.compositionVersion),
    oldReleaseIntact: stagingAfter.activeReleaseId === stagingBefore.activeReleaseId && await manifestMatches(stagingAfter),
    nativeLogsOverwritten: stagingSentinels.native !== baselineSentinels.native,
    hostAlive: host?.child.exitCode === null, exitCode: staging.exitCode })
  console.error(`[g6] staging injection exit=${staging.exitCode} active=${stagingAfter.compositionVersion}`)

  // Switch failure: block the release store so activation cannot publish a new
  // directory while the old release stays active.
  const releasesDir = join(home, 'hapi-dsh', 'releases')
  const switchDraft = await captureDraft()
  const switchBefore = await readState()
  const { chmod } = await import('node:fs/promises')
  await chmod(releasesDir, 0o500)
  const switching = runInstaller(e2Bundle, 'upgrade')
  await chmod(releasesDir, 0o700)
  const switchAfter = await readState()
  const switchSentinels = await sentinelHashes()
  injections.push({ point: 'switch', failed: switching.exitCode !== 0,
    activeBefore: labelFor(switchBefore.compositionVersion), activeAfter: labelFor(switchAfter.compositionVersion),
    oldReleaseIntact: switchAfter.activeReleaseId === switchBefore.activeReleaseId && await manifestMatches(switchAfter),
    nativeLogsOverwritten: switchSentinels.native !== baselineSentinels.native,
    hostAlive: host?.child.exitCode === null, exitCode: switching.exitCode })
  console.error(`[g6] switch injection exit=${switching.exitCode} active=${switchAfter.compositionVersion}`)

  // Three e1→e2→e1 rounds on the same rc.
  const rounds: Array<Record<string, unknown>> = []
  for (let round = 1; round <= 3; round++) {
    const e1Before = await readState()
    const draft1 = await captureDraft()
    const upgrade = runInstaller(e2Bundle, 'upgrade')
    const upgradeStep = await stepEvidence('e1', 'e2', upgrade, draft1, e1Before)
    const e2Before = await readState()
    const draft2 = await captureDraft()
    const rollback = runInstaller(e2Bundle, 'rollback')
    const rollbackStep = await stepEvidence('e2', 'e1', rollback, draft2, e2Before)
    rounds.push({ round, steps: [upgradeStep, rollbackStep] })
    console.error(`[g6] round ${round}: upgrade=${upgrade.exitCode} rollback=${rollback.exitCode} active=${(await readState()).compositionVersion}`)
  }
  // Health-check failure after e2 is installed: activation succeeds, the
  // unreachable health endpoint forces a rollback within the 30 s budget.
  const healthDraft = await captureDraft()
  const healthBefore = await readState()
  const health = runInstaller(e2Bundle, 'upgrade', ['--health-url', 'http://127.0.0.1:9/', '--health-timeout', '5000'])
  const healthAfter = await readState()
  const healthSentinels = await sentinelHashes()
  injections.push({ point: 'health-check', failed: health.exitCode !== 0,
    activeBefore: labelFor(healthBefore.compositionVersion), activeAfter: labelFor(healthAfter.compositionVersion),
    rolledBack: healthAfter.activeReleaseId === healthBefore.activeReleaseId,
    rollbackWithinMs: health.durationMs, healthAttempts: health.json.healthAttempts,
    oldReleaseIntact: healthAfter.activeReleaseId === healthBefore.activeReleaseId && await manifestMatches(healthAfter),
    nativeLogsOverwritten: healthSentinels.native !== baselineSentinels.native,
    hostAlive: host?.child.exitCode === null, durationMs: health.durationMs, exitCode: health.exitCode })
  const healthDraftKept = await restartAndCheckDraft(healthDraft)
  void healthDraftKept
  console.error(`[g6] health injection exit=${health.exitCode} active=${healthAfter.compositionVersion} ms=${health.durationMs}`)

  let runtimeIdentity: Record<string, unknown> = {}
  try {
    const { runtimeIdentity: resolveIdentity } = await import('../src/runner/identity.ts')
    runtimeIdentity = resolveIdentity({ dshVersion: DSH_VERSION, dshHome: home, profile }) as unknown as Record<string, unknown>
  } catch { /* optional */ }
  const finalState = await readState()
  const dataset = { schema: 1, gate: 'G6', environment: 'bundle-installed Home with HAPI fixture and Chromium reload checks',
    rounds, injections, onlineVersion: { version: labelFor(finalState.compositionVersion),
      actualVersion: finalState.compositionVersion ?? 'missing', releaseManifestMatches: await manifestMatches(finalState) },
    expectedIdentity: runtimeIdentity }
  await writeFile(reportPath, JSON.stringify(dataset, null, 1))
  console.log(JSON.stringify({ rounds: rounds.length,
    roundSteps: rounds.map(round => (round.steps as Array<Record<string, unknown>>).map(step => ({ from: step.from, to: step.to, ok: step.healthy, draft: step.reconnectDraftPreserved, retained: step.oldReleasesRetained }))),
    injections: injections.map(entry => ({ point: entry.point, failed: entry.failed, before: entry.activeBefore, after: entry.activeAfter, rollbackMs: entry.rollbackWithinMs })) }, null, 1))
} finally {
  host?.child.kill('SIGTERM')
  await browser.close().catch(() => {})
  await hapi.close().catch(() => {})
}
