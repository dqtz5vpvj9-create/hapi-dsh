import test from 'node:test'
import assert from 'node:assert/strict'
import { InitialTaskController, type InitialTaskDraft, type InitialTaskStore } from '../src/client/initial-task.ts'
import type { HapiRemoteApi, SourceInitialTask, SourceInitialTaskReceipt } from '../src/client-api.ts'
const ok = <T>(value: T) => ({ ok: true as const, value })
const creation = '11111111-1111-4111-8111-111111111111'
const receipt = (request: SourceInitialTask, confirmed = false): SourceInitialTaskReceipt => ({ operationId: request.operationId, creationRequestId: request.creationRequestId,
    sourceSessionId: 'original', logicalSessionId: 'logical', sessionId: request.sessionId, flavor: 'claude', nativeId: 'source-sdk',
    localId: `dsh:initial-task:${request.operationId}`, messageId: `hapi-initial-task:${request.operationId}`, status: confirmed ? 'queued' : 'indeterminate',
    text: request.text, attachments: [], delivery: null, sourceConfirmed: confirmed, sourceAvailable: true, canRetry: false, createdAt: 1, updatedAt: 2, message: null })
function store(): InitialTaskStore {
    const values = new Map<string, InitialTaskDraft>()
    return { read: async key => values.has(key) ? structuredClone(values.get(key)!) : null,
        write: async (key, draft) => { if (draft) values.set(key, structuredClone(draft)); else values.delete(key) } }
}
type Api = Pick<HapiRemoteApi, 'sourceInitialTask' | 'sourceInitialTaskRead' | 'sourceInitialTaskRetry' | 'sourceInitialTasks'>

test('attachment-only launch survives reload, lost delivery reply never reuploads or resends, and source confirmation completes the same task', async () => {
    const disk = store(); let posts = 0, uploads = 0; let observed: SourceInitialTaskReceipt | null = null
    let input: SourceInitialTask | undefined
    const api: Api = {
        sourceInitialTask: async request => { posts++; input = structuredClone(request); observed = receipt(request); throw new Error('reply lost') },
        sourceInitialTaskRead: async () => ok(observed), sourceInitialTaskRetry: async () => { throw new Error('unknown must not retry') }, sourceInitialTasks: async () => ok(observed ? [observed] : []),
    }
    const upload = async (_: string, file: File) => { uploads++; assert.equal(await file.text(), 'original bytes'); return { receiptId: 'original-receipt' } }
    const original = new InitialTaskController(api, upload, 'hub:create', disk)
    await original.load(); await original.addFiles([new File(['original bytes'], 'notes.txt', { type: 'text/plain' })]); await original.prepare(creation)
    const reopened = new InitialTaskController(api, upload, 'hub:create', disk); await reopened.load()
    assert.equal(reopened.getSnapshot().draft.files[0]!.name, 'notes.txt')
    assert.equal(await reopened.ready('display', creation), false)
    assert.equal(posts, 1); assert.equal(uploads, 1); assert.equal(input!.text, '')
    assert.deepEqual(input!.attachments, [{ type: 'file', receiptId: 'original-receipt' }])
    const afterDisconnect = new InitialTaskController(api, upload, 'hub:create', disk); await afterDisconnect.load()
    await afterDisconnect.ready('display', creation); await afterDisconnect.ready('display', creation, true)
    assert.equal(posts, 1); assert.equal(uploads, 1)
    observed = receipt(input!, true); await afterDisconnect.refresh()
    assert.equal(await afterDisconnect.ready('display', creation), true)
    await afterDisconnect.completed(); assert.equal(await disk.read('hub:create'), null)
})

test('partial upload failure retains files and their receipts; only an explicit retry uploads the remaining file to the same created session', async () => {
    const disk = store(); const uploads: string[] = []; let posts = 0; let failSecond = true
    const api: Api = { sourceInitialTask: async request => { posts++; return ok(receipt(request, true)) }, sourceInitialTaskRead: async () => ok(null), sourceInitialTaskRetry: async () => { throw new Error('not submitted') }, sourceInitialTasks: async () => ok([]) }
    const upload = async (sessionId: string, file: File) => { assert.equal(sessionId, 'existing-session'); uploads.push(file.name); if (file.name === 'two.txt' && failSecond) throw new Error('upload disconnected'); return { receiptId: file.name } }
    const first = new InitialTaskController(api, upload, 'task', disk); await first.load()
    first.setText('Keep my task'); await first.addFiles([new File(['1'], 'one.txt'), new File(['2'], 'two.txt')]); await first.prepare(creation)
    assert.equal(await first.ready('existing-session', creation), false); assert.equal(posts, 0)
    const reopened = new InitialTaskController(api, upload, 'task', disk); await reopened.load()
    await reopened.ready('existing-session', creation); assert.deepEqual(uploads, ['one.txt', 'two.txt'])
    failSecond = false; assert.equal(await reopened.ready('existing-session', creation, true), true)
    assert.deepEqual(uploads, ['one.txt', 'two.txt', 'two.txt']); assert.equal(posts, 1)
    assert.equal(reopened.getSnapshot().draft.text, 'Keep my task')
})

test('failed persistence prevents launch preparation and frozen task text cannot change after source launch', async () => {
    const api = {} as Api
    const controller = new InitialTaskController(api, async () => { throw new Error('no uploads') }, 'task', { read: async () => null, write: async () => { throw new Error('disk full') } })
    await controller.load(); controller.setText('must survive')
    await assert.rejects(controller.prepare(creation), /disk full/)
    const good = new InitialTaskController(api, async () => { throw new Error('no uploads') }, 'task', store())
    await good.load(); good.setText('original'); await good.prepare(creation); good.setText('changed')
    assert.equal(good.getSnapshot().draft.text, 'original')
    await assert.rejects(good.prepare('22222222-2222-4222-8222-222222222222'), /existing first task/)
    await good.releaseRejectedCreation(); good.setText('editable again'); assert.equal(good.getSnapshot().draft.text, 'editable again')
})
