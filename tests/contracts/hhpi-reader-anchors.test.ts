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
  ChatViewport: new () => { attach(list: HTMLElement, column: HTMLElement): void; detach(): void; capturePosition(): Position | null }
  createWindowCommitReader(source: {
    readMetrics(): { top: number; height: number; floor: number }
    capturePosition(): Position | null; following(): boolean; rows(): number
    restore(position: Position): void; followTail(): void
  }): { measure(): WindowReaderMeasurementV1; correct(measurement: WindowReaderMeasurementV1): void }
}

test('official viewport preserves a tool subcall anchor and measures its owning node separately', t => {
  const dom = new JSDOM('<div data-conversation-scroll><div id="list"><div id="column"><div data-chat-node-key="tool:root" data-chat-anchor-key="tool:root" data-chat-flow-key="tool:root"><div data-chat-anchor-key="call:child"><span id="hit">Nested tool result</span></div></div></div></div></div>', { pretendToBeVisual: true })
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
  const position = viewport.capturePosition()
  assert.ok(position)
  assert.equal(position.anchorKey, 'call:child', 'restoration keeps the precise nested tool position')
  assert.equal(position.anchorOwnerKey, 'tool:root', 'capacity validation addresses the assembler node')
  assert.equal(position.anchorTop, -17)
  let restored: Position | undefined
  const reader = official.createWindowCommitReader({ readMetrics: () => ({ top: 100, height: 600, floor: 1400 }),
    capturePosition: () => position, following: () => false, rows: () => 160,
    restore: value => { restored = value }, followTail: () => assert.fail('a pinned reader must not jump to the tail') })
  const measurement = reader.measure()
  assert.equal(measurement.anchor?.key, 'call:child')
  assert.equal(measurement.anchor?.ownerKey, 'tool:root')
  reader.correct(measurement)
  assert.deepEqual(restored, { anchorKey: 'call:child', anchorTop: -17, scrollTop: 100 })
})
