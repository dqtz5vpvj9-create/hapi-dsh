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
  // Attribute equality avoids requiring a CSS.escape polyfill in the DOM lane.
  const node = [...port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
    .find(node => node.dataset.chatAnchorKey === anchor.key)
  return node ? node.getBoundingClientRect().top - port.getBoundingClientRect().top - anchor.top : null
}
