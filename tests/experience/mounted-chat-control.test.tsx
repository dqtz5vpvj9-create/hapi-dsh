import { afterEach, expect, test, vi } from 'vitest'
import {
  installSharedMountedChatConsumer, MOUNTED_CHAT_ATTRIBUTE, publishPaneMountedChat, resetMountedChatRegistrations,
  resolveMountedChatForPane, resolveMountedChatLatestForPane,
  type MountedChatConsumerV1, type MountedChatControlV1,
} from '../../src/client/mounted-chat-control.ts'
import type { Context } from '@deepseek-ai/cordis'

function control(): MountedChatControlV1 {
  return {
    version: 1,
    read: () => ({ revision: 1, anchor: null, following: true, hasOlder: true, busy: false }),
    subscribe: () => () => {},
    loadOlder: vi.fn(async () => {}), reveal: vi.fn(async () => {}), toLatest: vi.fn(async () => {}),
  }
}

afterEach(resetMountedChatRegistrations)

test('shared graph delivers each portal reader to its own pane and ignores a preparation view', async () => {
  const left = document.createElement('section'), right = document.createElement('section')
  const leftView = document.createElement('div'), rightView = document.createElement('div')
  const candidate = document.createElement('div')
  left.append(leftView); right.append(rightView)
  let consumer!: MountedChatConsumerV1
  const ctx = { reflect: { provide(_name: string, value: MountedChatConsumerV1) { consumer = value; return () => {} } } } as unknown as Context
  const dispose = installSharedMountedChatConsumer(ctx, element => [left, right].find(pane => pane.contains(element)), async () => {})
  const first = control(), second = control(), preparation = control()
  consumer.onMountedChat?.(first, leftView)
  consumer.onMountedChat?.(second, rightView)
  consumer.onMountedChat?.(preparation, candidate)
  expect(resolveMountedChatForPane(leftView)).toBe(first)
  expect(resolveMountedChatForPane(rightView)).toBe(second)
  expect(resolveMountedChatForPane(candidate)).toBeUndefined()
  await resolveMountedChatForPane(leftView)!.loadOlder()
  expect(first.loadOlder).toHaveBeenCalledOnce()
  expect(second.loadOlder).not.toHaveBeenCalled()
  expect(preparation.loadOlder).not.toHaveBeenCalled()

  const successorView = document.createElement('div'), successor = control()
  left.append(successorView)
  consumer.onMountedChat?.(successor, successorView)
  consumer.onMountedChat?.(null, leftView)
  expect(resolveMountedChatForPane(successorView)).toBe(successor)
  expect(resolveMountedChatForPane(rightView)).toBe(second)
  dispose()
  expect(resolveMountedChatForPane(successorView)).toBeUndefined()
  expect(resolveMountedChatForPane(rightView)).toBeUndefined()
})

test('real pane elements register usable mounted controls and unmount independently', async () => {
  // Actual DOMStringMap validates dataset property names; a plain object hid
  // the registration exception and could never exercise CSS closest lookup.
  const left = document.createElement('section'), right = document.createElement('section')
  const leftContent = document.createElement('div'), rightContent = document.createElement('div')
  left.append(leftContent); right.append(rightContent)
  const leftControl = control(), rightControl = control()
  publishPaneMountedChat(left, leftControl, true)
  publishPaneMountedChat(right, rightControl)

  expect(left.hasAttribute(MOUNTED_CHAT_ATTRIBUTE)).toBe(true)
  expect(resolveMountedChatForPane(leftContent)).toBe(leftControl)
  expect(resolveMountedChatForPane(rightContent)).toBe(rightControl)
  expect(resolveMountedChatLatestForPane(leftContent)).toBe(leftControl)
  expect(resolveMountedChatLatestForPane(rightContent)).toBeUndefined()
  await resolveMountedChatForPane(rightContent)!.loadOlder()
  expect(rightControl.loadOlder).toHaveBeenCalledOnce()
  expect(leftControl.loadOlder).not.toHaveBeenCalled()

  publishPaneMountedChat(left, null)
  expect(left.hasAttribute(MOUNTED_CHAT_ATTRIBUTE)).toBe(false)
  expect(resolveMountedChatForPane(leftContent)).toBeUndefined()
  expect(resolveMountedChatForPane(rightContent)).toBe(rightControl)

  // Reopening a pane must register a fresh owner without affecting its sibling.
  const reopened = control()
  publishPaneMountedChat(left, reopened, true)
  expect(resolveMountedChatForPane(leftContent)).toBe(reopened)
  expect(resolveMountedChatForPane(rightContent)).toBe(rightControl)
  publishPaneMountedChat(left, null); publishPaneMountedChat(right, null)
  expect(right.hasAttribute(MOUNTED_CHAT_ATTRIBUTE)).toBe(false)
})
