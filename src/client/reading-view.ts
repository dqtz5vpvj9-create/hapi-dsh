import { readingCandidates } from './reading-candidates.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { WorkspacePaneNavigation } from './pane-navigation.ts'
import type { PaneReadingIntent } from './reading-intent.ts'
import { findChatElement, messageNodeTarget, parseReloadReadingAnchor, placeReadingAnchor, revealChatElement, type ReloadReadingAnchor } from './reading-anchor.ts'
import { keyIntent } from './seamless/intent.ts'
import { loadHistoryThrough } from './history-navigation.ts'
import type {} from './source-navigation.ts'
import type { SourceViewportSession } from './source-sessions.ts'

const latestCancellations = new WeakMap<HTMLElement, () => void>()

/** Link a mounted official action to this occurrence's explicit destinations. */
export function registerLatestCancellation(content: HTMLElement, cancel: () => void): () => void {
    latestCancellations.set(content, cancel)
    return () => { if (latestCancellations.get(content) === cancel) latestCancellations.delete(content) }
}

function cancelLatestNavigation(root: HTMLElement): void {
    latestCancellations.get(root)?.()
    for (const content of root.querySelectorAll<HTMLElement>('[data-conversation-content]')) latestCancellations.get(content)?.()
}

/** Let the mounted official Chat owner resume following after the source commit.
 * rc.3 does not export its ChatNavigation/ChatReading instance through the
 * public Chat slot. Its existing button is the supported action already used
 * for manual navigation; no plugin scroll position is written here. */
export async function activateOfficialLatest(root: HTMLElement, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const window = root.ownerDocument.defaultView
    if (!window) throw new Error('The conversation view is no longer available.')
    // Source publication notifies React before its load promise resolves. Run
    // before the next paint, after that committed window reaches the same Chat.
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => { window.cancelAnimationFrame(frame); reject(signal.reason) }
        const frame = window.requestAnimationFrame(() => {
            signal.removeEventListener('abort', abort)
            if (signal.aborted) reject(signal.reason); else resolve()
        })
        signal.addEventListener('abort', abort, { once: true })
    })
    signal.throwIfAborted()
    if (!root.isConnected || root.closest('[aria-hidden="true"], [data-hapi-pane-visible="false"]'))
        throw new Error('The conversation view is no longer visible.')
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
        .filter(button => button.className.includes('toBottom') && !button.disabled && button.getClientRects().length > 0)
    if (buttons.length === 1) { buttons[0]!.click(); return }
    const port = root.querySelector<HTMLElement>('[data-conversation-scroll]')
    // The official button is absent while Chat already owns tail following,
    // including its in-flight smooth motion. Do not create another position
    // owner or mistake that motion for a missing navigation action.
    if (buttons.length === 0 && port && (port.closest('[data-chat-following-tail]') || port.querySelector('[data-chat-following-tail]'))) return
    throw new Error('The official return-to-latest action is not available.')
}

/** Per-occurrence destination lifetime. Live/history/focus never request latest. */
export function bindPaneReading(ctx: Context, root: HTMLElement, reference: SessionReference, navigation: WorkspacePaneNavigation): () => void {
    const window = root.ownerDocument.defaultView
    if (!window) return () => {}
    const source = navigation.reading
    type ReadingRequest = { intent: PaneReadingIntent | undefined; reload?: ReloadReadingAnchor | undefined;
        phase: 'waiting' | 'running' | 'done' | 'error' | 'reader'; error?: unknown; recovery?: boolean }
    let disposed = false, ready = false, observed = false, observedIntent: PaneReadingIntent | undefined
    let request: ReadingRequest | undefined
    let pending: AbortController | undefined
    let failure: HTMLElement | undefined
    let retainedAnchor: ReloadReadingAnchor | undefined, readerOwned = false
    let sampleFrame: number | undefined
    let readerMoving = false, touchHeld = false, pointerHeld = false, readerScrolled = false
    let settleTimer: number | undefined
    let settleFrame: number | undefined
    let eventRevision = reference.binding.eventSource.getSnapshot().revision
    const sourceWindow = (reference.binding.session as Partial<SourceViewportSession>).sourceWindow
    let bodyVersion = sourceWindow?.getSnapshot()
    const projected = ctx.sessions.list.getSnapshot().byId[reference.sessionId]?.projectionValues
    const native = projected?.hapi ?? projected?.hapiObserved
    const sourceIdentity = native ? [native.hubId, native.hapiSessionId] : reference.sessionId
    const sourceAnchors = new Map<number, string>()
    let anchorTimer: number | undefined
    const storageKey = `hapi-dsh:reload-reading:${JSON.stringify([navigation.hostId, navigation.paneId, sourceIdentity])}`
    let restored: ReloadReadingAnchor | undefined
    try {
        const entry = window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        const saved = parseReloadReadingAnchor(window.sessionStorage.getItem(storageKey))
        if (entry?.type === 'reload' || saved?.sourceMessageId && saved.displayId !== reference.sessionId) restored = saved
        window.sessionStorage.removeItem(storageKey)
    } catch { /* A disabled browser store does not block conversation navigation. */ }

    const waitFor = <T,>(read: () => T | undefined, signal: AbortSignal, extraScopes: readonly HTMLElement[] = []): Promise<T> => new Promise((resolve, reject) => {
        const finish = (value?: T, error?: unknown): void => {
            observer.disconnect(); window.clearTimeout(timer); signal.removeEventListener('abort', abort)
            if (error) reject(error); else resolve(value!)
        }
        const check = (): void => { const value = read(); if (value !== undefined) finish(value) }
        const abort = (): void => finish(undefined, signal.reason ?? new Error('Navigation cancelled'))
        const observer = new MutationObserver(check)
        const timer = window.setTimeout(() => finish(undefined, new Error('The conversation target is not visible yet. Retry after loading finishes.')), 5000)
        observer.observe(root.closest('.hapi-pane') ?? root, { childList: true, subtree: true, attributes: true })
        for (const scope of extraScopes) observer.observe(scope, { childList: true, subtree: true, attributes: true })
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort(); else check()
    })
    const visible = (): boolean => navigation.state.getSnapshot().visible && root.isConnected && !root.hidden
    const clearFailure = (): void => { failure?.remove(); failure = undefined }
    const showFailure = (error: unknown, retry: () => void): void => {
        clearFailure()
        failure = root.ownerDocument.createElement('div')
        failure.className = 'hapi-reading-error'; failure.setAttribute('role', 'alert')
        const text = root.ownerDocument.createElement('span')
        text.textContent = error instanceof Error ? error.message : String(error)
        const button = root.ownerDocument.createElement('button')
        button.type = 'button'; button.textContent = ctx.locale.getSnapshot().active.startsWith('zh') ? '重试定位' : 'Retry navigation'
        button.onclick = retry
        failure.append(text, button); root.prepend(failure)
    }
    const retry = (current: ReadingRequest): void => {
        if (!disposed && visible() && request === current && source?.getSnapshot() === current.intent) void apply(current)
    }
    const apply = async (current: ReadingRequest): Promise<void> => {
        pending?.abort(); const operation = new AbortController(); pending = operation
        const signal = operation.signal
        const { intent, reload } = current
        current.phase = 'running'; delete current.error
        clearFailure(); root.dataset.hapiReading = 'loading'
        try {
            await reference.ready; signal.throwIfAborted()
            const scrollport = await waitFor(() => root.querySelector<HTMLElement>('[data-conversation-scroll]') ?? undefined, signal)
            const target = reload ? undefined : intent?.target
            if (target?.kind === 'message') {
                const service = ctx.get('hapiMessageNavigation')
                if (!service) throw new Error('Source message navigation is not ready.')
                const located = await service.locate(reference.sessionId, target.messageId, signal)
                signal.throwIfAborted()
                // A source reconciliation can publish a successor display ID.
                // Keep the explicit destination across that public rebind.
                if (located.sessionId !== reference.sessionId) {
                    navigation.openSession(located.sessionId, { target }); return
                }
                await service.revealSequence(reference.sessionId, located.seq, signal, root)
            } else if (target?.kind === 'approval' || target?.kind === 'delivery') {
                const selector = target.kind === 'approval' ? '[data-hapi-request-id]' : '[data-hapi-delivery-id]'
                // Mobile source receipts are portalled outside the pane. Only
                // this occurrence's stable status seat belongs to its lookup.
                const footer = target.kind === 'delivery' ? root.ownerDocument.querySelector<HTMLElement>(
                    `.hapi-pane-status-slot[data-hapi-pane-mobile-status="${CSS.escape(navigation.paneId)}"]`) : null
                const scopes = target.kind === 'delivery' ? [root.closest<HTMLElement>('.hapi-pane') ?? root, ...(footer ? [footer] : [])] : [root]
                const row = await waitFor(() => scopes.flatMap(scope => [...scope.querySelectorAll<HTMLElement>(selector)])
                    .find(element => target.kind === 'approval' ? element.dataset.hapiRequestId === target.requestId : element.dataset.hapiDeliveryId === target.localId), signal, footer ? [footer] : [])
                // The footer seat now lives inside the pane actions menu. Keep
                // lookup/observation scoped to that seat, but reveal its outer
                // disclosure too so explicit receipt navigation is visible.
                const boundaries = scopes.map(scope => scope === footer ? scope.closest<HTMLElement>('.hapi-pane-actions') ?? scope : scope)
                for (let ancestor = row.parentElement; ancestor; ancestor = ancestor.parentElement) {
                    if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true
                    if (boundaries.includes(ancestor)) break
                }
                row.scrollIntoView({ block: 'nearest' }); row.tabIndex = -1; row.focus({ preventScroll: true })
            } else if (reload) {
                let seq = reload.seq, key = reload.key
                if (reload.sourceMessageId) {
                    const service = ctx.get('hapiMessageNavigation')
                    if (!service) throw new Error('Source navigation is not ready.')
                    const located = await service.locate(reference.sessionId, reload.sourceMessageId, signal)
                    if (located.sessionId !== reference.sessionId) {
                        window.sessionStorage.setItem(storageKey, JSON.stringify(reload))
                        navigation.openSession(located.sessionId); return
                    }
                    seq = located.seq
                    await loadHistoryThrough(reference.binding.session, located.seq, signal); signal.throwIfAborted()
                    key = messageNodeTarget(ctx.uiConversation.binding(reference.binding).target('chat').getSnapshot(), seq)?.key ?? key
                } else await loadHistoryThrough(reference.binding.session, seq as SessionSeq, signal)
                signal.throwIfAborted()
                const clicked = new WeakSet<HTMLElement>()
                const row = await waitFor(() => revealChatElement(root, { key, kind: 'message' }, clicked), signal)
                signal.throwIfAborted()
                placeReadingAnchor(scrollport, row, reload.offset)
            } else if (target?.kind === 'latest') {
                const session = reference.binding.session as typeof reference.binding.session & {
                    returnToLive?: (signal?: AbortSignal) => boolean | Promise<boolean>
                }
                const returned = session.returnToLive?.(signal) ?? false
                // Synchronous false is the ordinary, already-resident Session
                // path. A false async result means this source jump failed or
                // was superseded: keep its previous window and reading owner.
                if (typeof returned !== 'boolean' && !await returned) {
                    signal.throwIfAborted()
                    throw new Error('The latest source window could not be opened.')
                }
                signal.throwIfAborted()
                await activateOfficialLatest(root, signal)
            }
            signal.throwIfAborted(); current.phase = readerOwned ? 'reader' : 'done'; root.dataset.hapiReading = 'ready'
            retainedAnchor = readAnchor()
        } catch (error) {
            if (signal.aborted || disposed) return
            current.phase = 'error'; current.error = error; root.dataset.hapiReading = 'error'
            showFailure(error, () => retry(current))
        } finally { if (pending === operation) pending = undefined }
    }
    const update = (): void => {
        if (disposed || !ready) return
        const next = source?.getSnapshot()
        if (!observed || next !== observedIntent) {
            observed = true; observedIntent = next
            // A resident message/receipt may need no source fetch, so it cannot
            // rely on SourceSession.beginJump to cancel a prior latest request.
            cancelLatestNavigation(root)
            pending?.abort(); pending = undefined; clearFailure()
            retainedAnchor = undefined; readerOwned = false
            const reload = !next || next.target.kind === 'latest' ? restored : undefined
            request = next || reload ? { intent: next, reload, phase: 'waiting' } : undefined
            restored = undefined
        }
        if (!visible()) {
            cancelLatestNavigation(root)
            readerMoving = touchHeld = pointerHeld = readerScrolled = false
            if (settleTimer !== undefined) window.clearTimeout(settleTimer)
            settleTimer = undefined
            if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
            settleFrame = undefined
            if (pending && !pending.signal.aborted) {
                pending.abort(); pending = undefined
                if (request?.phase === 'running') request.phase = 'waiting'
            }
            clearFailure(); return
        }
        if (request?.phase === 'waiting' && !(request.recovery && readerMoving)) void apply(request)
        else if (request?.phase === 'error' && !failure) {
            const current = request
            showFailure(current.error, () => retry(current))
        }
    }
    // Official navigation owns the next window placement. A replace caused by
    // that action must not be mistaken for a transport reconnect and restore
    // the bookmark from the window the user deliberately left.
    const officialNavigation = (event: Event): void => {
        if (!event.isTrusted) return
        const button = (event.target as Element | null)?.closest?.('button')
        if (!button) return
        const t = ctx.locale.bind('chat')
        const latest = button.className.includes('toBottom')
        const rail = button.closest('nav[aria-label]')
        const turn = button.getAttribute('data-index') !== null
            && rail?.getAttribute('aria-label') === t('chat.turnNavigation.label')
        if (!latest && !turn) return
        pending?.abort(); pending = undefined; request = undefined
        retainedAnchor = undefined; restored = undefined; readerOwned = true
        readerMoving = touchHeld = pointerHeld = readerScrolled = false
        if (sampleFrame !== undefined) window.cancelAnimationFrame(sampleFrame)
        if (anchorTimer !== undefined) window.clearTimeout(anchorTimer)
        if (settleTimer !== undefined) window.clearTimeout(settleTimer)
        if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
        sampleFrame = anchorTimer = settleTimer = settleFrame = undefined
        clearFailure()
        root.dataset.hapiReading = 'reader'
        try { window.sessionStorage.removeItem(storageKey) } catch { /* optional bookmark */ }
    }
    const reader = (event: Event): void => {
        // Real gestures win over outstanding history I/O. No focus/store event
        // is interpreted as a request to return to the tail.
        const element = event.target as Element | null
        if (!event.isTrusted || !element?.closest?.('[data-conversation-scroll]')
            || element.closest('input,textarea,[contenteditable="true"],[data-composer-card]')) return
        if (event.type === 'keydown' && keyIntent((event as KeyboardEvent).key, event as KeyboardEvent) === 'none') return
        readerOwned = true
        readerMoving = true
        if (event.type === 'touchstart') touchHeld = true
        if (event.type === 'pointerdown' && (event as PointerEvent).pointerType !== 'touch') pointerHeld = true
        pending?.abort(); pending = undefined
        if (request && !(request.recovery && request.phase === 'waiting')) request.phase = 'reader'
        if (root.dataset.hapiReading !== 'reader') root.dataset.hapiReading = 'reader'
        deferSettlement()
        scheduleSample()
    }
    const settleReader = (): void => {
        if (touchHeld || pointerHeld || !readerMoving || disposed) return
        const moved = readerScrolled
        readerMoving = false; readerScrolled = false
        if (settleTimer !== undefined) window.clearTimeout(settleTimer)
        settleTimer = undefined
        if (request?.recovery && request.phase === 'waiting') {
            // The reader may have travelled since replace arrived. Prefer the
            // settled visible position, but retain the old bookmark when the
            // replacement removed that history and it must be loaded again.
            if (moved && (!request.reload || findChatElement(root, request.reload.key))) {
                const current = readAnchor(), port = root.querySelector<HTMLElement>('[data-conversation-scroll]')
                if (!current && port && port.scrollHeight - port.clientHeight - port.scrollTop < 4) {
                    // Reaching the tail is also a reading decision. Do not pull
                    // the reader back to an earlier bookmark still in the DOM.
                    request.phase = 'reader'; request.reload = undefined; retainedAnchor = undefined
                } else request.reload = current ?? request.reload
            }
            update()
        }
        scheduleSample()
    }
    const deferSettlement = (): void => {
        if (settleTimer !== undefined) window.clearTimeout(settleTimer)
        settleTimer = undefined
        if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
        settleFrame = undefined
        if (touchHeld || pointerHeld || !readerMoving) return
        const port = root.querySelector<HTMLElement>('[data-conversation-scroll]')
        // touchend/pointercancel are not the end of native inertial scrolling.
        // A short no-scroll grace handles taps and late first compositor events;
        // older browsers extend this fallback on every outer scroll instead.
        if (readerScrolled && port && 'onscrollend' in port) return
        settleTimer = window.setTimeout(settleReader, 180)
    }
    const releaseReader = (event: Event): void => {
        if (!event.isTrusted) return
        if (event.type === 'touchend' || event.type === 'touchcancel') touchHeld = (event as TouchEvent).touches.length > 0
        else if ((event as PointerEvent).pointerType !== 'touch') pointerHeld = false
        deferSettlement()
    }
    const scroll = (event: Event): void => {
        if (event.target === root.querySelector('[data-conversation-scroll]') && readerMoving) {
            readerScrolled = true
            deferSettlement()
        }
        scheduleSample()
    }
    const scrollend = (event: Event): void => {
        if (!readerMoving || event.target !== root.querySelector('[data-conversation-scroll]')) return
        if (settleTimer !== undefined) window.clearTimeout(settleTimer)
        settleTimer = undefined
        if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
        // This listener runs in capture. Let the official scrollend listeners
        // publish their final reading state before our implicit recovery starts.
        settleFrame = window.requestAnimationFrame(() => { settleFrame = undefined; settleReader() })
    }
    const readAnchor = (): ReloadReadingAnchor | undefined => {
        if (!ready || !visible()) return undefined
        const port = root.querySelector<HTMLElement>('[data-conversation-scroll]')
        if (!port || port.closest('[data-chat-following-tail]') || port.querySelector('[data-chat-following-tail]')
            || port.scrollHeight - port.clientHeight - port.scrollTop < 4) return undefined
        const viewport = port.getBoundingClientRect(), top = viewport.top
        const snapshot = ctx.uiConversation.binding(reference.binding).target('chat').getSnapshot()
        for (const element of readingCandidates(port)) {
            const box = element.getBoundingClientRect(), nodeKey = element.dataset.chatNodeKey
            if (!nodeKey || box.bottom <= top || box.top >= viewport.bottom || box.height === 0
                || element.closest('[hidden], [data-hapi-visible="false"]')) continue
            const node = snapshot?.nodes.get(nodeKey)
            if (!node) continue
            // Live chunk anchors can sit fractionally between durable seqs;
            // loadThrough accepts the durable predecessor, never that fraction.
            // A mixed Assistant can have separate reasoning/response seats.
            // Retain its public flow anchor, not their shared node identity.
            const seq = Math.max(0, Math.floor(node.anchorSeq))
            return { key: element.dataset.chatAnchorKey ?? nodeKey, seq, offset: box.top - top, displayId: reference.sessionId, ...(sourceAnchors.has(seq) ? { sourceMessageId: sourceAnchors.get(seq)! } : {}) }
        }
    }
    const scheduleSample = (): void => {
        if (disposed || sampleFrame !== undefined) return
        sampleFrame = window.requestAnimationFrame(() => {
            sampleFrame = undefined
            if (ready && visible() && !pending && !reference.binding.session.getSnapshot().loadingOlder
                && request?.phase !== 'waiting' && request?.phase !== 'error') {
                retainedAnchor = readAnchor()
                if (anchorTimer !== undefined) window.clearTimeout(anchorTimer)
                const anchor = retainedAnchor
                if (!anchor) { try { window.sessionStorage.removeItem(storageKey) } catch { /* optional bookmark */ } }
                if (anchor?.sourceMessageId) { try { window.sessionStorage.setItem(storageKey, JSON.stringify(anchor)) } catch { /* optional bookmark */ } }
                if (native && anchor && !anchor.sourceMessageId) anchorTimer = window.setTimeout(() => {
                    anchorTimer = undefined
                    const service = ctx.get('hapiMessageNavigation')
                    if (!service) return
                    const version = bodyVersion
                    void service.sourceAnchor(reference.sessionId, anchor.seq).then(id => {
                        if (!id || disposed || retainedAnchor?.seq !== anchor.seq
                            || version?.historyId !== bodyVersion?.historyId || version?.historyVersion !== bodyVersion?.historyVersion) return
                        if (sourceAnchors.size >= 32) sourceAnchors.clear()
                        sourceAnchors.set(anchor.seq, id)
                        retainedAnchor = { ...retainedAnchor, sourceMessageId: id }
                        try { window.sessionStorage.setItem(storageKey, JSON.stringify(retainedAnchor)) } catch { /* optional bookmark */ }
                    }).catch(() => {})
                }, 250)
            }
        })
    }
    const recoverReading = (): void => {
        if (disposed || !ready) return
        const exact = request?.intent?.target.kind !== undefined && request.intent.target.kind !== 'latest' && !readerOwned
        if (!retainedAnchor && !exact) return
        pending?.abort(); pending = undefined
        request = { intent: source?.getSnapshot(), ...(retainedAnchor ? { reload: retainedAnchor } : {}), phase: 'waiting', recovery: true }
        update()
    }
    const sourceWindowChanged = (): void => {
        const next = sourceWindow!.getSnapshot(), previous = bodyVersion
        bodyVersion = next
        // HAPI publishes window metadata after its body commit. Only a new
        // source history identity/version invalidates this reader's window;
        // paging and same-item revisions can also use the public replace API.
        if (previous?.historyId !== undefined && next.historyId !== undefined && previous.historyId !== next.historyId
            || previous?.historyVersion !== undefined && next.historyVersion !== undefined && previous.historyVersion !== next.historyVersion) {
            if (anchorTimer !== undefined) window.clearTimeout(anchorTimer)
            anchorTimer = undefined
            sourceAnchors.clear()
            recoverReading()
        }
    }
    const eventWindowChanged = (): void => {
        const next = reference.binding.eventSource.getSnapshot()
        if (disposed || next.revision === eventRevision) return
        eventRevision = next.revision
        if (sourceWindow || !ready || next.change.kind !== 'replace') { scheduleSample(); return }
        // Ordinary DSH Session replacement still carries its reconnect signal.
        recoverReading()
    }
    const remember = (): void => {
        const anchor = readAnchor() ?? retainedAnchor
        try { if (anchor) window.sessionStorage.setItem(storageKey, JSON.stringify(anchor)); else window.sessionStorage.removeItem(storageKey) } catch { /* optional anchor persistence */ }
    }
    const stops = [navigation.state.subscribe(update), reference.binding.eventSource.subscribe(eventWindowChanged),
        ...(sourceWindow ? [sourceWindow.subscribe(sourceWindowChanged)] : []), ...(source ? [source.subscribe(update)] : [])]
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const event of events) root.addEventListener(event, reader, { capture: true, passive: true })
    root.addEventListener('click', officialNavigation, { capture: true })
    root.addEventListener('scroll', scroll, { capture: true, passive: true })
    root.addEventListener('scrollend', scrollend, { capture: true, passive: true })
    for (const event of ['touchend', 'touchcancel']) root.addEventListener(event, releaseReader, { capture: true, passive: true })
    for (const event of ['pointerup', 'pointercancel']) window.addEventListener(event, releaseReader, { capture: true, passive: true })
    window.addEventListener('pagehide', remember)
    void reference.ready.then(() => { if (!disposed) { ready = true; update() } }, () => {})
    return () => {
        cancelLatestNavigation(root)
        remember(); disposed = true; pending?.abort(); clearFailure()
        if (anchorTimer !== undefined) window.clearTimeout(anchorTimer)
        if (sampleFrame !== undefined) window.cancelAnimationFrame(sampleFrame)
        if (settleTimer !== undefined) window.clearTimeout(settleTimer)
        if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
        for (const stop of stops) stop()
        for (const event of events) root.removeEventListener(event, reader, { capture: true })
        root.removeEventListener('click', officialNavigation, { capture: true })
        root.removeEventListener('scroll', scroll, { capture: true })
        root.removeEventListener('scrollend', scrollend, { capture: true })
        for (const event of ['touchend', 'touchcancel']) root.removeEventListener(event, releaseReader, { capture: true })
        for (const event of ['pointerup', 'pointercancel']) window.removeEventListener(event, releaseReader, { capture: true })
        window.removeEventListener('pagehide', remember)
        delete root.dataset.hapiReading
    }
}
