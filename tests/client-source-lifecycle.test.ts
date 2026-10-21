import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { SourceLifecycleController, sourceOperationDisplayId, sourceOperationSuccessorId } from '../src/client/source-lifecycle.tsx'
import type { SourceOperation, SourceOperationRead, SourceOperationReceipt, SourceSessionTools } from '../src/hapi-agent/lifecycle-types.ts'

/** Browser transport fixture; no model credentials or original Runner execution are implied. */
class Api {
    readonly writes: SourceOperation[] = []
    readonly reads: SourceOperationRead[] = []
    receipt: SourceOperationReceipt | undefined
    failReply = false
    failRead = false
    tools: SourceSessionTools = {
        sessionId: 'display', sourceSessionId: 'source', nativeId: 'original-thread', flavor: 'pi', active: true,
        readOnly: false, lifecycleState: 'running', summary: '', pinMode: 'none', forkSource: null, warnings: [], operations: [],
        capabilities: { archive: true, reopen: false, resume: false, restart: true, delete: false, clear: false,
            summary: true, pin: true, forkCurrent: true, forkAtMessage: true, rewind: true },
    }
    async sourceSessionTools() { return { ok: true as const, value: structuredClone({ ...this.tools, operations: this.receipt ? [this.receipt] : [] }) } }
    async sourceOperation(request: SourceOperation) {
        this.writes.push(structuredClone(request))
        this.receipt = { operationId: request.operationId, sourceSessionId: 'source', logicalSessionId: 'display', flavor: 'pi',
            action: request.action, status: 'indeterminate', createdAt: 100, updatedAt: 100,
            message: 'The original source reply was lost', sourceCode: null, result: null, canReconcile: false, sourceFork: null }
        if (this.failReply) throw new Error('Browser disconnected after admission')
        return { ok: true as const, value: structuredClone(this.receipt) }
    }
    async sourceOperationRead(request: SourceOperationRead) {
        this.reads.push(structuredClone(request))
        if (this.failRead || !this.receipt) throw new Error('Receipt temporarily unavailable')
        return { ok: true as const, value: structuredClone(this.receipt) }
    }
}
function storage() {
    const entries = new Map<string, string>()
    return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) } }
}

test('a lost source mutation reply survives browser reconstruction as the same operation and only reads', async () => {
    const api = new Api(), saved = storage(), operationId = randomUUID()
    const controller = new SourceLifecycleController(api, 'display', saved, () => operationId)
    await controller.refresh(); api.failReply = true
    const result = await controller.run({ kind: 'fork', displayMessageSeq: 17 })
    assert.equal(result?.status, 'indeterminate'); assert.equal(api.writes.length, 1)
    assert.equal(controller.canRun({ kind: 'fork' }), false)
    assert.equal(controller.canRun({ kind: 'rewind', displayMessageSeq: 17 }), false)
    assert.equal(controller.canRun({ kind: 'pin', mode: 'project' }), true, 'An uncertain branch does not invent a block on source metadata edits')
    const restored = new SourceLifecycleController(api, 'display', saved)
    assert.equal(restored.unresolved()[0]?.operationId, operationId)
    await restored.refresh(); await restored.inspect(operationId)
    assert.equal(await restored.run({ kind: 'fork' }), null)
    assert.equal(api.writes.length, 1)
    assert.ok(api.reads.length >= 3)
    assert.ok(api.reads.every(row => row.action === 'read' && row.operationId === operationId))
    assert.deepEqual(api.writes[0]?.action, { kind: 'fork', displayMessageSeq: 17 })
})

test('an intent persists even when both the write reply and receipt query fail, without dispatch on restoration', async () => {
    const api = new Api(), saved = storage(), operationId = randomUUID()
    const controller = new SourceLifecycleController(api, 'display', saved, () => operationId)
    await controller.refresh(); api.failReply = true; api.failRead = true
    assert.equal(await controller.run({ kind: 'archive' }), null)
    assert.equal(controller.getSnapshot().intents[0]?.operationId, operationId)
    api.receipt = undefined
    const restored = new SourceLifecycleController(api, 'display', saved)
    await restored.refresh()
    assert.equal(restored.unresolved()[0]?.operationId, operationId)
    assert.match(restored.getSnapshot().error ?? '', /Receipt temporarily unavailable/)
    assert.equal(api.writes.length, 1); assert.equal(restored.canRun({ kind: 'archive' }), false)
})

test('source acknowledgement cannot open a branch until its original engine display is ready', async () => {
    const api = new Api(), saved = storage(), controller = new SourceLifecycleController(api, 'display', saved)
    await controller.refresh(); await controller.run({ kind: 'fork' })
    api.receipt = { ...api.receipt!, status: 'confirmed', updatedAt: 200,
        result: { sourceSessionId: 'child-source', sessionId: 'looks-like-a-display', displayReady: false } }
    await controller.refresh()
    assert.equal(sourceOperationDisplayId(controller.getSnapshot().receipts[0]!), undefined)
    const reads = api.reads.length
    api.receipt = { ...api.receipt, updatedAt: 300, result: { sourceSessionId: 'child-source', sessionId: 'confirmed-child', displayReady: true } }
    await controller.refresh(); assert.equal(sourceOperationDisplayId(controller.getSnapshot().receipts[0]!), 'confirmed-child')
    assert.equal(api.writes.length, 1); assert.equal(api.reads.length, reads)
    assert.equal(sourceOperationDisplayId({ ...api.receipt, status: 'submitted' }), undefined)
})

test('controls follow actual source capabilities and never write through an old display generation', async () => {
    const api = new Api(), controller = new SourceLifecycleController(api, 'display')
    await controller.refresh()
    assert.equal(await controller.run({ kind: 'clear' }), null)
    assert.equal(await controller.run({ kind: 'delete' }), null)
    assert.equal(controller.canRun({ kind: 'rewind', displayMessageSeq: 4 }), true)
    api.tools.capabilities.rewind = false
    api.tools.capabilities.archive = false
    await controller.refresh()
    assert.equal(controller.canRun({ kind: 'rewind', displayMessageSeq: 4 }), false)
    assert.equal(controller.canRun({ kind: 'archive' }), false)
    api.tools.sessionId = 'display-r1'; await controller.refresh()
    assert.equal(controller.canRun({ kind: 'summary', text: 'Source summary' }), false)
    assert.equal(api.writes.length, 0)
})

test('draft handoff requires a confirmed ready reopen or resume, never a branch or an acknowledgement', async () => {
    const api = new Api(), controller = new SourceLifecycleController(api, 'display')
    await controller.refresh(); await controller.run({ kind: 'fork' })
    const result = { sourceSessionId: 'successor-source', sessionId: 'successor-display', displayReady: true }
    const receipt: SourceOperationReceipt = { ...api.receipt!, action: { kind: 'reopen' }, status: 'confirmed', result }
    assert.equal(sourceOperationSuccessorId(receipt), 'successor-display')
    assert.equal(sourceOperationSuccessorId({ ...receipt, action: { kind: 'resume' } }), 'successor-display')
    assert.equal(sourceOperationSuccessorId({ ...receipt, status: 'submitted' }), undefined)
    assert.equal(sourceOperationSuccessorId({ ...receipt, status: 'indeterminate' }), undefined)
    assert.equal(sourceOperationSuccessorId({ ...receipt, result: { ...result, displayReady: false } }), undefined)
    assert.equal(sourceOperationSuccessorId({ ...receipt, action: { kind: 'fork' } }), undefined)
    assert.equal(sourceOperationSuccessorId({ ...receipt, action: { kind: 'clear' } }), undefined)
    assert.equal(sourceOperationDisplayId({ ...receipt, action: { kind: 'fork' } }), 'successor-display', 'A branch still opens through ordinary navigation')
})
