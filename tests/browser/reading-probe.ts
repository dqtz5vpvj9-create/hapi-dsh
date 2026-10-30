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
