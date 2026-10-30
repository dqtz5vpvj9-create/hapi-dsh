/** Only layout rectangles are simulated; the reading probe is the browser-lane implementation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readingPort, readingAnchor, anchorDrift } from './browser/reading-probe.ts'

test('a paging callback resolves its containing scrollport and cannot measure a sibling Pane', () => {
  const dom = new JSDOM(`<section id="a"><div data-conversation-scroll><div data-chat-flow>
    <div data-chat-anchor-key="row"></div></div></div></section>
    <section id="b"><div data-conversation-scroll><div data-chat-flow></div></div></section>`)
  try {
    const document = dom.window.document
    const pane = document.getElementById('a')!, port = pane.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const column = port.querySelector<HTMLElement>('[data-chat-flow]')!, row = column.querySelector<HTMLElement>('[data-chat-anchor-key]')!
    port.getBoundingClientRect = () => new dom.window.DOMRect(0, 40, 390, 804)
    let top = 50
    row.getBoundingClientRect = () => new dom.window.DOMRect(0, top, 390, 96)
    for (const element of [pane, port, column, row]) assert.equal(readingPort(element), port)
    assert.deepEqual(readingAnchor(column), { key: 'row', top: 10 })
    const before = readingAnchor(column)!
    top += 2
    assert.equal(anchorDrift(column, before), 2)
    row.remove()
    assert.equal(anchorDrift(column, before), null, 'a removed anchor is a failure, never a zero-drift sample')
    assert.equal(readingAnchor(column), null)
  } finally { dom.window.close() }
})

test('a missing official scrollport fails explicitly', () => {
  const dom = new JSDOM('<div id="detached"></div>')
  try { assert.throws(() => readingPort(dom.window.document.getElementById('detached')!), /no scrollport/) }
  finally { dom.window.close() }
})
