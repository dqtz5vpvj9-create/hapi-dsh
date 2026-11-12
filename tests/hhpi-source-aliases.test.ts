/** Production finite alias resolver; authorization and current directory are explicit synthetic boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceAliasIndex, type SourceAliasDocument, type SourceAliasPolicy } from '../src/workspace/source-aliases.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import type { AppSourceRoute } from '../src/workspace/app-service-types.ts'

const scope = { accountId: 'account-a', origin: 'https://workspace.example.invalid' }
const legacy = { kind: 'hapi-session' as const, hubId: 'old-hub', namespace: 'old-namespace', sessionId: 'old-session' }
const recovery = [{ packageId: 'offline-package', family: 'sessions' as const, objectId: 'old-hub:old-namespace:old-session' }]
const route = (sourceId = 'codex-source', hostId = 'host-a'): AppSourceRoute => {
    const identity = { machineId: 'machine-a', sourceId, engine: 'codex', nativeId: 'native-a' }
    return { kind: 'hhpi', hostId, identity, sessionId: sourceSessionId(identity) }
}
function fixture(entries: SourceAliasDocument['entries'] = [{ legacy, target: route(), recovery }]) {
    const index = new SourceAliasIndex({ version: 1, scope, entries }, scope), calls: Array<{ method: string; source: AppSourceRoute }> = []
    let active = true, allowed = true
    const policy: SourceAliasPolicy = { scope, current: () => active,
        authorize: async source => { calls.push({ method: 'authorize', source }); return allowed },
        locate: async source => { calls.push({ method: 'locate', source }); return source },
    }
    return { index, policy, calls, revoke: () => { allowed = false }, replaceScope: () => { active = false } }
}

test('exact legacy alias opens only the authorized current route with recovery references retained', async () => {
    const f = fixture(), result = await f.index.resolve(legacy, f.policy)
    assert.deepEqual(result, { status: 'resolved', via: 'alias', source: route(), recovery })
    assert.deepEqual(f.calls.map(call => call.method), ['authorize', 'locate', 'authorize'])
    for (const call of f.calls) assert.deepEqual(call.source, route())
    assert.equal('seq' in result, false, 'a legacy display coordinate is never manufactured into a native position')
})

test('current local, federated and HHPI routes use the same authorization and current-directory path', async () => {
    for (const source of [route(), { kind: 'local-dsh', hostId: 'host-local', sessionId: 'dsh-original' }, { kind: 'federated-dsh', hostId: 'host-remote', sessionId: 'remote-original' }] as AppSourceRoute[]) {
        const f = fixture([]), result = await f.index.resolve(source, f.policy)
        assert.deepEqual(result, { status: 'resolved', via: 'current', source, recovery: [] })
        assert.deepEqual(f.calls.map(call => call.method), ['authorize', 'locate', 'authorize'])
    }
})

test('unknown links, different Hub/namespace and unrecorded revision displays never trigger discovery', async () => {
    const display = { kind: 'hapi-display' as const, hostId: 'old-host', displayId: 'hapi-observed-recorded-r2' }
    const f = fixture([{ legacy: display, target: route(), recovery }])
    for (const reference of [legacy, { ...display, displayId: 'hapi-observed-recorded-r3' }, { ...display, displayId: 'hapi-observed-recorded' }, { ...display, hostId: 'other-host' }]) {
        assert.deepEqual(await f.index.resolve(reference, f.policy), { status: 'unmapped', recovery: [] })
    }
    assert.equal(f.calls.length, 0)
    const session = fixture()
    for (const reference of [{ ...legacy, hubId: 'other-hub' }, { ...legacy, namespace: 'other-namespace' }, { kind: 'hapi-session', hubId: legacy.hubId, sessionId: legacy.sessionId }]) {
        assert.equal((await session.index.resolve(reference, session.policy)).status, 'unmapped')
    }
    assert.equal(session.calls.length, 0)
})

test('unmapped and ambiguous aliases keep recovery objects but cannot choose the last matching title or source', async () => {
    const unmapped = fixture([{ legacy, target: null, recovery }])
    assert.deepEqual(await unmapped.index.resolve(legacy, unmapped.policy), { status: 'unmapped', recovery })
    const ambiguous = fixture([{ legacy, target: route(), recovery }, { legacy, target: route('other-source'), recovery }])
    assert.deepEqual(await ambiguous.index.resolve(legacy, ambiguous.policy), { status: 'ambiguous', recovery })
    assert.equal(unmapped.calls.length + ambiguous.calls.length, 0)
    const repeated = fixture([{ legacy, target: route(), recovery }, { legacy, target: route(), recovery }])
    assert.deepEqual(await repeated.index.resolve(legacy, repeated.policy), { status: 'resolved', via: 'alias', source: route(), recovery })
})

test('a known alias cannot bypass target Host denial or a grant revoked during location', async () => {
    const f = fixture(); f.revoke()
    assert.deepEqual(await f.index.resolve(legacy, f.policy), { status: 'denied' })
    assert.deepEqual(f.calls.map(call => call.method), ['authorize'])
    const delayed = fixture(), pending = Promise.withResolvers<AppSourceRoute | null>()
    delayed.policy.locate = async () => pending.promise
    const resolving = delayed.index.resolve(legacy, delayed.policy)
    await Promise.resolve(); delayed.revoke(); pending.resolve(route())
    assert.deepEqual(await resolving, { status: 'denied' })
})

test('account/origin and generation changes reject installed aliases and discard in-flight results', async () => {
    assert.throws(() => new SourceAliasIndex({ version: 1, scope, entries: [] }, { ...scope, accountId: 'other-account' }), /another account/)
    assert.throws(() => new SourceAliasIndex({ version: 1, scope, entries: [] }, { ...scope, origin: 'https://other.example.invalid' }), /another account/)
    const f = fixture()
    assert.deepEqual(await f.index.resolve(legacy, { ...f.policy, scope: { ...scope, accountId: 'other-account' } }), { status: 'scope-invalid' })
    assert.equal(f.calls.length, 0)
    const pending = Promise.withResolvers<AppSourceRoute | null>()
    f.policy.locate = async () => pending.promise
    const resolving = f.index.resolve(legacy, f.policy)
    await Promise.resolve(); f.replaceScope(); pending.resolve(route())
    assert.deepEqual(await resolving, { status: 'scope-invalid' })
})

test('directory absence, Host relocation and native/source identity mismatch retain recovery instead of rerouting', async () => {
    for (const located of [null, route('changed-source'), route('codex-source', 'changed-host'), { kind: 'local-dsh', hostId: 'host-a', sessionId: 'native-a' }] as Array<AppSourceRoute | null>) {
        const f = fixture(); f.policy.locate = async () => located
        assert.deepEqual(await f.index.resolve(legacy, f.policy), { status: 'unavailable', recovery })
    }
    const f = fixture(); f.policy.locate = async () => { throw new Error('Offline target Host') }
    assert.deepEqual(await f.index.resolve(legacy, f.policy), { status: 'unavailable', recovery })
})

test('aborts and invalid current native IDs dispatch no source discovery and reveal no stale alias metadata', async () => {
    const f = fixture(), abort = new AbortController(); abort.abort()
    assert.deepEqual(await f.index.resolve(legacy, f.policy, abort.signal), { status: 'aborted' })
    assert.deepEqual(await f.index.resolve({ ...route(), sessionId: 'hhpi:guessed' }, f.policy), { status: 'invalid' })
    assert.deepEqual(await f.index.resolve({ ...legacy, title: 'Shared title', cwd: '/same' }, f.policy), { status: 'invalid' })
    assert.equal(f.calls.length, 0)
    const pending = Promise.withResolvers<boolean>(), during = new AbortController()
    f.policy.authorize = async () => pending.promise
    const resolving = f.index.resolve(legacy, f.policy, during.signal)
    during.abort(); pending.resolve(true)
    assert.deepEqual(await resolving, { status: 'aborted' })
})
