/** The authenticated application RPC is an explicit fixture; no retired Hub or writer exists here. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveOriginalSession } from '../src/client/source-session-resolver.ts'
import { SourceResolutionError, sourceResolutionFailure } from '../src/client/source-session-state.ts'
import type { SourceAliasApi } from '../src/workspace/source-alias-api.ts'
import type { AppSourceRoute } from '../src/workspace/app-service-types.ts'

const reference = { kind: 'hapi-session' as const, hubId: 'old-hub', namespace: 'original-namespace', sessionId: 'old-session' }
const reply = (source: AppSourceRoute): Awaited<ReturnType<SourceAliasApi['resolve']>> => ({ ok: true, value: { status: 'resolved', source, via: 'alias', recovery: [] } })

test('an exact finite reference returns the server-authorized local, federation or HHPI route without loading a retired source', async () => {
    const routes: AppSourceRoute[] = [
        { kind: 'local-dsh', hostId: 'local', sessionId: 'original-native' },
        { kind: 'federated-dsh', hostId: 'paired-host', sessionId: 'original-native' },
        { kind: 'hhpi', hostId: 'source-host', sessionId: 'hhpi:machine:source:codex:native', identity: { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native' } },
    ]
    for (const route of routes) {
        let reads = 0
        const signal = new AbortController().signal
        const resolved = await resolveOriginalSession({ resolve: async (request, received) => {
            reads++; assert.deepEqual(request, { reference }); assert.equal(received, signal); return reply(route)
        } }, reference, signal)
        assert.deepEqual(resolved, route); assert.equal(reads, 1)
    }
})

test('mapping failures remain explicit and never turn an unavailable, denied or ambiguous source into another route', async () => {
    for (const [status, expected] of [['unmapped', 'not-found'], ['ambiguous', 'ambiguous'], ['unavailable', 'not-connected'], ['denied', 'denied'], ['scope-invalid', 'denied']] as const) {
        const resolve: SourceAliasApi['resolve'] = async () => ({ ok: true, value: status === 'unmapped' || status === 'ambiguous' || status === 'unavailable'
            ? { status, recovery: [] } : { status } })
        await assert.rejects(resolveOriginalSession({ resolve }, reference, new AbortController().signal), error => error instanceof SourceResolutionError && error.resolution === expected)
    }
})

test('connection disposal rejects a late authorized alias result instead of navigating with an old account', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<SourceAliasApi['resolve']>>>(), lifetime = new AbortController()
    const opening = resolveOriginalSession({ resolve: () => pending.promise }, reference, lifetime.signal)
    lifetime.abort(new Error('Original account connection closed'))
    pending.resolve(reply({ kind: 'local-dsh', hostId: 'local', sessionId: 'late-native' }))
    await assert.rejects(opening, /Original account connection closed/)
})

test('structured failures retain transport/auth distinctions without reading English error text as identity evidence', () => {
    for (const [status, expected] of [[404, 'not-found'], [410, 'removed'], [401, 'denied'], [403, 'denied'], [500, 'transport'], [503, 'transport']] as const) {
        assert.equal(sourceResolutionFailure({ details: { status } }), expected)
    }
    assert.equal(sourceResolutionFailure(new Error('mentions 404 without a structured status')), 'unknown')
})
