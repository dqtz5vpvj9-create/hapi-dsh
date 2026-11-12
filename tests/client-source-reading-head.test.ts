/** Original gateway methods are fixtures; head routing and cancellation are production code. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSourceReadHead } from '../src/client/source-reading-head.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import type { SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { AppSourceRoute } from '../src/workspace/app-service-types.ts'
const ok = <T>(value: T) => ({ ok: true as const, value })
const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread' }
const hhpiRoute: AppSourceRoute = { kind: 'hhpi', hostId: 'runner', sessionId: sourceSessionId(identity), identity }

test('Mark as read asks only the exact original gateway for a bounded head', async () => {
    const requests: unknown[] = []
    const ordinary = { events: async (request: unknown) => { requests.push(request); return ok({ records: [
        { type: 'event', event: { type: 'user/message', seq: 17, time: 170 } }, { type: 'transient', event: { seq: 18, time: 180 } },
        { type: 'event', event: { type: 'turn/end', seq: 19, time: 190 } },
    ] }) } } as unknown as Pick<SessionRemote, 'events'>
    const hhpi = { read: async (request: unknown) => { requests.push(request); return ok({ session: { id: hhpiRoute.sessionId }, epoch: 'accepted-generation',
        entries: [{ type: 'event', event: { type: 'assistant/message', seq: 91, time: 910 } },
            { type: 'event', event: { type: 'turn/end', seq: 97, time: 970 } }] }) } } as unknown as Pick<HhpiRemoteApi, 'read'>
    const head = createSourceReadHead('runner', ordinary, hhpi), signal = new AbortController().signal
    assert.deepEqual(await head(hhpiRoute, signal), { position: { kind: 'hhpi', epoch: 'accepted-generation', seq: 91 }, at: 910 })
    assert.deepEqual(requests, [{ sessionId: hhpiRoute.sessionId, limit: 160 }])
    assert.deepEqual(await head({ kind: 'federated-dsh', hostId: 'runner', sessionId: 'native' }, signal), { position: { kind: 'dsh', seq: 17 }, at: 170 })
    assert.deepEqual(requests[1], { address: { kind: 'session', sessionId: 'native' }, maxMessages: 1 })
    await assert.rejects(head({ ...hhpiRoute, hostId: 'another-host' }, signal), /another Host/)
    assert.equal(requests.length, 2)
})

test('a bounded tail containing only control records stays unknown without scanning earlier history', async () => {
    let calls = 0
    const hhpi = { read: async () => { calls++; return ok({ session: { id: hhpiRoute.sessionId }, epoch: 'original',
        hasBefore: true, before: 160, entries: [{ type: 'event', event: { type: 'turn/end', seq: 487, time: 4870 } }] }) } } as unknown as Pick<HhpiRemoteApi, 'read'>
    const ordinary = { events: () => { throw new Error('No local fallback') } } as unknown as Pick<SessionRemote, 'events'>
    assert.equal(await createSourceReadHead('runner', ordinary, hhpi)(hhpiRoute, new AbortController().signal), null)
    assert.equal(calls, 1)
})

test('a late source head after account departure cannot become a reading acknowledgement', async () => {
    let reply!: (value: unknown) => void
    const hhpi = { read: () => new Promise<unknown>(resolve => { reply = resolve }) } as unknown as Pick<HhpiRemoteApi, 'read'>
    const ordinary = { events: () => { throw new Error('No local fallback') } } as unknown as Pick<SessionRemote, 'events'>
    const abort = new AbortController(), head = createSourceReadHead('runner', ordinary, hhpi)(hhpiRoute, abort.signal)
    abort.abort(); reply(ok({ session: { id: hhpiRoute.sessionId }, epoch: 'old', entries: [{ type: 'event', event: { seq: 1, time: 1 } }] }))
    await assert.rejects(head, { name: 'AbortError' })
})

test('account changes retire old composer/read ownership, while settings refresh keeps the same lifetime', () => {
    const application = new WorkspaceApplicationIdentity(), scope = { accountId: 'first', origin: 'https://workspace.example' }
    application.set(scope, 'device')
    const first = application.getSnapshot()!
    application.set({ ...scope }, 'device')
    assert.equal(application.getSnapshot(), first)
    application.set({ ...scope, accountId: 'second' }, 'device')
    assert.equal(first.signal.aborted, true)
    assert.notEqual(application.getSnapshot()!.scope, first.scope)
    const second = application.getSnapshot()!
    application.clear()
    assert.equal(second.signal.aborted, true)
    assert.equal(application.getSnapshot(), undefined)
    application.dispose()
})
