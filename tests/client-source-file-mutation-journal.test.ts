import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserSourceFileMutationStorage } from '../src/client/source-file-mutation-journal.ts'

test('blocked IndexedDB open closes a late successful connection instead of losing its owner', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  let closed = 0
  const request = { result: { close: () => { closed++ } }, error: null, transaction: null,
    onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null } as unknown as IDBOpenDBRequest
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => request } })
  const storage = new BrowserSourceFileMutationStorage()
  try {
    const read = storage.read({ sourceHubId: 'hub', sourceSessionId: 'session', machineId: 'machine' })
    request.onblocked?.call(request, {} as IDBVersionChangeEvent)
    await assert.rejects(read, /blocking.*upgrade/)
    request.onsuccess?.call(request, {} as Event)
    assert.equal(closed, 1)
  } finally {
    storage.close()
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else Reflect.deleteProperty(globalThis, 'indexedDB')
  }
})
