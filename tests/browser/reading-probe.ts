/** Geometry observers for the official component lab. They never write scroll state. */
export interface ReadingAnchor {
  readonly key: string
  readonly top: number
}

const PORT = '[data-conversation-scroll]'

/** Callbacks receive a Chat column; other probes receive its content or Pane. */
export function readingPort(element: HTMLElement): HTMLElement {
  const port = element.matches(PORT) ? element
    : element.closest<HTMLElement>(PORT) ?? element.querySelector<HTMLElement>(PORT)
  if (!port) throw new Error('The measured official reader has no scrollport.')
  return port
}

export function readingAnchor(element: HTMLElement): ReadingAnchor | null {
  const port = readingPort(element), box = port.getBoundingClientRect()
  const node = [...port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')].find(node => {
    if (node.dataset.chatFlowKind === 'turn-process' || node.querySelector('[data-chat-anchor-key]')) return false
    const rect = node.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > box.top + 2 && rect.top < box.bottom - 100
  })
  return node ? { key: node.dataset.chatAnchorKey!, top: node.getBoundingClientRect().top - box.top } : null
}

export function anchorDrift(element: HTMLElement, anchor: ReadingAnchor): number | null {
  const port = readingPort(element)
  const node = [...port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
    .find(node => node.dataset.chatAnchorKey === anchor.key)
  return node ? node.getBoundingClientRect().top - port.getBoundingClientRect().top - anchor.top : null
}

interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Wait for the exact requested older-page commit and for every busy signal to clear. */
export async function waitForOlderSourceCommit(
  source: SnapshotSource<{ readonly olderRevision?: number; readonly pagingError?: true }>,
  session: SnapshotSource<{ readonly loadingOlder?: boolean }>,
  reading: SnapshotSource<{ readonly busy: boolean }>,
  previousRevision: number,
  signal: AbortSignal,
): Promise<void> {
  const ready = (): boolean => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Older page measurement cancelled.', 'AbortError')
    const progress = source.getSnapshot()
    if (progress.pagingError) throw new Error('The official source reader reported a paging failure.')
    return (progress.olderRevision ?? 0) > previousRevision
      && !reading.getSnapshot().busy && !session.getSnapshot().loadingOlder
  }
  if (ready()) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const stops: Array<() => void> = []
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      for (const stop of stops) stop()
    }
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true; cleanup()
      if (error === undefined) resolve(); else reject(error)
    }
    const check = (): void => {
      try { if (ready()) finish() } catch (error) { finish(error) }
    }
    const abort = (): void => finish(signal.reason ?? new DOMException('Older page measurement cancelled.', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('The official older-page commit did not settle within 10 seconds.')), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    stops.push(source.subscribe(check), session.subscribe(check), reading.subscribe(check))
    check()
  })
}

interface LayoutSample {
  readonly port: readonly number[]
  readonly anchor: readonly number[] | null
}

function layoutSample(element: HTMLElement, anchor: ReadingAnchor): LayoutSample {
  const port = readingPort(element), portRect = port.getBoundingClientRect()
  const node = [...port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
    .find(node => node.dataset.chatAnchorKey === anchor.key)
  const nodeRect = node?.getBoundingClientRect()
  return {
    port: [portRect.top, portRect.left, portRect.width, portRect.height,
      port.scrollTop, port.scrollHeight, port.clientHeight],
    anchor: nodeRect ? [nodeRect.top, nodeRect.left, nodeRect.width, nodeRect.height] : null,
  }
}

function sameLayout(left: LayoutSample, right: LayoutSample): boolean {
  return left.port.every((value, index) => value === right.port[index])
    && (left.anchor === null && right.anchor === null
      || left.anchor !== null && right.anchor !== null
        && left.anchor.every((value, index) => value === right.anchor![index]))
}

/**
 * Measure the original anchor only after its React layout has stayed unchanged
 * across two consecutive animation-frame intervals. Missing keys stay missing.
 */
export async function stableAnchorDrift(
  element: HTMLElement,
  anchor: ReadingAnchor,
  options: { signal?: AbortSignal; requestFrame?: (callback: FrameRequestCallback) => number; maxFrames?: number } = {},
): Promise<number | null> {
  const requestFrame = options.requestFrame ?? (callback => requestAnimationFrame(callback))
  const maxFrames = options.maxFrames ?? 60
  let previous: LayoutSample | undefined, stableFrames = 0
  for (let frame = 0; frame < maxFrames; frame++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Anchor measurement cancelled.', 'AbortError')
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { options.signal?.removeEventListener('abort', abort); reject(options.signal?.reason ?? new DOMException('Anchor measurement cancelled.', 'AbortError')) }
      options.signal?.addEventListener('abort', abort, { once: true })
      requestFrame(() => {
        options.signal?.removeEventListener('abort', abort)
        resolve()
      })
    })
    const current = layoutSample(element, anchor)
    if (previous && sameLayout(previous, current)) {
      if (++stableFrames >= 2) return anchorDrift(element, anchor)
    } else stableFrames = 0
    previous = current
  }
  throw new Error(`The original reading anchor layout did not stabilize: ${anchor.key}`)
}

/** A non-owning observer samples at the official commit checkpoint, not before network IO. */
export function observeReadingCommit(
  element: HTMLElement,
  register: (participant: import('@deepseek-ai/dsh-api-session-controller/client').WindowReaderParticipantV1) => () => void,
): { anchor(): ReadingAnchor | null; count(): number; release(): void } {
  let sample: ReadingAnchor | null = null, commits = 0
  const release = register({
    id: 'hhpi-lab-commit-observer',
    measure() {
      sample = readingAnchor(element); ++commits
      const port = readingPort(element)
      // Not a scroll owner: do not affect candidate admission, pinning or correction.
      // Every observed coordinate still comes from the actual DOM.
      return { revision: commits, anchor: null, following: false,
        scrollTop: port.scrollTop, clientHeight: port.clientHeight,
        scrollHeight: port.scrollHeight, nodes: 0, available: false }
    },
    correct() {},
  })
  return { anchor: () => sample, count: () => commits, release }
}
