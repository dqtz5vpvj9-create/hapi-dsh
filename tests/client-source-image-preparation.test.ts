/** Browser decoding/encoding is the only fixture; budget allocation and admission input are production code. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareSourceImages, type SourceImageEncoder } from '../src/client/source-image-preparation.ts'
import { SOURCE_IMAGE_BASE64_LIMIT } from '../src/shared/source-image-limits.ts'
const image = (length: number) => ({ mediaType: 'image/png' as const, data: 'A'.repeat(length) })

test('small originals pass through without invoking the local encoder', async () => {
  const original = image(100)
  assert.equal((await prepareSourceImages([original], undefined, async () => { throw new Error('unexpected encoding') }))[0], original)
})

test('oversized multi-image submissions preserve a small original and fit the aggregate wire budget before transport', async () => {
  const originals = [image(200), image(SOURCE_IMAGE_BASE64_LIMIT), image(SOURCE_IMAGE_BASE64_LIMIT)]
  const calls: number[] = []
  const encode: SourceImageEncoder = async (_image, budget) => { calls.push(budget); return { mediaType: 'image/webp', data: 'A'.repeat(budget) } }
  const prepared = await prepareSourceImages(originals, undefined, encode)
  assert.equal(prepared[0], originals[0]); assert.equal(calls.length, 2)
  assert.ok(prepared.reduce((n, value) => n + value.data.length, 0) <= SOURCE_IMAGE_BASE64_LIMIT)
  assert.equal(originals[1]!.data.length, SOURCE_IMAGE_BASE64_LIMIT, 'preparation does not change the retained original attachment')
})

test('aborting local optimization prevents the remaining images from reaching transport', async () => {
  const abort = new AbortController(); let calls = 0
  await assert.rejects(prepareSourceImages([image(SOURCE_IMAGE_BASE64_LIMIT), image(SOURCE_IMAGE_BASE64_LIMIT)], abort.signal,
    async () => { calls++; abort.abort(); return image(4) }), { name: 'AbortError' })
  assert.equal(calls, 1)
})
