import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { digest, manifest, release, tar } from '../src/cli/release.ts'

const runFile = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '..')
const packScript = join(repositoryRoot, 'scripts', 'bundle', 'pack.mjs')
const installScript = join(repositoryRoot, 'scripts', 'bundle', 'install.mjs')

function scratchRoot(): string {
    return process.env.HAPI_DSH_TEST_ROOT ?? tmpdir()
}

/** Minimal hapi-dsh package used as the bundle payload; no npm, no network. */
async function makeHapiPayload(directory: string): Promise<string> {
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

interface ExecResult { stdout: string; stderr: string }

async function run(file: string, args: string[], options: { cwd?: string } = {}): Promise<ExecResult> {
    return runFile(file, args, {
        cwd: options.cwd ?? repositoryRoot,
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
    }) as unknown as ExecResult
}

async function listFiles(root: string): Promise<string[]> {
    const files: string[] = []
    const walk = async (directory: string, prefix = ''): Promise<void> => {
        for (const item of await readdir(directory, { withFileTypes: true })) {
            const relative = prefix === '' ? item.name : `${prefix}/${item.name}`
            if (item.isDirectory()) await walk(join(directory, item.name), relative)
            else files.push(relative)
        }
    }
    await walk(root)
    return files
}

test('the fixture bundle has the layout fixed by the distribution spec', async () => {
    const root = await mkdtemp(join(scratchRoot(), 'hapi-dsh-bundle-layout-'))
    try {
        const hapiPayload = await makeHapiPayload(root)
        const out = join(root, 'out')
        const { stdout } = await run(process.execPath, [packScript, '--fixture', '--hapi-dsh-tgz', hapiPayload, '--out', out, '--tmp', join(root, 'scratch'), '--json'])
        const summary = JSON.parse(stdout) as {
            ok: boolean; bundle: string; sha256: string; fixture: boolean; releaseId: string; fileCount: number;
            payload: { dshExt: Array<{ name: string; tarball: string }> };
        }
        assert.equal(summary.ok, true)
        assert.equal(summary.fixture, true)
        assert.match(summary.releaseId, /^[a-f0-9]{64}$/)
        assert.ok(summary.bundle.endsWith('.tgz'))
        assert.equal(summary.payload.dshExt.length, 3)
        assert.equal(await digest.sha256File(summary.bundle), summary.sha256)
        const sums = await readFile(join(out, 'SHA256SUMS'), 'utf8')
        assert.match(sums, new RegExp(`^${summary.sha256}  hapi-dsh-bundle-[^ ]+\\.tgz$`, 'm'))

        const extracted = join(root, 'extracted-bundle')
        await tar.extractTgz(await readFile(summary.bundle), extracted)
        const bundleRoot = join(extracted, 'package')
        for (const required of ['dist/install.mjs', 'payload/hapi-dsh.tgz', 'manifest.json', 'SHA256SUMS', 'LICENSES/INDEX.json', 'SOURCE-OFFER/PROVENANCE.json', 'SOURCE-OFFER/README.md']) {
            assert.ok(existsSync(join(bundleRoot, required)), `bundle layout must contain ${required}`)
        }
        const extTarballs = (await readdir(join(bundleRoot, 'payload', 'dsh-ext'))).filter((name) => name.endsWith('.tgz'))
        assert.equal(extTarballs.length, 3)

        const verified = await release.verifyBundleRoot(bundleRoot)
        assert.equal(verified.releaseId, summary.releaseId)
        await release.verifyPayloadTarballs(bundleRoot, { listTgz: tar.listTgz, readTgz: tar.readTgz })
        const bundleManifest = verified.manifest
        assert.equal(bundleManifest.name, 'hapi-dsh-bundle')
        assert.deepEqual(Object.keys(bundleManifest.release.capabilities).sort(), ['historySource', 'mountedChat', 'windowCommit'])
        assert.equal(bundleManifest.release.protocol, 2)
        assert.equal(manifest.computeReleaseId(bundleManifest), bundleManifest.releaseId)
        assert.equal(manifest.packageSetSha256(bundleManifest.payload.dshExt), bundleManifest.release.packageSetSha256)
        assert.equal(bundleManifest.fixture, true)

        assert.deepEqual(manifest.bundleLayoutErrors(await listFiles(bundleRoot)), [])
        const sumsEntries = manifest.parseSums(await readFile(join(bundleRoot, 'SHA256SUMS'), 'utf8'))
        const files = (await listFiles(bundleRoot)).filter((path) => path !== 'SHA256SUMS').sort()
        assert.deepEqual(sumsEntries.map((entry) => entry.path).sort(), files, 'SHA256SUMS must cover every bundle file')
        for (const entry of sumsEntries) assert.equal(await digest.sha256File(join(bundleRoot, entry.path)), entry.sha256, `checksum mismatch for ${entry.path}`)

        for (const file of ['dist/install.mjs', ...(await readdir(join(bundleRoot, 'dist', 'lib'))).map((name) => `dist/lib/${name}`)]) {
            if (!file.endsWith('.mjs')) continue
            const source = await readFile(join(bundleRoot, file), 'utf8')
            assert.deepEqual(manifest.installerImportErrors(source, file), [], `${file} may only import Node builtins and local modules`)
        }
        const installSource = await readFile(join(bundleRoot, 'dist', 'install.mjs'), 'utf8')
        assert.ok(installSource.startsWith('#!/usr/bin/env node\n'), 'the installer keeps its executable hashbang')
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('packaging refuses to invent an ext payload', async () => {
    const root = await mkdtemp(join(scratchRoot(), 'hapi-dsh-bundle-nopayload-'))
    try {
        await assert.rejects(
            () => run(process.execPath, [packScript, '--out', join(root, 'out'), '--tmp', join(root, 'scratch'), '--json']),
            /real dsh-ext payload is required/,
        )
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('the bundle installer documents its commands and reports an uninstalled home', async () => {
    const { stdout } = await run(process.execPath, [installScript, '--help'])
    for (const fragment of ['install', 'upgrade', 'rollback', 'status', 'verify', 'prune', '--dsh-home', 'waiting-idle']) {
        assert.ok(stdout.includes(fragment), `installer help must mention ${fragment}`)
    }
    const root = await mkdtemp(join(scratchRoot(), 'hapi-dsh-bundle-status-'))
    try {
        const status = await run(process.execPath, [installScript, 'status', '--json', '--dsh-home', join(root, 'dsh')])
        const parsed = JSON.parse(status.stdout) as { ok: boolean; profiles: Record<string, unknown> }
        assert.equal(parsed.ok, true)
        assert.deepEqual(parsed.profiles, {})
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
