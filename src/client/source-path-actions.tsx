/** Source paths must never be handed to the serving DSH Host's desktop. */
import { createElement, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleNamespaceMap, PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Shortcuts, ShortcutFixedInput } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import type { WorkbenchSource } from '../workbench-types.ts'
import { isSourceDisplayId } from '../shared/source-display-id.ts'
import { errorMessage } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'

const actionSlots = {
    'conversation.session.header.utilities': 'directory',
    'sidebar.right.tab.files.actions': 'directory',
    'sidebar.right.tab.document.actions': 'document',
    'sidebar.right.tab.document.unpreviewable': 'document',
    'deliverables.file.actions': 'delivery',
    'deliverables.review.file.actions': 'delivery',
} as const
type ActionSlot = keyof typeof actionSlots
type ActionKind = typeof actionSlots[ActionSlot]
type ActionProps = PropsRuntime<'conversation.session.header.utilities'> & { absolutePath?: string }
type ActionComponent = (props: ActionProps) => ReactNode
type DownloadApi = Pick<HapiRemoteApi, 'nativeDocument'>

/** The explicit projection owns the source address, including child read views. */
export function sourcePathAddress(value: unknown): WorkbenchSource | null {
    if (!value || typeof value !== 'object'
        || !(Reflect.get(value, 'engine') === 'codex' || Reflect.get(value, 'ownership') === 'hapi-runner')) return null
    const sessionId: unknown = Reflect.get(value, 'hapiSessionId'), hubId: unknown = Reflect.get(value, 'hubId'), machineId: unknown = Reflect.get(value, 'machineId')
    if (typeof sessionId !== 'string' || !sessionId || typeof hubId !== 'string' || !hubId) return null
    return { sourceSessionId: sessionId, sourceHubId: hubId, ...(typeof machineId === 'string' && machineId ? { machineId } : {}) }
}

/** Resolve through the source-aware API and download its authenticated bytes. */
export async function downloadSourceFile(api: DownloadApi, source: WorkbenchSource, path: string, origin: string,
    fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ blob: Blob; fileName: string }> {
    signal?.throwIfAborted()
    const document = remoteValue(await api.nativeDocument({ source, document: { kind: 'file', path, ...(source.machineId ? { machineId: source.machineId } : {}) } }))
    signal?.throwIfAborted()
    const address = new URL(document.downloadUrl, origin)
    if (address.origin !== new URL(origin).origin || !['http:', 'https:'].includes(address.protocol)) throw new Error('The source download must use this authenticated Host')
    const response = await fetcher(address.href, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...(signal ? { signal } : {}) })
    if (!response.ok) throw new Error(`Source download failed (${response.status})`)
    return { blob: await response.blob(), fileName: document.fileName }
}

function SourceDownload({ api, source, path, t }: { api: DownloadApi; source: WorkbenchSource; path: string; t: WorkspaceTranslate }) {
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
    const active = useRef<AbortController | null>(null)
    useEffect(() => {
        active.current = null; setBusy(false); setError(null)
        return () => { active.current?.abort(); active.current = null }
    }, [path, source.sourceSessionId, source.sourceHubId])
    const download = async (): Promise<void> => {
        if (active.current) return
        const abort = new AbortController(); active.current = abort; setBusy(true); setError(null)
        try {
            const result = await downloadSourceFile(api, source, path, location.href, fetch, abort.signal)
            abort.signal.throwIfAborted()
            const link = document.createElement('a'), url = URL.createObjectURL(result.blob)
            link.href = url; link.download = result.fileName; link.click()
            setTimeout(() => { URL.revokeObjectURL(url) }, 30_000)
        } catch (error) { if (!abort.signal.aborted) setError(errorMessage(error)) }
        finally { if (active.current === abort) { active.current = null; if (!abort.signal.aborted) setBusy(false) } }
    }
    return <span className="hapi-source-download"><button type="button" disabled={busy} title={t('sourcePathHelp')} onClick={() => { void download() }}>{busy ? t('sourceDownloading') : t('sourceDownload')}</button>
        {error && <span className="hapi-error" role="alert">{error}</span>}</span>
}

/** Preserve the original renderer and injected face for every ordinary DSH session. */
export function guardedPathAction(Official: ComponentType<ActionProps>, kind: ActionKind, api: DownloadApi, t: WorkspaceTranslate): ActionComponent {
    return function SourceAwarePathAction(props) {
        const liveNative = props.useProjection('hapi'), liveObserved = props.useProjection('hapiObserved')
        const catalog = props.useSessions(state => state.byId[props.sessionId])
        // The retained Session's projection can hydrate after its catalog row.
        // Source ownership is already explicit in that public row; do not
        // briefly mount a serving-Host opener while the Session is opening.
        const native = liveNative ?? catalog?.projectionValues?.hapi
        const observed = liveObserved ?? catalog?.projectionValues?.hapiObserved
        const source = sourcePathAddress(native ?? observed)
        // Catalog and retained projections may both be empty while an existing
        // display generation rehydrates. Our own reserved source namespace is
        // sufficient to refuse a serving-Host opener during that interval; it
        // is deliberately insufficient to manufacture a source download URL.
        if (!native && !observed) return catalog && !isSourceDisplayId(props.sessionId) ? createElement(Official, props) : null
        // Delivery slots carry event coordinates, not a file path. Their normal
        // Sidebar preview remains available; never reinterpret those coordinates.
        return source && kind === 'document' && props.absolutePath
            ? <SourceDownload api={api} source={source} path={props.absolutePath} t={t}/>
            : null
    }
}

export function sourceOpenShortcutMatches(shortcuts: Pick<Shortcuts, 'catalog' | 'config'>, input: ShortcutFixedInput): boolean {
    if (input.type === 'reset') return false
    const { gesture, context } = input
    if (gesture.composing || gesture.defaultPrevented || context.modal !== null || context.region === 'terminal'
        || shortcuts.config.getSnapshot().status === 'loading') return false
    const command = shortcuts.catalog.getSnapshot().find(row => row.id === 'workspace.openLocal'), binding = command?.binding
    if (!binding || command.issue !== null || command.conflicts.length) return false
    const codes = binding.secondCode ? [binding.code, binding.secondCode].sort() : [binding.code]
    const pressed = gesture.secondCode ? [gesture.code, gesture.secondCode].sort() : [gesture.code]
    return codes.length === pressed.length && codes.every((code, index) => code === pressed[index])
        && (['control', 'alt', 'shift', 'meta'] as const).every(modifier => gesture[modifier] === binding.modifiers.includes(modifier))
}

/** Public list-cell shadowing, automatically following official plugin reloads. */
export function installSourcePathActions(ctx: Context, api: DownloadApi): () => void {
    const disposers: Array<() => void> = []
    for (const name of Object.keys(actionSlots) as ActionSlot[]) {
        disposers.push(ctx.slots.inject(name, () => {
            let original: StoredEntry | undefined, wrapped: ActionComponent | undefined, remove: (() => void) | undefined
            let updating = false
            const update = (): void => {
                if (updating) return
                const entry = ctx.slots.entries(name).find(candidate => candidate.options.id === 'open-in-app' && candidate.component !== wrapped)
                if (entry === original) return
                updating = true
                try {
                    remove?.(); remove = undefined; original = entry
                    // The pinned opening controls own no subtree or private store.
                    // A replacement with a different contract remains its owner's.
                    if (!entry || entry.children || entry.store) return
                    wrapped = guardedPathAction(entry.component as ComponentType<ActionProps>, actionSlots[name], api, ctx.locale.bind('hapiWorkspace'))
                    const inject = entry.inject as ((sessionId: SessionId) => Record<string, unknown>) | undefined
                    remove = ctx.slots.register({ name, id: 'open-in-app', order: entry.options.order ?? 0, priority: (entry.options.priority ?? 0) - 1,
                        ...(entry.locale ? { locale: entry.locale as keyof LocaleNamespaceMap } : {}),
                        inject: (sessionId: SessionId) => inject?.(sessionId) ?? {},
                    }, wrapped)
                } finally { updating = false }
            }
            const unsubscribe = ctx.slots.subscribe(name, update)
            update()
            return () => { unsubscribe(); remove?.() }
        }))
    }
    // The pinned Web shortcut selects the retained mainView, not a path-bearing
    // event. Consume only its real configured gesture while that view is source-owned.
    disposers.push(ctx.shortcuts.observeFixedInput(input => {
        if (input.type === 'reset' || !sourceOpenShortcutMatches(ctx.shortcuts, input) || ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return
        const selected = Object.values(ctx.sessions.list.getSnapshot().byId).find(row => (row.retainedBy.mainView ?? 0) > 0)
        if (selected && (isSourceDisplayId(selected.id) || selected.projectionValues?.hapi || selected.projectionValues?.hapiObserved)) input.consume()
    }))
    return () => { for (const dispose of disposers.reverse()) dispose() }
}
