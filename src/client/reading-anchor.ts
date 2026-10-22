/** Public Chat identities and DOM disclosure controls; no transcript text is saved. */
export interface ReloadReadingAnchor { key: string; seq: number; offset: number; displayId?: string; sourceMessageId?: string }
export interface ChatReadingTarget { key: string; kind: string; turn?: number }
interface ReadingNode { key: string; kind: string; anchorSeq: number; location?: { kind: string; turn?: { turn: number } } }
export function parseReloadReadingAnchor(raw: string | null): ReloadReadingAnchor | undefined {
    if (!raw) return undefined
    try {
        const value: unknown = JSON.parse(raw)
        if (!value || typeof value !== 'object') return undefined
        const { key, seq, offset, displayId, sourceMessageId } = value as Partial<ReloadReadingAnchor>
        if (typeof key === 'string' && key.length > 0 && typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0
            && typeof offset === 'number' && Number.isFinite(offset)) return { key, seq, offset, ...(typeof displayId === 'string' ? { displayId } : {}), ...(typeof sourceMessageId === 'string' ? { sourceMessageId } : {}) }
    } catch { /* Invalid optional reading state starts with the official view. */ }
}
export function messageNodeTarget(snapshot: { nodes: { values(): readonly ReadingNode[] } } | undefined, seq: number): ChatReadingTarget | undefined {
    const node = snapshot?.nodes.values().find(node => node.anchorSeq === seq)
    return node ? { key: node.key, kind: node.kind, ...(node.location?.turn === undefined ? {} : { turn: node.location.turn.turn }) } : undefined
}
export function findChatElement(root: HTMLElement, key: string): HTMLElement | undefined {
    return [...root.querySelectorAll<HTMLElement>('[data-chat-anchor-key],[data-chat-node-key]')]
        .find(element => element.dataset.chatAnchorKey === key || element.dataset.chatNodeKey === key)
}
export function revealChatElement(root: HTMLElement, target: ChatReadingTarget, clicked: WeakSet<HTMLElement>): HTMLElement | undefined {
    const row = findChatElement(root, target.key)
    if (row) {
        for (let ancestor: HTMLElement | null = row; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
            if (ancestor.getAttribute('hidden') === 'until-found') ancestor.dispatchEvent(new Event('beforematch', { bubbles: true }))
            if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true
            if (ancestor.hasAttribute('data-step-process')) openProcess(ancestor, clicked)
        }
        if (!row.closest('[hidden]') && row.getClientRects().length) return row
    }
    if (target.turn !== undefined) for (const group of root.querySelectorAll<HTMLElement>('[data-step-process][data-chat-turn]')) {
        if (Number(group.dataset.chatTurn) === target.turn) openProcess(group, clicked)
    }
    return undefined
}
function openProcess(group: HTMLElement, clicked: WeakSet<HTMLElement>): void {
    const button = group.querySelector<HTMLButtonElement>('button[aria-expanded="false"][aria-controls]')
    if (button && !clicked.has(button)) { clicked.add(button); button.click() }
}
export function placeReadingAnchor(port: HTMLElement, element: HTMLElement, offset = 24): void {
    const delta = element.getBoundingClientRect().top - port.getBoundingClientRect().top - offset
    if (Math.abs(delta) > .5) port.scrollTop = Math.max(0, Math.min(port.scrollHeight - port.clientHeight, port.scrollTop + delta))
}
