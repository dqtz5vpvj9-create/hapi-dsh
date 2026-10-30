import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readingAnchor, stableAnchorDrift, waitForOlderSourceCommit } from './reading-probe.ts'

function fixture() {
  const dom = new JSDOM('<div data-conversation-scroll><div data-chat-anchor-key="original"></div></div>', { pretendToBeVisual: true })
  const port = dom.window.document.querySelector<HTMLElement>('[data-conversation-scroll]')!
  const row = port.querySelector<HTMLElement>('[data-chat-anchor-key]')!
  let top = 100
  port.getBoundingClientRect = () => new dom.window.DOMRect(0, 20, 390, 800)
  row.getBoundingClientRect = () => new dom.window.DOMRect(0, top, 390, 40)
  return { dom, port, row, setTop: (value: number) => { top = value } }
}

test('waits for the original anchor layout to settle before returning its displacement', async () => {
  const { dom, port, setTop } = fixture()
  try {
    const anchor = readingAnchor(port)!
    assert.deepEqual(anchor, { key: 'original', top: 80 })
    let frames = 0
    const delta = await stableAnchorDrift(port, anchor, {
      requestFrame: callback => dom.window.requestAnimationFrame(time => {
        if (++frames === 1) setTop(118)
        callback(time)
      }),
    })
    assert.equal(frames, 3, 'two consecutive unchanged frame intervals are required')
    assert.equal(delta, 18)
  } finally { dom.window.close() }
})

test('a missing original key remains a null measurement after stable frames', async () => {
  const { dom, port, row } = fixture()
  try {
    const anchor = readingAnchor(port)!
    row.remove()
    const delta = await stableAnchorDrift(port, anchor, { requestFrame: callback => dom.window.requestAnimationFrame(callback) })
    assert.equal(delta, null)
  } finally { dom.window.close() }
})

test('waits for a new official source revision and both busy signals to clear', async () => {
  function observable<T>(value: T) {
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      set(next: T) { value = next; for (const listener of listeners) listener() },
    }
  }
  const source = observable<{ olderRevision: number }>({ olderRevision: 4 })
  const session = observable({ loadingOlder: true })
  const reading = observable({ busy: true })
  const pending = waitForOlderSourceCommit(source, session, reading, 4, new AbortController().signal)
  let resolved = false
  void pending.then(() => { resolved = true })
  source.set({ olderRevision: 5 })
  session.set({ loadingOlder: false })
  await Promise.resolve()
  assert.equal(resolved, false, 'the mounted reader remains busy')
  reading.set({ busy: false })
  await pending
  assert.equal(resolved, true)
})
