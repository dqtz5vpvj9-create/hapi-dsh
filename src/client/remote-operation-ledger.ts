/** Canonical operation transitions are serialized across browser contexts. The
 * synchronous admission journal remains available to the official draft API. */
import type { SourceStorage } from './remote-storage.ts'
interface RecordValue { key: string; terminal?: true; value?: string }
const fallback = new WeakMap<Storage, Map<string, RecordValue>>()
let database: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('hhpi-operations-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
  })
}
export interface OperationTransactions {
  read(id: string): Promise<string | null | undefined>
  transition(id: string, update: (value: string | undefined, terminal: boolean) => string | null, mirror: (value: string | null) => void): Promise<string | null>
}
export class RemoteOperationLedger implements OperationTransactions {
  constructor(private readonly access: SourceStorage) {}
  async read(id: string): Promise<string | null | undefined> {
    const key = JSON.stringify([this.access.scope, id])
    if (typeof indexedDB === 'undefined') {
      if (typeof window !== 'undefined') throw new Error('Transactional operation storage is unavailable in this browser.')
      const record = fallback.get(this.access.storage)?.get(key)
      return record?.terminal ? null : record?.value
    }
    const db = await open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('operations', 'readonly')
      const request = transaction.objectStore('operations').get(key)
      request.onsuccess = () => {
        const record = request.result as RecordValue | undefined
        resolve(record?.terminal ? null : record?.value)
      }
      request.onerror = () => reject(request.error)
    })
  }
  async transition(id: string, update: (value: string | undefined, terminal: boolean) => string | null,
    mirror: (value: string | null) => void): Promise<string | null> {
    const key = JSON.stringify([this.access.scope, id])
    const apply = (previous?: RecordValue): RecordValue => {
      const value = update(previous?.value, previous?.terminal === true)
      mirror(value)
      return value === null ? { key, terminal: true } : { key, value }
    }
    // Non-browser contract tests use an in-process Storage boundary. Browsers
    // require IndexedDB; an IndexedDB error never admits a native dispatch.
    if (typeof indexedDB === 'undefined') {
      if (typeof window !== 'undefined') throw new Error('Transactional operation storage is unavailable in this browser.')
      let records = fallback.get(this.access.storage)
      if (!records) { records = new Map(); fallback.set(this.access.storage, records) }
      const record = apply(records.get(key)); records.set(key, record)
      return record.value ?? null
    }
    const db = await open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('operations', 'readwrite'), store = transaction.objectStore('operations')
      const request = store.get(key)
      let record: RecordValue
      request.onsuccess = () => {
        try { record = apply(request.result as RecordValue | undefined); store.put(record) }
        catch (error) { transaction.abort(); reject(error) }
      }
      transaction.oncomplete = () => resolve(record!.value ?? null)
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Operation storage transaction failed.'))
    })
  }
}
