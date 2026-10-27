/**
 * Distribution-layer state machine tests: idempotent install, override merging,
 * retention, rollback and the health gate. The official launcher and pnpm are
 * fakes; see host-bundle-support.test.ts.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'
import {
    EXT_PACKAGES, createHarness, logLines, makeExtRelease, seedProfile,
} from './host-bundle-support.test.ts'
import { digest, ops, release } from '../src/cli/release.ts'

test('installing the same manifest twice changes nothing', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile, { '@synthetic/user-owned': '1.2.3' })
        const first = await harness.install('a')
        assert.equal(first.ok, true, first.error)
        assert.equal(first.changed, true)
        assert.equal(first.state, 'healthy')
        assert.equal(first.releaseId, (await harness.state()).profiles[harness.profile]!.active!.releaseId)

        const manifestBefore = await readFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), 'utf8')
        const stateBefore = await readFile(join(release.stateRoot(harness.dshHome), 'state.json'), 'utf8')
        const pluginAddsBefore = (await logLines(harness.logFile)).filter((entry) => entry.kind === 'plugin-add').length
        assert.equal(pluginAddsBefore, 1)

        const second = await harness.install('a')
        assert.equal(second.ok, true)
        assert.equal(second.changed, false)
        assert.equal(second.idempotent, true)
        assert.equal(await readFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), 'utf8'), manifestBefore)
        assert.equal(await readFile(join(release.stateRoot(harness.dshHome), 'state.json'), 'utf8'), stateBefore)
        assert.equal((await logLines(harness.logFile)).filter((entry) => entry.kind === 'plugin-add').length, pluginAddsBefore)

        const profileManifest = await harness.profileManifest()
        const dependencies = profileManifest.dependencies as Record<string, string>
        // The profile links the plugin from the private runtime and carries no
        // second copy of the patched packages.
        assert.equal(dependencies['hapi-dsh'], `link:${join(harness.releaseRoot('a'), 'runtime', 'node_modules', 'hapi-dsh')}`)
        const overrides = (profileManifest.pnpm as { overrides: Record<string, string> }).overrides ?? {}
        assert.equal(overrides['@synthetic/user-owned'], '1.2.3', 'unrelated user overrides are preserved')
        assert.deepEqual(Object.keys(overrides).filter((name) => name !== '@synthetic/user-owned').sort(), [],
            'runtime releases add no profile overrides')
        for (const item of EXT_PACKAGES) {
            assert.equal(existsSync(join(harness.dshHome, 'profiles', harness.profile, 'node_modules', item.name)), false,
                `${item.name} must not be installed into the profile`)
        }
        const inspection = await ops.inspectReleaseState({ dshHome: harness.dshHome, profile: harness.profile })
        assert.equal(inspection.installed, true)
        assert.equal(inspection.manifestHash?.ok, true)
        assert.deepEqual(inspection.extResolution?.flatMap((item) => item.problems), [])
        assert.equal(inspection.link?.ok, true)
        assert.equal(inspection.overridesMatch, true)
        assert.equal(inspection.active?.manifest?.fixture, false)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('the runner role installs the Host-only runner bundle into its profile', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        const installed = await harness.install('a', { role: 'runner' })
        assert.equal(installed.ok, true, installed.error)
        const profileManifest = await harness.profileManifest()
        const dependencies = profileManifest.dependencies as Record<string, string>
        assert.equal(dependencies['hapi-dsh-runner'], `link:${join(harness.releaseRoot('a'), 'package', 'dist', 'runner')}`)
        assert.equal(dependencies['hapi-dsh'], undefined)
        const state = await harness.state()
        assert.equal(state.profiles[harness.profile]!.role, 'runner')
        const inspection = await ops.inspectReleaseState({ dshHome: harness.dshHome, profile: harness.profile })
        assert.equal(inspection.link?.ok, true)
        assert.equal(inspection.link?.name, 'hapi-dsh-runner')
        const again = await harness.install('a', { role: 'runner' })
        assert.equal(again.changed, false)
        assert.equal(again.idempotent, true)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('an existing contributor override is a conflict, never overwritten', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile, { '@deepseek-ai/dsh-client-ui-chat': '0.2.0' })
        const result = await harness.install('a')
        assert.equal(result.ok, false)
        assert.match(result.error ?? '', /override/i)
        assert.equal(result.oldActivePreserved, false)
        const profileManifest = await harness.profileManifest()
        const overrides = (profileManifest.pnpm as { overrides: Record<string, string> }).overrides
        assert.deepEqual(overrides, { '@deepseek-ai/dsh-client-ui-chat': '0.2.0' })
        assert.equal((await harness.state()).profiles[harness.profile]?.active ?? null, null)
        assert.equal((await harness.state()).attempt?.state, 'failed')
        assert.equal((await logLines(harness.logFile)).filter((entry) => entry.kind === 'plugin-add').length, 0)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('an upgrade keeps two previous releases and rollback restores the pointer and profile', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        for (const tag of ['a', 'b', 'c']) assert.equal((await harness.install(tag)).ok, true)
        let state = await harness.state()
        assert.deepEqual(state.profiles[harness.profile]!.previous.map((entry) => entry.releaseId), [harness.releaseId('b'), harness.releaseId('a')])

        assert.equal((await harness.install('d')).ok, true)
        state = await harness.state()
        const previousAfterD = state.profiles[harness.profile]!.previous.map((entry) => entry.releaseId)
        assert.deepEqual(previousAfterD, [harness.releaseId('c'), harness.releaseId('b')], 'two previous releases are retained')
        assert.ok(!existsSync(release.releaseDirectory(harness.dshHome, harness.releaseId('a'))), 'the oldest release is pruned beyond the retention window')
        for (const tag of ['b', 'c', 'd']) assert.ok(existsSync(release.releaseDirectory(harness.dshHome, harness.releaseId(tag))))

        const pluginAddsBefore = (await logLines(harness.logFile)).filter((entry) => entry.kind === 'plugin-add').length
        const rolledBack = await ops.rollbackRelease({
            dshHome: harness.dshHome,
            profile: harness.profile,
            command: harness.command,
            pnpm: harness.pnpm,
            env: { ...process.env, HAPI_DSH_FAKE_LOG: harness.logFile, HAPI_DSH_FAKE_PNPM_LOG: harness.pnpmLog },
            logger: () => {},
            reinstall: harness.reinstall,
        })
        assert.equal(rolledBack.ok, true, rolledBack.error)
        assert.equal(rolledBack.to, previousAfterD[0])
        assert.equal(harness.reinstallCalls.length, 1, 'rollback rebuilds node_modules from the restored lockfile')
        state = await harness.state()
        assert.equal(state.profiles[harness.profile]!.active!.releaseId, previousAfterD[0])
        assert.equal(state.profiles[harness.profile]!.previous[0]!.releaseId, harness.releaseId('d'))
        const afterRollback = await harness.profileManifest()
        const dependencies = afterRollback.dependencies as Record<string, string>
        assert.equal(dependencies['hapi-dsh'],
            `link:${join(release.releaseDirectory(harness.dshHome, previousAfterD[0]!), 'runtime', 'node_modules', 'hapi-dsh')}`)
        const overrides = (afterRollback.pnpm as { overrides: Record<string, string> }).overrides ?? {}
        assert.deepEqual(Object.keys(overrides), [], 'a rollback keeps the runtime-owned design without profile overrides')
        const inspection = await ops.inspectReleaseState({ dshHome: harness.dshHome, profile: harness.profile })
        assert.equal(inspection.overridesMatch, true)
        assert.equal(inspection.manifestHash?.ok, true)
        assert.deepEqual(inspection.previous.flatMap((entry) => entry.error ?? []), [])
        assert.equal((await logLines(harness.logFile)).filter((entry) => entry.kind === 'plugin-add').length, pluginAddsBefore)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('a failed health gate rolls back and keeps the previous active release', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const activeBefore = (await harness.state()).profiles[harness.profile]!.active!.releaseId
        const profileBefore = await readFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), 'utf8')
        const result = await harness.install('b', { env: { HAPI_DSH_FAKE_FAIL: 'health' } })
        assert.equal(result.ok, false)
        assert.equal(result.rolledBack, true)
        assert.equal(result.oldActivePreserved, true)
        assert.match(result.error ?? '', /expected the extended/)
        const state = await harness.state()
        assert.equal(state.profiles[harness.profile]!.active!.releaseId, activeBefore)
        assert.equal(state.profiles[harness.profile]!.previous.length, 0)
        assert.equal(state.attempt?.state, 'failed')
        assert.equal(await readFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), 'utf8'), profileBefore)
        assert.equal(harness.reinstallCalls.length, 1)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('a failed pinned-runtime assembly aborts before activation and keeps the previous release', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const activeBefore = (await harness.state()).profiles[harness.profile]!.active!.releaseId
        const profileBefore = await readFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), 'utf8')
        const result = await harness.install('b', {
            runtimeBuilder: async () => { throw new Error('pinned runtime install failed (injected)') },
        })
        assert.equal(result.ok, false)
        assert.match(result.error ?? '', /pinned runtime install failed/)
        assert.equal(result.oldActivePreserved, true)
        const state = await harness.state()
        assert.equal(state.profiles[harness.profile]!.active!.releaseId, activeBefore)
        assert.equal(state.attempt?.state, 'failed')
        assert.equal(await readFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), 'utf8'), profileBefore)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('a failed plugin install after staging restores the previous profile and release pointer', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const activeBefore = (await harness.state()).profiles[harness.profile]!.active!.releaseId
        const profileBefore = await readFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), 'utf8')
        const result = await harness.install('b', { env: { HAPI_DSH_FAKE_FAIL: 'plugin' } })
        assert.equal(result.ok, false)
        assert.equal(result.oldActivePreserved, true)
        const state = await harness.state()
        assert.equal(state.profiles[harness.profile]!.active!.releaseId, activeBefore)
        assert.equal(state.attempt?.state, 'failed')
        assert.equal(await readFile(join(harness.dshHome, 'profiles', harness.profile, 'package.json'), 'utf8'), profileBefore)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('a busy host stops at waiting-idle and the same command resumes later', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const activeBefore = (await harness.state()).profiles[harness.profile]!.active!.releaseId
        const runtimeFile = release.runtimeFile(harness.dshHome)
        await mkdir(dirname(runtimeFile), { recursive: true })
        await writeFile(runtimeFile, JSON.stringify({ role: 'host', pid: process.pid, startedAt: new Date().toISOString(), busySessions: 2, identity: {} }))
        const waiting = await harness.install('b')
        assert.equal(waiting.ok, true)
        assert.equal(waiting.waiting, true)
        assert.match(waiting.reason ?? '', /ordinary DSH session/)
        assert.equal((await harness.state()).profiles[harness.profile]!.active!.releaseId, activeBefore)
        assert.equal((await harness.state()).attempt?.state, 'waiting-idle')

        await writeFile(runtimeFile, JSON.stringify({ role: 'host', pid: process.pid, startedAt: new Date().toISOString(), busySessions: 0, identity: {} }))
        const resumed = await harness.install('b')
        assert.equal(resumed.ok, true, resumed.error)
        assert.equal(resumed.state, 'healthy')
        assert.equal((await harness.state()).profiles[harness.profile]!.active!.releaseId, harness.releaseId('b'))
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('the state machine rejects skipped transitions and keeps a previous release pointer', () => {
    const attempt = release.startAttempt({ releaseId: 'a'.repeat(64), role: 'host', profile: 'hapi' })
    assert.equal(attempt.state, 'downloaded')
    const verified = release.transitionAttempt(attempt, 'verified')
    assert.throws(() => release.transitionAttempt(verified, 'activating'), /strictly ordered/)
    assert.throws(() => release.transitionAttempt(verified, 'downloaded'), /strictly ordered/)
    const failed = release.failAttempt(verified, new Error('boom'))
    assert.equal(failed.state, 'failed')
    assert.throws(() => release.transitionAttempt(failed, 'staged'), /already finished/)
})

test('override merging preserves user keys, replaces its own and reports conflicts', () => {
    const merged = release.mergeOverrides({
        existing: { '@synthetic/user': '1.0.0', '@deepseek-ai/dsh-client-ui-chat': 'file:../../hapi-dsh/releases/r-old/payload/dsh-ext/chat.tgz' },
        managed: { '@deepseek-ai/dsh-client-ui-chat': 'file:../../hapi-dsh/releases/r-new/payload/dsh-ext/chat.tgz', '@deepseek-ai/dsh-api-session-controller': 'file:../../hapi-dsh/releases/r-new/payload/dsh-ext/sc.tgz' },
        previousManaged: { '@deepseek-ai/dsh-client-ui-chat': 'file:../../hapi-dsh/releases/r-old/payload/dsh-ext/chat.tgz' },
    })
    assert.deepEqual(merged.conflicts, [])
    assert.equal(merged.overrides['@synthetic/user'], '1.0.0')
    assert.match(merged.overrides['@deepseek-ai/dsh-client-ui-chat']!, /r-new/)
    assert.match(merged.overrides['@deepseek-ai/dsh-api-session-controller']!, /r-new/)

    const conflict = release.mergeOverrides({
        existing: { '@deepseek-ai/dsh-client-ui-chat': '0.2.0' },
        managed: { '@deepseek-ai/dsh-client-ui-chat': 'file:../../hapi-dsh/releases/r-new/payload/dsh-ext/chat.tgz' },
        previousManaged: {},
    })
    assert.equal(conflict.conflicts.length, 1)
    assert.equal(conflict.overrides['@deepseek-ai/dsh-client-ui-chat'], '0.2.0')

    const removed = release.mergeOverrides({
        existing: { '@deepseek-ai/dsh-client-ui-chat': 'file:old.tgz' },
        managed: {},
        previousManaged: { '@deepseek-ai/dsh-client-ui-chat': 'file:old.tgz' },
    })
    assert.deepEqual(removed.overrides, {})
    assert.deepEqual(removed.removed, ['@deepseek-ai/dsh-client-ui-chat'])
})
