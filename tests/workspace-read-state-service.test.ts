/** Actual SQLite CAS, account authorization and operation replay; no execution owner is created. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { sourceSessionId } from '../src/remote/protocol.ts'
import { ReadStateService } from '../src/workspace/read-state-service.ts'
import type { AppAccountScope, AppServiceContext, AppSourceRoute, AppServiceRequest } from '../src/workspace/app-service-types.ts'
const scope: AppAccountScope = { accountId: 'account', origin: 'https://workspace.example' }
const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native' }
const source: AppSourceRoute = { kind: 'hhpi', hostId: 'local', sessionId: sourceSessionId(identity), identity }
const context: AppServiceContext = { scope, authorizeSource() {} }
const seen = (seq: number, at = seq, epoch = 'epoch') => ({ kind: 'seen' as const, position: { kind: 'hhpi' as const, epoch, seq }, at })
const write = (operationId: string, expectedRevision: number, intent: AppServiceRequest<'appReadStateWrite'>['intent'], deviceId = 'device') => ({ source, deviceId, operationId, expectedRevision, intent })

test('two devices must rebase an explicit unread intent; older source positions cannot clear it', async () => {
    const service = new ReadStateService({ path: ':memory:' })
    try {
        assert.equal((await service.appReadStateWrite(context, write('read', 0, seen(40)))).applied, true)
        const stale = await service.appReadStateWrite(context, write('unread', 0, { kind: 'unread', at: 50 }, 'other-device'))
        assert.equal(stale.applied, false); assert.equal(stale.state.revision, 1)
        const unread = await service.appReadStateWrite(context, write('unread', 1, { kind: 'unread', at: 50 }, 'other-device'))
        assert.equal(unread.state.manualUnreadAt, 50)
        const old = await service.appReadStateWrite(context, write('old-window', 2, seen(20, 60)))
        assert.equal(old.state.seen?.position.seq, 40); assert.equal(old.state.manualUnreadAt, 50)
        const actual = await service.appReadStateWrite(context, write('visible-commit', 3, seen(41, 70)))
        assert.equal(actual.state.seen?.position.seq, 41); assert.equal(actual.state.manualUnreadAt, null)
    } finally { service.close() }
})

test('a lost acknowledgement replay returns current state without undoing a later device intent', async () => {
    const service = new ReadStateService({ path: ':memory:' })
    try {
        const operation = write('lost-read', 0, seen(40))
        await service.appReadStateWrite(context, operation)
        await service.appReadStateWrite(context, write('later-unread', 1, { kind: 'unread', at: 50 }, 'other'))
        const replay = await service.appReadStateWrite(context, operation)
        assert.equal(replay.applied, true); assert.equal(replay.state.revision, 2); assert.equal(replay.state.manualUnreadAt, 50)
        await assert.rejects(service.appReadStateWrite(context, { ...operation, intent: seen(99) }), /another intent/)
        assert.equal((await service.appReadState(context, { source }))?.revision, 2)
    } finally { service.close() }
})

test('source generations retain original coordinates and reject native notification IDs as read evidence', async () => {
    const service = new ReadStateService({ path: ':memory:' })
    try {
        await service.appReadStateWrite(context, write('old-generation', 0, seen(99)))
        const next = await service.appReadStateWrite(context, write('new-generation', 1, seen(2, 10, 'next-epoch')))
        assert.deepEqual(next.state.seen, { position: { kind: 'hhpi', epoch: 'next-epoch', seq: 2 }, at: 10 })
        await assert.rejects(service.appReadStateWrite(context, { ...write('fake-read', 2, seen(2)), intent: { kind: 'seen', position: { kind: 'native', turnId: 'turn' }, at: 100 } } as never))
    } finally { service.close() }
})

test('account, origin, Host and current original source authorization isolate stored watermarks', async () => {
    const service = new ReadStateService({ path: ':memory:' })
    try {
        await service.appReadStateWrite(context, write('read', 0, seen(40)))
        for (const next of [{ ...scope, accountId: 'another' }, { ...scope, origin: 'https://other.example' }]) {
            assert.equal(await service.appReadState({ ...context, scope: next }, { source }), null)
        }
        assert.equal(await service.appReadState(context, { source: { ...source, hostId: 'another-host' } }), null)
        const denied = { scope, authorizeSource() { throw new Error('source grant revoked') } }
        await assert.rejects(service.appReadState(denied, { source }), /source grant revoked/)
        await assert.rejects(service.appReadStateWrite(denied, write('denied', 1, seen(50))), /source grant revoked/)
        await assert.rejects(service.appReadStates(denied, { sources: [source] }), /source grant revoked/)
    } finally { service.close() }
})

test('batch reads preserve request order, authorize every source and enforce the 200-source bound', async () => {
    const service = new ReadStateService({ path: ':memory:' }), allowed: string[] = []
    const other: AppSourceRoute = { kind: 'federated-dsh', hostId: 'remote', sessionId: 'dsh-session' }
    try {
        await service.appReadStateWrite(context, write('read', 0, seen(40)))
        const batch = await service.appReadStates({ scope, authorizeSource(route) { allowed.push(route.sessionId) } }, { sources: [other, source] })
        assert.equal(batch[0], null); assert.equal(batch[1]?.seen?.position.seq, 40)
        assert.deepEqual(allowed, [other.sessionId, source.sessionId])
        await assert.rejects(service.appReadStates(context, { sources: Array.from({ length: 201 }, () => source) }))
    } finally { service.close() }
})

test('private SQLite storage survives service restart with both watermark and durable replay identity', async () => {
    const directory = mkdtempSync('/mnt/cache/data-cache/hhpi-read-state-'), path = join(directory, 'read.sqlite')
    let service = new ReadStateService({ path })
    try {
        const original = write('original', 0, seen(40))
        await service.appReadStateWrite(context, original); service.close()
        service = new ReadStateService({ path })
        assert.equal((await service.appReadState(context, { source }))?.seen?.position.seq, 40)
        await service.appReadStateWrite(context, write('manual', 1, { kind: 'unread', at: 50 }))
        assert.equal((await service.appReadStateWrite(context, original)).state.manualUnreadAt, 50)
    } finally { service.close(); rmSync(directory, { recursive: true }) }
})
