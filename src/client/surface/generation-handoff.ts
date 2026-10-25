import type { PaneResource } from '../model.ts'
import { isSourceDisplaySessionId } from '../catalog-readiness.ts'

type Resource = Exclude<PaneResource, { kind: 'empty' }>
const conversation = (resource: Resource): boolean => resource.kind === 'chat' || resource.kind === 'view' && resource.target.type === 'conversation'

/** Only a new display of this exact source may temporarily reuse its old view. */
export function sameSourceGeneration(before: Resource | undefined, after: Resource | undefined): boolean {
    if (!before || !after || !conversation(before) || !conversation(after)
        || !before.sourceHubId || !before.sourceSessionId || before.sourceHubId !== after.sourceHubId
        || before.sourceSessionId !== after.sourceSessionId || before.sessionId === after.sessionId) return false
    const displayId = before.sessionId.slice(before.sessionId.lastIndexOf(':') + 1)
    return isSourceDisplaySessionId(displayId)
        && before.sessionId.replace(/-r\d+$/, '') === after.sessionId.replace(/-r\d+$/, '')
}

/** Suspending saves and stops the old reader. A layout rollback must mount a
 * fresh occurrence, not expose that retired reader/editor again. */
export function canReuseGenerationSurface(displayId: string, desiredId: string, suspended: boolean): boolean {
    return !suspended || desiredId !== displayId
}

export interface ReplacementReadiness {
    referenceReady: boolean
    open: boolean
    blank: boolean
    content: boolean
    editor: boolean
    reading: string | undefined
}

/** A resolved reference alone may still expose loading history and defaults. */
export function replacementReady(state: ReplacementReadiness): boolean {
    return state.referenceReady && state.open && (state.blank || state.content) && state.editor
        && state.reading !== 'loading' && state.reading !== 'error'
}

/** Stage the actual official surface at its final size. A ready predecessor
 * remains on screen, but is inert because its backend may already be retired. */
export function stageGenerationSurface(options: {
    previous: HTMLElement
    next: HTMLElement
    ready(): boolean
    commit(): void
    timeout(): void
}): () => void {
    const { previous, next } = options
    const window = next.ownerDocument.defaultView!
    let stopped = false, frame: number | undefined
    previous.inert = true; previous.dataset.hapiHandoff = 'previous'
    next.inert = true; next.dataset.hapiHandoff = 'preparing'
    Object.assign(next.style, { position: 'absolute', inset: '0', opacity: '0', pointerEvents: 'none' })
    const stop = (): void => {
        if (stopped) return
        stopped = true; observer.disconnect(); window.clearTimeout(timer)
        if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
    const check = (): void => {
        if (stopped || frame !== undefined) return
        frame = window.requestAnimationFrame(() => {
            frame = undefined
            if (options.ready()) { stop(); options.commit() }
        })
    }
    const observer = new MutationObserver(check)
    observer.observe(next, { childList: true, subtree: true, attributes: true })
    // A broken successor must not retain an extra history/reference forever.
    const timer = window.setTimeout(() => { stop(); options.timeout() }, 30_000)
    check()
    return stop
}

export function revealGenerationSurface(surface: HTMLElement): void {
    surface.inert = false; delete surface.dataset.hapiHandoff
    for (const name of ['position', 'inset', 'opacity', 'pointer-events']) surface.style.removeProperty(name)
}
