import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { WorkspacePaneNavigation } from './pane-navigation.ts'
import type { PaneReadingIntent } from './reading-intent.ts'
import { messageNodeTarget, parseReloadReadingAnchor, placeReadingAnchor, revealChatElement, type ReloadReadingAnchor } from './reading-anchor.ts'
import { keyIntent } from './seamless/intent.ts'
import type {} from './source-navigation.ts'

/** Per-occurrence destination lifetime. Live/history/focus never request latest. */
export function bindPaneReading(ctx: Context, root: HTMLElement, reference: SessionReference, navigation: WorkspacePaneNavigation): () => void {
    const window = root.ownerDocument.defaultView
    if (!window) return () => {}
    const source = navigation.reading
    type ReadingRequest = { intent: PaneReadingIntent | undefined; reload?: ReloadReadingAnchor | undefined;
        phase: 'waiting' | 'running' | 'done' | 'error' | 'reader'; error?: unknown }
    let disposed = false, ready = false, observed = false, observedIntent: PaneReadingIntent | undefined
    let request: ReadingRequest | undefined
    let pending: AbortController | undefined
    let failure: HTMLElement | undefined
    let retainedAnchor: ReloadReadingAnchor | undefined, readerOwned = false
    let sampleFrame: number | undefined
    let eventRevision = reference.binding.eventSource.getSnapshot().revision
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

    const waitFor = <T,>(read: () => T | undefined, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
        const finish = (value?: T, error?: unknown): void => {
            observer.disconnect(); window.clearTimeout(timer); signal.removeEventListener('abort', abort)
            if (error) reject(error); else resolve(value!)
        }
        const check = (): void => { const value = read(); if (value !== undefined) finish(value) }
        const abort = (): void => finish(undefined, signal.reason ?? new Error('Navigation cancelled'))
        const observer = new MutationObserver(check)
        const timer = window.setTimeout(() => finish(undefined, new Error('The conversation target is not visible yet. Retry after loading finishes.')), 5000)
        observer.observe(root.closest('.hapi-pane') ?? root, { childList: true, subtree: true, attributes: true })
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
                const scope = target.kind === 'delivery' ? root.closest('.hapi-pane') ?? root : root
                const row = await waitFor(() => [...scope.querySelectorAll<HTMLElement>(selector)]
                    .find(element => target.kind === 'approval' ? element.dataset.hapiRequestId === target.requestId : element.dataset.hapiDeliveryId === target.localId), signal)
                for (let ancestor = row.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
                    if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true
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
                    await reference.binding.session.loadThrough(located.seq); signal.throwIfAborted()
                    key = messageNodeTarget(ctx.uiConversation.binding(reference.binding).target('chat').getSnapshot(), seq)?.key ?? key
                }
                await reference.binding.session.loadThrough(seq as SessionSeq); signal.throwIfAborted()
                const clicked = new WeakSet<HTMLElement>()
                const row = await waitFor(() => revealChatElement(root, { key, kind: 'message' }, clicked), signal)
                placeReadingAnchor(scrollport, row, reload.offset)
            } else if (target?.kind === 'latest') {
                // Activate the official return-to-bottom action when paused;
                // this keeps future live following under the original owner.
                const label = ctx.locale.bind('chat')('chat.toBottom')
                const button = [...root.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(button => button.getAttribute('aria-label') === label)
                if (button) button.click()
                else scrollport.scrollTop = scrollport.scrollHeight
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
            pending?.abort(); pending = undefined; clearFailure()
            retainedAnchor = undefined; readerOwned = false
            const reload = !next || next.target.kind === 'latest' ? restored : undefined
            request = next || reload ? { intent: next, reload, phase: 'waiting' } : undefined
            restored = undefined
        }
        if (!visible()) {
            if (pending && !pending.signal.aborted) {
                pending.abort(); pending = undefined
                if (request?.phase === 'running') request.phase = 'waiting'
            }
            clearFailure(); return
        }
        if (request?.phase === 'waiting') void apply(request)
        else if (request?.phase === 'error' && !failure) {
            const current = request
            showFailure(current.error, () => retry(current))
        }
    }
    const reader = (event: Event): void => {
        // Real gestures win over outstanding history I/O. No focus/store event
        // is interpreted as a request to return to the tail.
        const element = event.target as Element | null
        if (!event.isTrusted || !element?.closest?.('[data-conversation-scroll]')
            || element.closest('input,textarea,[contenteditable="true"],[data-composer-card]')) return
        if (event.type === 'keydown' && keyIntent((event as KeyboardEvent).key, event as KeyboardEvent) === 'none') return
        readerOwned = true
        pending?.abort(); pending = undefined
        if (request) request.phase = 'reader'
        root.dataset.hapiReading = 'reader'
        scheduleSample()
    }
    const readAnchor = (): ReloadReadingAnchor | undefined => {
        if (!ready || !visible()) return undefined
        const port = root.querySelector<HTMLElement>('[data-conversation-scroll]')
        if (!port || port.scrollHeight - port.clientHeight - port.scrollTop < 4) return undefined
        const viewport = port.getBoundingClientRect(), top = viewport.top
        const snapshot = ctx.uiConversation.binding(reference.binding).target('chat').getSnapshot()
        for (const element of port.querySelectorAll<HTMLElement>('[data-chat-node-key]')) {
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
            if (ready && visible() && !pending && request?.phase !== 'waiting' && request?.phase !== 'error') {
                retainedAnchor = readAnchor()
                if (anchorTimer !== undefined) window.clearTimeout(anchorTimer)
                const anchor = retainedAnchor
                if (!anchor) { try { window.sessionStorage.removeItem(storageKey) } catch { /* optional bookmark */ } }
                if (anchor?.sourceMessageId) { try { window.sessionStorage.setItem(storageKey, JSON.stringify(anchor)) } catch { /* optional bookmark */ } }
                if (native && anchor && !anchor.sourceMessageId) anchorTimer = window.setTimeout(() => {
                    anchorTimer = undefined
                    const service = ctx.get('hapiMessageNavigation')
                    if (!service) return
                    void service.sourceAnchor(reference.sessionId, anchor.seq).then(id => {
                        if (!id || disposed || retainedAnchor?.seq !== anchor.seq) return
                        if (sourceAnchors.size >= 32) sourceAnchors.clear()
                        sourceAnchors.set(anchor.seq, id)
                        retainedAnchor = { ...retainedAnchor, sourceMessageId: id }
                        try { window.sessionStorage.setItem(storageKey, JSON.stringify(retainedAnchor)) } catch { /* optional bookmark */ }
                    }).catch(() => {})
                }, 250)
            }
        })
    }
    const eventWindowChanged = (): void => {
        const next = reference.binding.eventSource.getSnapshot()
        if (disposed || next.revision === eventRevision) return
        eventRevision = next.revision
        if (!ready || next.change.kind !== 'replace') { scheduleSample(); return }
        // A public Session stream reconnect/rebaseline replaces its retained
        // tail page. Recover this occurrence's last reading anchor, not the
        // default latest landing. Append/prepend/assistant settlement never
        // manufacture a new navigation request.
        const exact = request?.intent?.target.kind !== undefined && request.intent.target.kind !== 'latest' && !readerOwned
        if (!retainedAnchor && !exact) return
        pending?.abort(); pending = undefined
        request = { intent: source?.getSnapshot(), ...(retainedAnchor ? { reload: retainedAnchor } : {}), phase: 'waiting' }
        update()
    }
    const remember = (): void => {
        const anchor = readAnchor() ?? retainedAnchor
        try { if (anchor) window.sessionStorage.setItem(storageKey, JSON.stringify(anchor)); else window.sessionStorage.removeItem(storageKey) } catch { /* optional anchor persistence */ }
    }
    const stops = [navigation.state.subscribe(update), reference.binding.eventSource.subscribe(eventWindowChanged), ...(source ? [source.subscribe(update)] : [])]
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const event of events) root.addEventListener(event, reader, { capture: true, passive: true })
    root.addEventListener('scroll', scheduleSample, { capture: true, passive: true })
    window.addEventListener('pagehide', remember)
    void reference.ready.then(() => { if (!disposed) { ready = true; update() } }, () => {})
    return () => {
        remember(); disposed = true; pending?.abort(); clearFailure()
        if (anchorTimer !== undefined) window.clearTimeout(anchorTimer)
        if (sampleFrame !== undefined) window.cancelAnimationFrame(sampleFrame)
        for (const stop of stops) stop()
        for (const event of events) root.removeEventListener(event, reader, { capture: true })
        root.removeEventListener('scroll', scheduleSample, { capture: true })
        window.removeEventListener('pagehide', remember)
        delete root.dataset.hapiReading
    }
}
