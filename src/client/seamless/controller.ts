/**
 * Seamless earlier-history loading — strategy B (drive the official control).
 *
 * The pinned official Chat exposes exactly one public way to page history with
 * its own anchoring: the "Load earlier" button in `ChatView`. Clicking it runs
 * `ChatNavigation.loadEarlier()`, which calls `viewport.beginPaging()` +
 * `reading.pauseFollowing()` before `ISession.loadOlder()`, and preserves the
 * reader position after the prepend commit. No public seam exposes that action
 * programmatically, so this controller automates the *user* action instead of
 * reimplementing the anchor owner: it watches the conversation scrollport for a
 * deliberate upward gesture near the top and clicks the official control. All
 * paging and rendering stay upstream. Normal paging anchors stay upstream too;
 * the sole exception is an in-flight page interrupted by a new reader gesture,
 * after the official reader has released its anchor. One visible row supplies
 * a commit-time correction during motion or a gesture gap at the upper edge.
 * Touch paging waits for the outer scrollport to settle: the official button
 * retains a fixed reading anchor, which must not be acquired mid-drag/inertia.
 *
 * Safety rules (from the design review):
 * - Only an explicit upward gesture (wheel/touch/key, or a scroll sample within
 *   the fresh-input window of one) may start a request; scroll samples produced
 *   by restore, jump, follow, or anchor writes never do.
 * - `hasMore`/`loadingOlder` are read from the official control itself (present
 *   and enabled), and are re-checked immediately before the click, so a local
 *   timeout never authorizes a click while upstream still reports loading.
 * - A re-enabled control is not success: progress must be observed as a new
 *   older row in the DOM (row identity/count/height). Missing progress counts as
 *   a failure and suspends automatic loading after the configured streak; the
 *   manual control stays available.
 * - Reader arbitration: tail following, active selection, editing focus, a
 *   pointer drag on transcript text, hidden panes, nested scrollports, and
 *   panes the reader is not touching all suppress the automation.
 * - Cross-pane aggregate concurrency/rate and a per-session automatic page
 *   ceiling bound requests and retained history growth (the upstream window is
 *   append-only and has no trim API).
 *
 * Automation is best effort and fully removable: if the official DOM contract
 * changes, every helper returns null and the plugin degrades to the stock
 * manual control. The pinned dependency version is the compatibility contract.
 */

import { captureInterruptedPrepend, INTERRUPTED_PREPEND_STYLE, type InterruptedPrependAnchor } from './interrupted-anchor.ts'
import type { AggregateLoadGate, SessionPageLedger, AggregateLoadLimits } from './concurrency.ts'
import type { EarlierLoadBudgetLimits } from './budget.ts'
import { keyIntent, scrollIntent, touchIntent, wheelIntent, type ReaderIntent } from './intent.ts'
import { EarlierLoadPolicy, nearTopPixels, type EarlierViewState } from './policy.ts'
import { automaticHistoryBounds, automaticHistoryIdentity } from './shared.ts'

/** Diagnostics event emitted by one pane controller. */
export interface SeamlessHistoryEvent {
    readonly type: 'attached' | 'requested' | 'observed' | 'committed' | 'failed' | 'deferred' | 'recovered' | 'reset' | 'suspended'
    /** Workspace pane identity, when the pane element exposes one. */
    readonly paneId: string | null
    /** Official conversation session id currently rendered by the pane. */
    readonly sessionId: string | null
    /** Stable host/session identity used by the per-session page ceiling. */
    readonly identity: string | null
    /** Short machine-readable explanation for failures/suspension. */
    readonly detail: string | null
    /** Consecutive automatic-load failures at emission time. */
    readonly consecutiveFailures: number
    /** Whether automatic loading is suspended at emission time. */
    readonly suspended: boolean
    /** Automatic pages already committed for this identity. */
    readonly sessionPages: number
}

/** Installer options; every field is optional with conservative defaults. */
export interface SeamlessHistoryOptions {
    /**
     * Optional diagnostics sink. The diagnostics layer can subscribe without the
     * controller depending on it; handler errors are swallowed.
     */
    readonly onEvent?: (event: SeamlessHistoryEvent) => void
    /** Per-surface budget overrides (burst/timeout/backoff/lifetime cap). */
    readonly budget?: Partial<EarlierLoadBudgetLimits>
    /** Lead distance override; defaults to one viewport capped at 600px. */
    readonly nearTop?: (clientHeight: number) => number
    /** Official label resolver, used only as a fallback control locator. */
    readonly loadEarlierLabel?: () => string | undefined
    /** Cross-pane aggregate concurrency/rate overrides. */
    readonly aggregate?: Partial<AggregateLoadLimits>
    /**
     * Automatic pages allowed per host+session identity across the page lifetime.
     * A conservative default bounds retained history growth; the manual control
     * still pages beyond it.
     */
    readonly maxAutomaticPagesPerSession?: number
    /** Monotonic clock override; defaults to the document's performance clock. */
    readonly now?: () => number
}

/** How long a scroll/hit sample stays attributable to a real reader input. */
const FRESH_INPUT_MS = 250
/** Scrollend fallback for older engines; every outer scroll sample postpones it. */
const TOUCH_SCROLL_QUIET_MS = 180
/** Earliest point at which "control re-enabled without progress" is a failure. */
const MIN_FAILURE_OBSERVE_MS = 600
/** Pending progress poll cadence; cheap because it only runs while one page is loading. */
const PENDING_POLL_MS = 400
/** Suppress automation briefly after a large non-reader scroll jump. */
const QUIET_AFTER_JUMP_MS = 400
/** Throttle between emitted aggregate-deferral events. */
const DEFERRAL_EVENT_MS = 1_000
/** Default per-session ceiling on automatic pages. */
export const DEFAULT_MAX_AUTOMATIC_PAGES_PER_SESSION = 20
/** Attribute the controller maintains on the workspace pane for diagnostics. */
export const SEAMLESS_ATTRIBUTE = 'data-hapi-seamless'
/**
 * Window event mirroring every controller event. The diagnostics layer can
 * subscribe without importing this module or accepting a dependency on it.
 */
export const SEAMLESS_EVENT_NAME = 'hapi-dsh:seamless-history'

const CONTENT_SELECTOR = '[data-conversation-content][data-conversation-session]'
const SCROLLER_SELECTOR = '[data-conversation-scroll]'
const COLUMN_SELECTOR = '[data-chat-flow]:not([data-step-process-content])'
const PANE_SELECTOR = '[data-pane-id]'
const TAIL_ATTRIBUTE = 'data-chat-following-tail'

/** Cheap structural read of the current older-page request. */
interface ProgressProbe {
    /** Topmost flow row identity, null when the transcript is empty. */
    readonly firstKey: string | null
    /** Number of anchored flow rows currently mounted. */
    readonly count: number
}

/** One measurement of the pane's chat surface. */
interface Measured {
    readonly content: HTMLElement
    readonly scroller: HTMLElement
    readonly column: HTMLElement
    /** Official Load earlier control; null when no older history remains. */
    readonly control: HTMLButtonElement | null
    readonly followingTail: boolean
}

/** Shared state installed once per document. */
interface SharedState {
    readonly clock: () => number
    pointerTarget: Element | null
}

/** One in-flight earlier page, either requested here or observed upstream. */
interface PendingLoad {
    readonly origin: 'automatic' | 'observed'
    readonly identity: string
    readonly probe: ProgressProbe
    readonly startedAt: number
}

/**
 * Read a topmost-anchored progress probe.
 *
 * @param column - outer chat column.
 * @returns stable measurements used to prove a prepend happened.
 */
export function probeHistoryWindow(column: HTMLElement): ProgressProbe {
    const rows = column.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
    for (const row of rows) {
        if (row.closest('[hidden]') !== null) continue
        const key = row.getAttribute('data-chat-anchor-key')
        if (key !== null && key !== '') return { firstKey: key, count: rows.length }
    }
    return { firstKey: null, count: rows.length }
}

/**
 * Whether the probe proves older rows were prepended.
 *
 * A prepend inserts rows above the retained window: the topmost anchored row
 * becomes a different row *and* the mounted row set grows. Appends from a live
 * turn grow the row set but leave the top row alone; a window replace changes
 * the top row but is not progress. Requiring both keeps streaming and resyncs
 * out of the success/failure decision.
 *
 * @param before - probe captured when the request started.
 * @param after - probe read after the request settled.
 * @returns whether the loaded window moved toward older history.
 */
function progressed(before: ProgressProbe, after: ProgressProbe): boolean {
    if (after.count <= before.count || after.firstKey === null) return false
    if (before.firstKey === null) return true
    return before.firstKey !== after.firstKey
}

/**
 * Whether the probe proves the window was replaced/reset under us.
 *
 * @param before - probe captured when the request started.
 * @param after - probe read after the request settled.
 * A live tail can retire an ephemeral anchor without changing the retained
 * history head. That contraction is not a source-window replacement and must
 * not cancel the older page that is still in flight.
 *
 * @returns whether a smaller window also replaced its earliest identity.
 */
export function historyWindowWasReset(before: ProgressProbe, after: ProgressProbe): boolean {
    return after.count < before.count && after.firstKey !== before.firstKey
}

/**
 * Whether an element is a text-editing target whose focus must suppress automation.
 *
 * @param element - active element candidate.
 * @returns true for form fields and contenteditable hosts.
 */
function isEditable(element: Element | null): boolean {
    return element !== null && (element.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        || element.closest('[contenteditable]:not([contenteditable="false"])') !== null)
}

/**
 * Locate the official Load earlier control without depending on hashed CSS.
 *
 * The official render puts the control in a plain wrapper that is a direct child
 * of the chat column and holds exactly one button; no other direct child of the
 * column is a button or a single-button wrapper. A localized label lookup stays
 * as a documented fallback.
 *
 * @param column - outer chat column.
 * @param label - optional official label resolver for the fallback path.
 * @returns the control, or null when no older history remains.
 */
export function findLoadEarlierControl(
    column: HTMLElement,
    label?: () => string | undefined,
): HTMLButtonElement | null {
    for (const child of Array.from(column.children)) {
        if (child instanceof HTMLButtonElement) return child
        if (child.children.length === 1 && child.firstElementChild instanceof HTMLButtonElement) {
            return child.firstElementChild
        }
    }
    if (label !== undefined) {
        const wanted = label()?.trim()
        if (wanted !== undefined && wanted !== '') {
            for (const button of column.querySelectorAll('button')) {
                if (button.closest('[data-slot="conversation.chat.flow"]') !== null) continue
                if (button.textContent?.trim() === wanted) return button
            }
        }
    }
    return null
}

/**
 * Read the official tail-following marker for one chat column.
 *
 * @param column - outer chat column.
 * @param scroller - conversation scrollport.
 * @returns whether the view currently owns tail following.
 */
function readingTail(column: HTMLElement, scroller: HTMLElement): boolean {
    if (column.closest(`[${TAIL_ATTRIBUTE}]`) !== null) return true
    return scroller.querySelector(`[${TAIL_ATTRIBUTE}]`) !== null
}

/**
 * Watch one conversation content element of one pane.
 *
 * Constructed by {@link installSeamlessHistory}; never by application code.
 */
class ConversationHistoryController {
    private readonly root: Document
    private readonly content: HTMLElement
    private readonly options: SeamlessHistoryOptions
    private readonly shared: SharedState
    private readonly gate: AggregateLoadGate
    private readonly ledger: SessionPageLedger
    private readonly policy: EarlierLoadPolicy
    private readonly frame: Window
    private disposed = false
    private attached = false
    private sessionId: string | null = null
    private identity: string | null = null
    private lastScrollTop: number | null = null
    private lastUserInputAt = Number.NEGATIVE_INFINITY
    private quietUntil = Number.NEGATIVE_INFINITY
    private touchY: number | null = null
    private touchActive = false
    private touchMotion = false
    private touchScrolling = false
    private touchWantsEarlier = false
    private touchCancelled = false
    private touchSettleTimer: ReturnType<typeof setTimeout> | undefined
    private touchEndFrame: number | undefined
    private pending: PendingLoad | null = null
    private interruptedAnchor: InterruptedPrependAnchor | null = null
    private deadline: ReturnType<typeof setTimeout> | undefined
    private poll: ReturnType<typeof setInterval> | undefined
    private observer: MutationObserver | null = null
    private observedColumn: HTMLElement | null = null
    private recoveryProbe: ProgressProbe | null = null
    private awaitingRecovery = false
    private lastDeferralAt = Number.NEGATIVE_INFINITY
    private lastSuspendedAt = Number.NEGATIVE_INFINITY
    private readonly listeners: Array<{
        readonly type: string
        readonly listener: EventListener
        readonly options: AddEventListenerOptions
    }> = []

    constructor(
        root: Document,
        content: HTMLElement,
        options: SeamlessHistoryOptions,
        shared: SharedState,
        gate: AggregateLoadGate,
        ledger: SessionPageLedger,
    ) {
        this.root = root
        this.content = content
        this.options = options
        this.shared = shared
        this.gate = gate
        this.ledger = ledger
        this.frame = root.defaultView ?? window
        this.policy = new EarlierLoadPolicy({
            ...(options.budget === undefined ? {} : { budget: options.budget }),
            ...(options.nearTop === undefined ? {} : { nearTop: options.nearTop }),
        })
        this.sessionId = content.getAttribute('data-conversation-session')
        this.listen('scroll', this.onScroll, { capture: true, passive: true })
        this.listen('scrollend', this.onScrollEnd, { capture: true, passive: true })
        this.listen('wheel', this.onWheel, { passive: true })
        this.listen('touchstart', this.onTouchStart, { passive: true })
        this.listen('touchmove', this.onTouchMove, { passive: true })
        this.listen('touchend', this.onTouchEnd, { passive: true })
        this.listen('touchcancel', this.onTouchEnd, { passive: true })
        this.listen('keydown', this.onKeyDown, { passive: true })
        this.listen('pointerdown', this.onPointerDown, { passive: true })
    }

    /** The clock shared by every controller of this document. */
    private now(): number {
        return this.shared.clock()
    }

    /** Attach one passive, non-intercepting listener. */
    private listen<T extends Event>(type: string, listener: (event: T) => void, options: AddEventListenerOptions): void {
        const installed = listener as EventListener
        this.content.addEventListener(type, installed, options)
        this.listeners.push({ type, listener: installed, options })
    }

    /** Remove every listener this controller attached. */
    private unlisten(): void {
        for (const entry of this.listeners) this.content.removeEventListener(entry.type, entry.listener, entry.options)
        this.listeners.length = 0
    }

    /** Whether the automation may act for this pane right now. */
    private usable(): boolean {
        if (this.disposed || !this.content.isConnected) return false
        const pane = this.content.closest<HTMLElement>(PANE_SELECTOR) ?? this.content.closest<HTMLElement>('.hapi-pane')
        if (pane === null) return true
        if (pane.getAttribute('data-hapi-pane-visible') === 'false') return false
        if (pane.closest('[aria-hidden="true"]') !== null) return false
        return true
    }

    /**
     * Measure the pane's chat surface, or null when it does not render one.
     *
     * Read paging controls only when the reader approaches the history edge
     * or a pending page needs inspection. Ordinary motion skips this work.
     */
    private measure(): Measured | null {
        const scroller = this.content.querySelector<HTMLElement>(SCROLLER_SELECTOR)
        if (scroller === null) return null
        const column = scroller.querySelector<HTMLElement>(COLUMN_SELECTOR)
        if (column === null) return null
        return {
            content: this.content,
            scroller,
            column,
            control: findLoadEarlierControl(column, this.options.loadEarlierLabel),
            followingTail: readingTail(column, scroller),
        }
    }

    /** Read the transcript probe used to prove a prepend; only while watching. */
    private probeOf(measured: Measured): ProgressProbe {
        return probeHistoryWindow(measured.column)
    }

    /** Read the official state the policy needs, including reader fixation. */
    private viewOf(measured: Measured): EarlierViewState {
        return {
            hasMore: measured.control !== null,
            loading: measured.control !== null && measured.control.disabled,
            open: true,
            followingTail: measured.followingTail,
            scrollTop: measured.scroller.scrollTop,
            clientHeight: measured.scroller.clientHeight,
            fixated: this.fixated(measured.scroller),
        }
    }

    /**
     * Whether a reader interaction must not be interrupted by automatic history I/O.
     *
     * Deliberately ignores plain editor focus: the official composer is a
     * contenteditable that keeps focus while a reader wheels through the
     * transcript, so treating that focus as fixation would disable the feature
     * for the common case. Keyboard samples are handled separately and already
     * require a non-editor target; here only an active selection or a pointer
     * drag on transcript text counts as reader fixation.
     *
     * @param scroller - conversation scrollport (a press on it is a scrollbar drag, not a text selection).
     */
    private fixated(scroller: HTMLElement): boolean {
        const selection = this.root.getSelection()
        if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed) {
            const range = selection.getRangeAt(0)
            if (this.content.contains(range.commonAncestorContainer)) return true
        }
        const pointer = this.shared.pointerTarget
        if (pointer === null || pointer === scroller) return false
        if (!this.content.contains(pointer)) return false
        if (pointer.closest('button, a, input, textarea, select, [contenteditable]') !== null) return false
        // A pointer press on transcript text is likely a selection drag.
        return true
    }

    /** Stable host+session identity for the per-session page ceiling. */
    private identityOf(content: HTMLElement): string {
        const session = content.getAttribute('data-conversation-session') ?? 'unknown'
        return automaticHistoryIdentity(content, session)
    }

    /** Reset when the same pane occurrence renders a different session. */
    private ensureSession(): void {
        const next = this.content.getAttribute('data-conversation-session')
        if (next === this.sessionId) return
        const previous = this.sessionId
        this.cancelPending('session-changed')
        this.policy.reset()
        this.sessionId = next
        this.identity = next === null ? null : this.identityOf(this.content)
        this.lastScrollTop = null
        this.lastUserInputAt = Number.NEGATIVE_INFINITY
        this.quietUntil = Number.NEGATIVE_INFINITY
        this.touchY = null
        this.cancelTouchPaging()
        this.recoveryProbe = null
        this.awaitingRecovery = false
        this.mark(null)
        this.observe(null)
        if (previous !== null && next !== null) this.emit('reset', 'session-changed')
    }

    /** Mark the pane element with the current automation state for diagnostics. */
    private mark(state: 'error' | 'suspended' | 'limit' | null): void {
        const pane = this.content.closest<HTMLElement>(PANE_SELECTOR) ?? this.content
        if (state === null) {
            if (pane.getAttribute(SEAMLESS_ATTRIBUTE) !== null) pane.removeAttribute(SEAMLESS_ATTRIBUTE)
            return
        }
        if (pane.getAttribute(SEAMLESS_ATTRIBUTE) !== state) pane.setAttribute(SEAMLESS_ATTRIBUTE, state)
    }

    /** Publish one diagnostics event; subscriber failures never break loading. */
    private emit(type: SeamlessHistoryEvent['type'], detail: string | null): void {
        const now = this.now()
        const snapshot = this.policy.snapshot(now)
        const event: SeamlessHistoryEvent = {
            type,
            paneId: this.content.closest<HTMLElement>(PANE_SELECTOR)?.getAttribute('data-pane-id') ?? null,
            sessionId: this.sessionId,
            identity: this.identity,
            detail,
            consecutiveFailures: snapshot.consecutiveFailures,
            suspended: snapshot.suspended,
            sessionPages: this.identity === null ? 0 : this.ledger.pages(this.identity),
        }
        try { this.frame.dispatchEvent(new CustomEvent(SEAMLESS_EVENT_NAME, { detail: event })) } catch { /* Detached window. */ }
        const handler = this.options.onEvent
        if (handler === undefined) return
        try { handler(event) } catch { /* Diagnostics must never affect the transcript. */ }
    }

    /** Emit a suspension state at most once per few seconds of reader gestures. */
    private notifySuspended(detail: string, now: number): void {
        if (now - this.lastSuspendedAt < DEFERRAL_EVENT_MS * 5) return
        this.lastSuspendedAt = now
        this.emit('suspended', detail)
    }

    /** Keep the pending/recovery mutation observer on the current column. */
    private observe(column: HTMLElement | null): void {
        if (column === this.observedColumn) return
        this.observer?.disconnect()
        this.observedColumn = column
        if (column === null) return
        this.observer ??= new MutationObserver(() => this.onMutation())
        this.observer.observe(column, { childList: true, subtree: true })
    }

    /** React to row-level DOM changes while a request or recovery is watched. */
    private onMutation(): void {
        if (this.disposed) return
        if (this.pending !== null) { this.checkPending(); return }
        if (!this.awaitingRecovery) return
        const measured = this.measure()
        if (measured === null) return
        this.checkRecovery(measured)
    }

    /** Whether a nested scrollport between the target and the scroller consumes this direction. */
    private innerScrollConsumes(target: Element, scroller: HTMLElement, intent: ReaderIntent): boolean {
        let node: Element | null = target
        while (node !== null && node !== scroller) {
            if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
                const style = this.frame.getComputedStyle(node)
                const overflow = style.overflowY
                if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') {
                    const max = node.scrollHeight - node.clientHeight
                    if (intent === 'down' ? node.scrollTop < max : node.scrollTop > 0) return true
                }
            }
            node = node.parentElement
        }
        return false
    }

    /** Record reader input and, when it asks for earlier content, run the policy. */
    private input(intent: ReaderIntent, now: number): void {
        if (intent !== 'up' && intent !== 'down') return
        this.lastUserInputAt = now
        if (this.touchMotion) {
            const scroller = this.content.querySelector<HTMLElement>(SCROLLER_SELECTOR)
            this.touchWantsEarlier = !this.touchCancelled && intent === 'up' && scroller !== null
                && scroller.scrollTop <= (this.options.nearTop ?? nearTopPixels)(scroller.clientHeight)
            return
        }
        if (intent !== 'up') return
        this.requestEarlier(now)
    }

    /** The scrollport scroll sample: only reader-owned motion may page history. */
    private readonly onScroll = (event: Event): void => {
        if (!this.usable()) return
        this.ensureSession()
        const target = event.target
        if (!(target instanceof HTMLElement) || !target.matches(SCROLLER_SELECTOR)) return
        const current = target.scrollTop
        const previous = this.lastScrollTop
        this.lastScrollTop = current
        const now = this.now()
        if (this.touchMotion) {
            this.touchScrolling = true
            if (previous !== null) this.input(scrollIntent(previous, current), now)
            this.scheduleTouchFallback(target)
            return
        }
        if (previous === null) return
        const intent = scrollIntent(previous, current)
        // Restore, jump, follow, and anchor compensation also move scrollTop.
        // Only a sample attributable to a reader gesture may page history: a
        // fresh wheel/touch/key sample, or a scrollbar drag whose press target
        // is the scrollport itself.
        const draggingScrollbar = this.shared.pointerTarget === target
        if (now - this.lastUserInputAt > FRESH_INPUT_MS && !draggingScrollbar) {
            if (Math.abs(current - previous) > Math.max(64, target.clientHeight)) {
                this.quietUntil = now + QUIET_AFTER_JUMP_MS
            }
            return
        }
        this.input(intent, now)
    }

    /** A wheel sample is the primary desktop gesture; respect nested scrollports. */
    private readonly onWheel = (event: WheelEvent): void => {
        if (event.isTrusted) this.releaseInterruptedAnchor()
        if (!this.usable()) return
        this.ensureSession()
        const intent = wheelIntent(event.deltaY, event.deltaMode)
        if (intent === 'none') return
        const scroller = this.content.querySelector<HTMLElement>(SCROLLER_SELECTOR)
        if (scroller === null) return
        const target = event.target
        if (!(target instanceof Element) || !scroller.contains(target)) return
        if (this.innerScrollConsumes(target, scroller, intent)) return
        if (event.isTrusted) {
            // Wheel input also releases the official paging anchor. At zero
            // another upward wheel may produce no scroll/scrollend at all,
            // leaving an in-flight prepend with no reading-position owner.
            // Cover manual pages too, without issuing or budgeting a new load.
            if (this.pending === null
                && scroller.scrollTop <= (this.options.nearTop ?? nearTopPixels)(scroller.clientHeight)) this.observeEarlierPage()
            if (this.pending !== null) {
                this.interruptedAnchor = captureInterruptedPrepend(scroller)
                if (intent === 'up') this.interruptedAnchor?.retainAtUpperEdge()
            }
        }
        this.input(intent, this.now())
    }

    /** Touch start only records the finger position for inertial intent. */
    private readonly onTouchStart = (event: TouchEvent): void => {
        this.ensureSession()
        this.cancelTouchPaging()
        this.releaseInterruptedAnchor()
        this.touchY = null
        const scroller = this.content.querySelector<HTMLElement>(SCROLLER_SELECTOR)
        if (event.touches.length !== 1 || !(event.target instanceof Element) || !scroller?.contains(event.target)) return
        this.touchActive = true
        this.touchMotion = true
        this.touchY = event.touches[0]?.clientY ?? null
        // The official capture listener has relinquished its paging anchor for
        // this new gesture. During a held drag Chromium also suspends native
        // scroll anchoring. Retain one current row for this pending page only.
        // A process-heading button is also a valid place to start a pan.
        if (event.isTrusted && this.usable()
            && !isEditable(event.target)
            && !this.innerScrollConsumes(event.target, scroller, 'up')
            && !this.innerScrollConsumes(event.target, scroller, 'down')) {
            // Manual paging and official prefetch use the same loading state.
            // Observe an already-running page; never request or budget it here.
            if (this.pending === null) this.observeEarlierPage()
            if (this.pending !== null) this.interruptedAnchor = captureInterruptedPrepend(scroller)
        }
    }

    /** Touch move carries the direction of the finger and of momentum drags. */
    private readonly onTouchMove = (event: TouchEvent): void => {
        if (!this.usable()) return
        if (event.touches.length !== 1) { this.touchY = null; this.cancelTouchPaging(); return }
        this.ensureSession()
        if (!this.touchMotion) return
        const current = event.touches[0]?.clientY
        if (current === undefined) { this.touchY = null; return }
        const intent = touchIntent(this.touchY, current)
        this.touchY = current
        if (intent === 'none') return
        const scroller = this.content.querySelector<HTMLElement>(SCROLLER_SELECTOR)
        if (scroller === null) return
        const target = event.target
        if (!(target instanceof Element)) return
        if (this.innerScrollConsumes(target, scroller, intent)) { this.touchWantsEarlier = false; return }
        this.input(intent, this.now())
    }

    /** The finger leaving is not the end of native momentum scrolling. */
    private readonly onTouchEnd = (event: TouchEvent): void => {
        // Native anchoring owns normal inertia. The exception is an earlier
        // pan blocked at zero: it may emit no scrollend to reacquire the
        // official paging anchor, even though the older page is still pending.
        if (event.type === 'touchcancel' || !this.touchWantsEarlier || this.pending === null
            || !this.interruptedAnchor?.retainAtUpperEdge()) this.releaseInterruptedAnchor()
        this.touchY = null
        this.touchActive = false
        if (event.type === 'touchcancel') {
            this.touchCancelled = true
            this.touchWantsEarlier = false
            this.lastUserInputAt = Number.NEGATIVE_INFINITY
        }
        if (!this.touchMotion) return
        // A compositor scroll can arrive after touchend. Every delivered outer
        // scroll cancels this grace and waits for the actual native scrollend.
        if (!this.touchScrolling) {
            this.touchSettleTimer = setTimeout(() => {
                this.touchSettleTimer = undefined
                if (!this.touchScrolling) this.settleTouchPaging()
            }, TOUCH_SCROLL_QUIET_MS)
            return
        }
        const scroller = this.content.querySelector<HTMLElement>(SCROLLER_SELECTOR)
        if (scroller) this.scheduleTouchFallback(scroller)
    }

    private readonly onScrollEnd = (event: Event): void => {
        if (!(event.target instanceof HTMLElement) || !event.target.matches(SCROLLER_SELECTOR)) return
        // A desktop wheel burst can finish at zero while its page is still
        // loading. Preserve that seam across the next burst, as touchend does
        // for a finger stopped at the boundary. Normal motion returns upstream.
        if (this.touchMotion || this.pending === null || !this.interruptedAnchor?.retainAtUpperEdge()) {
            this.releaseInterruptedAnchor()
        }
        if (!this.touchMotion) return
        this.touchScrolling = false
        // Let the official handler commit its last reading sample first.
        if (!this.touchActive) {
            if (this.touchEndFrame !== undefined) this.frame.cancelAnimationFrame(this.touchEndFrame)
            this.touchEndFrame = this.frame.requestAnimationFrame(() => {
                this.touchEndFrame = undefined
                if (!this.touchScrolling) this.settleTouchPaging()
            })
        }
    }

    private scheduleTouchFallback(scroller: HTMLElement): void {
        if (this.touchSettleTimer !== undefined) clearTimeout(this.touchSettleTimer)
        if (this.touchEndFrame !== undefined) this.frame.cancelAnimationFrame(this.touchEndFrame)
        this.touchSettleTimer = undefined
        this.touchEndFrame = undefined
        if (this.touchActive || 'onscrollend' in scroller) return
        this.touchSettleTimer = setTimeout(() => {
            this.touchSettleTimer = undefined
            this.settleTouchPaging()
        }, TOUCH_SCROLL_QUIET_MS)
    }

    private settleTouchPaging(): void {
        if (this.touchActive || !this.touchMotion) return
        this.ensureSession()
        if (!this.touchMotion) return
        const requested = this.touchWantsEarlier
        if (!this.interruptedAnchor?.waitingAtUpperEdge) this.releaseInterruptedAnchor()
        this.resetTouchPaging()
        if (requested && this.usable()) this.requestEarlier(this.now())
    }

    private cancelTouchPaging(): void {
        this.releaseInterruptedAnchor()
        this.resetTouchPaging()
    }

    private resetTouchPaging(): void {
        if (this.touchSettleTimer !== undefined) clearTimeout(this.touchSettleTimer)
        if (this.touchEndFrame !== undefined) this.frame.cancelAnimationFrame(this.touchEndFrame)
        this.touchSettleTimer = undefined
        this.touchEndFrame = undefined
        this.touchActive = false
        this.touchMotion = false
        this.touchScrolling = false
        this.touchWantsEarlier = false
        this.touchCancelled = false
    }

    private releaseInterruptedAnchor(): void {
        this.interruptedAnchor?.release()
        this.interruptedAnchor = null
    }

    private readonly onPointerDown = (event: PointerEvent): void => {
        if (event.isTrusted && event.target instanceof Element
            && event.target.closest('button, a, input, textarea, select, [contenteditable]') !== null) {
            this.releaseInterruptedAnchor()
        }
    }

    /** Keyboard scrolling only counts when the transcript, not an editor, owns it. */
    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (event.isTrusted) this.releaseInterruptedAnchor()
        if (!this.usable()) return
        this.ensureSession()
        const intent = keyIntent(event.key, event)
        if (intent === 'none') return
        const target = event.target
        if (!(target instanceof Element) || !this.content.contains(target)) return
        if (isEditable(target)) return
        const active = this.root.activeElement
        if (active === null || !this.content.contains(active) || isEditable(active)) return
        const scroller = this.content.querySelector<HTMLElement>(SCROLLER_SELECTOR)
        if (scroller === null) return
        if (this.innerScrollConsumes(target, scroller, intent)) return
        this.input(intent, this.now())
    }

    /** Evaluate policy and, when approved, click the official control once. */
    private requestEarlier(now: number): void {
        if (this.pending !== null) return
        if (now < this.quietUntil) return
        // Ordinary motion inside the retained window needs no control search,
        // tail-marker scan or selection measurement. Inspect paging only near
        // the same lead boundary used by the policy below.
        const scroller = this.content.querySelector<HTMLElement>(SCROLLER_SELECTOR)
        if (scroller === null || scroller.scrollTop > (this.options.nearTop ?? nearTopPixels)(scroller.clientHeight)) return
        const measured = this.measure()
        if (measured === null) return
        const identity = this.identityOf(measured.content)
        this.identity = identity
        if (!this.attached) { this.attached = true; this.emit('attached', null) }
        if (measured.control === null) {
            // The official window reports no older history: the manual control is
            // gone too, so a stale failure marker would describe a finished state.
            this.awaitingRecovery = false
            this.recoveryProbe = null
            this.observe(null)
            this.mark(null)
            return
        }
        // Re-point the recovery observer when the view switched away and back.
        if (this.awaitingRecovery) this.observe(measured.column)
        if (this.ledger.exhausted(identity)) {
            this.mark('limit')
            this.notifySuspended('session-page-ceiling', now)
            return
        }
        const decision = this.policy.evaluate(this.viewOf(measured), 'up', now)
        if (!decision.request) {
            if (decision.reason === 'suspended') {
                this.mark('suspended')
                this.notifySuspended('failure-streak', now)
            }
            return
        }
        // Re-read the official control immediately before acting: the snapshot
        // gates from a moment ago may be stale, and a local timeout must never
        // authorize a click while upstream still reports loading.
        const control = measured.control
        if (control === null || control.disabled) return
        if (!this.gate.tryStart(now).allowed) {
            if (now - this.lastDeferralAt >= DEFERRAL_EVENT_MS) {
                this.lastDeferralAt = now
                this.emit('deferred', 'aggregate-limit')
            }
            return
        }
        this.policy.requested(now)
        this.pending = { origin: 'automatic', identity, probe: this.probeOf(measured), startedAt: now }
        this.awaitingRecovery = false
        this.recoveryProbe = null
        this.mark(null)
        this.emit('requested', null)
        this.observe(measured.column)
        this.setPendingTimers()
        try { control.click() } catch { this.settle('error', now) }
    }

    /** Watch an upstream page only when a reader gesture interrupts its anchor. */
    private observeEarlierPage(): void {
        const measured = this.measure()
        if (measured === null || !measured.control?.disabled || measured.followingTail) return
        const identity = this.identityOf(measured.content)
        this.identity = identity
        this.pending = { origin: 'observed', identity, probe: this.probeOf(measured), startedAt: this.now() }
        this.observe(measured.column)
        this.setPendingTimers()
        this.emit('observed', 'upstream-page')
    }

    /** Install the pending-page poll and the hard timeout. */
    private setPendingTimers(): void {
        this.clearPendingTimers()
        this.poll = setInterval(() => this.checkPending(), PENDING_POLL_MS)
        this.deadline = setTimeout(() => this.expirePending(), this.policy.budget.limits.requestTimeoutMs)
    }

    /** Clear pending timers. */
    private clearPendingTimers(): void {
        if (this.poll !== undefined) { clearInterval(this.poll); this.poll = undefined }
        if (this.deadline !== undefined) { clearTimeout(this.deadline); this.deadline = undefined }
    }

    /** Observe a pending request: success, reset, or a settled-but-idle control. */
    private checkPending(): void {
        const pending = this.pending
        if (pending === null || this.disposed) return
        const now = this.now()
        if (pending.origin === 'automatic' && this.policy.expire(now)) { this.failPending('timeout', now); return }
        const measured = this.measure()
        if (measured === null) { this.settle('reset', now, 'view-unmounted'); return }
        if (!this.usable() || measured.followingTail) this.releaseInterruptedAnchor()
        const after = this.probeOf(measured)
        if (historyWindowWasReset(pending.probe, after)) { this.settle('reset', now, 'window-reset'); return }
        if (progressed(pending.probe, after)) { this.commitPending(now); return }
        this.interruptedAnchor?.refresh()
        // The official control re-enabling means the fetch settled with nothing
        // prepended. A control still disabled means upstream is still loading:
        // keep waiting, never click again.
        if (now - pending.startedAt >= MIN_FAILURE_OBSERVE_MS
            && measured.control !== null && !measured.control.disabled) {
            this.failPending('no-progress', now)
        }
    }

    /** Hard deadline: mark the page failed but never authorize another click. */
    private expirePending(): void {
        const pending = this.pending
        if (pending === null) return
        const now = this.now()
        const measured = this.measure()
        if (measured !== null) {
            const after = this.probeOf(measured)
            if (progressed(pending.probe, after)) { this.commitPending(now); return }
            if (historyWindowWasReset(pending.probe, after)) { this.settle('reset', now, 'window-reset'); return }
        }
        this.failPending('timeout', now)
    }

    /** Record one committed older page. */
    private commitPending(now: number): void {
        const pending = this.pending
        if (pending === null) return
        this.interruptedAnchor?.commit()
        this.interruptedAnchor = null
        this.pending = null
        this.clearPendingTimers()
        if (pending.origin === 'automatic') {
            this.policy.committed(now)
            this.ledger.spend(pending.identity)
            this.gate.release()
        } else this.policy.resume()
        this.awaitingRecovery = false
        this.recoveryProbe = null
        this.mark(null)
        this.observe(null)
        this.emit('committed', pending.origin === 'observed' ? 'observed-page' : null)
    }

    /** Record one failed page; automatic loading may suspend, the manual control stays. */
    private failPending(detail: 'timeout' | 'no-progress' | 'error', now: number): void {
        this.releaseInterruptedAnchor()
        const pending = this.pending
        if (pending === null) return
        this.pending = null
        this.clearPendingTimers()
        if (pending.origin === 'observed') {
            // The official request owns its failure UI. Observing it must not
            // charge automatic backoff or release another pane's load slot.
            this.observe(this.awaitingRecovery ? this.measure()?.column ?? null : null)
            return
        }
        this.policy.failed(now)
        this.gate.release()
        const suspended = this.policy.snapshot(now).suspended
        this.awaitingRecovery = true
        const measured = this.measure()
        this.recoveryProbe = measured === null ? pending.probe : this.probeOf(measured)
        this.mark(suspended ? 'suspended' : 'error')
        this.observe(measured?.column ?? null)
        this.emit('failed', detail)
    }

    /** Record a reset/replace: cancel the generation and drop local budgets. */
    private settle(kind: 'error' | 'reset', now: number, detail = 'error'): void {
        this.releaseInterruptedAnchor()
        const pending = this.pending
        if (pending === null) return
        this.pending = null
        this.clearPendingTimers()
        if (pending.origin === 'automatic') this.gate.release()
        if (kind === 'reset') {
            this.policy.reset()
            this.mark(null)
            this.awaitingRecovery = false
            this.recoveryProbe = null
            this.observe(null)
            this.emit('reset', detail)
            return
        }
        if (pending.origin === 'automatic') this.policy.failed(now)
        const measured = this.measure()
        this.awaitingRecovery = true
        this.recoveryProbe = measured === null ? null : this.probeOf(measured)
        this.mark(this.policy.snapshot(now).suspended ? 'suspended' : 'error')
        this.observe(measured?.column ?? null)
        this.emit('failed', detail)
    }

    /** Recognize progress that arrived outside our request (manual page or late commit). */
    private checkRecovery(measured: Measured): void {
        const baseline = this.recoveryProbe
        if (baseline === null) return
        if (!progressed(baseline, this.probeOf(measured))) return
        this.policy.resume()
        this.awaitingRecovery = false
        this.recoveryProbe = null
        this.lastScrollTop = measured.scroller.scrollTop
        this.mark(null)
        this.observe(null)
        this.emit('recovered', null)
    }

    /** Cancel an in-flight request without counting it as a failure (session switch). */
    private cancelPending(detail: string): void {
        this.releaseInterruptedAnchor()
        const pending = this.pending
        if (pending === null) return
        this.pending = null
        this.clearPendingTimers()
        if (pending.origin === 'automatic') this.gate.release()
        this.observe(null)
        this.emit('reset', detail)
    }

    /** Remove every listener, observer, timer, and diagnostic attribute. */
    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.cancelPending('disposed')
        this.cancelTouchPaging()
        this.unlisten()
        this.observer?.disconnect()
        this.observer = null
        this.observedColumn = null
        this.mark(null)
        this.policy.reset()
    }
}

/**
 * Install seamless earlier-history loading for every workspace pane.
 *
 * The installer is page-global on purpose: it must cover panes of every Host,
 * including panes whose official graph exposes no HAPI client context, and it
 * needs only DOM. It discovers `.hapi-pane[data-pane-id]` sections and their
 * official conversation content, then attaches one controller per content.
 * Instances are idempotent; the returned disposer removes all listeners,
 * observers, timers, and diagnostic attributes.
 *
 * @param root - document that hosts the workspace.
 * @param options - diagnostics sink and bounds overrides.
 * @returns idempotent disposer.
 */
export function installSeamlessHistory(root: Document, options: SeamlessHistoryOptions = {}): () => void {
    const installed = INSTALLED.get(root)
    if (installed !== undefined) return () => {}
    const view = root.defaultView
    const shared: SharedState = {
        clock: options.now ?? (() => (view?.performance.now() ?? Date.now())),
        pointerTarget: null,
    }
    const { gate, ledger } = automaticHistoryBounds(root, {
        aggregate: options.aggregate, maxPages: options.maxAutomaticPagesPerSession ?? DEFAULT_MAX_AUTOMATIC_PAGES_PER_SESSION,
    })
    const controllers = new Map<HTMLElement, ConversationHistoryController>()
    const interruptedStyle = root.createElement('style')
    interruptedStyle.textContent = INTERRUPTED_PREPEND_STYLE
    root.head.append(interruptedStyle)
    let scheduled = false
    let disposed = false

    const scan = (): void => {
        scheduled = false
        if (disposed) return
        const contents = new Set(root.querySelectorAll<HTMLElement>(CONTENT_SELECTOR))
        for (const [element, controller] of [...controllers]) {
            if (!contents.has(element) || !element.isConnected) {
                controller.dispose()
                controllers.delete(element)
            }
        }
        for (const content of contents) {
            if (controllers.has(content)) continue
            controllers.set(content, new ConversationHistoryController(root, content, options, shared, gate, ledger))
        }
    }
    const schedule = (): void => {
        if (scheduled || disposed) return
        scheduled = true
        if (view === null) { scan(); return }
        view.requestAnimationFrame(() => scan())
    }

    const pointerDown = (event: Event): void => { shared.pointerTarget = event.target instanceof Element ? event.target : null }
    const pointerUp = (): void => { shared.pointerTarget = null }
    root.addEventListener('pointerdown', pointerDown, { capture: true, passive: true })
    root.addEventListener('pointerup', pointerUp, { capture: true, passive: true })
    root.addEventListener('pointercancel', pointerUp, { capture: true, passive: true })

    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') { schedule(); return }
            for (const node of [...record.addedNodes, ...record.removedNodes]) {
                if (!(node instanceof Element)) continue
                if (node.matches(CONTENT_SELECTOR) || node.querySelector(CONTENT_SELECTOR) !== null
                    || node.matches(PANE_SELECTOR) || node.querySelector(PANE_SELECTOR) !== null) {
                    schedule()
                    return
                }
            }
        }
    })
    observer.observe(root.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-conversation-session'],
    })

    const dispose = (): void => {
        if (disposed) return
        disposed = true
        observer.disconnect()
        root.removeEventListener('pointerdown', pointerDown, { capture: true })
        root.removeEventListener('pointerup', pointerUp, { capture: true })
        root.removeEventListener('pointercancel', pointerUp, { capture: true })
        for (const controller of controllers.values()) controller.dispose()
        controllers.clear()
        interruptedStyle.remove()
        gate.reset()
        ledger.reset()
        INSTALLED.delete(root)
    }
    INSTALLED.set(root, dispose)
    scan()
    return dispose
}

/** One live install per document; a repeated install is a no-op. */
const INSTALLED = new WeakMap<Document, () => void>()
