import { AggregateLoadGate, SessionPageLedger, type AggregateLoadLimits } from './concurrency.ts'

export interface AutomaticHistoryBounds {
    readonly gate: AggregateLoadGate
    readonly ledger: SessionPageLedger
}

/** Reader paging and initial-window prefetch share one document-wide budget. */
const bounds = new WeakMap<object, AutomaticHistoryBounds>()

export function automaticHistoryBounds(owner: object, options: {
    aggregate?: Partial<AggregateLoadLimits> | undefined
    maxPages?: number | undefined
} = {}): AutomaticHistoryBounds {
    let current = bounds.get(owner)
    if (current === undefined) {
        current = { gate: new AggregateLoadGate(options.aggregate), ledger: new SessionPageLedger(options.maxPages ?? 20) }
        bounds.set(owner, current)
    }
    return current
}

/** The host and official session axes remain stable across pane occurrences. */
export function automaticHistoryIdentity(target: HTMLElement, sessionId: string): string {
    const host = target.closest<HTMLElement>('[data-hapi-host]')?.getAttribute('data-hapi-host') ?? 'local'
    return `${host}|${sessionId}`
}
