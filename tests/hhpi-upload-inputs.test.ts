/** Real source upload receipt IO; the native writer must remain unused during receipt resolution. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CodexUploads } from '../src/remote/codex-uploads.ts'
import type { CodexAccessBridge } from '../src/remote/codex-access-bridge.ts'

test('source upload inputs preserve exact stored paths across restart and refuse cross-session receipts or cancellation', async t => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-structured-upload-')
  t.after(async () => { await rm(directory, { recursive: true }) })
  const sessionId = 'hhpi:machine:source:codex:original', file = '00000000-0000-4000-8000-000000000001', image = '00000000-0000-4000-8000-000000000002'
  await writeFile(join(directory, file + '.json'), JSON.stringify({ sessionId, name: 'notes.txt', path: '/native/exact/notes.txt', bytes: 5 }))
  await writeFile(join(directory, image + '.json'), JSON.stringify({ sessionId, name: 'image.png', path: '/native/exact/image.png', bytes: 1, image: true }))
  const uploads = new CodexUploads(directory, { call() { throw new Error('Receipt resolution must not execute native writes') } } as unknown as CodexAccessBridge)
  assert.deepEqual(await uploads.inputs(sessionId, [file, image]), [
    { type: 'text', text: 'Attached file "notes.txt": "/native/exact/notes.txt"', text_elements: [] }, { type: 'localImage', path: '/native/exact/image.png' },
  ])
  await assert.rejects(uploads.inputs('hhpi:machine:source:codex:another', [image]), /another source session/)
  await assert.rejects(uploads.inputs(sessionId, ['/native/path']), /Invalid file upload receipt/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(uploads.inputs(sessionId, [image], cancelled.signal), { name: 'AbortError' })
})
