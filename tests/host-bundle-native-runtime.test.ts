import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createTgz } from '../scripts/bundle/lib/tar.mjs'
import { prepareNativeRuntimeDependency } from '../scripts/bundle/lib/native-runtime-dependency.mjs'

const name = '@dsh-remote/native-runtime'
const repository = 'https://github.com/example/remote'
const tarball = `${repository}/releases/download/v1/native-runtime.tgz`
const pack = (value: Record<string, unknown>) => createTgz(Object.entries(value).map(([path, data]) => ({ path: `package/${path}`, data: Buffer.from(JSON.stringify(data)) })))

test('a shared runtime install uses only the integrity-pinned local package and caches it across retries', async t => {
  const root = await mkdtemp('/mnt/cache/data-cache/hhpi-native-package-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const native = pack({ 'package.json': { name, version: '1.0.0' } })
  const pin = { package: name, repository, tarball, version: '1.0.0', integrity: `sha512-${createHash('sha512').update(native).digest('base64')}` }
  await writeFile(join(root, 'hapi.tgz'), pack({ 'package.json': { dependencies: { [name]: tarball } }, 'UPSTREAMS.json': { remoteNativeRuntime: pin } }))
  const manifest = { payload: { hapi: { tarball: 'hapi.tgz' } } }
  let downloads = 0
  const options = { releaseRoot: root, manifest, fetchPackage: async (url: string) => {
    assert.equal(url, tarball); downloads++; return new Response(Uint8Array.from(native))
  } }
  assert.deepEqual(await prepareNativeRuntimeDependency(options), ['pnpm-workspace.yaml', 'vendor/native-runtime.tgz'])
  assert.deepEqual(await readFile(join(root, 'runtime/vendor/native-runtime.tgz')), native)
  assert.equal(await readFile(join(root, 'runtime/pnpm-workspace.yaml'), 'utf8'), `overrides:\n  '${name}': 'file:vendor/native-runtime.tgz'\n`)
  await prepareNativeRuntimeDependency(options)
  assert.equal(downloads, 1)
  await writeFile(join(root, 'runtime/vendor/native-runtime.tgz'), 'tampered')
  await assert.rejects(prepareNativeRuntimeDependency(options), /integrity/)
  assert.equal(downloads, 1)
})

test('missing provenance, changed downloads and mismatched identities cannot enter the runtime', async t => {
  for (const failure of ['missing-pin', 'integrity', 'identity'] as const) {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-native-reject-')
    t.after(() => rm(root, { recursive: true, force: true }))
    const bytes = pack({ 'package.json': { name: failure === 'identity' ? 'different' : name, version: '1.0.0' } })
    const pin = { package: name, repository, tarball, version: '1.0.0', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
    await writeFile(join(root, 'hapi.tgz'), pack({ 'package.json': { dependencies: { [name]: tarball } },
      'UPSTREAMS.json': { remoteNativeRuntime: failure === 'missing-pin' ? undefined : pin } }))
    await assert.rejects(prepareNativeRuntimeDependency({ releaseRoot: root, manifest: { payload: { hapi: { tarball: 'hapi.tgz' } } },
      fetchPackage: async () => new Response(Uint8Array.from(failure === 'integrity' ? Buffer.from('different') : bytes)),
    }), failure === 'missing-pin' ? /integrity pin/ : failure === 'integrity' ? /integrity does not match/ : /identity differs/)
    await assert.rejects(readFile(join(root, 'runtime/pnpm-workspace.yaml')), { code: 'ENOENT' })
  }
})
