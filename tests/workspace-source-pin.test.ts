/** Fake source receipt tests. They do not replace real source/browser checks. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { HapiRemoteApi } from '../src/client-api.ts'
import { SourcePinController } from '../src/client/source-pin.tsx'

const ok = <T>(value: T) => ({ ok: true as const, value })
const id = '11111111-1111-4111-8111-111111111111'
type Api = Pick<HapiRemoteApi, 'nativeSourceOperation' | 'nativeOperation' | 'sourceOperation' | 'sourceOperationRead'>

test('native pin unknown result survives reload and only reads the same operation before another mutation', async () => {
    const memory = new Map<string, string>(), writes: unknown[] = [], reads: unknown[] = []
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) } }
    const unused = async (): Promise<never> => { throw new Error('wrong owner') }
    const api: Api = { sourceOperation: unused, sourceOperationRead: unused,
        nativeSourceOperation: async request => { writes.push(request); throw new Error('reply lost') },
        nativeOperation: async request => { reads.push(request); return ok({ operationId: id, scope: 'source', action: 'pin', status: 'confirmed', createdAt: 1, updatedAt: 2, message: null, result: null }) },
    }
    const original = new SourcePinController(api, storage, 'pin', () => id)
    assert.equal(await original.set('display', 'native', 'project'), false)
    assert.equal(await original.set('display', 'native', 'none'), false)
    const restored = new SourcePinController(api, storage, 'pin')
    assert.equal(restored.getSnapshot().pending!.mode, 'project')
    assert.equal(await restored.inspect(), true)
    assert.deepEqual(writes, [{ operationId: id, sessionId: 'display', action: { kind: 'pin', mode: 'project' } }])
    assert.deepEqual(reads, [{ operationId: id }])
    assert.equal(new SourcePinController(api, storage, 'pin').getSnapshot().pending, null)
})

test('observed pin acknowledgement remains unresolved until its source confirms', async () => {
    const requests: unknown[] = []
    const unused = async (): Promise<never> => { throw new Error('wrong owner') }
    const receipt = { operationId: id, sourceSessionId: 'source', logicalSessionId: 'logical', flavor: 'claude', action: { kind: 'pin' as const, mode: 'global' as const },
        status: 'submitted' as const, createdAt: 1, updatedAt: 1, message: null, sourceCode: null, result: null, canReconcile: false, sourceFork: null }
    const api: Api = { nativeSourceOperation: unused, nativeOperation: unused,
        sourceOperation: async request => { requests.push(request); return ok(receipt) },
        sourceOperationRead: async request => { requests.push(request); return ok({ ...receipt, status: 'confirmed', updatedAt: 2 }) },
    }
    const controller = new SourcePinController(api, undefined, 'pin', () => id)
    assert.equal(await controller.set('display', 'observed', 'global'), false)
    assert.equal(controller.getSnapshot().pending!.operationId, id)
    assert.equal(await controller.inspect(), true)
    assert.deepEqual(requests, [{ operationId: id, sessionId: 'display', action: { kind: 'pin', mode: 'global' } }, { operationId: id, action: 'read' }])
})
