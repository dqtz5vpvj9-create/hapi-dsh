/** Explicit fake RPC tests for source creation intent/recovery, not Runner execution. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { HapiRemoteApi } from '../src/client-api.ts'
import type { CreateSourceSession, SourceCreationState } from '../src/hapi-agent/creation-types.ts'
import { sourceCreationRequest, SourceCreationController, type SourceLaunchFields } from '../src/client/source-creation.ts'

const id = '11111111-1111-4111-8111-111111111111'
const fields = (patch: Partial<SourceLaunchFields> = {}): SourceLaunchFields => ({ agent: 'claude', machineId: 'machine', directory: '/repo', model: '', effort: '', reasoning: '', permission: '', startingMode: 'remote', copilotMode: '', worktree: false, worktreeName: '', ...patch })
const ok = <T>(value: T) => ({ ok: true as const, value })
const row = (request: CreateSourceSession, patch: Partial<SourceCreationState> = {}): SourceCreationState => ({ requestId: request.requestId, request, status: 'accepted', sourceSessionId: 'source', nativeId: null, sessionId: null, registrationObservedAt: null, createdAt: 1, updatedAt: 2, message: null, sourceCode: null, ...patch })

test('source launch only passes supported original options and never aliases a Pi model to Codex', () => {
    assert.deepEqual(sourceCreationRequest(fields(), id), { requestId: id, agent: 'claude', machineId: 'machine', directory: '/repo', startingMode: 'remote', sessionType: 'simple' })
    assert.equal(sourceCreationRequest(fields({ agent: 'pi', model: 'provider/actual-model', effort: 'high', startingMode: 'pty' }), id).model, 'provider/actual-model')
    assert.equal(sourceCreationRequest(fields({ agent: 'opencode', model: 'provider/model', reasoning: 'high' }), id).modelReasoningEffort, 'high')
    assert.throws(() => sourceCreationRequest(fields({ agent: 'dsh', startingMode: 'pty' }), id), /only supports remote/)
    assert.throws(() => sourceCreationRequest(fields({ agent: 'pi', permission: 'yolo' }), id), /permission mode/)
    assert.throws(() => sourceCreationRequest(fields({ agent: 'cursor', effort: 'high' }), id), /does not accept effort/)
    assert.equal(sourceCreationRequest(fields({ worktree: true }), id).sessionType, 'worktree')
    assert.equal(sourceCreationRequest(fields({ worktree: true }), id).worktreeName, undefined)
})

test('lost creation replies preserve immutable request across browser remounts and polling never launches', async () => {
    const saved = new Map<string, string>()
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) } }
    const writes: CreateSourceSession[] = [], observations: unknown[] = []
    let source: SourceCreationState[] = []
    const api: Pick<HapiRemoteApi, 'createSourceSession' | 'sourceCreations' | 'sourceCreationOperation'> = {
        createSourceSession: async request => { writes.push(request); source = [row(request)]; throw new Error('reply lost') },
        sourceCreations: async () => ok(source),
        sourceCreationOperation: async request => { observations.push(request); return ok(source[0]!) },
    }
    const first = new SourceCreationController(api, () => id, storage, 'recovery')
    await first.start(fields())
    assert.equal(first.getSnapshot().request!.requestId, id)
    const remounted = new SourceCreationController(api, () => 'unused-new-id', storage, 'recovery')
    assert.equal(remounted.getSnapshot().request!.requestId, id)
    await remounted.refresh()
    assert.equal(await remounted.start(fields({ directory: '/another' })), null)
    assert.equal(writes.length, 1)
    assert.deepEqual(observations, [{ requestId: id, action: 'read' }])
    await remounted.recover()
    assert.deepEqual(observations.at(-1), { requestId: id, action: 'reconcile' })
    assert.equal(writes.length, 1)
    source = [row(writes[0]!, { status: 'ready', sessionId: 'display-ready', nativeId: 'source-thread', registrationObservedAt: 3, updatedAt: 4 })]
    await remounted.refresh()
    assert.equal(remounted.current()!.sessionId, 'display-ready')
    remounted.acknowledgeOpened(id)
    assert.equal(new SourceCreationController(api, () => id, storage, 'recovery').getSnapshot().request, null)
})

test('recovery before a receipt is known resends only the original payload on an explicit action', async () => {
    const writes: CreateSourceSession[] = []
    const api: Pick<HapiRemoteApi, 'createSourceSession' | 'sourceCreations' | 'sourceCreationOperation'> = {
        createSourceSession: async request => { writes.push(request); if (writes.length === 1) throw new Error('transport not available'); return ok(row(request)) },
        sourceCreations: async () => ok([]), sourceCreationOperation: async () => { throw new Error('no receipt') },
    }
    const controller = new SourceCreationController(api, () => id)
    await controller.start(fields({ model: 'original-model' }))
    await controller.refresh(); await controller.refresh()
    assert.equal(writes.length, 1)
    assert.equal(await controller.start(fields({ model: 'another-model' })), null)
    await controller.recover()
    assert.deepEqual(writes[1], writes[0])
    assert.equal(writes.length, 2)
})
