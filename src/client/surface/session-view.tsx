/**
 * One official AppFrame hosts every explicit Session view of its Host.
 *
 * The additive shell seat preserves the renderer's installed scope adapters.
 * Each visible portal is an occurrence of the public Conversation factory,
 * following the pinned ui-subagent sidebar-chat composition. No second root,
 * navigation selection, store adapter, or composer implementation is created.
 * Temporary latest-window measurements borrow its authorized chat-only seat.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Component, createContext, memo, useContext, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerBlock, ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatNode, ChatSnapshot, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { WorkspacePaneNavigation } from '../pane-navigation.ts'
import { WorkspacePaneProvider } from './pane-context.tsx'
import { installSharedRightbar } from './shared-rightbar.tsx'
import { installSourceWindowNavigation } from './source-window-navigation.tsx'
import { bindPaneReading } from '../reading-view.ts'
import type { SourcePreparationReference, SourceViewportSession, SourceWindowViewport } from '../source-sessions.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'hapi.workspace.session-view': { kind: 'single'; scope: 'session' }
        'hapi.workspace.shared-rightbar': { kind: 'single'; scope: 'session' }
    }
}

/** Public payload dependencies can extend beyond a row's ordering anchor. */
function nodeSourceSpan(value: ChatConversationViewNode, lastSeq: number): [number, number] | undefined {
    const node = value as ChatNode
    // Process controls are placed just before their real event (seq - 0.1).
    // Flooring that presentation position invents the preceding event number,
    // which need not exist in a paged window. The public payload identifies
    // the actual source event used by the control.
    let first = node.kind === 'turn-process' ? node.data.controlAnchorSeq : Math.floor(node.anchorSeq), last = first
    const include = (seq: number | null | undefined): void => {
        if (seq === null || seq === undefined) return
        first = Math.min(first, Math.floor(seq)); last = Math.max(last, Math.floor(seq))
    }
    const step = (): boolean => {
        if (node.location.kind !== 'step' || !node.location.step.start) return false
        include(node.location.step.start.seq)
        include(node.location.step.end?.seq ?? lastSeq)
        return true
    }
    switch (node.kind) {
        case 'tool-call': {
            const pending: ToolCallBlock[] = [node.data.root]
            let seen = 0
            while (pending.length) {
                // A huge nested tool tree stays intact until its dependencies
                // can be determined without work proportional to the archive.
                if (++seen > 256) return undefined
                const call = pending.pop()!
                if ('kind' in call) include(call.seq)
                else if (!step()) return undefined
                if (pending.length + call.subCalls.length > 256) return undefined
                pending.push(...call.subCalls)
            }
            break
        }
        case 'assistant-step':
            if (node.data.finalNode) include(node.data.finalNode.seq)
            else if (!step()) return undefined
            break
        case 'compaction': include(node.data.seq); include(node.data.summaryEventSeq); break
        case 'manual-compaction':
            include(node.data.command.seq); include(node.data.command.outcome?.sourceEventSeq)
            include(node.data.compaction?.seq); include(node.data.compaction?.summaryEventSeq)
            if (!step()) return undefined
            break
        case 'command':
            include(node.data.seq); include(node.data.outcome?.sourceEventSeq)
            if (!step()) return undefined
            break
        case 'model-retry':
            if (node.data.attempts.length > 256) return undefined
            for (const attempt of node.data.attempts) include(attempt.seq)
            break
        case 'turn-tail': include(node.data.seq); include(node.data.closing?.finalNode.seq); break
        case 'turn-process':
            include(node.data.processStartSeq); include(node.data.controlAnchorSeq); include(node.data.answerAnchorSeq)
            break
        case 'user': case 'steering': case 'context': case 'turn-trigger':
        case 'unknown': case 'turn-error': case 'turn-max-tokens': include(node.data.seq); break
        // Prompt cards and extension Nodes can depend on earlier state that
        // their public payload does not identify. Do not guess that boundary.
        default: return undefined
    }
    return Number.isFinite(first) && first >= 0 && Number.isFinite(last) ? [first, last] : undefined
}

/** Read visible source dependencies with bounded layout work, never row bodies. */
export function readSourceWindowViewport(target: HTMLElement, snapshot: ChatSnapshot | undefined, lastSeq: number): SourceWindowViewport | undefined {
    if (!snapshot || !target.isConnected || target.hidden || target.closest('[hidden], [data-hapi-visible="false"]')) return undefined
    const port = target.querySelector<HTMLElement>('[data-conversation-scroll]')
    const view = target.ownerDocument.defaultView
    if (!port || !view || port.clientHeight <= 0 || port.clientWidth <= 0 || view.getComputedStyle(port).visibility !== 'visible') return undefined
    const box = port.getBoundingClientRect()
    // The sticky composer occupies the bottom of the same scrollport. Its
    // covered rows are not reader boundaries and otherwise force a fallback
    // search whenever the bottom hit lands in the editor.
    const top = Math.max(0, box.top), bottom = Math.min(view.innerHeight, box.top + chatViewportHeight(port))
    const left = Math.max(0, box.left), right = Math.min(view.innerWidth, box.right)
    if (bottom <= top || right <= left) return undefined
    const measured = new Map<HTMLElement, DOMRect>()
    const measure = (element: HTMLElement): DOMRect => {
        let rect = measured.get(element)
        if (!rect) { rect = element.getBoundingClientRect(); measured.set(element, rect) }
        return rect
    }
    const visible = (element: HTMLElement): boolean => {
        if (!port.contains(element) || element.closest('[hidden], [data-hapi-visible="false"], [data-turn-process-hidden="true"]')) return false
        const rect = measure(element)
        return rect.height > 0 && rect.bottom > top && rect.top < bottom
    }
    const hit = (y: number): HTMLElement | undefined => {
        for (const x of [(left + right) / 2, left + 24, right - 24]) {
            if (x <= left || x >= right) continue
            const element = target.ownerDocument.elementFromPoint(x, y)?.closest<HTMLElement>('[data-chat-node-key][data-chat-flow-key]')
            if (element && visible(element)) return element
        }
    }
    let outerRows: NodeListOf<HTMLElement> | undefined
    const rowsOf = (): NodeListOf<HTMLElement> => outerRows ??= port.querySelectorAll<HTMLElement>(
        '[data-chat-node-key][data-chat-flow-key]:not([hidden]):not([hidden] *):not([data-turn-process-hidden="true"]):not([data-turn-process-hidden="true"] *)')
    const boundary = (position: number, leading: boolean): number => {
        const rows = rowsOf()
        let low = 0, high = rows.length
        while (low < high) {
            const middle = (low + high) >>> 1, rect = measure(rows[middle]!)
            if (leading ? rect.bottom > position : rect.top >= position) high = middle
            else low = middle + 1
        }
        return leading ? low : low - 1
    }
    const indexOf = (element: HTMLElement): number => {
        const rows = rowsOf()
        let low = 0, high = rows.length
        while (low < high) {
            const middle = (low + high) >>> 1, row = rows[middle]!
            if (row === element) return middle
            // DOCUMENT_POSITION_FOLLOWING: no off-screen layout measurement.
            if (row.compareDocumentPosition(element) & 4) low = middle + 1
            else high = middle
        }
        return -1
    }
    let first = hit(top + .5), last = hit(bottom - .5)
    let visibleRows: readonly HTMLElement[]
    if (first && first === last) visibleRows = [first]
    else {
        // Public outer flow rows are in visual order. Binary search gaps and
        // folded headings; measuring every retained row would force layout of
        // the very history this reader is intended to release.
        const rows = rowsOf()
        const firstIndex = first ? indexOf(first) : boundary(top, true)
        const lastIndex = last ? indexOf(last) : boundary(bottom, false)
        if (firstIndex < 0 || lastIndex < firstIndex || lastIndex - firstIndex >= 64) return undefined
        first = rows[firstIndex]; last = rows[lastIndex]
        if (!first || !last || !visible(first) || !visible(last)) return undefined
        visibleRows = Array.prototype.slice.call(rows, firstIndex, lastIndex + 1) as HTMLElement[]
    }
    const sourceSpan = (rows: readonly HTMLElement[]): { firstSeq: number; lastSeq: number } | undefined => {
        let firstSeq = Infinity, finalSeq = -Infinity
        const visited = new Set<string>()
        for (const row of rows) {
            const key = row.dataset.chatNodeKey
            if (!key || visited.has(key)) continue
            visited.add(key)
            const node = snapshot.nodes.get(key)
            if (!node || node.visibility !== 'visible') return undefined
            const span = nodeSourceSpan(node, lastSeq)
            if (!span) return undefined
            firstSeq = Math.min(firstSeq, span[0]); finalSeq = Math.max(finalSeq, span[1])
        }
        return Number.isFinite(firstSeq) && Number.isFinite(finalSeq) ? { firstSeq, lastSeq: finalSeq } : undefined
    }
    const span = sourceSpan(visibleRows)
    if (!span) return undefined
    let overscan: SourceWindowViewport['overscan']
    // A turn spacer can leave only a short tail inside the viewport. Source
    // overscan may consist entirely of folded tools, so retain enough existing
    // outer history by measured height before allowing those older rows to go.
    // Keep this separate from the visible boundary used to detect reader motion.
    const requiredHeight = chatViewportHeight(port) + 8
    if (measure(last!).bottom - measure(first!).top <= requiredHeight) {
        const rows = rowsOf(), end = indexOf(last!), desiredTop = measure(last!).bottom - requiredHeight
        let start = boundary(desiredTop, true)
        if (start > 0 && rows[start] && measure(rows[start]!).top > desiredTop) start--
        if (start >= 0 && start < indexOf(first!)) {
            if (end < start || end - start >= 64) return undefined
            overscan = sourceSpan(Array.prototype.slice.call(rows, start, end + 1) as HTMLElement[])
            if (!overscan) return undefined
            if (overscan.firstSeq >= span.firstSeq && overscan.lastSeq <= span.lastSeq) overscan = undefined
        }
    }
    return { ...span, followingTail: !!port.querySelector('[data-chat-following-tail]'), ...(overscan ? { overscan } : {}) }
}

/** Register an occurrence reader without retaining or activating another view. */
export function registerVisibleWindowReader(ctx: Context, target: HTMLElement, reference: SessionReference, available: () => boolean): () => void {
    const session = reference.binding.session as SessionReference['binding']['session'] & Partial<SourceViewportSession>
    return session.registerWindowReader?.({ available, read: () => {
        if (!available()) return undefined
        const entries = reference.binding.eventSource.getSnapshot().entries
        const snapshot = ctx.uiConversation.binding(reference.binding).target('chat').getSnapshot()
        return readSourceWindowViewport(target, snapshot, entries.at(-1)?.event.seq ?? 0)
    } }) ?? (() => {})
}

/** The outer official flow excludes both the synthetic turn spacer and the
 * composer seat. Those can create scroll range without any readable history. */
function chatViewportHeight(port: HTMLElement): number {
    return port.clientHeight - (port.querySelector<HTMLElement>('[data-composer-seat]')?.offsetHeight ?? 0)
}

function chatContentFillsViewport(port: HTMLElement): boolean {
    const height = chatViewportHeight(port)
    const flow = port.querySelector<HTMLElement>('[data-chat-flow]:not([data-step-process-content])')
    return height > 0 && !!flow && flow.getBoundingClientRect().height > height + 8
}

/** Folded tools can consume a page without adding readable height. Use the
 * previous page's measured gain to size the next read, instead of paying one
 * network and React commit cycle for every twenty source messages. This stays
 * within the existing source API limit and retained-window byte/event bounds. */
class ViewportPagePlan {
    private height: number | undefined
    private limit = 20

    next(port: HTMLElement): number {
        const flow = port.querySelector<HTMLElement>('[data-chat-flow]:not([data-step-process-content])')
        const height = flow?.getBoundingClientRect().height ?? 0
        if (this.height !== undefined) {
            const gain = height - this.height
            const missing = chatViewportHeight(port) + 9 - height
            const needed = gain > 0 ? Math.ceil(this.limit * missing / gain) : this.limit * 4
            this.limit = Math.max(20, Math.min(200, this.limit * 4, needed))
        }
        this.height = height
        return this.limit
    }
}

/** Only foreground work spends the admission budget. Candidate DOM is hidden
 * intentionally; its owning pane already cancels it through the source signal. */
function preparationBudget(document: Document, pane?: WorkspacePaneNavigation['state']) {
    const now = (): number => document.defaultView?.performance.now() ?? performance.now()
    const active = (): boolean => (pane?.getSnapshot().visible ?? true) && document.visibilityState !== 'hidden'
    const timeout = new AbortController()
    let remaining = 5_000, activeSince: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const account = (): void => {
        const time = now()
        if (activeSince !== undefined) remaining -= time - activeSince
        activeSince = active() ? time : undefined
        if (remaining <= 0) timeout.abort()
        if (activeSince === undefined || timeout.signal.aborted) {
            clearTimeout(timer); timer = undefined
        } else if (timer === undefined) {
            timer = setTimeout(() => { timer = undefined; account() }, remaining)
        }
    }
    const unwatch = pane?.subscribe(account)
    document.addEventListener('visibilitychange', account)
    account()
    return { signal: timeout.signal, active, account, dispose(): void {
        clearTimeout(timer)
        unwatch?.()
        document.removeEventListener('visibilitychange', account)
    } }
}

/** Measure the official candidate chat, without changing the visible owner. */
export async function prepareCandidateViewport(target: HTMLElement, reference: SessionReference, signal: AbortSignal): Promise<boolean> {
    const budget = preparationBudget(target.ownerDocument)
    const stopped = AbortSignal.any([signal, budget.signal])
    const wait = (work: Promise<unknown>): Promise<boolean> => new Promise(resolve => {
        if (stopped.aborted) { resolve(false); return }
        const finish = (ok: boolean): void => { stopped.removeEventListener('abort', abort); resolve(ok && !stopped.aborted) }
        const abort = (): void => finish(false)
        stopped.addEventListener('abort', abort, { once: true })
        void work.then(() => finish(true), () => finish(false))
    })
    const frame = async (): Promise<boolean> => {
        const view = target.ownerDocument.defaultView
        while (!stopped.aborted) {
            let request = 0
            const done = wait(new Promise<void>(resolve => {
                if (view) request = view.requestAnimationFrame(() => resolve())
                else resolve()
            }))
            let ready: boolean
            try { ready = await done }
            finally { view?.cancelAnimationFrame(request) }
            if (!ready) return false
            budget.account()
            if (stopped.aborted) return false
            if (budget.active()) return true
        }
        return false
    }
    try {
        let pages = 0
        const pagePlan = new ViewportPagePlan()
        while (await frame()) {
            const port = target.querySelector<HTMLElement>('[data-conversation-scroll]')
            if (!port || port.clientHeight <= 0 || port.clientWidth <= 0) continue
            const snapshot = reference.binding.session.getSnapshot()
            if (snapshot.loadingOlder) continue
            if (!snapshot.hasMore || chatContentFillsViewport(port)) return true
            if (pages++ >= 12) return false
            const before = reference.binding.eventSource.getSnapshot().entries[0]?.event.seq
            const session = reference.binding.session as SessionReference['binding']['session'] & SourceViewportSession
            if (!await wait(session.loadViewportPage(pagePlan.next(port)))) return false
            // The loop's next frame supplies the second post-commit frame.
            if (!await frame()) return false
            const after = reference.binding.eventSource.getSnapshot().entries[0]?.event.seq
            if (before === after && reference.binding.session.getSnapshot().hasMore && !chatContentFillsViewport(port)) return false
        }
        return false
    } finally { budget.dispose() }
}

export interface WindowPreparationMount {
    readonly target: HTMLElement
    /** Resolve after the official chat occurrence has unmounted. */
    dispose(): Promise<void>
}

/** Serialize temporary occurrences, including their asynchronous unmount. */
export class WindowPreparationCoordinator {
    private revision = 0
    private active: { abort: AbortController; done: Promise<boolean> } | undefined
    private disposed = false

    async prepare(reference: SessionReference, signal: AbortSignal,
        mount: (failed: () => void) => WindowPreparationMount): Promise<boolean> {
        const revision = ++this.revision
        const previous = this.active
        previous?.abort.abort()
        await previous?.done
        if (this.disposed || signal.aborted || revision !== this.revision) return false
        const abort = new AbortController()
        const stopped = AbortSignal.any([signal, abort.signal])
        const done = (async (): Promise<boolean> => {
            let occurrence: WindowPreparationMount | undefined
            let ready = false
            try {
                occurrence = mount(() => abort.abort())
                ready = await prepareCandidateViewport(occurrence.target, reference, stopped)
            } catch { ready = false }
            finally { await occurrence?.dispose() }
            return ready && !stopped.aborted
        })()
        const active = { abort, done }
        this.active = active
        try { return await done }
        finally { if (this.active === active) this.active = undefined }
    }

    async dispose(): Promise<void> {
        this.disposed = true
        this.revision++
        this.active?.abort.abort()
        await this.active?.done
    }
}


/** Official input availability, independent of the measuring wrapper's CSS.
 * A real public restriction keeps its reason; a missing/busy editor waits for
 * the existing bounded admission rather than being made editable here. */
export function initialComposerReady(target: HTMLElement, snapshot: SessionSnapshot, block?: ComposerBlock): boolean {
    const inputs = target.querySelectorAll<HTMLElement>('[data-composer-card] [data-composer-input]')
    const input = inputs.length === 1 ? inputs[0] : undefined
    if (block !== undefined) throw new Error(block.reason)
    if (snapshot.removed) throw new Error('The conversation was removed.')
    if (snapshot.subagent?.address.mode === 'continuable' && snapshot.subagent.parentAvailable === false)
        throw new Error('The parent session is offline.')
    if (!input || input.getClientRects().length === 0) return false
    const box = input.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && input.getAttribute('contenteditable') === 'true'
        && input.getAttribute('aria-disabled') !== 'true' && !input.hasAttribute('disabled')
        && input.closest('[inert], [hidden], [aria-hidden="true"]') === null
}

/** One owner prepares the visible window. Source readiness and the outline are
 * already part of reference.ready; additional history is read only if the
 * actual viewport needs it, never to meet an arbitrary turn count. */
export async function prepareInitialViewport(
    target: HTMLElement,
    reference: SessionReference,
    navigation: WorkspacePaneNavigation,
    live: () => boolean,
    composerBlock: () => ComposerBlock | undefined = () => undefined,
    signal?: AbortSignal,
): Promise<boolean> {
    const document = target.ownerDocument, frame = document.defaultView
    const budget = preparationBudget(document, navigation.state)
    const stopped = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal
    const wait = (work: Promise<unknown>): Promise<boolean> => new Promise(resolve => {
        if (stopped.aborted || !live()) { resolve(false); return }
        const finish = (ok: boolean): void => {
            stopped.removeEventListener('abort', abort)
            resolve(ok && !stopped.aborted && live())
        }
        const abort = (): void => finish(false)
        stopped.addEventListener('abort', abort, { once: true })
        void work.then(() => finish(true), () => finish(false))
    })
    const nextActiveFrame = async (): Promise<boolean> => {
        while (live() && !stopped.aborted) {
            let request = 0
            const next = wait(new Promise<void>(resolve => {
                if (frame) request = frame.requestAnimationFrame(() => resolve())
                else resolve()
            }))
            let ready: boolean
            try { ready = await next }
            finally { if (frame) frame.cancelAnimationFrame(request) }
            if (!ready) return false
            budget.account()
            if (stopped.aborted) return false
            if (budget.active()) return true
        }
        return false
    }
    try {
        let pages = 0
        const pagePlan = new ViewportPagePlan()
        while (await nextActiveFrame()) {
            const port = target.querySelector<HTMLElement>('[data-conversation-scroll]')
            if (!port || port.clientHeight <= 0 || port.clientWidth <= 0) continue
            const snapshot = reference.binding.session.getSnapshot()
            if (!initialComposerReady(target, snapshot, composerBlock())) continue
            const reading = navigation.reading.getSnapshot()
            const readingState = target.getAttribute('data-hapi-reading')
            // Reload restoration can run without a new intent. Latest is also an
            // explicit destination, so neither may expose the preceding viewport
            // while the reading owner is still positioning it.
            if (reading || readingState) {
                if (readingState === 'error') return false
                if (readingState !== 'ready' && readingState !== 'reader') continue
            }
            if (snapshot.loadingOlder) continue
            if (!snapshot.hasMore || chatContentFillsViewport(port)) return true
            if (pages++ >= 12) return false
            const before = reference.binding.eventSource.getSnapshot().entries[0]?.event.seq
            const session = reference.binding.session as SessionReference['binding']['session'] & Partial<SourceViewportSession>
            if (!await wait(session.loadViewportPage ? session.loadViewportPage(pagePlan.next(port)) : session.loadOlder())) return false
            if (!await nextActiveFrame()) return false
            const after = reference.binding.eventSource.getSnapshot().entries[0]?.event.seq
            // A page can contain only folded steps and add no visible height.
            // Continue while its leading event advances, within the same bounded
            // page/visible-time budget. A live append is not older-history progress.
            if (before === after && reference.binding.session.getSnapshot().hasMore
                && !chatContentFillsViewport(port)) return false
        }
        return false
    } finally { budget.dispose() }
}
/** The caller owns the reference and releases it after removing this view. */
export interface SessionViewMount {
    readonly paneId: string
    /** A retired draft-transfer occurrence may coexist with its pane successor. */
    readonly instanceId?: string | undefined
    readonly reference: SessionReference
    readonly target: HTMLElement
    readonly navigation: WorkspacePaneNavigation
    /** The reference is ready and its registered view has committed. */
    readonly onReady?: (() => void) | undefined
    readonly onError?: ((error: unknown) => void) | undefined
}

export interface SessionViewHandle {
    /** Changing presentation preserves the factory occurrence and editor DOM. */
    update(options: { navigation?: WorkspacePaneNavigation | undefined }): void
    /** Persist the reading anchor before a same-source successor mounts. */
    suspendReading(): void
    /** Waits for portal unmount before its owner may release the reference. */
    dispose(): Promise<void>
}

interface ViewLifetime { mounted: boolean; removed?: (() => void) | undefined }

interface Entry extends SessionViewMount {
    readonly key: number
    readonly lifetime: ViewLifetime
    readonly phase: 'loading' | 'measuring' | 'ready' | 'error'
    readonly error?: unknown
}

interface PreparationEntry {
    readonly key: number
    readonly ownerKey: number
    readonly target: HTMLElement
    readonly reference: SessionReference
    readonly lifetime: ViewLifetime
    readonly onError: () => void
}

type HostProps = PropsRuntime<'shell.overlay'> & PropsRenderSlots<'hapi.workspace.session-view' | 'hapi.workspace.shared-rightbar'>
type ContentProps = PropsRuntime<'hapi.workspace.session-view'> & PropsRenderFactories
const PreparationContext = createContext<PreparationEntry | undefined>(undefined)

function PreparationOccurrence({ entry, SessionProvider, renderSlot }:
    Pick<ConversationViewsProps, 'SessionProvider' | 'renderSlot'> & { entry: PreparationEntry }): ReactNode {
    useLayoutEffect(() => {
        entry.lifetime.mounted = true
        return () => { entry.lifetime.mounted = false; entry.lifetime.removed?.() }
    }, [entry.lifetime])
    return <ViewBoundary onError={entry.onError}>
        <SessionProvider session={entry.reference}>
            <div data-conversation-scroll="" style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
                {renderSlot('conversation.session', { view: 'chat' })}
            </div>
        </SessionProvider>
    </ViewBoundary>
}

/** A local factory position may render only children declared by that factory. */
function ChatViews({ renderSlot, SessionProvider }: ConversationViewsProps): ReactNode {
    const candidate = useContext(PreparationContext)
    return <>{renderSlot('conversation.session', { view: 'chat' })}
        {candidate && createPortal(<PreparationOccurrence entry={candidate} SessionProvider={SessionProvider} renderSlot={renderSlot}/>,
            candidate.target, String(candidate.key))}</>
}

/** Same public binding and phase inputs as the official embedded child chat. */
function SessionContent({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }: ContentProps): ReactNode {
    const activeTargets = useConversation(value => value.activeTargets.size > 0)
    const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
    // Subscribe only to shell phase. Streaming text, queue receipts and draft
    // edits have their own subscriptions below this factory occurrence.
    const phase = useSession(session => {
        const active = activeTargets || (!session.blank && !session.awaitingFirstTurn) || session.running
        const blank = !active && !session.promptAttempted
        const parentPending = session.subagent?.address.mode === 'continuable' && session.subagent.parentAvailable === undefined
        if ((blank && session.openState === 'loading' && summaryBlank !== true) || parentPending) return 'settling'
        return blank && (session.openState === 'open' || summaryBlank === true) ? 'hero' : 'active'
    })
    return renderFactorySlot('conversation.content', {
        variant: 'embedded', phase, hero: phase === 'hero',
    }, { slots: { views: ChatViews } })
}

function Failure({ error }: { error: unknown }): ReactNode {
    return <div className="hapi-empty" role="alert"><p>{error instanceof Error ? error.message : String(error)}</p></div>
}

class ViewBoundary extends Component<{ onError?: ((error: unknown) => void) | undefined; children: ReactNode }, { error?: unknown }> {
    override state: { error?: unknown } = {}
    static getDerivedStateFromError(error: unknown): { error: unknown } { return { error } }
    override componentDidCatch(error: unknown): void { this.props.onError?.(error) }
    override render(): ReactNode { return this.state.error === undefined ? this.props.children : <Failure error={this.state.error}/> }
}

function ViewFrame({ entry, children }: { entry: Entry; children: ReactNode }): ReactNode {
    const announced = useRef(false)
    useLayoutEffect(() => {
        entry.lifetime.mounted = true
        return () => { entry.lifetime.mounted = false; entry.lifetime.removed?.() }
    }, [entry.lifetime])
    useLayoutEffect(() => {
        if (entry.phase === 'ready' && !announced.current) { announced.current = true; entry.onReady?.() }
    }, [entry.phase, entry.onReady])
    return <div data-hapi-session-view={entry.reference.sessionId} data-hapi-session-pane={entry.paneId}
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', width: '100%', overflow: 'hidden' }}>
        {entry.phase === 'error' ? <Failure error={entry.error}/>
            : entry.phase === 'loading'
                ? <div className="hapi-session-loading" role="status" aria-live="polite" data-hapi-session-loading="loading">
                    <span className="hapi-session-loading-spinner" aria-hidden="true"/>
                    <p>正在打开会话…</p>
                </div>
                : children}
    </div>
}

/** The pin caches both public faces; unchanged entries need no sibling render.
 * Session, locale, and slot subscriptions below remain independently active. */
const SessionOccurrence = memo(function SessionOccurrence({ entry, candidate, SessionProvider, renderSlot }:
    Pick<HostProps, 'SessionProvider' | 'renderSlot'> & { entry: Entry; candidate?: PreparationEntry | undefined }): ReactNode {
    return <WorkspacePaneProvider value={entry.navigation}>
        <PreparationContext.Provider value={candidate}>
        <ViewBoundary onError={entry.onError}>
            <ViewFrame entry={entry}>
                {entry.phase === 'loading' || entry.phase === 'error' ? null : <div data-hapi-session-reveal={entry.phase === 'ready' ? 'ready' : 'pending'}
                    style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%', height: '100%',
                        visibility: entry.phase === 'ready' ? 'visible' : 'hidden', pointerEvents: entry.phase === 'ready' ? 'auto' : 'none' }}>
                    <SessionProvider session={entry.reference}>
                        {renderSlot('hapi.workspace.session-view', {})}
                        {renderSlot('hapi.workspace.shared-rightbar', {})}
                    </SessionProvider>
                </div>}
            </ViewFrame>
        </ViewBoundary>
        </PreparationContext.Provider>
    </WorkspacePaneProvider>
})

/**
 * Install exactly once per official Client Context. The graph owner must render
 * that Context's AppFrame once; portals inherit its public scope and slot hosts.
 * Closing a handle never releases a different view or terminates execution.
 */
export function installSessionViewHost(ctx: Context): {
    mount(options: SessionViewMount): SessionViewHandle
    size(): number
    dispose(): void
} {
    const entries = new Map<string, Entry>()
    const initialHistory = new Map<string, () => void>()
    const preparers = new Map<string, () => void>()
    const readers = new Map<string, () => void>()
    const preparation = new WindowPreparationCoordinator()
    const hostAbort = new AbortController()
    const listeners = new Set<() => void>()
    let candidate: PreparationEntry | undefined
    let snapshot: { views: readonly Entry[]; candidate: PreparationEntry | undefined } = { views: [], candidate }
    let sequence = 0
    let disposed = false
    const publish = (): void => {
        snapshot = { views: [...entries.values()], candidate }
        for (const listener of listeners) listener()
    }
    const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    const getSnapshot = (): typeof snapshot => snapshot
    const Host = ({ SessionProvider, renderSlot }: HostProps): ReactNode => {
        const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        return <>{current.views.map(entry => createPortal(
            <SessionOccurrence entry={entry} candidate={current.candidate?.ownerKey === entry.key ? current.candidate : undefined}
                SessionProvider={SessionProvider} renderSlot={renderSlot}/>, entry.target, String(entry.key),
        ))}</>
    }
    const mountPreparation = (reference: SessionReference, owner: Entry, onError: () => void): WindowPreparationMount => {
        const visibleTarget = owner.target
        const port = visibleTarget.querySelector<HTMLElement>('[data-conversation-scroll]')
        if (!port || !visibleTarget.parentElement || port.clientHeight <= 0 || port.clientWidth <= 0) throw new Error('The visible chat viewport is unavailable')
        const height = chatViewportHeight(port)
        if (height <= 0) throw new Error('The visible chat has no space above its composer')
        const target = visibleTarget.ownerDocument.createElement('div')
        target.dataset.hapiWindowPreparation = reference.sessionId
        target.setAttribute('aria-hidden', 'true')
        target.inert = true
        Object.assign(target.style, { position: 'absolute', top: '0', left: '0', width: `${port.clientWidth}px`, height: `${height}px`,
            visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden', contain: 'layout paint' })
        const computed = visibleTarget.ownerDocument.defaultView?.getComputedStyle(port)
        if (computed) {
            for (const name of computed) if (name.startsWith('--')) target.style.setProperty(name, computed.getPropertyValue(name))
            target.style.font = computed.font
            target.style.letterSpacing = computed.letterSpacing
        }
        // Match the real conversation's geometry without putting candidate
        // anchors inside the visible reading owner's DOM query boundary.
        visibleTarget.parentElement.appendChild(target)
        const entry: PreparationEntry = { key: ++sequence, ownerKey: owner.key, target, reference, lifetime: { mounted: false }, onError }
        candidate = entry; publish()
        return { target, async dispose() {
            const removed = entry.lifetime.mounted ? new Promise<void>(resolve => { entry.lifetime.removed = resolve }) : Promise.resolve()
            if (candidate === entry) { candidate = undefined; publish() }
            await removed
            target.remove()
        } }
    }
    const disposers: Array<() => void> = []
    try {
        disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id: 'hapi.workspace.session-views',
            children: {
                'hapi.workspace.session-view': { kind: 'single', scope: 'session' },
                'hapi.workspace.shared-rightbar': { kind: 'single', scope: 'session' },
            },
        }, Host)))
        disposers.push(ctx.slots.inject('hapi.workspace.session-view', () => ctx.slots.register({ name: 'hapi.workspace.session-view' }, SessionContent)))
        disposers.push(installSharedRightbar(ctx))
        disposers.push(installSourceWindowNavigation(ctx))
    } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    return {
        mount(options) {
            if (disposed) throw new Error('The Host session-view surface is disposed')
            const identity = options.instanceId ?? options.paneId
            if (entries.has(identity)) throw new Error(`Pane ${options.paneId} already has a session view on this Host`)
            let entry: Entry = { ...options, key: ++sequence, lifetime: { mounted: false }, phase: 'loading' }
            entries.set(identity, entry); publish()
            const stopReading = bindPaneReading(ctx, options.target, options.reference, options.navigation)
            let readingStopped = false
            const uninitialHistory = (): void => { if (!readingStopped) { readingStopped = true; stopReading() } }
            initialHistory.set(identity, uninitialHistory)
            let live = true
            const preparationAbort = new AbortController()
            let removed: Promise<void> | undefined
            const fail = (error: unknown): void => {
                if (!live || disposed || entry.phase === 'error') return
                preparationAbort.abort()
                preparers.get(identity)?.(); preparers.delete(identity)
                uninitialHistory()
                entry = { ...entry, phase: 'error', error }; entries.set(identity, entry); publish()
                entry.onError?.(error)
            }
            // Outline failure must end this occurrence even if the original
            // Session open is still pending. Both waits share one error path.
            const preparationReady = (options.reference as Partial<SourcePreparationReference>).preparationReady ?? options.reference.ready
            const mounted = preparationReady.then(() => {
                if (!live || disposed || entry.phase === 'error') return
                // Build the same official factory hidden while the outline is
                // loading. Reading and viewport admission retain full readiness.
                entry = { ...entry, phase: 'measuring' }; entries.set(identity, entry); publish()
                const session = options.reference.binding.session as SessionReference['binding']['session'] & Partial<SourceViewportSession>
                const available = (): boolean => {
                    if (!live || disposed || (entry.phase !== 'measuring' && entry.phase !== 'ready')
                        || !entry.navigation.state.getSnapshot().visible || !options.target.isConnected || options.target.hidden) return false
                    const port = options.target.querySelector<HTMLElement>('[data-conversation-scroll]')
                    return !!port && port.clientHeight > 0 && port.clientWidth > 0
                }
                // This occurrence can supply candidate geometry as soon as
                // its Chat mounts. Reused source records may have only hidden
                // old preparers; waiting for reading-ready here would prevent
                // the very latest operation that initial admission awaits.
                const stopPreparing = session.registerWindowPreparer?.({
                    available,
                    prepare: async (reference, signal) => {
                        const ready = await preparation.prepare(reference, AbortSignal.any([signal, preparationAbort.signal]),
                            failed => mountPreparation(reference, entry, failed))
                        return ready && available()
                    },
                })
                if (stopPreparing) preparers.set(identity, stopPreparing)
            })
            void Promise.all([mounted, options.reference.ready]).then(async () => {
                if (!live || disposed || entry.phase === 'error') return
                const block = ctx.get('conversation')?.blocks.storeFor(options.reference.sessionId)
                const alive = (): boolean => live && !disposed && entries.get(identity)?.key === entry.key
                const lifetime = AbortSignal.any([preparationAbort.signal, hostAbort.signal])
                // A mobile/second pane can be hidden or still measuring its first
                // geometry when this occurrence mounts. Retry the viewport admission
                // instead of failing the whole conversation on one false sample.
                let ok = false
                for (let attempt = 0; attempt < 240 && !lifetime.aborted; attempt++) {
                    ok = await prepareInitialViewport(options.target, options.reference, options.navigation, alive,
                        () => block?.getSnapshot(), lifetime)
                    if (ok) break
                    // A pane can be visible while its measured editor is still
                    // settling (restore, split, mobile keyboard). Keep retrying
                    // for a bounded minute instead of failing the occurrence
                    // after two seconds; detached targets still stop early.
                    if (!alive()) break
                    if (!options.target.hidden && attempt >= 40) break
                    await new Promise<void>(resolve => {
                        const timer = setTimeout(resolve, 250)
                        lifetime.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
                    })
                }
                if (!live || disposed) return
                if (!ok) throw new Error('The source conversation could not open its usable editor and first history viewport')
                entry = { ...entry, phase: 'ready' }; entries.set(identity, entry)
                readers.set(identity, registerVisibleWindowReader(ctx, options.target, options.reference,
                    () => live && !disposed && entry.phase === 'ready' && entry.navigation.state.getSnapshot().visible
                        && options.target.isConnected && !options.target.hidden))
                publish()
            }).catch(fail)
            return {
                suspendReading: uninitialHistory,
                update(next) {
                    if (!live || disposed || next.navigation === undefined || next.navigation === entry.navigation) return
                    entry = { ...entry, navigation: next.navigation }; entries.set(identity, entry); publish()
                },
                dispose() {
                    if (removed) return removed
                    live = false
                    preparationAbort.abort()
                    preparers.get(identity)?.(); preparers.delete(identity)
                    readers.get(identity)?.(); readers.delete(identity)
                    uninitialHistory()
                    initialHistory.delete(identity)
                    removed = entry.lifetime.mounted ? new Promise<void>(resolve => { entry.lifetime.removed = resolve }) : Promise.resolve()
                    if (entries.get(identity)?.key === entry.key) { entries.delete(identity); publish() }
                    return removed
                },
            }
        },
        size: () => entries.size,
        dispose() {
            if (disposed) return
            disposed = true
            hostAbort.abort()
            void preparation.dispose()
            for (const stop of preparers.values()) stop()
            preparers.clear()
            for (const stop of readers.values()) stop()
            readers.clear()
            for (const dispose of initialHistory.values()) dispose()
            initialHistory.clear(); entries.clear(); publish()
            for (const dispose of disposers.reverse()) dispose()
            listeners.clear()
        },
    }
}
