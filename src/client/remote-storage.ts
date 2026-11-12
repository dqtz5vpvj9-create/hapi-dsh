import { RemoteOperationLedger } from './remote-operation-ledger.ts'
/** Browser persistence is selected by the authenticated Host/account, never by a session label. */
export interface SourceStorage { storage: Storage; scope: string }
export const nativeActionStoragePrefix = (scope: string): string => `hhpi:native-actions:v1:${scope}:`
const clearListeners = new WeakMap<Storage, Set<() => void>>()
export function onSourceStorageClear(storage: Storage, listener: () => void): () => void {
  let listeners = clearListeners.get(storage)
  if (!listeners) { listeners = new Set(); clearListeners.set(storage, listeners) }
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Explicit Host revocation clears only HHPI's retained source data. */
export function clearSourceStorage(storage: Storage): void {
  for (const listener of clearListeners.get(storage) ?? []) listener()
  const retirements: Promise<string | null>[] = []
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith('hhpi:reading:v1:') || key?.startsWith('hhpi:outbox:v1:') || key?.startsWith('hhpi:native-actions:v1:') || key?.startsWith('hhpi:creation:v1:')) keys.push(key)
  }
  for (const key of keys) {
    if (key.startsWith('hhpi:outbox:v1:') || key.startsWith('hhpi:native-actions:v1:') || key.startsWith('hhpi:creation:v1:')) {
      const separator = key.lastIndexOf(':')
      const prefix = key.startsWith('hhpi:outbox:v1:') ? 'hhpi:outbox:v1:' : key.startsWith('hhpi:creation:v1:') ? 'hhpi:creation:v1:' : 'hhpi:native-actions:v1:'
      const scope = key.slice(prefix.length, separator)
      const id = decodeURIComponent(key.slice(separator + 1))
      retirements.push(new RemoteOperationLedger({ storage, scope }).transition(id, () => null, () => storage.removeItem(key)))
    }
    storage.removeItem(key)
  }
  void Promise.all(retirements).catch(() => { console.error('HHPI could not finish clearing transactional operation storage.') })
}

export function browserSourceStorage(scope?: string): SourceStorage | undefined {
  const identity: unknown = scope ?? Reflect.get(globalThis, '__HHPI_STORAGE_SCOPE__')
  if (typeof identity !== 'string' || !identity.trim()) return undefined
  try { return { storage: localStorage, scope: identity } } catch { return undefined }
}
