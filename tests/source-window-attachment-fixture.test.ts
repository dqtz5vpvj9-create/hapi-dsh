import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { parseObservedHistory } from '../src/hapi-agent/parser.ts'
import { attachmentWindowImages, sourceWindowAttachmentHistory } from './fixtures/source-window-attachment-fixture.ts'

test('attachment acceptance fixture places the old image beyond the three-page opening tail with complete turns', () => {
  const history = sourceWindowAttachmentHistory(), items = parseObservedHistory(history.rows)
  assert.equal(history.rows.length, 1202)
  assert.equal(new Set(history.rows.map(row => row.id)).size, history.rows.length)
  assert.equal(items.filter(item => item.kind === 'user').length, 400)
  assert.equal(items.filter(item => item.kind === 'end').length, 400)
  const images = items.filter(item => item.kind === 'assistant')
    .flatMap(item => item.parts.filter(part => part.type === 'generated-media'))
  assert.deepEqual(images.map(part => part.media.imageId), [attachmentWindowImages.old.imageId, attachmentWindowImages.latest.imageId])
  const tail = parseObservedHistory(history.rows.slice(-600))
  assert.equal(tail.some(item => item.rowId === history.oldMessageId), false)
  assert.equal(tail.some(item => item.kind === 'assistant' && item.parts.some(part =>
    part.type === 'generated-media' && part.media.imageId === attachmentWindowImages.old.imageId)), false)
  assert.equal(tail.some(item => item.kind === 'assistant' && item.parts.some(part =>
    part.type === 'generated-media' && part.media.imageId === attachmentWindowImages.latest.imageId)), true)
})

test('official attachment store accepts both fixture images with distinct durable identities', async () => {
  const directory = await mkdtemp(join('/mnt/cache/data-cache', 'attachment-image-fixture-'))
  const ctx = new Context(), store = new LocalAttachmentStore(ctx, { dshHome: directory })
  try {
    const refs = []
    for (const image of Object.values(attachmentWindowImages)) {
      const ref = await store.saveImage({ data: image.bytes, mediaType: image.mimeType, name: image.fileName })
      assert.equal(ref.width, 1); assert.equal(ref.height, 1)
      assert.equal((await store.readImage(ref)).data.length, ref.bytes)
      refs.push(ref)
    }
    assert.notEqual(refs[0]!.attachmentId, refs[1]!.attachmentId,
      'a recent image must not authorize the old image by sharing its content identity')
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
