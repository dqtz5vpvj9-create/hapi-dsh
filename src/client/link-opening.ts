import type { WorkspaceUiPreferences } from './ui-preferences.ts'

export type WorkspaceLinkOpening = 'same-tab' | 'new-tab' | 'dsh'
/** Original HAPI key/default; the explicit DSH option preserves its own link providers. */
export function readWorkspaceLinkOpening(preferences: WorkspaceUiPreferences): WorkspaceLinkOpening {
    if (preferences.getItem('hapi-dsh-link-opening') === 'dsh') return 'dsh'
    return preferences.getItem('hapi-open-external-links-in-new-tab') === 'true' ? 'new-tab' : 'same-tab'
}

export interface LinkActivation {
    href: string | null; target?: string | null; download?: boolean; native?: boolean
    button: number; defaultPrevented: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean
}
/** Only ordinary explicit HTTP(S) anchors participate. Browser modifier gestures
 * and a plugin's explicit native navigation stay with that anchor's owner. */
export function workspaceExternalHref(event: LinkActivation): string | null {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
        || event.download || event.native || !event.href || !/^https?:/i.test(event.href)) return null
    if (event.target && event.target !== '_blank' && event.target !== '_self') return null
    try { const url = new URL(event.href); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null }
    catch { return null }
}

export type LinkNavigationState = { phase: 'idle' | 'saving' | 'failed'; error: string | null }
const idle: LinkNavigationState = Object.freeze({ phase: 'idle', error: null })

/** A same-tab departure is gated by the existing draft persistence contract.
 * Cancellation invalidates the intent, never cancels the underlying save. */
export class WorkspaceLinkNavigation {
    private epoch = 0
    private disposed = false
    private state = idle
    private listeners = new Set<() => void>()
    constructor(private readonly actions: { prepare(): Promise<void>; assign(href: string): void; open(href: string): void }) {}
    getSnapshot = (): LinkNavigationState => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(next: LinkNavigationState): void { this.state = next; for (const listener of this.listeners) listener() }
    open(href: string, mode: Exclude<WorkspaceLinkOpening, 'dsh'>): void {
        if (this.disposed) return
        const intent = ++this.epoch
        if (mode === 'new-tab') { this.publish(idle); this.actions.open(href); return }
        this.publish({ phase: 'saving', error: null })
        void Promise.resolve().then(() => this.actions.prepare()).then(() => {
            if (this.disposed || intent !== this.epoch) return
            this.actions.assign(href)
            this.publish(idle)
        }).catch(error => {
            if (!this.disposed && intent === this.epoch) this.publish({ phase: 'failed', error: error instanceof Error ? error.message : String(error) })
        })
    }
    cancel = (): void => { ++this.epoch; this.publish(idle) }
    dispose(): void { this.disposed = true; ++this.epoch; this.listeners.clear() }
}
