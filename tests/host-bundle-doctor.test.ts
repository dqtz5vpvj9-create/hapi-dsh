/**
 * Doctor coverage for the bundle checks: manifest hash, ext capability set,
 * actual resolution paths, DSH singleton duplicates, Host/Runner release
 * identity, current/previous release integrity — and output redaction.
 *
 * The official launcher and pnpm are the fakes from host-bundle-support; the
 * install they perform is real filesystem state built by the bundle library.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { doctor, type DoctorCheck, type DoctorResult } from '../src/cli/doctor.ts'
import type { RuntimeConfig } from '../src/cli/config.ts'
import { createHarness, repositoryRoot, seedProfile, type Harness } from './host-bundle-support.test.ts'
import { ops, release } from '../src/cli/release.ts'

const TOKEN = 'doctor-secret-token-value'

function configFor(harness: Harness): RuntimeConfig {
    return {
        version: 1,
        dsh: { home: harness.dshHome, profile: harness.profile },
        hapi: { id: '00000000-0000-4000-8000-000000000000', url: 'http://127.0.0.1:9', tokenEnv: 'HAPI_DSH_TOKEN', token: TOKEN },
        server: { host: '127.0.0.1', port: 0 },
    }
}

async function runDoctor(harness: Harness): Promise<DoctorResult> {
    return doctor(configFor(harness), join(harness.root, 'config.json'), {
        packageRoot: repositoryRoot,
        offline: true,
        command: harness.command,
        run: async (command, options) => command.executable === 'pnpm'
            ? { exitCode: 0, stdout: '11.28.5\n', stderr: '' }
            : ops.defaultRun(command, options),
    })
}

function check(result: DoctorResult, name: string): DoctorCheck {
    const found = result.checks.find((entry) => entry.name === name)
    assert.ok(found, `doctor must report a ${name} check`)
    return found
}

test('doctor verifies an installed bundle release without leaking paths or credentials', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const result = await runDoctor(harness)
        const report = JSON.stringify(result)
        assert.ok(!report.includes(harness.dshHome), 'doctor output must redact the DSH home path')
        assert.ok(!report.includes(TOKEN), 'doctor output must never contain the HAPI token')
        assert.equal(result.ok, true, JSON.stringify(result.checks.filter((entry) => entry.status === 'fail')))

        assert.equal(check(result, 'node').status, 'pass')
        assert.equal(check(result, 'pnpm').status, 'pass')
        assert.equal(check(result, 'manifest-hash').status, 'pass')
        assert.equal(check(result, 'release-integrity').status, 'warn', 'a first install has no previous release yet')
        assert.equal(check(result, 'ext-capabilities').status, 'pass')
        assert.equal(check(result, 'ext-resolution').status, 'pass')
        assert.equal(check(result, 'profile-overrides').status, 'pass')
        assert.equal(check(result, 'data-format').status, 'pass')
        assert.equal(check(result, 'licenses').status, 'pass')
        assert.equal(check(result, 'dsh-singletons').status, 'warn', 'the fake profile has no pnpm virtual store')
        assert.equal(check(result, 'release-identity').status, 'warn', 'no runtime snapshot is present yet')
        assert.equal(check(result, 'host-runner-identity').status, 'warn', 'only the Host identity is recorded locally')
        assert.equal(check(result, 'dsh-version').status, 'pass')
        assert.equal(check(result, 'profile').status, 'pass')
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('doctor fails when a live Host identity differs from the active release', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const inspection = await ops.inspectReleaseState({ dshHome: harness.dshHome, profile: harness.profile })
        const identity = inspection.active!.identity!
        const runtimeFile = release.runtimeFile(harness.dshHome)
        await mkdir(dirname(runtimeFile), { recursive: true })

        await writeFile(runtimeFile, JSON.stringify({ role: 'host', pid: process.pid, startedAt: new Date().toISOString(), busySessions: 0, identity }))
        let result = await runDoctor(harness)
        assert.equal(check(result, 'release-identity').status, 'pass')

        await writeFile(runtimeFile, JSON.stringify({ role: 'host', pid: process.pid, startedAt: new Date().toISOString(), busySessions: 0, identity: { ...identity, upstreamCommit: 'f'.repeat(40) } }))
        result = await runDoctor(harness)
        const mismatch = check(result, 'release-identity')
        assert.equal(mismatch.status, 'fail')
        assert.match(mismatch.detail, /upstreamCommit/)
        assert.equal(result.ok, false)
        assert.ok(!JSON.stringify(result).includes(harness.dshHome))
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('doctor reports Host and Runner identity drift recorded in one DSH home', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const inspection = await ops.inspectReleaseState({ dshHome: harness.dshHome, profile: harness.profile })
        const manifest = (await release.readManifestFrom(inspection.active!.directory))
        let state = await release.readBundleState(harness.dshHome)
        const activatedAt = new Date().toISOString()
        state = release.commitActivation(state, 'hapi-runner', {
            releaseId: manifest.releaseId, role: 'runner', activatedAt, manifest,
            manifestSha256: inspection.manifestSha256!, treeDigest: inspection.integrity!.treeDigest,
            managedOverrides: inspection.managedOverrides,
        })
        await release.writeBundleState(harness.dshHome, state)
        let result = await runDoctor(harness)
        assert.equal(check(result, 'host-runner-identity').status, 'pass')

        const driftedManifest = structuredClone(manifest)
        driftedManifest.release.extRelease = '0.2.1-rc.3.ext.drifted'
        driftedManifest.releaseId = release.computeReleaseId(driftedManifest)
        state = await release.readBundleState(harness.dshHome)
        state = release.commitActivation(state, 'hapi-runner', {
            releaseId: driftedManifest.releaseId, role: 'runner', activatedAt, manifest: driftedManifest,
            manifestSha256: inspection.manifestSha256!, treeDigest: inspection.integrity!.treeDigest,
            managedOverrides: inspection.managedOverrides,
        })
        await release.writeBundleState(harness.dshHome, state)
        result = await runDoctor(harness)
        const drift = check(result, 'host-runner-identity')
        assert.equal(drift.status, 'fail')
        assert.match(drift.detail, /extRelease/)
        assert.equal(result.ok, false)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('doctor detects a corrupt previous release', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        assert.equal((await harness.install('b')).ok, true)
        let result = await runDoctor(harness)
        assert.equal(check(result, 'release-integrity').status, 'warn', 'two releases are required before the retention check passes')

        const state = await release.readBundleState(harness.dshHome)
        const previous = state.profiles[harness.profile]!.previous[0]!
        assert.equal((await harness.install('c')).ok, true)
        await rm(release.releaseDirectory(harness.dshHome, previous.releaseId), { recursive: true, force: true })
        result = await runDoctor(harness)
        const integrity = check(result, 'release-integrity')
        assert.equal(integrity.status, 'fail')
        assert.match(integrity.detail, /r-[a-f0-9]{16}/)
        assert.equal(result.ok, false)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('doctor fails when the active release manifest was tampered with', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const inspection = await ops.inspectReleaseState({ dshHome: harness.dshHome, profile: harness.profile })
        const manifestPath = join(inspection.active!.directory, 'manifest.json')
        await writeFile(manifestPath, `${await readFile(manifestPath, 'utf8')} `)
        const result = await runDoctor(harness)
        assert.equal(check(result, 'manifest-hash').status, 'fail')
        assert.equal(result.ok, false)
        const report = JSON.stringify(result)
        assert.ok(!report.includes(harness.dshHome))
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('a source (link:) installation skips bundle checks instead of failing', async () => {
    const harness = await createHarness()
    try {
        await mkdir(join(harness.dshHome, 'profiles', harness.profile), { recursive: true })
        await writeFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), JSON.stringify({
            name: `dsh-profile-${harness.profile}`,
            private: true,
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'hapi-dsh'] } },
            dependencies: { 'hapi-dsh': 'link:/opt/hapi-dsh' },
        }, null, 2))
        const result = await runDoctor(harness)
        assert.equal(check(result, 'bundle-release').status, 'skipped')
        assert.equal(result.ok, true)
        assert.ok(!result.checks.some((entry) => entry.name === 'manifest-hash'))
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('the test harness never leaves release directories behind', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const files = await readdir(join(release.stateRoot(harness.dshHome), 'releases'))
        assert.equal(files.length, 1)
        assert.match(files[0]!, /^r-[a-f0-9]{16}$/)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})
