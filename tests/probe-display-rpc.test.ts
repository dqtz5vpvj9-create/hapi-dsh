import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedDisplayRpc, parseCdpRpcBody } from '../scripts/probe-display-rpc.mjs'

const target = { hubId: 'exact-hub', sourceSessionId: 'exact-source' }
const body = (request: object) => ({ payload: { args: { request } } })
const allowed = (path: string, value: unknown) => allowedDisplayRpc(`/api/hapi/${path}`, value, target.hubId, target.sourceSessionId)

test('CDP string postData reaches the exact source display audit', () => {
    assert.equal(allowed('sourceSessionResolve', parseCdpRpcBody({ postData: JSON.stringify(body(target)) })), true)
})

test('a Playwright accessor is not silently invoked as a CDP payload field', () => {
    let called = false
    const playwrightRequest = { postData() { called = true; return JSON.stringify(body(target)) } }
    assert.equal(parseCdpRpcBody(playwrightRequest), undefined)
    assert.equal(called, false)
    assert.equal(allowed('sourceSessionResolve', parseCdpRpcBody(playwrightRequest)), false)
})

test('missing and malformed CDP payloads remain blocked', () => {
    for (const request of [undefined, {}, { postData: '' }, { postData: 'broken' }, { postData: '{}' }])
        assert.equal(allowed('sourceSessionResolve', parseCdpRpcBody(request)), false)
})

test('display resolver still rejects a different hub, source, extra key, or native endpoint', () => {
    for (const request of [{ ...target, hubId: 'other' }, { ...target, sourceSessionId: 'other' },
        { ...target, text: 'send' }, { hubId: target.hubId }])
        assert.equal(allowed('sourceSessionResolve', body(request)), false)
    assert.equal(allowed('nativeSend', body(target)), false)
})

test('only existing exact-source display lease lifecycle actions remain permitted', () => {
    for (const action of ['acquire', 'renew', 'release'])
        assert.equal(allowed('sourceDisplayLease', body({ ...target, action, leaseId: 'lease', ttlMs: 1000 })), true)
    for (const request of [{ ...target, action: 'send' }, { ...target, action: 'acquire', text: 'send' },
        { ...target, action: 'renew', hubId: 'other' }])
        assert.equal(allowed('sourceDisplayLease', body(request)), false)
})
