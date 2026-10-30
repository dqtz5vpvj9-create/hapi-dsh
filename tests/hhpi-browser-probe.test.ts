/** Only layout rectangles are simulated; the reading probe is the browser-lane implementation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readingPort, readingAnchor, anchorDrift, observeReadingCommit } from './browser/reading-probe.ts'

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

test('anchor observation excludes intentional motion before the official commit and never corrects scroll state', () => {
  const dom = new JSDOM('<div data-conversation-scroll><div data-chat-flow><div data-chat-anchor-key="row"></div></div></div>')
  try {
    const port = dom.window.document.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const column = port.firstElementChild as HTMLElement, row = column.firstElementChild as HTMLElement
    port.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 390, 804)
    let top = 100
    row.getBoundingClientRect = () => new dom.window.DOMRect(0, top, 390, 96)
    let participant!: Parameters<Parameters<typeof observeReadingCommit>[1]>[0], released = false
    const observer = observeReadingCommit(column, value => { participant = value; return () => { released = true } })
    const requested = readingAnchor(column)!
    top += 46 // A trusted finger can move while the source read is in flight.
    port.scrollTop = 500
    const measured = participant.measure()
    assert.equal(measured.available, false, 'a diagnostic observer must not become an admission/scroll owner')
    assert.equal(observer.count(), 1)
    assert.equal(anchorDrift(column, observer.anchor()!), 0, 'commit-local drift excludes pre-commit finger movement')
    assert.equal(anchorDrift(column, requested), 46)
    participant.correct(measured, { windowId: 'pane', baseRevision: 0, revision: 1, measurement: measured })
    assert.equal(port.scrollTop, 500, 'diagnostics never write scroll position')
    observer.release(); assert.equal(released, true)
  } finally { dom.window.close() }
})
