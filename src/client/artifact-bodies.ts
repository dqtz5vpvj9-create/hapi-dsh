/** Reuse inspected official document registrations without taking ownership of their stores. */
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export const DOCUMENT_PREFIX = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/'
const BODY_IDS = new Set([`${DOCUMENT_PREFIX}pdf`, `${DOCUMENT_PREFIX}text`, `${DOCUMENT_PREFIX}html`])
const staticHtml = { getSnapshot: () => false, subscribe: () => () => {} }

/**
 * StoredEntry is the public typed-erasure boundary. Its original registration
 * already proved component/store/inject compatibility. Share the exact handle,
 * never invoke a private store factory or take another owner's child slots.
 */
export function borrowArtifactBodies(ctx: Pick<Context, 'slots'>): () => void {
    const installed = new Map<string, { entry: StoredEntry; remove(): void }>()
    const register = ctx.slots.register.bind(ctx.slots) as (options: {
        name: 'hapi.artifact.document'; key: string; locale?: string; store?: StoredEntry['store']; inject?: StoredEntry['inject']
    }, component: unknown) => () => void
    const reconcile = (): void => {
        const entries = new Map(ctx.slots.entriesOfSlot('sidebar.right.tab.document')
            .filter(entry => BODY_IDS.has(entry.options.key ?? '') && !entry.children && typeof entry.store !== 'function')
            .map(entry => [entry.options.key!, entry] as const))
        for (const [key, value] of installed) if (entries.get(key) !== value.entry) { value.remove(); installed.delete(key) }
        for (const [key, entry] of entries) {
            if (installed.has(key)) continue
            let inject = entry.inject
            if (key === `${DOCUMENT_PREFIX}html`) {
                // Opaque artifacts have no filesystem dependency base. The
                // unchanged official static mode never reads a guessed path.
                const original = inject
                inject = (...args: never[]) => ({ ...(original?.(...args) ?? {}), hooks: { interactivePreview: staticHtml } })
            }
            const remove = register({ name: 'hapi.artifact.document', key,
                ...(entry.locale ? { locale: entry.locale } : {}), ...(entry.store ? { store: entry.store } : {}), ...(inject ? { inject } : {}),
            }, entry.component)
            installed.set(key, { entry, remove })
        }
    }
    const stop = ctx.slots.subscribe('sidebar.right.tab.document', reconcile)
    reconcile()
    return () => { stop(); for (const value of installed.values()) value.remove(); installed.clear() }
}
