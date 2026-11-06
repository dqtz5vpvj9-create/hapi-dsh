/** Storage boundary for jsdom, which has no IndexedDB. Browser transactions are
 * exercised separately with the native IndexedDB implementation. */
import type { OperationTransactions } from '../../src/client/remote-operation-ledger.ts'
export function memoryOperations(): OperationTransactions {
  const records = new Map<string, string | null>()
  return { async read(id) { return records.get(id) }, async transition(id, update, mirror) {
    const prior = records.get(id)
    const next = update(prior ?? undefined, prior === null)
    mirror(next); records.set(id, next); return next
  } }
}
