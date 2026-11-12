/** Actual application SQLite records and current source ACL; links grant no bearer access. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ShareService } from '../src/workspace/share-service.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import type { AppServiceContext, AppSourceRoute } from '../src/workspace/app-service-types.ts'
const scope = { accountId: 'account', origin: 'https://workspace.example' }
const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native' }
const source: AppSourceRoute = { kind: 'hhpi', hostId: 'original-host', sessionId: sourceSessionId(identity), identity }

test('account-scoped shares resolve the exact source target and recheck current grants', async () => {
    const service = new ShareService({ path: ':memory:' }), authorized: AppSourceRoute[] = []
    let allowed = true
    const context: AppServiceContext = { scope, authorizeSource(route) { authorized.push(route); if (!allowed) throw new Error('source grant revoked') } }
    try {
        const target = { kind: 'reading' as const, source, position: { kind: 'native' as const, turnId: 'original-turn', itemId: 'original-item' } }
        const record = await service.appShareCreate(context, { deviceId: 'device', target })
        assert.deepEqual((await service.appShareResolve(context, { shareId: record.id })).target, target)
        assert.deepEqual(authorized, [source, source]); allowed = false
        await assert.rejects(service.appShareResolve(context, { shareId: record.id }), /grant revoked/)
        await assert.rejects(service.appShareCreate(context, { deviceId: 'device', target }), /grant revoked/)
    } finally { service.close() }
})

test('a copied share identity cannot cross account/origin boundaries or replace its stored target', async () => {
    const service = new ShareService({ path: ':memory:' }), context = { scope, authorizeSource() {} }
    try {
        const record = await service.appShareCreate(context, { deviceId: 'device', target: { kind: 'session', source } })
        for (const otherScope of [{ ...scope, accountId: 'other' }, { ...scope, origin: 'https://other.example' }]) {
            await assert.rejects(service.appShareResolve({ ...context, scope: otherScope }, { shareId: record.id }), /unavailable/)
        }
        await assert.rejects(service.appShareResolve(context, { shareId: record.id, target: { kind: 'session', source: { ...source, hostId: 'replacement' } } } as never))
        await assert.rejects(service.appShareResolve(context, { shareId: 'missing' }), /unavailable/)
    } finally { service.close() }
})

test('expired references do not open old resources, while original source content is never deleted', async () => {
    let now = 100
    const service = new ShareService({ path: ':memory:', now: () => now, ttlMs: 1000 }), context = { scope, authorizeSource() {} }
    try {
        const record = await service.appShareCreate(context, { deviceId: 'device', target: { kind: 'session', source } })
        now = 1100
        await assert.rejects(service.appShareResolve(context, { shareId: record.id }), /expired/)
        const next = await service.appShareCreate(context, { deviceId: 'device', target: { kind: 'session', source } })
        assert.notEqual(next.id, record.id)
    } finally { service.close() }
})

test('account source references survive an application service restart', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs'), { join } = await import('node:path')
    const directory = mkdtempSync('/mnt/cache/data-cache/hhpi-share-state-'), path = join(directory, 'shares.sqlite'), context = { scope, authorizeSource() {} }
    let service = new ShareService({ path })
    try {
        const record = await service.appShareCreate(context, { deviceId: 'device', target: { kind: 'session', source } })
        service.close(); service = new ShareService({ path })
        assert.deepEqual(await service.appShareResolve(context, { shareId: record.id }), record)
    } finally { service.close(); rmSync(directory, { recursive: true }) }
})
