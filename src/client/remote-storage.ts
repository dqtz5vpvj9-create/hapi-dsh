/** Browser persistence is selected by the authenticated Host/account, never by a session label. */
export interface SourceStorage { storage: Storage; scope: string }

/** Explicit Host revocation clears only HHPI's retained source data. */
export function clearSourceStorage(storage: Storage): void {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith('hhpi:reading:v1:') || key?.startsWith('hhpi:outbox:v1:')) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}

export function browserSourceStorage(scope?: string): SourceStorage | undefined {
  const identity: unknown = scope ?? Reflect.get(globalThis, '__HHPI_STORAGE_SCOPE__')
  if (typeof identity !== 'string' || !identity.trim()) return undefined
  try { return { storage: localStorage, scope: identity } } catch { return undefined }
}
