import type { SessionBinding, SessionEventWindow, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { keyIntent } from './intent.ts'
import { automaticHistoryBounds, automaticHistoryIdentity } from './shared.ts'

/** Share the existing automatic-history ceiling; do not stop after two pages. */
export const MAX_INITIAL_HISTORY_PAGES = 20
export const INITIAL_HISTORY_ATTRIBUTE = 'data-hapi-initial-history'

export interface InitialWindowProbe {
    readonly firstSeq: number | null
    readonly turns: number
    readonly previousTurnIncluded: boolean
}

/** A start without its original input may be a partial source seed, not context. */
export function probeInitialWindow(window: Pick<SessionEventWindow, 'entries'>): InitialWindowProbe {
    let firstSeq: number | null = null
    const turns = new Set<number>()
    const groups = new Map<number, { start: boolean; input: boolean }>()
    let current: number | null = null
    const group = (turn: number) => {
        let value = groups.get(turn)
        if (value === undefined) { value = { start: false, input: false }; groups.set(turn, value) }
        return value
    }
    for (const entry of window.entries) {
        if (entry.type !== 'event') continue
        firstSeq = firstSeq === null ? entry.event.seq : Math.min(firstSeq, entry.event.seq)
        const event = entry.event
        if (event.type === 'turn/start') {
            current = event.data.turn; turns.add(current); group(current).start = true
        } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt' || event.type === 'tool/call') {
            current = event.data.turn; group(current)
        } else if (event.type === 'user/message' && event.surfaceOp === 'append' && current !== null) {
            group(current).input = true
        }
    }
    const latest = [...groups.entries()].sort(([a], [b]) => a - b).slice(-2)
    return { firstSeq, turns: turns.size,
        previousTurnIncluded: latest.length === 2 && latest.every(([, value]) => value.start && value.input) }
}

export type InitialHistoryState = 'waiting' | 'loading' | 'ready' | 'exhausted' | 'limited' | 'error' | 'reader'

/** Pure, generation-owned limit shared by simultaneous views of one Session. */
export class InitialHistoryPlan {
    state: InitialHistoryState = 'waiting'
    pages = 0
    private reader = false

    evaluate(input: {
        visible: boolean; open: boolean; loading: boolean; hasMore: boolean; previousTurnIncluded: boolean
    }): boolean {
        if (this.state !== 'waiting' || !input.visible || !input.open || input.loading) return false
        if (input.previousTurnIncluded) { this.state = 'ready'; return false }
        if (!input.hasMore) { this.state = 'exhausted'; return false }
        if (this.pages >= MAX_INITIAL_HISTORY_PAGES) { this.state = 'limited'; return false }
        return true
    }

    requested(): void { this.pages++; this.state = 'loading' }

    settled(before: InitialWindowProbe, after: InitialWindowProbe, hasMore: boolean): void {
        if (this.state !== 'loading') return
        if (this.reader) { this.state = 'reader'; return }
        if (after.previousTurnIncluded) { this.state = 'ready'; return }
        if (!hasMore) { this.state = 'exhausted'; return }
        if (before.firstSeq === null || after.firstSeq === null || after.firstSeq >= before.firstSeq) {
            this.state = 'error'; return
        }
        this.state = this.pages >= MAX_INITIAL_HISTORY_PAGES ? 'limited' : 'waiting'
    }

    failed(): void { this.state = this.reader ? 'reader' : 'error' }
    interrupt(): void {
        this.reader = true
        if (this.state === 'waiting') this.state = 'reader'
    }
}

interface SharedInitialPlan {
    readonly plan: InitialHistoryPlan
    readonly listeners: Set<() => void>
}

// Public Session faces identify exact retained generations. Nothing here owns a
// reference or reaches into the official Session's private implementation.
const plans = new WeakMap<SessionBinding['session'], SharedInitialPlan>()

/**
 * Fill a missing previous Turn in the official retained window after first
 * paint. Unlike clicking Load earlier, the public Session verb does not pause
 * tail following. It also leaves editor focus, drafts and scroll ownership to
 * the official view. A reader gesture cancels any further automatic prefetch.
 *
 * The target is two input-bearing Turns, not a fixed number of pages. The
 * shared 20-page ceiling still applies; exhausted means the Host has no more
 * rows, without claiming that a partial source seed contains a previous Turn.
 */
export function bindInitialHistory(
    target: HTMLElement,
    reference: SessionReference,
    visibility: ObservableSnapshot<{ visible: boolean }>,
): () => void {
    const binding = reference.binding
    const session = binding.session
    let shared = plans.get(session)
    if (shared === undefined) {
        shared = { plan: new InitialHistoryPlan(), listeners: new Set() }
        plans.set(session, shared)
    }
    const { plan, listeners } = shared
    const { gate, ledger } = automaticHistoryBounds(target.ownerDocument)
    const identity = automaticHistoryIdentity(target, reference.sessionId)
    const frame = target.ownerDocument.defaultView
    const now = (): number => frame?.performance.now() ?? Date.now()
    let disposed = false, ready = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let paint: number | undefined
    const publish = (): void => { for (const listener of listeners) listener() }
    const mark = (): void => {
        if (!disposed && target.getAttribute(INITIAL_HISTORY_ATTRIBUTE) !== plan.state) {
            target.setAttribute(INITIAL_HISTORY_ATTRIBUTE, plan.state)
        }
    }
    const schedule = (delay = 0): void => {
        mark()
        if (disposed || timer !== undefined || paint !== undefined || plan.state !== 'waiting') return
        // A macrotask after the next animation frame leaves the first transcript
        // and composer commit on the critical path by themselves.
        const enqueue = (): void => { paint = undefined; timer = setTimeout(check, delay) }
        if (frame === null || delay > 0) enqueue()
        else paint = frame.requestAnimationFrame(enqueue)
    }
    const check = (): void => {
        timer = undefined
        if (disposed || !ready || !target.isConnected || !visibility.getSnapshot().visible || target.hidden) return
        const snapshot = session.getSnapshot()
        const before = probeInitialWindow(binding.eventSource.getSnapshot())
        const allowed = plan.evaluate({
            visible: true,
            open: snapshot.openState === 'open', loading: snapshot.loadingOlder,
            hasMore: snapshot.hasMore, previousTurnIncluded: before.previousTurnIncluded,
        })
        mark()
        if (!allowed) return
        if (ledger.exhausted(identity)) { plan.state = 'limited'; publish(); return }
        const verdict = gate.tryStart(now())
        if (!verdict.allowed) {
            if (verdict.reason === 'rate') schedule(gate.limits.windowMs + 1)
            return
        }
        plan.requested(); publish()
        // loadOlder synchronously publishes its busy bit; both duplicate views
        // and ordinary gesture paging therefore observe the same single flight.
        void (async () => {
            try {
                await session.loadOlder()
                const after = probeInitialWindow(binding.eventSource.getSnapshot())
                if (before.firstSeq !== null && after.firstSeq !== null && after.firstSeq < before.firstSeq) ledger.spend(identity)
                plan.settled(before, after, session.getSnapshot().hasMore)
            } catch { plan.failed() }
            finally { gate.release(); publish() }
        })()
    }
    const changed = (): void => { schedule() }
    const reader = (event: Event): void => {
        const element = event.target as Element | null
        // Composer focus, typing, permission controls and attachments must not
        // cancel the opening context. Only a gesture inside this transcript
        // transfers scroll ownership to its reader.
        if (!element || typeof element.closest !== 'function' || !element.closest('[data-conversation-scroll]')
            || element.closest('input,textarea,[contenteditable="true"],[data-composer-card]')) return
        if (event.type === 'keydown' && keyIntent((event as KeyboardEvent).key, event as KeyboardEvent) === 'none') return
        plan.interrupt(); publish()
    }
    listeners.add(changed)
    const unsubscribe = [session.subscribe(changed), binding.eventSource.subscribe(changed), visibility.subscribe(changed), gate.subscribe(changed)]
    const inputs = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const
    for (const input of inputs) target.addEventListener(input, reader, { capture: true, passive: true })
    void reference.ready.then(() => {
        if (disposed) return
        ready = true; schedule()
    }, () => {
        if (disposed) return
        plan.failed(); publish()
    })
    mark()
    return () => {
        if (disposed) return
        disposed = true
        if (timer !== undefined) clearTimeout(timer)
        if (paint !== undefined) frame?.cancelAnimationFrame(paint)
        for (const unlisten of unsubscribe) unlisten()
        for (const input of inputs) target.removeEventListener(input, reader, { capture: true })
        listeners.delete(changed)
        target.removeAttribute(INITIAL_HISTORY_ATTRIBUTE)
    }
}
