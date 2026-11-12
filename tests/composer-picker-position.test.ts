import assert from 'node:assert/strict'
import { test } from 'node:test'
import { positionPicker } from '../src/client/composer-picker/position.ts'

const viewport = { left: 0, top: 0, width: 1440, height: 900 }

test('More in a 72.5px split keeps readable width rather than the observed 48.5px column', () => {
  const anchor = { left: 292, right: 324, top: 808, bottom: 840 }
  const pane = { left: 280, right: 352.5, top: 80, bottom: 880 }
  const box = positionPicker(anchor, viewport, 1400, pane)
  assert.ok(box.width >= 280, 'MCP names and More actions need readable lines in a narrow split')
  assert.ok(box.left <= anchor.left && box.left + box.width >= anchor.right)
  assert.ok(box.left >= 12 && box.left + box.width <= 1428)
  assert.ok(box.top >= pane.top + 12)
  assert.ok(box.top + box.maxHeight <= anchor.top - 8)
  assert.ok(box.maxHeight <= 480, 'long source lists scroll inside the existing popover')
})

test('a narrow split at the right edge opens a readable menu toward the screen interior', () => {
  const anchor = { left: 1380, right: 1412, top: 808, bottom: 840 }
  const box = positionPicker(anchor, viewport, 700, { left: 1360, right: 1432.5, top: 80, bottom: 880 })
  assert.ok(box.width >= 280)
  assert.ok(box.left <= anchor.left && box.left + box.width >= anchor.right)
  assert.ok(box.left + box.width <= 1428)
})

test('narrow split overflow respects a keyboard-adjusted visual viewport and leaves the close header reachable', () => {
  const view = { left: 45, top: 120, width: 390, height: 330 }
  const anchor = { left: 88, right: 120, top: 390, bottom: 434 }
  const box = positionPicker(anchor, view, 1200, { left: 68, right: 140.5, top: 80, bottom: 850 })
  assert.ok(box.width >= 280)
  assert.ok(box.left >= view.left + 12 && box.left + box.width <= view.left + view.width - 12)
  assert.ok(box.top >= view.top + 12)
  assert.ok(box.maxHeight >= 44, 'the existing close button must remain visible above the keyboard')
  assert.ok(box.top + box.maxHeight <= view.top + view.height - 12)
})

test('normal panes keep their existing boundary while a tiny viewport remains the final width limit', () => {
  const pane = { left: 400, right: 900, top: 60, bottom: 860 }
  const normal = positionPicker({ left: 850, right: 882, top: 760, bottom: 792 }, viewport, 500, pane)
  assert.ok(normal.left >= pane.left + 12 && normal.left + normal.width <= pane.right - 12)
  assert.equal(normal.width, 320)
  const tinyView = { left: 0, top: 0, width: 220, height: 400 }
  const tiny = positionPicker({ left: 130, right: 162, top: 320, bottom: 352 }, tinyView, 500, { left: 120, right: 192.5, top: 40, bottom: 390 })
  assert.ok(tiny.width > 100)
  assert.ok(tiny.left >= 12 && tiny.left + tiny.width <= 208)
})
