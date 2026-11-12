import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserSourceFileMutationStorage } from '../src/client/source-file-mutation-journal.ts'
import { BrowserNativeDocumentJournal } from '../src/client/native-document-journal.ts'
import { fileOwner } from './source-file-context-fixture.ts'

test('blocked IndexedDB open closes a late successful connection instead of losing its owner', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  let closed = 0
  const request = { result: { close: () => { closed++ } }, error: null, transaction: null,
    onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null } as unknown as IDBOpenDBRequest
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => request } })
  const storage = new BrowserSourceFileMutationStorage()
  try {
    const read = storage.read(fileOwner())
    request.onblocked?.call(request, {} as IDBVersionChangeEvent)
    await assert.rejects(read, /blocking.*upgrade/)
    request.onsuccess?.call(request, {} as Event)
    assert.equal(closed, 1)
  } finally {
    storage.close()
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else Reflect.deleteProperty(globalThis, 'indexedDB')
  }
})

test('a blocked document-draft upgrade releases a late connection and can open storage again', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  let closed = 0, opens = 0
  const request = { result: { close: () => { closed++ } }, error: null, transaction: null,
    onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null } as unknown as IDBOpenDBRequest
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => { opens++; return request } } })
  try {
    const journal = new BrowserNativeDocumentJournal(), first = journal.read('exact-owner')
    request.onblocked?.call(request, {} as IDBVersionChangeEvent)
    await assert.rejects(first, /waiting for another browser window/)
    request.onsuccess?.call(request, {} as Event); assert.equal(closed, 1)
    const second = journal.read('exact-owner'); request.onerror?.call(request, {} as Event)
    await assert.rejects(second, /could not open/); assert.equal(opens, 2)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else Reflect.deleteProperty(globalThis, 'indexedDB')
  }
})
