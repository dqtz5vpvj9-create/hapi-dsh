import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceFileMutation, sourceFileContains, validSourceFileName } from '../src/client/source-file-management.ts'
import type { NativeWorkbenchApi } from '../src/workbench-types.ts'

test('source file mutation retains unknown identity, inspects both paths, and never replays during recovery', async () => {
  const writes: unknown[] = [], reads: string[] = []
  const api: Pick<NativeWorkbenchApi, 'nativeFileManage' | 'nativeFileUpload' | 'nativeFileInspect'> = {
    nativeFileManage: async request => { writes.push(request); throw new Error('Connection lost after source rename') },
    nativeFileUpload: async request => { writes.push(request); return { ok: true, value: { success: true } } },
    nativeFileInspect: async request => { reads.push(request.path); return { ok: true, value: { success: false, code: 'not-found' } } },
  }
  const model = new SourceFileMutation(api, { sourceSessionId: 'source-a', machineId: 'machine-a' })
  await model.manage({ action: 'rename', path: '/source/first', destination: '/source/second', expectedRevision: 'a'.repeat(64) })
  assert.equal(model.getSnapshot().uncertain, true)
  await model.manage({ action: 'delete', path: '/source/first', expectedRevision: 'a'.repeat(64), recursive: false })
  await model.upload('/source/new', 'YQ=='); assert.equal(writes.length, 1)
  assert.equal(model.review(), false)
  await model.inspect(); assert.deepEqual(reads, ['/source/first', '/source/second']); assert.equal(writes.length, 1)
  assert.equal(model.getSnapshot().uncertain, true)
  assert.equal(model.review(), true)
  await model.upload('/source/new', 'YQ=='); assert.equal(writes.length, 2)
})

test('partial delete and committed rename metadata survive the failure response', async () => {
  const result = { success: false, error: 'Cannot inspect new path', commit: { action: 'rename' as const, path: '/a', destination: '/b' } }
  const model = new SourceFileMutation({ nativeFileManage: async () => ({ ok: true, value: result }),
    nativeFileUpload: async () => ({ ok: true, value: { success: true } }),
    nativeFileInspect: async () => ({ ok: true, value: { success: false, code: 'denied' } }),
  }, { sourceSessionId: 'source-a' })
  await model.manage({ action: 'rename', path: '/a', destination: '/b', expectedRevision: 'a'.repeat(64) })
  assert.deepEqual(model.getSnapshot().result?.commit, result.commit)
  await model.inspect(); assert.equal(model.review(), false)
})

test('source path guards cover descendant drafts and reject ambiguous creation names', () => {
  assert.equal(sourceFileContains('/work/a', '/work/a/file'), true)
  assert.equal(sourceFileContains('/work/a', '/work/ab/file'), false)
  assert.equal(sourceFileContains('C:\\Work\\A', 'c:/work/a/file'), true)
  assert.equal(sourceFileContains('/Work/A', '/work/a'), false)
  for (const value of ['.', '..', ' ', 'a/b', 'a\\b', 'C:drive', 'a\0b']) assert.equal(validSourceFileName(value), false)
  assert.equal(validSourceFileName('你好 source.txt'), true)
})
