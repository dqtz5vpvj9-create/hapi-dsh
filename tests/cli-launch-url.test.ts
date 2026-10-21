import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLaunchUrl, writeLaunchUrl } from '../src/cli/runtime.ts'

const launch = 'https://hapi-dsh.tail.example.test/?token=current-process-token'

test('the launcher login line is parsed and requires the token query', () => {
    assert.equal(parseLaunchUrl(`dsh web: ${launch}`), launch)
    assert.equal(parseLaunchUrl(`noise\r\ndsh web: ${launch}\r`), undefined)
    assert.equal(parseLaunchUrl('dsh web: https://hapi-dsh.tail.example.test/'), undefined)
    assert.equal(parseLaunchUrl('dsh web: not-a-url?token=x'), undefined)
    assert.equal(parseLaunchUrl('unrelated: https://x.test/?token=x'), undefined)
})

test('a restart rewrites the persisted launch URL beside the private config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-launch-'))
    const config = join(directory, 'config.json')
    await writeFile(config, '{}')
    await writeLaunchUrl(config, launch)
    const target = join(directory, 'launch-url')
    assert.equal((await readFile(target, 'utf8')).trim(), launch)
    assert.equal((await stat(target)).mode & 0o777, 0o600)
    const restarted = launch.replace('current-process-token', 'next-process-token')
    await writeLaunchUrl(config, restarted)
    assert.equal((await readFile(target, 'utf8')).trim(), restarted)
})
