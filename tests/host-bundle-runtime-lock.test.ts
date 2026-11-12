import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHarness } from './host-bundle-support.test.ts'
import { release } from '../src/cli/release.ts'
import { prepareRuntime, reuseRuntimeLockfile } from '../scripts/bundle/lib/runtime.mjs'

// The official launcher/pnpm are process fixtures. The verified release store,
// runtime seal, source selection and lockfile transfer execute unchanged.
async function fixture(t: any) {
  const previous = process.env.HAPI_DSH_TEST_ROOT
  process.env.HAPI_DSH_TEST_ROOT = '/mnt/cache/data-cache'
  let harness: Awaited<ReturnType<typeof createHarness>>
  try { harness = await createHarness() } finally {
    if (previous === undefined) delete process.env.HAPI_DSH_TEST_ROOT
    else process.env.HAPI_DSH_TEST_ROOT = previous
  }
  t.after(() => rm(harness.root, { recursive: true, force: true }))
  assert.equal((await harness.install('a')).ok, true)
  const old = harness.releaseRoot('a'), runtime = join(old, 'runtime')
  const manifest = (await release.verifyReleaseDirectory(old)).manifest
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'hapi-dsh-runtime', private: true, version: String(manifest.version), dependencies: {
    '@deepseek-ai/dsh': manifest.release.upstreamVersion, 'hapi-dsh': `file:${join(old, manifest.payload.hapi.tarball)}`,
  } }))
  await mkdir(join(runtime, 'node_modules/.pnpm'), { recursive: true })
  const lock = 'lockfileVersion: 9.0\n# installed fixture resolution\n'
  await writeFile(join(runtime, 'pnpm-lock.yaml'), lock)
  await writeFile(join(runtime, 'node_modules/.pnpm/lock.yaml'), lock)
  await writeFile(join(runtime, 'node_modules/.modules.yaml'), JSON.stringify({ packageManager: 'pnpm@11.28.5' }))
  return { harness, runtime, lock }
}

test('an upgrade seeds only the activated runtime lock and a later install failure keeps the old active release', async t => {
  const { harness, runtime, lock } = await fixture(t)
  let source: any
  const result = await harness.install('b', { runtimeBuilder: async (options: any) => {
    assert.equal(options.previousReleaseRoot, harness.releaseRoot('a'))
    assert.equal(options.pnpmVersion, '11.28.5')
    await mkdir(join(options.releaseRoot, 'runtime'))
    source = await reuseRuntimeLockfile(options)
    assert.equal(source.releaseId, harness.releaseId('a'))
    assert.equal(await readFile(join(options.releaseRoot, 'runtime/pnpm-lock.yaml'), 'utf8'), lock)
    await assert.rejects(readFile(join(options.releaseRoot, 'runtime/node_modules/.modules.yaml')), { code: 'ENOENT' })
    throw Error('injected install failed after lock reuse')
  } })
  assert.equal(result.ok, false)
  assert.match(result.error!, /injected install failed/)
  assert.equal((await harness.state()).profiles[harness.profile]!.active!.releaseId, harness.releaseId('a'))
  assert.equal(await readFile(join(runtime, 'pnpm-lock.yaml'), 'utf8'), lock)
})

test('an untrusted old lock or different pnpm falls back to the normal installer without seeding', async t => {
  const { harness, runtime, lock } = await fixture(t)
  await writeFile(join(runtime, 'pnpm-lock.yaml'), 'untrusted edit\n')
  let normalInstall = 0
  const result = await harness.install('b', { runtimeBuilder: (options: any) => prepareRuntime({ ...options,
    run: async (_command: any, settings: any) => {
      normalInstall++
      await assert.rejects(readFile(join(settings.cwd, 'pnpm-lock.yaml')), { code: 'ENOENT' })
      return { exitCode: 1, stdout: '', stderr: 'normal pnpm install reached' }
    },
  }) })
  assert.equal(result.ok, false)
  assert.match(result.error!, /normal pnpm install reached/)
  assert.equal(normalInstall, 1)
  await writeFile(join(runtime, 'pnpm-lock.yaml'), lock)
  assert.equal(await reuseRuntimeLockfile({ releaseRoot: harness.releaseRoot('b'), manifest: (await release.verifyReleaseDirectory(harness.releaseRoot('b'))).manifest,
    previousReleaseRoot: harness.releaseRoot('a'), pnpmVersion: '11.28.6' }), undefined)
})

test('an existing target lock survives manifest replacement and is never overwritten by the previous release', async t => {
  const { harness } = await fixture(t)
  const lock = 'existing target attempt resolution\n'
  const result = await harness.install('b', { runtimeBuilder: async (options: any) => {
    const directory = join(options.releaseRoot, 'runtime')
    await mkdir(directory)
    await writeFile(join(directory, 'package.json'), '{"outdated":true}')
    await writeFile(join(directory, 'pnpm-lock.yaml'), lock)
    return prepareRuntime({ ...options, run: async (_command: any, settings: any) => {
      assert.equal(await readFile(join(settings.cwd, 'pnpm-lock.yaml'), 'utf8'), lock)
      return { exitCode: 1, stdout: '', stderr: 'normal update of the target lock' }
    } })
  } })
  assert.match(result.error!, /normal update of the target lock/)
  assert.equal(await readFile(join(harness.releaseRoot('b'), 'runtime/pnpm-lock.yaml'), 'utf8'), lock)
})
