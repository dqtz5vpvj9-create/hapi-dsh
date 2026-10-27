/**
 * Shared fixture harness for the bundle tests.
 *
 * It deliberately uses a fake official launcher (`dsh`) and a fake `pnpm`:
 * these tests exercise the distribution layer's state machine, overrides and
 * rollback bookkeeping, not a real DSH or pnpm installation. Real-launcher
 * evidence is reported separately.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { digest, ops, release, tar, type InstallResult } from '../src/cli/release.ts'

const runFile = promisify(execFile)
export const repositoryRoot = resolve(import.meta.dirname, '..')
const packScript = join(repositoryRoot, 'scripts', 'bundle', 'pack.mjs')

export function scratchRoot(): string {
    return process.env.HAPI_DSH_TEST_ROOT ?? tmpdir()
}

export const FAKE_DSH_SOURCE = (repositoryRootPath: string): string => `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readTgz } from ${JSON.stringify(`${repositoryRootPath}/scripts/bundle/lib/tar.mjs`)}

const args = process.argv.slice(2)
const dshHome = process.env.DSH_HOME
const logFile = process.env.HAPI_DSH_FAKE_LOG
const fail = process.env.HAPI_DSH_FAKE_FAIL ?? ''
const log = (entry) => { if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\\n') }
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
if (args[0] === '--version') { console.log('0.2.1-rc.3'); process.exit(0) }
const profile = flag('--profile')
const profileDir = join(dshHome, 'profiles', profile)
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\\n')

if (args.includes('--from-default-profile')) {
  log({ kind: 'init', profile })
  mkdirSync(profileDir, { recursive: true })
  if (!existsSync(join(profileDir, 'package.json'))) {
    writeJson(join(profileDir, 'package.json'), { name: 'dsh-profile-' + profile, private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } }, dependencies: {} })
  }
  console.log('- id: @deepseek-ai/dsh-web-app')
  process.exit(0)
}

if (args[0] === 'plugin' && args.includes('add')) {
  const spec = args[args.length - 1]
  if (!spec.startsWith('link:')) { console.error('fake dsh: expected a link: spec'); process.exit(4) }
  const target = spec.slice('link:'.length)
  const name = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name
  log({ kind: 'plugin-add', profile, name, target })
  if (fail === 'plugin') { console.error('fake dsh: injected plugin failure'); process.exit(3) }
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: spec }
  pkg.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: [...new Set([...(pkg.dsh?.profile?.bundles ?? []), name])] } }
  writeJson(join(profileDir, 'package.json'), pkg)
  const releaseRoot = target.endsWith('/package/dist/runner')
    ? target.slice(0, -'/package/dist/runner'.length)
    : target.endsWith('/runtime/node_modules/hapi-dsh')
      ? target.slice(0, -'/runtime/node_modules/hapi-dsh'.length)
      : target.endsWith('/package') ? dirname(target) : undefined
  if (!releaseRoot) { console.error('fake dsh: unexpected link target ' + target); process.exit(6) }
  const releaseManifest = JSON.parse(readFileSync(join(releaseRoot, 'manifest.json'), 'utf8'))
  // Runtime-managed releases keep patched packages in the private runtime; the
  // profile only links the plugin.
  for (const item of existsSync(join(releaseRoot, 'runtime')) ? [] : releaseManifest.payload.dshExt) {
    const unpacked = join(releaseRoot, 'payload', 'dsh-ext', 'unpacked', item.name.replace(/[^A-Za-z0-9]/g, '_'))
    mkdirSync(unpacked, { recursive: true })
    for (const entry of readTgz(readFileSync(join(releaseRoot, item.tarball)), { withData: true })) {
      if (entry.type !== 'file' || !entry.data || !entry.path.startsWith('package/')) continue
      const file = join(unpacked, entry.path.slice('package/'.length))
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, entry.data)
    }
    if (fail === 'health') {
      const broken = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'))
      writeJson(join(unpacked, 'package.json'), { ...broken, version: '0.2.1-rc.3' })
    }
    const link = join(profileDir, 'node_modules', item.name)
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { recursive: true, force: true })
    symlinkSync(unpacked, link, 'dir')
  }
  process.exit(0)
}

if (args.includes('--dump-config')) {
  log({ kind: 'dump-config', profile })
  console.log('- id: @deepseek-ai/dsh-web-app')
  const path = join(profileDir, 'package.json')
  if (existsSync(path)) {
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    for (const dependency of Object.keys(pkg.dependencies ?? {})) console.log('- id: ' + dependency)
  }
  process.exit(0)
}

console.error('fake dsh: unsupported arguments ' + args.join(' '))
process.exit(5)
`

export const FAKE_PNPM_SOURCE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const logFile = process.env.HAPI_DSH_FAKE_PNPM_LOG
if (logFile) appendFileSync(logFile, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv.includes('--version')) { console.log('11.28.5'); process.exit(0) }
process.exit(0)
`

export interface Harness {
    root: string
    dshHome: string
    profile: string
    hapiPayload: string
    fakeDsh: string
    fakePnpm: string
    logFile: string
    pnpmLog: string
    install: (tag: string, options?: { env?: NodeJS.ProcessEnv; waitIdleTimeoutMs?: number; healthTimeoutMs?: number; role?: 'host' | 'runner';
        runtimeBuilder?: (options: { releaseRoot: string; manifest: { release: { upstreamVersion: string }; payload: { dshExt: Array<{ name: string; version: string; tarball: string }> } } }) => Promise<{ directory: string; dshBinary: string; dshVersion: string; packages: Array<{ name: string; version: string; sha256: string }> }> }) => Promise<InstallResult>
    command: { executable: string; args: string[] }
    pnpm: { executable: string; args: string[] }
    reinstallCalls: string[]
    reinstall: (options: { profileDirectory: string }) => Promise<void>
    state: () => Promise<release.BundleState>
    releaseRoot: (tag: string) => string
    releaseId: (tag: string) => string
    profileManifest: () => Promise<Record<string, unknown>>
}

export async function createHarness(): Promise<Harness> {
    const root = await mkdtemp(join(scratchRoot(), 'hapi-dsh-bundle-install-'))
    const dshHome = join(root, 'dsh')
    const profile = 'hapi'
    const hapiPayload = await makeHapiPayload(root)
    const fakeDsh = join(root, 'fake-dsh.mjs')
    const fakePnpm = join(root, 'fake-pnpm.mjs')
    await writeFile(fakeDsh, FAKE_DSH_SOURCE(repositoryRoot))
    await writeFile(fakePnpm, FAKE_PNPM_SOURCE)
    const logFile = join(root, 'fake-dsh.log')
    const pnpmLog = join(root, 'fake-pnpm.log')
    const releases: Record<string, { bundleRoot: string; releaseId: string; releaseDirectory: string }> = {}
    const reinstallCalls: string[] = []
    const command = { executable: process.execPath, args: [fakeDsh] }
    const pnpm = { executable: process.execPath, args: [fakePnpm] }
    const state = () => release.readBundleState(dshHome)
    const profileManifest = async () => JSON.parse(await readFile(join(dshHome, 'profiles', profile, 'package.json'), 'utf8')) as Record<string, unknown>
    const ensureRelease = async (tag: string) => {
        if (releases[tag]) return releases[tag]
        const extRelease = await makeExtRelease(root, tag)
        const out = join(root, `out-${tag}`)
        const { stdout } = await runFile(process.execPath, [packScript, '--ext-release', extRelease, '--hapi-dsh-tgz', hapiPayload, '--out', out, '--tmp', join(root, 'scratch'), '--json'], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 }) as unknown as { stdout: string }
        const summary = JSON.parse(stdout) as { bundle: string; releaseId: string }
        const extracted = join(root, `bundle-${tag}`)
        await tar.extractTgz(await readFile(summary.bundle), extracted)
        const record = { bundleRoot: join(extracted, 'package'), releaseId: summary.releaseId, releaseDirectory: release.releaseDirectory(dshHome, summary.releaseId) }
        releases[tag] = record
        return record
    }
    const fakeReinstall = async ({ profileDirectory }: { profileDirectory: string }) => {
        reinstallCalls.push(profileDirectory)
        const profileManifest = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8')) as { pnpm?: { overrides?: Record<string, string> } }
        for (const [name, spec] of Object.entries(profileManifest.pnpm?.overrides ?? {})) {
            const tarball = resolve(profileDirectory, String(spec).replace(/^file:/, ''))
            const unpacked = join(dirname(tarball), 'unpacked', name.replace(/[^A-Za-z0-9]/g, '_'))
            const link = join(profileDirectory, 'node_modules', name)
            await mkdir(dirname(link), { recursive: true })
            await rm(link, { recursive: true, force: true })
            await symlink(unpacked, link, 'dir')
        }
    }
    // Fake pinned runtime: only the files inspectRuntime reads, no network.
    const runtimeBuilderFor = (fail: string | undefined) => async ({ releaseRoot, manifest }: { releaseRoot: string; manifest: { release: { upstreamVersion: string; extRelease?: string }; payload: { dshExt: Array<{ name: string; version: string; tarball: string }> } } }) => {
        const directory = join(releaseRoot, 'runtime')
        const write = async (relative: string, value: unknown) => {
            const file = join(directory, relative)
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, `${JSON.stringify(value)}\n`)
        }
        await write('node_modules/@deepseek-ai/dsh/package.json', { name: '@deepseek-ai/dsh', version: manifest.release.upstreamVersion, bin: { dsh: 'lib/bin.js' } })
        // The profile links this runtime copy of the plugin.
        await write('node_modules/hapi-dsh/package.json', { name: 'hapi-dsh', version: '0.1.2' })
        const packages = []
        for (const item of manifest.payload.dshExt) {
            await write(`node_modules/${item.name}/package.json`, { name: item.name, version: fail === 'health' ? '0.2.1-rc.3' : item.version })
            packages.push({ name: item.name, version: item.version, sha256: '0'.repeat(64) })
        }
        // Sealed identity so inspectRuntime verifies hashes like production.
        const sealPaths = ['node_modules/@deepseek-ai/dsh/package.json',
            ...manifest.payload.dshExt.map(item => `node_modules/${item.name}/package.json`)]
        const files: Record<string, string> = {}
        for (const path of sealPaths) files[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex')
        await write('runtime-identity.json', { schemaVersion: 1, upstreamVersion: manifest.release.upstreamVersion,
            extRelease: manifest.release.extRelease, packages: [], files })
        return { directory, dshBinary: join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), dshVersion: manifest.release.upstreamVersion, packages }
    }
    type RuntimeBuilder = ReturnType<typeof runtimeBuilderFor>
    const install = async (tag: string, options: { env?: NodeJS.ProcessEnv; waitIdleTimeoutMs?: number; healthTimeoutMs?: number; role?: 'host' | 'runner'; runtimeBuilder?: RuntimeBuilder } = {}) => {
        const target = await ensureRelease(tag)
        return ops.installRelease({
            runtimeBuilder: options.runtimeBuilder ?? runtimeBuilderFor(options.env?.HAPI_DSH_FAKE_FAIL),
            bundleRoot: target.bundleRoot,
            dshHome,
            profile,
            role: options.role ?? 'host',
            command,
            pnpm,
            pnpmVersion: '11.28.5',
            env: { ...process.env, HAPI_DSH_FAKE_LOG: logFile, HAPI_DSH_FAKE_PNPM_LOG: pnpmLog, ...(options.env ?? {}) },
            waitIdleTimeoutMs: options.waitIdleTimeoutMs ?? 0,
            healthTimeoutMs: options.healthTimeoutMs ?? 500,
            healthIntervalMs: 50,
            logger: () => {},
            reinstall: fakeReinstall,
        })
    }
    return {
        root, dshHome, profile, hapiPayload, fakeDsh, fakePnpm, logFile, pnpmLog, install, command, pnpm, reinstallCalls, reinstall: fakeReinstall,
        state, profileManifest,
        releaseRoot: (tag: string) => {
            const entry = releases[tag]
            if (!entry) throw new Error(`release ${tag} has not been prepared`)
            return entry.releaseDirectory
        },
        releaseId: (tag: string) => {
            const entry = releases[tag]
            if (!entry) throw new Error(`release ${tag} has not been prepared`)
            return entry.releaseId
        },
    }
}

export async function makeHapiPayload(directory: string): Promise<string> {
    const packageRoot = join(directory, 'hapi-dsh-package')
    await mkdir(join(packageRoot, 'dist', 'runner'), { recursive: true })
    const version = (JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }).version
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'hapi-dsh', version, type: 'module', main: './dist/cli.js' }, null, 2))
    await writeFile(join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n// fixture payload\n')
    await writeFile(join(packageRoot, 'dist', 'runner', 'package.json'), JSON.stringify({ name: 'hapi-dsh-runner', version, type: 'module', main: './index.js' }, null, 2))
    const archive = await tar.createTgzFromDirectory(packageRoot, { prefix: 'package' })
    const file = join(directory, 'hapi-dsh-fixture.tgz')
    await writeFile(file, archive)
    return file
}

export const EXT_PACKAGES = [
    { name: '@deepseek-ai/dsh-client-ui-chat', capability: 'mountedChat' },
    { name: '@deepseek-ai/dsh-client-ui-conversation', capability: 'windowCommit' },
    { name: '@deepseek-ai/dsh-api-session-controller', capability: 'historySource' },
] as const

/** A real-shaped ext release: three modified official packages, no placeholders flag. */
export async function makeExtRelease(root: string, tag: string): Promise<string> {
    const directory = join(root, `ext-release-${tag}`)
    await mkdir(directory, { recursive: true })
    const version = `0.2.1-rc.3.ext.${tag}`
    const packages = []
    for (const item of EXT_PACKAGES) {
        const source = join(directory, 'sources', item.name.replace(/[^A-Za-z0-9]/g, '_'))
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'package.json'), JSON.stringify({
            name: item.name,
            version,
            type: 'module',
            main: './index.js',
            license: 'MIT',
            dsh: { ext: { capabilities: { [item.capability]: 1 } } },
        }, null, 2))
        await writeFile(join(source, 'index.js'), `export const tag = ${JSON.stringify(tag)}\n`)
        const tarball = `${item.name.replace(/^@[^/]+\//, '')}-${version}.tgz`
        await writeFile(join(directory, tarball), await tar.createTgzFromDirectory(source, { prefix: 'package' }))
        packages.push({ name: item.name, version, tarball })
    }
    const patchSet = await digest.sha256File(join(repositoryRoot, 'package.json'))
    await writeFile(join(directory, 'release.json'), JSON.stringify({
        upstreamVersion: '0.2.1-rc.3',
        upstreamCommit: '1f81c047fc48fa190a683e469daa699857e9afe8',
        extRelease: version,
        patchSetSha256: patchSet,
        compositionVersion: `ext-${tag}`,
        protocol: 2,
        capabilities: { historySource: 1, mountedChat: 1, windowCommit: 1 },
        packages,
    }, null, 2))
    return directory
}

export async function seedProfile(dshHome: string, profile: string, overrides: Record<string, string> = {}): Promise<void> {
    const directory = join(dshHome, 'profiles', profile)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({
        name: `dsh-profile-${profile}`,
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
        dependencies: {},
        pnpm: { overrides },
    }, null, 2) + '\n')
}

export async function logLines(path: string): Promise<Array<Record<string, unknown>>> {
    try {
        return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    }
}

