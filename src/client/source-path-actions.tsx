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
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchSource } from '../workbench-types.ts'
import { isSourceDisplayId } from '../shared/source-display-id.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
import { sourceFileAccess, type SourceFileClient } from './source-workspace-provider.ts'
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
type DownloadApi = SourceFileClient

/** The explicit projection owns the source address, including child read views. */
export function sourcePathAddress(value: unknown): WorkbenchSource | null {
    if (!value || typeof value !== 'object'
        || !(Reflect.get(value, 'engine') === 'codex' || Reflect.get(value, 'ownership') === 'hapi-runner')) return null
    const sessionId: unknown = Reflect.get(value, 'hapiSessionId'), hubId: unknown = Reflect.get(value, 'hubId'), machineId: unknown = Reflect.get(value, 'machineId')
    if (typeof sessionId !== 'string' || !sessionId || typeof hubId !== 'string' || !hubId) return null
    return { sourceSessionId: sessionId, sourceHubId: hubId, ...(typeof machineId === 'string' && machineId ? { machineId } : {}) }
}

/** Download the exact source's authenticated binary result; no browser-supplied URL is opened. */
export async function downloadSourceFile(client: SourceFileClient, sessionId: string, path: string,
    signal: AbortSignal = new AbortController().signal): Promise<{ blob: Blob; fileName: string }> {
    const context = await client.resolve(sessionId, signal); signal.throwIfAborted()
    if (context.owner.binding.target.sessionId !== sessionId) throw new Error('The download belongs to another source session.')
    const bytes = await context.services.files.readBytes(path, {}, sourceFileAccess(context.owner, signal)); signal.throwIfAborted()
    return { blob: new Blob([new Uint8Array(bytes.data).buffer], { type: 'application/octet-stream' }),
        fileName: bytes.absolutePath.split(/[\\/]/).at(-1) || 'download' }
}

function SourceDownload({ client, sessionId, path, t }: { client: DownloadApi; sessionId: string; path: string; t: WorkspaceTranslate }) {
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
    const active = useRef<AbortController | null>(null)
    useEffect(() => {
        active.current = null; setBusy(false); setError(null)
        return () => { active.current?.abort(); active.current = null }
    }, [client, path, sessionId])
    const download = async (): Promise<void> => {
        if (active.current) return
        const abort = new AbortController(); active.current = abort; setBusy(true); setError(null)
        try {
            const result = await downloadSourceFile(client, sessionId, path, abort.signal); abort.signal.throwIfAborted()
            const link = document.createElement('a'), url = URL.createObjectURL(result.blob)
            link.href = url; link.download = result.fileName; link.click()
            setTimeout(() => { URL.revokeObjectURL(url) }, 30_000)
        } catch (error) { if (!abort.signal.aborted) setError(errorMessage(error)) }
        finally { if (active.current === abort) { active.current = null; if (!abort.signal.aborted) setBusy(false) } }
    }
    return <span className="hapi-source-download" style={{ display: 'inline-flex', flexShrink: 0 }}><Button type="button" variant="toolbar" size="sm" disabled={busy}
        aria-label={busy ? t('sourceDownloading') : t('sourceDownload')} title={t('sourcePathHelp')} style={{ flexShrink: 0, width: 32, height: 32, padding: 6 }} onClick={() => { void download() }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 1v9m-3-3 3 3 3-3M2 10v4h12v-4"/></svg>
    </Button>
        {error && <span className="hapi-error" role="alert">{error}</span>}</span>
}

/** Ordinary local and federated DSH retain their official opener and injected face. */
export function guardedPathAction(Official: ComponentType<ActionProps>, kind: ActionKind, client: DownloadApi, t: WorkspaceTranslate): ActionComponent {
    return function SourceAwarePathAction(props) {
        if (!isSourceSessionId(props.sessionId)) return isSourceDisplayId(props.sessionId) ? null : createElement(Official, props)
        return kind === 'document' && props.absolutePath
            ? <SourceDownload client={client} sessionId={props.sessionId} path={props.absolutePath} t={t}/>
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
        const sessions = ctx.sessions as unknown as ISessions
        const selected = Object.values(sessions.list.getSnapshot().byId).find(row => (row.retainedBy.mainView ?? 0) > 0)
        if (selected && (isSourceSessionId(selected.id) || isSourceDisplayId(selected.id))) input.consume()
    }))
    return () => { for (const dispose of disposers.reverse()) dispose() }
}
