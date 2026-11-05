import { RemoteOperationLedger } from './remote-operation-ledger.ts'
/** Browser persistence is selected by the authenticated Host/account, never by a session label. */
export interface SourceStorage { storage: Storage; scope: string }

/** Explicit Host revocation clears only HHPI's retained source data. */
export function clearSourceStorage(storage: Storage): void {
  const retirements: Promise<string | null>[] = []
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith('hhpi:reading:v1:') || key?.startsWith('hhpi:outbox:v1:')) keys.push(key)
  }
  for (const key of keys) {
    if (key.startsWith('hhpi:outbox:v1:')) {
      const separator = key.lastIndexOf(':')
      const scope = key.slice('hhpi:outbox:v1:'.length, separator)
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
