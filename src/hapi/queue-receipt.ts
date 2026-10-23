import type { HapiMessage, HapiQueuedState } from '../codex/contracts.ts'

/** An exact source receipt can update a queue row; absence cannot retire it. */
export function checkedQueueMessage(row: HapiMessage, state: HapiQueuedState): HapiMessage | null {
    if (!row.localId) return row
    if (state.invokedLocalMessages.some(value => value.localId === row.localId)) return null
    if (state.indeterminateLocalIds?.includes(row.localId)) return { ...row, deliveryState: 'indeterminate' }
    if (state.dispatchingLocalIds?.includes(row.localId)) return { ...row, deliveryState: 'dispatching' }
    if (state.queuedLocalIds.includes(row.localId)) {
        const { deliveryState: _previous, ...queued } = row
        return queued
    }
    return row
}
