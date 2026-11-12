import type { WorkspaceCatalogRow } from '../client/controller.ts'
import type { PaneReadingTarget } from '../client/reading-intent.ts'
import { sourceProjection } from './presentation.ts'

export function pendingTarget(row: WorkspaceCatalogRow): PaneReadingTarget {
    const source = sourceProjection(row)
    const request = source?.pendingRequests[0]
    return request ? { kind: 'approval', requestId: request.id } : { kind: 'latest' }
}
