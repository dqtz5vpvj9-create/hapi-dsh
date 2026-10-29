import assert from 'node:assert/strict'
import test from 'node:test'
import {
    captureInterruptedPrepend, InterruptedPrependAnchor, INTERRUPTED_PREPEND_ATTRIBUTE, planInterruptedPrepend,
} from '../src/client/seamless/interrupted-anchor.ts'
import { readAnchor } from '../src/client/seamless/anchor.ts'

const baseline = { anchor: { key: 'old-row', offset: -7 }, scrollTop: 227 }
const metrics = { scrollTop: 164, scrollHeight: 8666, clientHeight: 600 }
test('HAPI semantic node keys take precedence over nested DSH anchor keys', () => {
    const row = { getAttribute: (name: string) => name === 'data-chat-node-key' ? 'hapi-message'
        : name === 'data-chat-anchor-key' ? 'dsh-subrow' : null,
        getBoundingClientRect: () => ({ top: 120 }) }
    const port = { getBoundingClientRect: () => ({ top: 100 }) }
    assert.deepEqual(readAnchor(row as unknown as Element, port as unknown as Element),
        { key: 'hapi-message', offset: 20 })
})

test('prepend anchor falls through paging chrome to the first visible message row', () => {
    const row = {
        id: 'message-row', isConnected: true,
        getAttribute: (name: string) => name === 'data-chat-node-key' ? 'message:42' : null,
        closest: () => null,
        getBoundingClientRect: () => ({ top: 230, bottom: 280 }),
    }
    const attributes = new Map<string, string>()
    const port = {
        ownerDocument: { defaultView: { getComputedStyle: () => ({ scrollPaddingTop: '0px', scrollPaddingBottom: '0px' }) },
            elementFromPoint: () => null },
        getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 0, width: 360 }),
        contains: (candidate: unknown) => candidate === row,
        querySelectorAll: () => [row],
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
        scrollTop: 0,
    }
    const anchor = captureInterruptedPrepend(port as unknown as HTMLElement)
    assert.ok(anchor, 'the message below the paging/status chrome must still be captured')
    assert.equal(attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), true)
    anchor.release()
})

test('prepend anchoring chooses the topmost visible row instead of a lower hit-test target', () => {
    const makeRow = (key: string, top: number) => ({
        isConnected: true,
        getAttribute: (name: string) => name === 'data-chat-node-key' ? key : null,
        closest: () => null,
        getBoundingClientRect: () => ({ top, bottom: top + 48 }),
    })
    const first = makeRow('top-message', 146), lower = makeRow('lower-message', 220)
    const port = {
        ownerDocument: { defaultView: { getComputedStyle: () => ({ scrollPaddingTop: '0px', scrollPaddingBottom: '0px' }) },
            elementFromPoint: () => ({ closest: () => lower }) },
        getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 0, width: 360 }),
        contains: () => true,
        querySelectorAll: () => [first, lower],
        setAttribute: () => {}, removeAttribute: () => {}, scrollTop: 0,
    }
    const anchor = captureInterruptedPrepend(port as unknown as HTMLElement)
    assert.ok(anchor)
    assert.equal((anchor as unknown as { before: { anchor: { key: string } } }).before.anchor.key, 'top-message')
    anchor.release()
})

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
    const frames: Array<FrameRequestCallback> = []
    let currentRow: Record<string, unknown>
    const attributes = new Map<string, string>()
    const style = { overflowAnchor: '' }
    const row = {
        isConnected: true,
        key: 'old-row',
        getAttribute: (name: string) => name === 'data-chat-anchor-key' ? row.key : null,
        closest: () => null,
        getBoundingClientRect: () => ({ top: documentTop - scrollTop }),
    }
    currentRow = row
    const port = {
        style,
        setAttribute: (key: string, value: string) => attributes.set(key, value),
        removeAttribute: (key: string) => attributes.delete(key),
        contains: (value: unknown) => value === currentRow && currentRow.isConnected === true,
        querySelectorAll: () => currentRow.isConnected === true ? [currentRow] : [],
        ownerDocument: { defaultView: {
            requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length },
            ResizeObserver: class { constructor() { throw new Error('HAPI owns post-commit layout observation') } },
            MutationObserver: class { constructor() { throw new Error('page commits must not observe every transcript mutation') } },
        } },
        getBoundingClientRect: () => ({ top: 0 }),
        get scrollTop() { return scrollTop },
        set scrollTop(value: number) { scrollTop = value; writes += 1 },
        scrollHeight: 8666,
        clientHeight: 600,
    }
    const owner = new InterruptedPrependAnchor(row as unknown as HTMLElement, port as unknown as HTMLElement, baseline.anchor)
    return { row, port, owner, attributes, prepend: () => { documentTop += 1840 }, expand: (height: number) => { documentTop += height },
        flushNextFrame: () => { frames.shift()?.(0) },
        flushFrames: () => { while (frames.length) frames.shift()!(0) },
        move: (top: number) => { scrollTop = top },
        replaceRow: () => {
            row.isConnected = false
            currentRow = {
                isConnected: true,
                getAttribute: (name: string) => name === 'data-chat-anchor-key' ? 'old-row' : null,
                closest: () => null,
                getBoundingClientRect: () => ({ top: documentTop - scrollTop }),
            }
        }, writes: () => writes }
}

test('committed prepend releases its anchor after the correction lands', () => {
    const f = fixture()
    assert.ok(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE))
    f.move(164)
    f.prepend()
    f.owner.commit()
    f.owner.commit()
    f.flushFrames()
    assert.equal(f.port.scrollTop, 2004)
    assert.equal(f.writes(), 1)
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), false)
    f.owner.release()
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), false)
})

test('a new gesture between commit paint turns cannot cancel the page correction', () => {
    const f = fixture()
    f.move(164)
    f.prepend()
    f.owner.commit()
    f.flushNextFrame()
    f.owner.release()
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), true)
    f.flushFrames()
    assert.equal(f.port.scrollTop, 2004)
    assert.equal(f.writes(), 1)
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), false)
})

test('one reader releasing a shared scrollport does not remove another reader commit anchor', () => {
    const f = fixture()
    const pageReader = new InterruptedPrependAnchor(f.row as unknown as HTMLElement, f.port as unknown as HTMLElement, baseline.anchor)
    f.prepend()
    pageReader.commit()
    f.owner.release()
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), true)
    f.flushFrames()
    assert.equal(f.port.scrollTop, 2067)
    assert.equal(f.writes(), 1)
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), false)
})

test('finger release returns the following prepend to native inertia without a scroll write', () => {
    const f = fixture()
    f.owner.release()
    f.move(800)
    f.prepend()
    f.owner.commit()
    f.flushFrames()
    assert.equal(f.port.scrollTop, 800)
    assert.equal(f.writes(), 0)
})

test('a gesture at zero retains CSS anchor ownership through the page commit', () => {
    const f = fixture()
    f.move(0)
    assert.equal(f.owner.retainAtUpperEdge(), true)
    assert.equal(f.owner.waitingAtUpperEdge, true)
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), true)
    f.prepend()
    f.owner.commit()
    f.flushFrames()
    assert.equal(f.port.scrollTop, 1840)
    assert.equal(f.writes(), 1)
    assert.equal(f.owner.waitingAtUpperEdge, false)
    f.owner.release()
    assert.equal(f.owner.waitingAtUpperEdge, false)
})

test('commit waits for the rendered page before measuring the retained anchor', () => {
    const f = fixture()
    f.move(0)
    assert.equal(f.owner.retainAtUpperEdge(), true)
    f.owner.commit()
    f.flushNextFrame()
    assert.equal(f.port.scrollTop, 0, 'source progress can precede the React layout commit')
    f.prepend()
    f.flushFrames()
    assert.equal(f.port.scrollTop, 1840)
    assert.equal(f.writes(), 1)
})

test('upper-edge commit corrects only the residual after partial host compensation', () => {
    const f = fixture()
    f.move(0)
    assert.equal(f.owner.retainAtUpperEdge(), true)
    f.prepend()
    // The page added 1840 px and the browser/Host already moved partway.
    f.move(1500)
    f.owner.commit()
    f.flushFrames()
    assert.equal(f.port.scrollTop, 1840)
    assert.equal(f.writes(), 1)
})

test('page commit resolves the retained semantic key after React replaces its DOM row', () => {
    const f = fixture()
    f.move(0)
    assert.equal(f.owner.retainAtUpperEdge(), true)
    f.prepend()
    f.replaceRow()
    f.owner.commit()
    f.flushFrames()
    assert.equal(f.port.scrollTop, 1840)
    assert.equal(f.writes(), 1)
})

test('post-commit content layout stays with HAPI and does not observe transcript mutations', () => {
    const f = fixture()
    f.move(0)
    assert.equal(f.owner.retainAtUpperEdge(), true)
    f.prepend()
    f.owner.commit()
    f.flushFrames()
    f.expand(380)
    assert.equal(f.port.scrollTop, 1840)
    assert.equal(f.writes(), 1)
    f.owner.release()
})

test('polling keeps the request-time anchor while the Host moves scrollTop in stages', () => {
    const f = fixture()
    f.move(0)
    assert.equal(f.owner.retainAtUpperEdge(), true)
    f.prepend()
    f.move(900)
    f.owner.refresh()
    f.move(1500)
    f.owner.refresh()
    f.owner.commit()
    f.flushFrames()
    assert.equal(f.port.scrollTop, 1840)
    assert.equal(f.writes(), 1)
})

test('reader input can release an upper-edge anchor before the page commits', () => {
    const f = fixture()
    f.move(0)
    assert.equal(f.owner.retainAtUpperEdge(), true)
    f.owner.release()
    f.move(80)
    f.prepend()
    f.owner.commit()
    f.flushFrames()
    assert.equal(f.port.scrollTop, 80)
    assert.equal(f.writes(), 0)
})

test('a mid-list release cannot retain a boundary anchor', () => {
    const f = fixture()
    assert.equal(f.owner.retainAtUpperEdge(), false)
    assert.equal(f.owner.waitingAtUpperEdge, false)
})

test('source replacement discards the old DOM anchor and never restores stale position', () => {
    const f = fixture()
    f.row.isConnected = false
    f.prepend()
    f.owner.commit()
    f.flushFrames()
    assert.equal(f.writes(), 0)
    assert.equal(f.attributes.has(INTERRUPTED_PREPEND_ATTRIBUTE), false)
})

test('source replacement that reuses an element with a new row identity also releases it', () => {
    const f = fixture()
    f.row.key = 'replacement-row'
    f.prepend()
    f.owner.commit()
    f.flushFrames()
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
