/** Real installed-source viewport and reader; jsdom rectangles are explicit geometry fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import type { WindowReaderMeasurementV1 } from '@deepseek-ai/dsh-api-session-controller/client'
import { installDomGeometry } from './dom-geometry.ts'

const require = createRequire(import.meta.url)
interface Position { anchorKey: string; anchorOwnerKey?: string; anchorTop: number; scrollTop: number }
const official = require('../../.tmp/hhpi-official-contract.cjs') as {
  ChatViewport: new () => {
    attach(list: HTMLElement, column: HTMLElement): void; detach(): void; capturePosition(): Position | null
    registerVirtualRows(rows: { contains(key: string): boolean; pinReading(key: string | null): void; reveal(key: string): boolean; releaseDestination(): void; retain(key: string, value: boolean): void; observeProgrammaticScroll(top: number): void }): () => void
    registerAnchorOwner(anchor: string, row: string): () => void
    restore(position: Position): unknown; restoreVirtualLayout(): void; stopPreserving(): void
  }
  createWindowCommitReader(source: {
    readMetrics(): { top: number; height: number; floor: number }
    capturePosition(): Position | null; following(): boolean; rows(): number
    restore(position: Position): void; followTail(): void
  }): { measure(): WindowReaderMeasurementV1; correct(measurement: WindowReaderMeasurementV1): void }
}

test('official viewport preserves a tool subcall anchor and measures its owning node separately', t => {
  const dom = new JSDOM('<div data-conversation-scroll><div id="list"><div id="column"><div data-chat-virtual-row data-chat-virtual-key="row:root"><div data-chat-node-key="tool:root" data-chat-anchor-key="tool:root" data-chat-flow-key="tool:root"><div data-chat-anchor-key="call:child"><span id="hit">Nested tool result</span></div></div></div></div></div></div>', { pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ document: dom.window.document, HTMLElement: dom.window.HTMLElement })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const geometry = installDomGeometry(dom.window, { width: 390, height: 600 })
  const viewport = new official.ChatViewport()
  t.after(() => {
    viewport.detach(); geometry.dispose(); dom.window.close()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  const { document } = dom.window, list = document.getElementById('list')!, column = document.getElementById('column')!
  const child = document.querySelector<HTMLElement>('[data-chat-anchor-key="call:child"]')!
  geometry.setBox(child, { x: 0, y: -17, width: 390, height: 160 })
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [document.getElementById('hit')!] })
  viewport.attach(list, column)
  const pins: Array<string | null> = [], reveals: string[] = [], landings: number[] = []
  let releases = 0
  viewport.registerVirtualRows({ contains: key => key === 'row:root', pinReading: key => { pins.push(key) },
    reveal: key => { reveals.push(key); return key === 'row:root' }, releaseDestination: () => { releases++ },
    retain: () => {}, observeProgrammaticScroll: top => { landings.push(top) } })
  viewport.registerAnchorOwner('tool:root', 'row:root')
  const position = viewport.capturePosition()
  assert.ok(position)
  assert.equal(position.anchorKey, 'call:child', 'restoration keeps the precise nested tool position')
  assert.equal(position.anchorOwnerKey, 'tool:root', 'capacity validation addresses the assembler node')
  assert.equal(position.anchorTop, -17)
  assert.equal(pins.at(-1), 'tool:root', 'the virtualizer must resolve the stable semantic owner even when grouping changes its physical row key')
  let restored: Position | undefined
  const reader = official.createWindowCommitReader({ readMetrics: () => ({ top: 100, height: 600, floor: 1400 }),
    capturePosition: () => position, following: () => false, rows: () => 160,
    restore: value => { restored = value }, followTail: () => assert.fail('a pinned reader must not jump to the tail') })
  const measurement = reader.measure()
  assert.equal(measurement.anchor?.key, 'call:child')
  assert.equal(measurement.anchor?.ownerKey, 'tool:root')
  reader.correct(measurement)
  assert.deepEqual(restored, { anchorKey: 'call:child', anchorOwnerKey: 'tool:root', anchorTop: -17, scrollTop: 100 })

  const virtualRow = document.querySelector<HTMLElement>('[data-chat-virtual-row]')!, scroller = document.querySelector<HTMLElement>('[data-conversation-scroll]')!
  virtualRow.remove(); scroller.scrollTop = 100
  assert.equal(viewport.restore({ ...position, scrollTop: 11 }), null)
  assert.equal(reveals.at(-1), 'row:root', 'a missing inner anchor reveals its known owner row')
  assert.equal(scroller.scrollTop, 100, 'an unmounted owner must not fall back to the obsolete raw scroll offset')
  column.append(virtualRow)
  geometry.setBox(child, { x: 0, y: 120, width: 390, height: 160 })
  viewport.restoreVirtualLayout()
  assert.equal(landings.at(-1), 237, 'once mounted, the exact inner anchor restores its original -17px offset')
  assert.equal(releases, 1, 'a successful remount releases its temporary navigation pin')
  virtualRow.remove()
  viewport.restore(position)
  child.remove(); column.append(virtualRow)
  viewport.restoreVirtualLayout()
  assert.equal(releases, 2, 'an owner mounted without its removed subcall cancels the pending restore')
  virtualRow.firstElementChild!.append(child)
  viewport.restoreVirtualLayout()
  assert.equal(landings.length, 1, 'a later layout must not revive an obsolete inner-anchor restore')
  virtualRow.remove(); viewport.restore(position); viewport.stopPreserving()
  assert.equal(releases, 3, 'user navigation cancelling a pending remount releases its temporary pin')
  column.append(virtualRow); viewport.restoreVirtualLayout()
  assert.equal(landings.length, 1, 'cancelled navigation must not revive on remount')
})
