/** Actual share persistence with controlled Remote-result transport and navigation effects. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ShareService } from '../src/workspace/share-service.ts'
import { createSourceSharing, resumeSourceShare, type AppShareApi } from '../src/client/source-share.ts'
import type { AppShareTarget } from '../src/workspace/app-service-types.ts'
const scope = { accountId: 'account', origin: 'https://workspace.example' }
const target: AppShareTarget = { kind: 'reading', source: { kind: 'federated-dsh', hostId: 'original-host', sessionId: 'original-session' }, position: { kind: 'dsh', seq: 42 } }
function fixture() {
    const service = new ShareService({ path: ':memory:' }), lifetime = new AbortController(), resolved: unknown[] = []
    let allowed = true
    const context = { scope, authorizeSource() { if (!allowed) throw new Error('original grant denied') } }
    const api: AppShareApi = { appShareCreate: async value => ({ ok: true, value: await service.appShareCreate(context, value) }), appShareResolve: async value => {
        resolved.push(value); return { ok: true, value: await service.appShareResolve(context, value) }
    } }
    return { api, lifetime, resolved, sharing: createSourceSharing(api, scope, 'device', `${scope.origin}/app/?token=never-copy`, lifetime.signal),
        deny() { allowed = false }, close() { lifetime.abort(); service.close() } }
}

test('opaque account links survive login, resolve the stored original target and remove only their own navigation parameters', async () => {
    const view = fixture(), opened: unknown[] = []
    try {
        const link = await view.sharing.create(target, view.lifetime.signal), url = new URL(link)
        assert.equal(url.pathname, '/app/'); assert.equal(url.searchParams.has('token'), false)
        assert.equal(link.includes('original-session'), false); assert.equal(link.includes('original-host'), false)
        url.searchParams.set('keep', 'navigation'); url.hash = 'retained-draft'
        const clean = await resumeSourceShare(view.api, scope, url.href, async value => { opened.push(value) }, view.lifetime.signal)
        assert.deepEqual(opened, [target]); assert.equal(new URL(clean!).searchParams.get('keep'), 'navigation')
        assert.equal(new URL(clean!).hash, '#retained-draft'); assert.equal(new URL(clean!).searchParams.has('hhpiShare'), false)
        assert.deepEqual(Object.keys(view.resolved[0] as object), ['shareId'])
    } finally { view.close() }
})

test('wrong account, changed source grant and closed authenticated lifetime cannot open a target', async () => {
    const view = fixture(); let opened = 0
    try {
        const link = await view.sharing.create(target, view.lifetime.signal)
        await assert.rejects(resumeSourceShare(view.api, { ...scope, accountId: 'other' }, link, () => { opened++ }, view.lifetime.signal), /another authenticated account/)
        assert.deepEqual(view.resolved, []); view.deny()
        await assert.rejects(resumeSourceShare(view.api, scope, link, () => { opened++ }, view.lifetime.signal), /original grant denied/)
        view.lifetime.abort()
        await assert.rejects(resumeSourceShare(view.api, scope, link, () => { opened++ }, view.lifetime.signal), { name: 'AbortError' })
        assert.equal(opened, 0)
    } finally { view.close() }
})

test('a late resolve response after account replacement is ignored before navigation', async () => {
    const view = fixture(); let reply!: () => void, opened = 0
    try {
        const link = await view.sharing.create(target, view.lifetime.signal)
        const api: AppShareApi = { ...view.api, appShareResolve: async request => {
            const result = await view.api.appShareResolve(request); return new Promise(resolve => { reply = () => resolve(result) })
        } }
        const pending = resumeSourceShare(api, scope, link, () => { opened++ }, view.lifetime.signal)
        await new Promise<void>(resolve => setImmediate(resolve)); view.lifetime.abort(); reply()
        await assert.rejects(pending, { name: 'AbortError' }); assert.equal(opened, 0)
    } finally { view.close() }
})
