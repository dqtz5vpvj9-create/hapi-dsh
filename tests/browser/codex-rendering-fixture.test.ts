/** Real fixture preparation and official storage; only native file bytes are synthetic. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceEventIndex } from '../../src/remote/event-index.ts'
import { sourceSessionId, type SourceEntry, type SourceSession } from '../../src/remote/protocol.ts'
import { seedCodexRendering } from './codex-rendering-fixture.ts'

function images(entries: readonly SourceEntry[]) {
  return entries.flatMap(({ event }) => {
    const content = event.type === 'user/message' ? event.data.content : event.type === 'tool/result' ? event.data.message.content : []
    return content.flatMap(block => block.type === 'image' ? [block.attachment] : [])
  })
}

test('Codex browser images publish in their private attachment home without changing its ancestors', { timeout: 5000 }, async () => {
  const outer = await mkdtemp(join(tmpdir(), 'hhpi-browser-storage-'))
  const temporary = join(outer, 'temporary')
  await mkdir(temporary)
  await chmod(outer, 0o751)
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
  process.env.TMPDIR = temporary; process.env.TMP = temporary; process.env.TEMP = temporary
  const identity = { machineId: 'fixture-scope', sourceId: 'fixture-source', engine: 'codex', nativeId: 'fixture-thread' }
  const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic image storage', cwd: '/synthetic',
    updatedAt: 1000, status: 'idle', activeTurnId: null, pendingRequests: [],
    capabilities: { send: true, steer: true, cancel: true, approve: true, files: false } }
  const index = new SourceEventIndex(':memory:', session), lifetime = new AbortController()
  let resources: Awaited<ReturnType<typeof seedCodexRendering>> | undefined
  let changes: AsyncIterator<unknown> | undefined
  try {
    resources = await seedCodexRendering(index, session)
    const page = index.read({ sessionId: session.id, limit: 160 })
    assert.equal(images(page.entries).length, 0, 'the body starts before image bytes are admitted')
    changes = index.changes({ sessionId: session.id, epoch: page.epoch, version: page.version },
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]))[Symbol.asyncIterator]()
    let pending = changes.next()
    resources.schedule(page.entries)
    resources.releaseImages()
    for (;;) {
      assert.equal((await pending).done, false, 'prepared images must publish through source changes')
      const current = index.read({ sessionId: session.id, limit: 160 })
      assert.doesNotMatch(JSON.stringify(current.entries), /Image preview unavailable/, 'official storage must accept both synthetic images')
      const prepared = images(current.entries)
      if (prepared.length === 2) {
        for (const image of prepared) {
          const stored = await resources.read(`attachment:${image.attachmentId}`)
          assert.equal(stored.attachment?.attachmentId, image.attachmentId)
          assert.equal(stored.attachment?.width, 1)
          assert.equal(stored.attachment?.height, 1)
        }
        break
      }
      pending = changes.next()
    }
    const homes = await readdir(temporary)
    assert.equal(homes.length, 1)
    if (process.platform !== 'win32') {
      assert.equal((await stat(outer)).mode & 0o777, 0o751, 'official storage must not chmod the fixture home’s ancestors')
      assert.equal((await stat(join(temporary, homes[0]!))).mode & 0o777, 0o700, 'the attachment home remains private')
    }
    assert.equal((await stat(join(temporary, homes[0]!, 'attachments', 'v1'))).isDirectory(), true)
    assert.equal(resources.snapshot().imageRevisions, 2)
  } finally {
    lifetime.abort(); await changes?.return?.(); await resources?.dispose(); index.dispose()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    await rm(outer, { recursive: true, force: true })
  }
})
