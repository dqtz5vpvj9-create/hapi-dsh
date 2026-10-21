import assert from 'node:assert/strict'
import test from 'node:test'
import { browserValue } from '../src/client/browser-value.ts'

test('pane globals preserve constructor identity, prototypes and static operations used by official document plugins', () => {
    class Element { static marker = 'original'; readonly nodeType = 1; cloneNode() { return new Element() } }
    const host = { Element, Map, Uint8Array, Symbol, document: {} }
    assert.equal(browserValue(host, 'Element'), Element)
    const Original = browserValue(host, 'Element') as typeof Element
    assert.equal(Original.prototype.cloneNode, Element.prototype.cloneNode)
    assert.equal(Original.marker, 'original')
    assert.equal(new Original() instanceof Element, true)
    assert.equal((browserValue(host, 'Uint8Array') as typeof Uint8Array).from, Uint8Array.from)
    assert.equal((browserValue(host, 'Symbol') as typeof Symbol).iterator, Symbol.iterator)
    assert.equal((browserValue(host, 'Map') as typeof Map).prototype, Map.prototype)
    assert.equal(browserValue(host, 'document'), host.document)
})

test('native browser methods still use their original receiver and getters are read against it', () => {
    const host = {
        value: 'original document',
        get title() { assert.equal(this, host); return this.value },
        read() { assert.equal(this, host); return this.value },
    }
    const detached = browserValue(host, 'read') as () => string
    assert.equal(detached(), host.value)
    assert.equal(browserValue(host, 'title'), host.value)
})
