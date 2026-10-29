import { afterEach, expect, test, vi } from 'vitest'
import { installSeamlessHistory, type SeamlessHistoryEvent } from '../../src/client/seamless/controller.ts'

const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')

function historySurface() {
  document.body.innerHTML = `<section class="hapi-pane" data-pane-id="pane-a" data-hapi-pane-visible="true">
    <div data-conversation-content data-conversation-session="hapi-codex-${'a'.repeat(32)}">
      <div data-conversation-scroll><div data-chat-flow><div data-chat-anchor-key="row-0"></div>
        <div><button type="button">Load earlier</button></div>
      </div></div>
    </div>
  </section>`
  const pane = document.querySelector<HTMLElement>('.hapi-pane')!
  const scroller = pane.querySelector<HTMLElement>('[data-conversation-scroll]')!
  const column = pane.querySelector<HTMLElement>('[data-chat-flow]')!
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2_000 })
  scroller.scrollTop = 0
  // jsdom omits browser hit testing; the paging fixture has one visible row.
  Object.defineProperty(document, 'elementFromPoint', { configurable: true,
    value: () => scroller.querySelector('[data-chat-anchor-key]') })
  return { pane, scroller, column }
}

async function requestOneOlderPage(scroller: HTMLElement): Promise<void> {
  scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
  await vi.advanceTimersByTimeAsync(181)
  await Promise.resolve()
  await Promise.resolve()
  // The mounted reader settles the page after its official layout commit.
  await vi.advanceTimersByTimeAsync(60)
}

afterEach(() => {
  document.body.replaceChildren()
  if (originalElementFromPoint) Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint)
  else Reflect.deleteProperty(document, 'elementFromPoint')
  vi.useRealTimers()
})

test('source cursor progress waits for the mounted reader and folded pages continue to earlier readable content', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000)
  const { scroller, column } = historySurface()
  const events: SeamlessHistoryEvent[] = []
  let cursor = 100, requests = 0
  let commit!: () => void
  const dispose = installSeamlessHistory(document, {
    now: () => Date.now(), nearTop: () => 100,
    maxAutomaticPagesPerSession: 1,
    budget: { maxAutomaticPages: 1, maxRequestsPerBurst: 1 },
    sourceWindowProgress: () => ({ before: { at: cursor, seq: 0 }, historyId: 'history', historyVersion: 1 }),
    loadOlderProgrammatically: async () => {
      requests++; cursor--
      if (requests === 1) await new Promise<void>(resolve => { commit = resolve })
      if (requests === 3) {
        const earlier = document.createElement('div')
        earlier.dataset.chatAnchorKey = 'earlier-readable-message'
        column.prepend(earlier)
      }
      return true
    },
    onEvent: event => events.push(event),
  })
  try {
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
    await vi.advanceTimersByTimeAsync(60)
    expect(requests).toBe(1)
    expect(events.filter(event => event.type === 'committed')).toHaveLength(0)
    expect(scroller.hasAttribute('data-hapi-interrupted-prepend')).toBe(false)
    commit()
    await vi.advanceTimersByTimeAsync(80)
    expect(requests).toBe(3)
    expect(column.firstElementChild?.getAttribute('data-chat-anchor-key')).toBe('earlier-readable-message')
    expect(events.filter(event => event.type === 'committed')).toHaveLength(3)
    expect(events.some(event => event.type === 'failed' || event.type === 'suspended')).toBe(false)
  } finally { dispose() }
})

test('a bounded HAPI source window keeps loading earlier after the ordinary Session page ceiling', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000)
  const { scroller, column } = historySurface()
  let cursor = 1_000
  const events: SeamlessHistoryEvent[] = []
  const dispose = installSeamlessHistory(document, {
    maxAutomaticPagesPerSession: 1,
    nearTop: () => 100,
    now: () => Date.now(),
    budget: { maxRequestsPerBurst: 10, burstWindowMs: 60_000, maxAutomaticPages: 10 },
    sourceWindowProgress: () => ({ before: { at: cursor, seq: 0 }, historyId: 'source-history', historyVersion: 1 }),
    loadOlderProgrammatically: async () => {
      cursor--
      const row = document.createElement('div')
      row.setAttribute('data-chat-anchor-key', `row-${cursor}`)
      column.insertBefore(row, column.firstChild)
      return true
    },
    onEvent: event => events.push(event),
  })
  try {
    await requestOneOlderPage(scroller)
    expect(events.filter(event => event.type === 'committed')).toHaveLength(1)
    expect(events.at(-1)?.sessionPages).toBe(1)

    await requestOneOlderPage(scroller)
    expect(events.filter(event => event.type === 'committed')).toHaveLength(2)
    expect(events.some(event => event.type === 'suspended' && event.detail === 'session-page-ceiling')).toBe(false)
    expect(column.querySelector('[data-chat-anchor-key="row-998"]')).not.toBeNull()
  } finally { dispose() }
})

test('ordinary append-only Sessions still stop at their configured page ceiling', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000)
  const { scroller, column } = historySurface()
  const events: SeamlessHistoryEvent[] = []
  const dispose = installSeamlessHistory(document, {
    maxAutomaticPagesPerSession: 1,
    nearTop: () => 100,
    now: () => Date.now(),
    budget: { maxRequestsPerBurst: 10, burstWindowMs: 60_000, maxAutomaticPages: 10 },
    loadOlderProgrammatically: async () => {
      const row = document.createElement('div')
      row.setAttribute('data-chat-anchor-key', `row-${column.querySelectorAll('[data-chat-anchor-key]').length}`)
      column.insertBefore(row, column.firstChild)
      return true
    },
    onEvent: event => events.push(event),
  })
  try {
    await requestOneOlderPage(scroller)
    expect(events.filter(event => event.type === 'committed')).toHaveLength(1)
    await requestOneOlderPage(scroller)
    expect(events.some(event => event.type === 'suspended' && event.detail === 'session-page-ceiling'),
      JSON.stringify(events.map(({ type, detail, sessionPages }) => ({ type, detail, sessionPages })))).toBe(true)
    expect(events.filter(event => event.type === 'committed')).toHaveLength(1)
  } finally { dispose() }
})

test('upward intent warms a source page before the reader reaches the load boundary', () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000)
  const { scroller } = historySurface()
  scroller.scrollTop = 500
  const prefetch = vi.fn()
  const events: SeamlessHistoryEvent[] = []
  const sessionId = `hapi-codex-${'a'.repeat(32)}`
  const dispose = installSeamlessHistory(document, {
    nearTop: () => 100,
    now: () => Date.now(),
    sourceWindowProgress: () => ({ before: { at: 1_000, seq: 0 }, historyId: 'source-history', historyVersion: 1 }),
    prefetchOlderPage: prefetch,
    loadOlderProgrammatically: async () => true,
    onEvent: event => events.push(event),
  })
  try {
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
    expect(prefetch).toHaveBeenCalledOnce()
    expect(prefetch).toHaveBeenCalledWith(sessionId)
    expect(events.some(event => event.type === 'requested')).toBe(false)
  } finally { dispose() }
})

test('a committed source page warms the next cursor during the same upward reading gesture', () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000)
  const { scroller } = historySurface()
  scroller.scrollTop = 500
  const sessionId = `hapi-codex-${'a'.repeat(32)}`
  const prefetch = vi.fn()
  const listeners = new Set<() => void>()
  let cursor = 1_000
  const dispose = installSeamlessHistory(document, {
    nearTop: () => 100,
    now: () => Date.now(),
    sourceWindowProgress: () => ({ before: { at: cursor, seq: 0 }, historyId: 'source-history', historyVersion: 1 }),
    subscribeSourceWindow: (_id, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    prefetchOlderPage: prefetch,
    loadOlderProgrammatically: async () => true,
  })
  try {
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
    expect(prefetch).toHaveBeenCalledTimes(1)
    expect(prefetch).toHaveBeenLastCalledWith(sessionId)

    // HAPI's history-window subscription rechecks the boundary after commit;
    // the next page is ready before another wheel/touch sample is needed.
    cursor = 999
    for (const listener of listeners) listener()
    expect(prefetch).toHaveBeenCalledTimes(2)
    expect(prefetch).toHaveBeenLastCalledWith(sessionId)

    // Repeated snapshot notifications for one cursor do not start duplicate reads.
    for (const listener of listeners) listener()
    expect(prefetch).toHaveBeenCalledTimes(2)
  } finally { dispose() }
  expect(listeners.size).toBe(0)
})

test('a stalled source page is cancelled when the reader request expires', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000)
  const { scroller, column } = historySurface()
  const button = column.querySelector('button')!
  const signals: AbortSignal[] = []
  const cancelled: Array<{ sessionId: string | null; reason: unknown }> = []
  const events: SeamlessHistoryEvent[] = []
  const dispose = installSeamlessHistory(document, {
    nearTop: () => 100,
    now: () => Date.now(),
    budget: { requestTimeoutMs: 500, failureCooldownMs: 100 },
    sourceWindowProgress: () => ({ before: { at: 1_000, seq: 0 }, historyId: 'source-history', historyVersion: 1 }),
    cancelSourcePage: (sessionId, reason) => cancelled.push({ sessionId, reason }),
    loadOlderProgrammatically: async (_pane, _sessionId, signal) => {
      signals.push(signal)
      button.disabled = true
      signal.addEventListener('abort', () => { button.disabled = false }, { once: true })
      return await new Promise<boolean>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    onEvent: event => events.push(event),
  })
  try {
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
    await vi.advanceTimersByTimeAsync(181)
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve()
    expect(signals[0]!.aborted).toBe(true)
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]!.reason).toBeInstanceOf(Error)
    expect(button.disabled).toBe(false)
    expect(events.some(event => event.type === 'failed' && event.detail === 'timeout')).toBe(true)
  } finally { dispose() }
})
