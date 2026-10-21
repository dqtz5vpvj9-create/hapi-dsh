import { randomId } from './random-id.ts';
import { remoteValue, type HapiRemoteApi, type WorkspaceWrite } from '../client-api.ts'
import type { WorkspacePersistence } from './controller.ts'
import type { WorkspaceState } from './model.ts'

export class WorkspaceConflictError extends Error {
    override readonly name = 'WorkspaceConflictError'
    constructor(readonly latest: WorkspaceState | null) {
        super('Another browser updated this workspace. Choose which layout to keep.')
    }
}

/**
 * One outstanding operation has one idempotency identity. An uncertain network
 * outcome is reconciled using that same operation before a newer layout writes.
 */
export function createWorkspacePersistence(api: Pick<HapiRemoteApi, 'workspaceGet' | 'workspacePut'>, nextId: () => string = () => randomId()): WorkspacePersistence {
    let revision: number | undefined
    let pending: WorkspaceWrite | undefined
    const read = async (signal: AbortSignal): Promise<WorkspaceState | null> => {
        signal.throwIfAborted()
        const document = remoteValue(await api.workspaceGet())
        signal.throwIfAborted()
        revision = document.revision
        return document.state
    }
    const writePending = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        const result = remoteValue(await api.workspacePut(pending!))
        signal.throwIfAborted()
        revision = result.revision
        pending = undefined
        if (result.status === 'conflict') throw new WorkspaceConflictError(result.state)
    }
    return {
        load: read,
        async save(state, signal) {
            if (revision === undefined) await read(signal)
            if (pending) {
                const previous = pending.state
                await writePending(signal)
                if (previous === state) return
            }
            pending = { expectedRevision: revision!, state, operationId: nextId() }
            await writePending(signal)
        },
    }
}
