/** Explicit API fakes exercise client CAS/idempotency; real gateway tests live separately. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { HapiRemoteApi, WorkspaceWrite } from '../src/client-api.ts'
import { createWorkspacePersistence, WorkspaceConflictError } from '../src/client/persistence.ts'
import { initialWorkspace } from '../src/client/model.ts'

function state() { let id = 0; return initialWorkspace(() => `id-${++id}`) }

test('workspace persistence uses server CAS revision, independent of layout revision', async () => {
    const writes: WorkspaceWrite[] = []
    const api: Pick<HapiRemoteApi, 'workspaceGet' | 'workspacePut'> = {
        workspaceGet: async () => ({ ok: true, value: { revision: 70, state: null } }),
        workspacePut: async request => { writes.push(request); return { ok: true, value: { status: 'applied', revision: request.expectedRevision + 1, state: request.state } } },
    }
    const persistence = createWorkspacePersistence(api, () => 'operation-one')
    const signal = new AbortController().signal
    const layout = { ...state(), revision: 4 }
    assert.equal(await persistence.load(signal), null)
    await persistence.save(layout, signal)
    assert.deepEqual(writes, [{ expectedRevision: 70, state: layout, operationId: 'operation-one' }])
})

test('uncertain save retries the same operation before publishing newer geometry', async () => {
    let attempt = 0
    let id = 0
    const writes: WorkspaceWrite[] = []
    const api: Pick<HapiRemoteApi, 'workspaceGet' | 'workspacePut'> = {
        workspaceGet: async () => ({ ok: true, value: { revision: 2, state: null } }),
        workspacePut: async request => {
            writes.push(request)
            if (++attempt === 1) throw new Error('Response lost after server accepted write')
            return { ok: true, value: { status: 'applied', revision: request.expectedRevision + 1, state: request.state } }
        },
    }
    const persistence = createWorkspacePersistence(api, () => `operation-${++id}`)
    const signal = new AbortController().signal
    const first = state()
    await assert.rejects(persistence.save(first, signal), /Response lost/)
    const latest = { ...first, revision: 9 }
    await persistence.save(latest, signal)
    assert.equal(writes.length, 3)
    assert.equal(writes[0], writes[1])
    assert.equal(writes[1]!.operationId, 'operation-1')
    assert.equal(writes[2]!.operationId, 'operation-2')
    assert.equal(writes[2]!.expectedRevision, 3)
    assert.equal(writes[2]!.state, latest)
})

test('CAS conflict exposes the server layout and never silently retries an overwrite', async () => {
    const remote = { ...state(), revision: 99 }
    let calls = 0
    const api: Pick<HapiRemoteApi, 'workspaceGet' | 'workspacePut'> = {
        workspaceGet: async () => ({ ok: true, value: { revision: 1, state: null } }),
        workspacePut: async () => { calls++; return { ok: true, value: { status: 'conflict', revision: 4, state: remote } } },
    }
    const persistence = createWorkspacePersistence(api, () => 'id')
    await assert.rejects(persistence.save(state(), new AbortController().signal), error => error instanceof WorkspaceConflictError && error.latest === remote)
    assert.equal(calls, 1)
})

test('plugin disposal abort prevents any new persistence mutation', async () => {
    let calls = 0
    const api: Pick<HapiRemoteApi, 'workspaceGet' | 'workspacePut'> = {
        workspaceGet: async () => { calls++; return { ok: true, value: { revision: 0, state: null } } },
        workspacePut: async request => { calls++; return { ok: true, value: { status: 'applied', revision: 1, state: request.state } } },
    }
    const abort = new AbortController(); abort.abort()
    await assert.rejects(createWorkspacePersistence(api).save(state(), abort.signal), /abort/i)
    assert.equal(calls, 0)
})
