/** Installed Gateway, private offline aliases; original source authorization/location are explicit fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { SOURCE_ALIAS_HOST_CONTRACT } from '../src/workspace/source-alias-api.ts'
import { SourceAliasService } from '../src/workspace/source-alias-service.ts'
import type { AppSourceRoute } from '../src/workspace/app-service-types.ts'

test('a retired link resolves through an exact private alias without creating an owner or querying a Hub', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-source-alias-'), path = join(directory, 'aliases.json')
    const ctx = new Context(), scope = { accountId: 'account', origin: 'https://workspace.fixture' }
    const reference = { kind: 'hapi-session' as const, hubId: 'old-hub', sessionId: 'old-session' }
    const source: AppSourceRoute = { kind: 'local-dsh', hostId: 'local', sessionId: 'original-native-id' }
    let current = scope, allowed = true, locations = 0
    await ctx.plugin(TypertRegistry); new RemoteAccess(ctx)
    ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: SOURCE_ALIAS_HOST_CONTRACT.invocations,
        model: { services: SOURCE_ALIAS_HOST_CONTRACT.services, events: [], objects: [] } })
    const gateway = new Gateway(ctx, Gateway.Config({})), connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
    const service = new SourceAliasService(ctx, { path,
        context: () => ({ scope: current, authorizeSource() { if (!allowed) throw new Error('revoked') } }),
        async locate(target) { locations++; assert.deepEqual(target, source); return source },
    })
    const invoke = (input: unknown) => gateway.invoke({ peer: connection.browserPeer, namespace: 'sourceAliases', method: 'resolve', args: { request: input } })
    try {
        assert.deepEqual(await invoke({ reference }), { status: 'unmapped', recovery: [] })
        await writeFile(path, JSON.stringify({ version: 1, scope, entries: [{ legacy: reference, target: source, recovery: [] }] }), { mode: 0o600 })
        assert.deepEqual(await invoke({ reference }), { status: 'resolved', via: 'alias', source, recovery: [] })
        assert.equal(locations, 1)
        assert.deepEqual(await invoke({ reference: { ...reference, sessionId: 'unmapped' } }), { status: 'unmapped', recovery: [] })
        current = { ...scope, accountId: 'another-account' }
        assert.deepEqual(await invoke({ reference }), { status: 'scope-invalid' }); assert.equal(locations, 1)
        current = scope; allowed = false
        assert.deepEqual(await invoke({ reference }), { status: 'unavailable', recovery: [] }); assert.equal(locations, 1)
        await assert.rejects(invoke({ reference, accountId: scope.accountId }))
        await assert.rejects(service.resolve({ reference }), /authenticated application connection/)
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true }) }
})
