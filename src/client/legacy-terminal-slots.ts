/** Follow the public official terminal leaf without copying its child/store
 * ownership. Registrations remain effects of the calling Cordis plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

type LegacySlotName = 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title'

export function followLegacyTerminalSeat<Injected>(ctx: Context, name: LegacySlotName, sourceKey: string, key: string,
    inject: (entry: StoredEntry, sessionId: SessionId) => Injected, component: (entry: StoredEntry) => unknown): () => void {
    let current: StoredEntry | undefined, remove: (() => void) | undefined, updating = false
    const update = (): void => {
        if (updating) return
        const entry = ctx.slots.entriesOfSlot(name).find(value => value.options.key === sourceKey)
        if (entry === current) return
        updating = true
        try {
            remove?.(); remove = undefined; current = entry
            // A leaf can be composed through its public face. Child/store
            // ownership cannot be transferred by copying an entry.
            if (!entry || entry.children || entry.store) return
            const slots = ctx.slots as unknown as {
                register(options: { name: LegacySlotName; key: string; locale?: string; inject(sessionId: SessionId): Injected }, component: unknown): () => void
            }
            // Keep the service receiver: Cordis binds this.ctx to the caller's
            // plugin so registration and unload use that plugin's lifetime.
            remove = slots.register({ name, key, ...(entry.locale ? { locale: entry.locale } : {}), inject: sessionId => inject(entry, sessionId) }, component(entry))
        } finally { updating = false }
    }
    const stop = ctx.slots.subscribe(name, update); update()
    return () => { stop(); remove?.() }
}
