/** Browser decoding/encoding is the only fixture; budget allocation and admission input are production code. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareSourceImages, prepareSourceImageBlob, type SourceImageEncoder } from '../src/client/source-image-preparation.ts'
import { SOURCE_IMAGE_BASE64_LIMIT } from '../src/shared/source-image-limits.ts'
const image = (length: number) => ({ mediaType: 'image/png' as const, data: 'A'.repeat(length) })

test('small originals still reach dimension inspection and can pass through unchanged', async () => {
  const original = image(100)
  assert.equal((await prepareSourceImages([original], undefined, async value => value))[0], original)
})

test('oversized multi-image submissions preserve a small original and fit the aggregate wire budget before transport', async () => {
  const originals = [image(200), image(SOURCE_IMAGE_BASE64_LIMIT), image(SOURCE_IMAGE_BASE64_LIMIT)]
  const calls: number[] = []
  const encode: SourceImageEncoder = async (_image, budget) => { calls.push(budget); return _image.data.length <= budget ? _image : { mediaType: 'image/webp', data: 'A'.repeat(budget) } }
  const prepared = await prepareSourceImages(originals, undefined, encode)
  assert.equal(prepared[0], originals[0]); assert.equal(calls.length, 3)
  assert.ok(prepared.reduce((n, value) => n + value.data.length, 0) <= SOURCE_IMAGE_BASE64_LIMIT)
  assert.equal(originals[1]!.data.length, SOURCE_IMAGE_BASE64_LIMIT, 'preparation does not change the retained original attachment')
})

test('aborting local optimization prevents the remaining images from reaching transport', async () => {
  const abort = new AbortController(); let calls = 0
  await assert.rejects(prepareSourceImages([image(SOURCE_IMAGE_BASE64_LIMIT), image(SOURCE_IMAGE_BASE64_LIMIT)], abort.signal,
    async () => { calls++; abort.abort(); return image(4) }), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('an original within source byte and raster limits stays byte-identical without canvas encoding', async t => {
  const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const encodes: Array<{ type: string; quality: number | undefined }> = []
  let closed = false
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 480, height: 40000, close() { closed = true } }) })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() {
    return { width: 0, height: 0, getContext() { return { clearRect() {}, drawImage() {} } },
      toBlob(done: (value: Blob) => void, type: string, quality?: number) {
        encodes.push({ type, quality }); done(new Blob([new Uint8Array(250_000)], { type }))
      } }
  } } })
  t.after(() => { for (const [name, old] of [['createImageBitmap', oldBitmap], ['document', oldDocument]] as const) {
    if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name)
  } })
  const original = new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'image/png' })
  const prepared = await prepareSourceImageBlob(original)
  assert.equal(prepared.blob, original)
  assert.equal(prepared.mediaType, 'image/png')
  assert.deepEqual([prepared.width, prepared.height], [480, 40000])
  assert.deepEqual(encodes, [], 'a valid long screenshot must not require a canvas that cannot encode its long edge')
  assert.equal(original.size, 3 * 1024 * 1024); assert.equal(original.type, 'image/png'); assert.equal(closed, true)
})

function webpChunk(kind: string, data: Uint8Array): Buffer<ArrayBuffer> {
  const chunk = Buffer.alloc(8 + data.length + (data.length & 1))
  chunk.write(kind, 0, 'ascii'); chunk.writeUInt32LE(data.length, 4); chunk.set(data, 8)
  return chunk
}
function webpContainer(...chunks: Uint8Array[]): Buffer<ArrayBuffer> {
  const data = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), ...chunks])
  data.writeUInt32LE(data.length - 8, 4); return data
}
function encodedCanvas(t: test.TestContext, blob: Blob): (value: Blob) => void {
  let output = blob
  const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 800, height: 600, close() {} }) })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() {
    return { width: 0, height: 0, getContext(_kind: string, options: unknown) {
      assert.deepEqual(options, { colorSpace: 'srgb' }); return { clearRect() {}, drawImage() {} }
    }, toBlob(done: (value: Blob) => void) { done(output) } }
  } } })
  t.after(() => { for (const [name, old] of [['createImageBitmap', oldBitmap], ['document', oldDocument]] as const) {
    if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name)
  } })
  return value => { output = value }
}
test('new sRGB canvas WebP drops its redundant profile while preserving alpha and compressed pixels', async t => {
  const extended = Uint8Array.of(0x30, 0, 0, 0, 31, 3, 0, 87, 2, 0)
  const alpha = webpChunk('ALPH', Uint8Array.of(0, 128, 255)), pixels = webpChunk('VP8 ', Uint8Array.of(9, 8, 7, 6))
  const encoded = new Blob([webpContainer(webpChunk('VP8X', extended), webpChunk('ICCP', Uint8Array.of(1, 2, 3)), alpha, pixels)], { type: 'image/webp' })
  encodedCanvas(t, encoded)
  const original = new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'image/png' }), prepared = await prepareSourceImageBlob(original, undefined, 2 * 1024 * 1024)
  const retained = Uint8Array.from(extended); retained[0] = 0x10
  assert.deepEqual(Buffer.from(await prepared.blob.arrayBuffer()), webpContainer(webpChunk('VP8X', retained), alpha, pixels))
  assert.equal(original.size, 3 * 1024 * 1024)
  // A user-selected small original is passed through byte-for-byte, including
  // its own profile: only newly rendered sRGB canvas bytes may lose ICCP.
  assert.equal((await prepareSourceImageBlob(encoded)).blob, encoded)
})
test('unrecognized or malformed canvas containers keep their original bytes for source admission', async t => {
  const extended = webpChunk('VP8X', Uint8Array.of(0x20, 0, 0, 0, 31, 3, 0, 87, 2, 0)), profile = webpChunk('ICCP', Uint8Array.of(1)), pixels = webpChunk('VP8 ', Uint8Array.of(9))
  const valid = webpContainer(extended, profile, pixels), invalidLength = Buffer.from(valid); invalidLength.writeUInt32LE(0xfffffff0, 4)
  const invalidChunk = Buffer.from(valid); invalidChunk.writeUInt32LE(0xffffffff, 16)
  const unknown = webpContainer(extended, profile, pixels, webpChunk('XMP ', Uint8Array.of(1)))
  const original = new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'image/png' })
  const setOutput = encodedCanvas(t, new Blob())
  for (const bytes of [invalidLength, invalidChunk, valid.subarray(0, valid.length - 1), unknown]) {
    const encoded = new Blob([bytes], { type: 'image/webp' }); setOutput(encoded)
    assert.equal((await prepareSourceImageBlob(original, undefined, 2 * 1024 * 1024)).blob, encoded)
  }
})
