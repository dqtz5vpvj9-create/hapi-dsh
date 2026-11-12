/** Real standalone archive + actual Node subprocesses; only selected browser data is synthetic. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { extractTgz, listTgz } from '../scripts/bundle/lib/tar.mjs'

const execute = promisify(execFile)
test('the separate recovery archive restores selected draft and Blob bytes without product dependencies or source dispatch', async t => {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-offline-distribution-test-')
    t.after(() => rm(root, { recursive: true, force: true }))
    const { stdout } = await execute(process.execPath, ['scripts/migrations/hapi-offline/pack.mjs', '--out', root], { cwd: resolve('.'), timeout: 30000 })
    const packed = JSON.parse(stdout), bytes = await readFile(packed.archive)
    const paths = listTgz(bytes).map(entry => entry.path)
    for (const path of ['package/cli.mjs', 'package/api.mjs', 'package/README.md', 'package/LICENSES/HHPI-AGPL-3.0-only.txt',
        'package/LICENSES/ZOD-MIT.txt', 'package/SOURCE/scripts/migrations/hapi-offline/sessions.ts',
        'package/SOURCE/scripts/migrations/hapi-offline/pack.mjs']) assert.ok(paths.includes(path), path)
    assert.equal(paths.some(path => path.startsWith('package/dist/') || path.includes('/runner-pairings.json')), false)
    await extractTgz(bytes, join(root, 'extracted'))
    const packageRoot = join(root, 'extracted/package'), manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'))
    assert.equal(manifest.productRegistration, false)
    assert.equal(manifest.automaticDispatch, false)
    assert.deepEqual(manifest.bundledDependencies.map((value: { name: string }) => value.name), ['zod'])
    assert.equal(manifest.runtimeImports.some((value: string) => /node:(?:https?|net|tls|child_process)/.test(value)), false)
    const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    assert.equal(metadata.dsh, undefined); assert.equal(metadata.dependencies, undefined)
    const blob = Buffer.from([0, 255, 10, 2]), input = join(root, 'browser.json')
    const original = JSON.stringify({ version: 1, origin: 'https://workspace.example.test', createdAt: 1,
        localStorage: [{ key: 'old-unassigned-draft', value: '未发送草稿' }], databases: [{ name: 'legacy-attachments', version: 1,
            stores: [{ name: 'drafts', records: [{ key: 'original-attachment', value: { $hhpiBlob: 1, type: 'application/octet-stream', data: blob.toString('base64') } }] }] }] })
    await writeFile(input, original)
    const output = join(root, 'private-recovery'), cli = join(packageRoot, 'cli.mjs')
    const run = await execute(process.execPath, [cli, 'recover-browser', '--input', input, '--output', output], { cwd: root, timeout: 10000 })
    const result = JSON.parse(run.stdout)
    assert.equal(result.automaticInstall, false); assert.equal(result.automaticDispatch, false)
    assert.equal(result.status, 'needs-review')
    assert.equal(await readFile(input, 'utf8'), original)
    assert.equal(await readFile(join(output, 'selected/browser-export.json'), 'utf8'), original)
    assert.deepEqual(await readFile(join(output, 'selected/blobs/0.bin')), blob)
    const index = JSON.parse(await readFile(join(output, 'recovery/index.json'), 'utf8'))
    assert.ok(index.objects.length > 0)
    const objects = await Promise.all(index.objects.map((value: { file: string }) => readFile(join(output, 'recovery', value.file), 'utf8')))
    assert.ok(objects.some(value => value.includes('未发送草稿')))
    assert.ok((await readdir(join(output, 'recovery'))).includes('index.html'))
    const resumed = await execute(process.execPath, [cli, 'resume', '--output', join(output, 'recovery')], { cwd: root, timeout: 10000 })
    assert.equal(JSON.parse(resumed.stdout).objects, index.objects.length)
})
