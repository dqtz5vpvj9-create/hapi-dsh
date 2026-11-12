/** Installed Typert Gateway and real private SQLite; account/source authorization is an explicit Host boundary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { APP_SERVICES_HOST_CONTRACT } from '../src/workspace/app-api.ts'
import { AppServicesController } from '../src/workspace/app-service.ts'
import { AppNotificationService } from '../src/workspace/notification-service.ts'
import { NotificationStore } from '../src/workspace/notification-store.ts'
import { ReadStateService } from '../src/workspace/read-state-service.ts'
import type { AppAccountScope, AppServiceContext, AppServiceRequest, AppServiceResponse, AppSourceRoute } from '../src/workspace/app-service-types.ts'

const scope: AppAccountScope = { accountId: 'account', origin: 'https://workspace.fixture' }
const source: AppSourceRoute = { kind: 'local-dsh', hostId: 'local', sessionId: 'original-session' }
const write = (operationId: string, expectedRevision = 0): AppServiceRequest<'appReadStateWrite'> => ({ source, deviceId: 'device', operationId, expectedRevision,
    intent: { kind: 'seen', position: { kind: 'dsh', seq: 40 }, at: 40 } })

async function fixture(path: string, context: () => AppServiceContext) {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry); new RemoteAccess(ctx)
    ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: APP_SERVICES_HOST_CONTRACT.invocations,
        model: { services: APP_SERVICES_HOST_CONTRACT.services, events: [], objects: [] } })
    const gateway = new Gateway(ctx, Gateway.Config({})), connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
    const store = new NotificationStore(':memory:'), notifications = new AppNotificationService({ store, contextForScope: () => null })
    const controller = new AppServicesController(ctx, { context, notifications, readStatePath: path })
    const invoke = <K extends 'appReadState' | 'appReadStates' | 'appReadStateWrite'>(method: K, request: AppServiceRequest<K>, signal?: AbortSignal) =>
        gateway.invoke({ peer: connection.browserPeer, namespace: 'appServices', method, args: { request }, ...(signal ? { signal } : {}) }) as Promise<AppServiceResponse<K>>
    return { ctx, controller, invoke, async close() { await ctx.fiber.dispose(); await notifications.close() } }
}

test('owned application read state is private, survives Controller disposal, and accepts only server-derived account/origin/source scope', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-read-controller-'), path = join(directory, 'read.sqlite')
    let current = scope, denied = false
    const context = (): AppServiceContext => ({ scope: current, authorizeSource(route) { if (denied || route.hostId !== 'local') throw new Error('Original source grant revoked') } })
    let f = await fixture(path, context)
    try {
        const saved = await f.invoke('appReadStateWrite', write('original'))
        assert.equal(saved.applied, true); assert.deepEqual(saved.state.scope, scope)
        assert.equal((await stat(path)).mode & 0o777, 0o600)
        await assert.rejects(f.invoke('appReadStateWrite', { ...write('forged', 1), accountId: 'another-account' } as never))
        current = { ...scope, accountId: 'another-account' }; assert.equal(await f.invoke('appReadState', { source }), null)
        current = { ...scope, origin: 'https://another.fixture' }; assert.equal(await f.invoke('appReadState', { source }), null)
        current = scope; denied = true
        await assert.rejects(f.invoke('appReadState', { source }), /revoked/)
        await assert.rejects(f.invoke('appReadStateWrite', write('denied', 1)), /revoked/)
        denied = false
        const request = { ...write('unread', 1), intent: { kind: 'unread' as const, at: 50 } }
        await f.invoke('appReadStateWrite', request)
        await assert.rejects(f.controller.appReadState({ source }), /authenticated application connection/)
        await f.close(); f = await fixture(path, context)
        const replay = await f.invoke('appReadStateWrite', write('original'))
        assert.equal(replay.applied, true); assert.equal(replay.state.revision, 2); assert.equal(replay.state.manualUnreadAt, 50)
        assert.equal((await f.invoke('appReadStates', { sources: [source] }))[0]?.manualUnreadAt, 50)
    } finally { await f.close(); await rm(directory, { recursive: true }) }
})

test('caller cancellation and service disposal during original authorization cannot commit a late read intent', async () => {
    for (const stop of ['caller', 'service'] as const) {
        const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-read-cancel-'), path = join(directory, 'read.sqlite')
        const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), caller = new AbortController()
        const f = await fixture(path, () => ({ scope, async authorizeSource() { entered.resolve(); await release.promise } }))
        try {
            const result = f.invoke('appReadStateWrite', write(`cancelled-${stop}`), caller.signal)
            const rejected = assert.rejects(result)
            await entered.promise
            if (stop === 'caller') caller.abort(); else await f.ctx.fiber.dispose()
            release.resolve(); await rejected
            const actual = new ReadStateService({ path })
            try { assert.equal(await actual.appReadState({ scope, authorizeSource() {} }, { source }), null) }
            finally { actual.close() }
        } finally { release.resolve(); await f.close(); await rm(directory, { recursive: true }) }
    }
})
