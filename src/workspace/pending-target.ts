import type { WorkspaceCatalogRow } from '../client/controller.ts'
import type { PaneReadingTarget } from '../client/reading-intent.ts'
import { nativeProjection, observedProjection } from './presentation.ts'

export function pendingTarget(row: WorkspaceCatalogRow): PaneReadingTarget {
    const source = nativeProjection(row) ?? observedProjection(row)
    const request = source?.pendingRequests[0]
    if (request) return { kind: 'approval', requestId: request.requestId }
    const delivery = source?.delivery.find(value => value.state === 'rejected' || value.state === 'indeterminate')
    return delivery ? { kind: 'delivery', localId: delivery.localId } : { kind: 'latest' }
}
