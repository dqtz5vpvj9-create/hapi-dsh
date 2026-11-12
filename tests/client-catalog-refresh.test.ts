import assert from 'node:assert/strict'
import test from 'node:test'
import { CatalogRefresh } from '../src/client/catalog-refresh.ts'
import { catalogFailureText, classifyClientError, noticeText } from '../src/client/error-policy.ts'

test('catalog HTTP failures have a local actionable message without transport internals', () => {
    const error = new Error('transport failure for /api/hapi/catalog: HTTP 502')
    assert.equal(classifyClientError(error), 'transient')
    assert.match(catalogFailureText(error, 'en'), /Retrying automatically/)
    assert.doesNotMatch(catalogFailureText(error, 'en'), /502|HTTP|\/api|transport failure/)
    assert.match(catalogFailureText(new Error('HTTP 401'), 'en'), /sign-in/)
    assert.match(catalogFailureText(new Error('HTTP 403'), 'zh-CN'), /权限/)
    assert.doesNotMatch(noticeText(error), /502|HTTP|\/api|transport failure/)
    assert.match(noticeText(new Error('transport failure for /api/hapi/catalog: HTTP 401')), /认证/)
})

test('a failed catalog poll preserves the accepted inventory and the next poll recovers', async () => {
    const original = ['loaded-session']
    let visible = original, failures = 0, error: unknown
    let complete!: (value: string[]) => void
    let reads = 0
    const refresh = new CatalogRefresh({
        read: () => { reads++; return new Promise<string[]>((resolve, reject) => {
            if (reads === 1) reject(new Error('transport failure for /api/hapi/catalog: HTTP 503'))
            else complete = resolve
        }) },
        accept: value => { visible = value; error = undefined },
        failed: value => { error = value; failures++ },
    })
    await refresh.refresh()
    assert.equal(visible, original); assert.equal(failures, 1); assert.ok(error)
    const next = refresh.refresh()
    assert.equal(refresh.refresh(), next, 'manual refresh shares the pending background read')
    await Promise.resolve()
    complete(['loaded-session', 'new-session'])
    await next
    assert.equal(reads, 2); assert.equal(error, undefined)
    assert.deepEqual(visible, ['loaded-session', 'new-session'])
    refresh.dispose()
})

test('disposed catalog owners cannot publish late success or failure', async () => {
    for (const rejected of [false, true]) {
        let complete!: (value: string) => void, fail!: (reason: Error) => void
        let publications = 0
        const refresh = new CatalogRefresh({
            read: () => new Promise<string>((resolve, reject) => { complete = resolve; fail = reject }),
            accept: () => { publications++ }, failed: () => { publications++ },
        })
        const pending = refresh.refresh(); await Promise.resolve(); refresh.dispose()
        if (rejected) fail(new Error('HTTP 502')); else complete('late')
        await pending; await refresh.refresh()
        assert.equal(publications, 0)
    }
})

test('cancelled catalog reads do not create an unavailable status', async () => {
    let failures = 0
    const refresh = new CatalogRefresh({ read: async () => { throw new Error('gateway/cancelled') },
        accept: () => assert.fail('cancelled read must not publish'), failed: () => { failures++ } })
    await refresh.refresh(); assert.equal(failures, 0); refresh.dispose()
})
