import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionHeaderCwd } from '../src/hapi/session-header-cwd.ts'

test('POSIX source paths are preserved as the local header cwd', () => {
  assert.equal(sessionHeaderCwd('/home/chris/project'), '/home/chris/project')
  assert.equal(sessionHeaderCwd('/'), '/')
})

test('Windows drive paths become POSIX-absolute without losing the drive', () => {
  assert.equal(sessionHeaderCwd('C:\\Users\\lixinrui\\Documents'), '/C:/Users/lixinrui/Documents')
  assert.equal(sessionHeaderCwd('d:/work/项目'), '/D:/work/项目')
})

test('UNC paths and relative paths still produce valid headers', () => {
  assert.equal(sessionHeaderCwd('\\\\server\\share\\dir'), '/unc/server/share/dir')
  assert.equal(sessionHeaderCwd('relative/dir'), '/relative/dir')
  assert.equal(sessionHeaderCwd(''), '/')
  assert.equal(sessionHeaderCwd(undefined), '/')
})
