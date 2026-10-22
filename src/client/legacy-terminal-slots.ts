/** Follow the public official terminal leaf without copying its child/store
 * ownership. Registrations remain effects of the calling Cordis plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

type LegacySlotName = 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title'

// The pinned public FiberState declares UNLOADING = 5 as a const enum, with
// no runtime enum export. A retiring owner cannot acquire another effect.
const UNLOADING = 5

export function followLegacyTerminalSeat<Injected>(ctx: Context, name: LegacySlotName, sourceKey: string, key: string,
    inject: (entry: StoredEntry, sessionId: SessionId) => Injected, component: (entry: StoredEntry) => unknown): () => void {
    let current: StoredEntry | undefined, remove: (() => void) | undefined, updating = false, stopped = false
    let unsubscribe = (): void => {}
    const retired = (): boolean => ctx.fiber.uid === null || ctx.fiber.state === UNLOADING
    const stop = (): void => {
        if (stopped) return
        stopped = true
        unsubscribe()
        const dispose = remove; remove = undefined; current = undefined
        dispose?.()
    }
    const update = (): void => {
        if (updating || stopped) return
        // Slot changes are microtask-batched. Cordis marks the owner retired
        // before its asynchronous unload reaches this subscription's cleanup.
        if (retired()) { stop(); return }
        const entry = ctx.slots.entriesOfSlot(name).find(value => value.options.key === sourceKey)
        if (entry === current) return
        updating = true
        try {
            const previous = remove; remove = undefined; current = entry; previous?.()
            if (stopped || retired()) { stop(); return }
            // A leaf can be composed through its public face. Child/store
            // ownership cannot be transferred by copying an entry.
            if (!entry || entry.children || entry.store) return
            const slots = ctx.slots as unknown as {
                register(options: { name: LegacySlotName; key: string; locale?: string; inject(sessionId: SessionId): Injected }, component: unknown): () => void
            }
            const body = component(entry)
            if (stopped || retired()) { stop(); return }
            // Keep the service receiver: Cordis binds this.ctx to the caller's
            // plugin so registration and unload use that plugin's lifetime.
            const next = slots.register({ name, key, ...(entry.locale ? { locale: entry.locale } : {}), inject: sessionId => inject(entry, sessionId) }, body)
            if (stopped || retired()) { next(); stop() }
            else remove = next
        } finally { updating = false }
    }
    unsubscribe = ctx.slots.subscribe(name, update)
    try { update() } catch (error) { stop(); throw error }
    return stop
}
