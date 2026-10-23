import assert from 'node:assert/strict'
import test from 'node:test'
import {
    InterruptedPrependAnchor, INTERRUPTED_PREPEND_ATTRIBUTE, planInterruptedPrepend,
} from '../src/client/seamless/interrupted-anchor.ts'

const baseline = { anchor: { key: 'old-row', offset: -7 }, scrollTop: 227 }
const metrics = { scrollTop: 164, scrollHeight: 8666, clientHeight: 600 }

test('prepend preserves the finger movement between the last sample and commit', () => {
    const result = planInterruptedPrepend(baseline, { key: 'old-row', offset: 1896 }, metrics)
    assert.deepEqual(result, { apply: true, residual: 1840, targetScrollTop: 2004 })
})

test('uncompensated prepend while still at the upper edge keeps the retained row', () => {
    assert.deepEqual(planInterruptedPrepend({ anchor: { key: 'old-row', offset: 46 }, scrollTop: 0 },
        { key: 'old-row', offset: 1886 }, { ...metrics, scrollTop: 0 }),
    { apply: true, residual: 1840, targetScrollTop: 1840 })
})

test('already compensated prepend does not add its height a second time', () => {
    assert.equal(planInterruptedPrepend(baseline, baseline.anchor, { ...metrics, scrollTop: 2067 }).apply, false)
})

test('pure finger movement carries no layout residual', () => {
    assert.equal(planInterruptedPrepend(baseline, { key: 'old-row', offset: 56 }, metrics).apply, false)
})

function fixture() {
    let documentTop = 220
    let writes = 0
    let scrollTop = 227
    const attributes = new Map<string, string>()
    const style = { overflowAnchor: '' }
    const row = {
        isConnected: true,
        key: 'old-row',
        getAttribute: (name: string) => name === 'data-chat-anchor-key' ? row.key : null,
        getBoundingClientRect: () => ({ top: documentTop - scrollTop }),
    }
    const port = {
        style,
        setAttribute: (key: string, value: string) => attributes.set(key, value),
        removeAttribute: (key: string) => attributes.delete(key),
        contains: (value: unknown) => value === row && row.isConnected,
        getBoundingClientRect: () => ({ top: 0 }),
        get scrollTop() { return scrollTop },
        set scrollTop(value: number) { scrollTop = value; writes += 1 },
        scrollHeight: 8666,
        clientHeight: 600,
    }
    const owner = new InterruptedPrependAnchor(row as unknown as HTMLElement, port as unknown as HTMLElement, baseline.anchor)
    return { row, port, owner, attributes, prepend: () => { documentTop += 1840 }, move: (top: number) => { scrollTop = top }, writes: () => writes }
}

test('held prepend writes once and drops its temporary style ownership', () => {
    const f = fixture()
    assert.ok(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE))
    f.move(164)
    f.prepend()
    f.owner.commit()
    f.owner.commit()
    assert.equal(f.port.scrollTop, 2004)
    assert.equal(f.writes(), 1)
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), false)
})

test('finger release returns the following prepend to native inertia without a scroll write', () => {
    const f = fixture()
    f.owner.release()
    f.move(800)
    f.prepend()
    f.owner.commit()
    assert.equal(f.port.scrollTop, 800)
    assert.equal(f.writes(), 0)
})

test('source replacement discards the old DOM anchor and never restores stale position', () => {
    const f = fixture()
    f.row.isConnected = false
    f.prepend()
    f.owner.commit()
    assert.equal(f.writes(), 0)
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), false)
})

test('source replacement that reuses an element with a new row identity also releases it', () => {
    const f = fixture()
    f.row.key = 'replacement-row'
    f.prepend()
    f.owner.commit()
    assert.equal(f.writes(), 0)
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), false)
})

test('release leaves both previous and newer official flow-motion styles untouched', () => {
    for (const value of ['', 'auto', 'none']) {
        const f = fixture()
        f.port.style.overflowAnchor = value
        f.owner.release()
        assert.equal(f.port.style.overflowAnchor, value)
    }
})
