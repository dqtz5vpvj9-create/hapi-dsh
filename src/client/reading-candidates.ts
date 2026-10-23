/** Find an on-screen anchor without measuring every retained transcript row. */
export function readingCandidates(port: HTMLElement): Iterable<HTMLElement> {
    const doc = port.ownerDocument, view = doc.defaultView, box = port.getBoundingClientRect()
    if (view) {
        const top = Math.max(0, box.top), bottom = Math.min(view.innerHeight, box.bottom)
        const left = Math.max(0, box.left), right = Math.min(view.innerWidth, box.right)
        for (const y of [top + 2, top + 18, top + 48]) {
            if (y >= bottom) break
            for (const x of [(left + right) / 2, left + 24, right - 24]) {
                if (x <= left || x >= right) continue
                const hit = doc.elementFromPoint(x, y)?.closest<HTMLElement>('[data-chat-node-key]')
                if (hit && port.contains(hit) && !hit.closest('[hidden], [data-hapi-visible="false"]')) return [hit]
            }
        }
    }
    // A pointer over a process heading or a gap has no message ancestor.
    // Search ordered outer flow rows instead of measuring every retained
    // descendant (which also forces layout inside collapsed/off-screen groups).
    const rows = port.querySelectorAll<HTMLElement>('[data-chat-node-key][data-chat-flow-key]:not([data-chat-flow-kind="turn-process"]):not([hidden]):not([hidden] *):not([data-turn-process-hidden="true"])')
    let low = 0, high = rows.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (rows[middle]!.getBoundingClientRect().bottom > box.top) high = middle
        else low = middle + 1
    }
    const row = rows[low]
    return row && row.getBoundingClientRect().top < box.bottom ? [row] : []
}
