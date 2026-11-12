import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
/** Add source navigation around the unchanged official file card and image gallery. */
import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isSourceSessionId } from '../remote/protocol.ts'
import { workspaceAttachmentResource, workspaceDocumentAddress } from '../workspace/artifacts.ts'
import type { WorkspaceDocumentRef } from '../workbench-types.ts'
import type { SourceFileClient } from './source-workspace-provider.ts'
import { useWorkspacePane } from './surface/pane-context.tsx'
import { errorMessage } from './controller.ts'

export function SourceDocumentOpen({ ctx, client, sessionId, document, name, children }: {
    ctx: Context; client: SourceFileClient; sessionId: SessionId; document: WorkspaceDocumentRef; name: string; children?: ReactNode
}) {
    const pane = useWorkspacePane(ctx), pending = useRef<AbortController | null>(null)
    const [busy, setBusy] = useState(false), [error, setError] = useState('')
    const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active), zh = language.startsWith('zh')
    useEffect(() => () => { pending.current?.abort() }, [sessionId])
    const open = async () => {
        if (pending.current) return
        const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
        try {
            const context = await client.resolve(sessionId, controller.signal); controller.signal.throwIfAborted()
            const target = context.owner.binding.target, hostId = pane?.hostId ?? ctx.get('sourceWorkspaceTransport')?.hostId ?? 'local'
            if (target.hostId !== hostId || target.sessionId !== sessionId) throw new Error('This attachment belongs to another Host or source session. Its original reference is kept.')
            const address = workspaceDocumentAddress({ target, document })
            if (pane) pane.openResource(address)
            else ctx.sidebarRight.openResourceIn(sessionId, address)
        } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)) }
        finally { if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setBusy(false) } }
    }
    return <><button type="button" className={`hhpi-source-document-open${children === undefined ? '' : ' hhpi-source-document-card'}`} disabled={busy} aria-label={`${zh ? '打开源文件' : 'Open source file'} ${name}`} onClick={() => { void open() }}>{children ?? `${zh ? '打开原件' : 'Open original'} ${name}`}</button>{error && <span role="alert">{error}</span>}</>
}
export function SourceChatFileCard({ ctx, client, sessionId, file, children }: {
    ctx: Context; client: SourceFileClient; sessionId: SessionId; file: FileAttachmentRef; children: ReactNode
}) {
    const target = { hostId: ctx.get('sourceWorkspaceTransport')?.hostId ?? 'local', sessionId }
    return <SourceDocumentOpen ctx={ctx} client={client} sessionId={sessionId} document={workspaceAttachmentResource(target, file).document} name={file.name}>{children}</SourceDocumentOpen>
}
type ChatSlot = 'conversation.chat.user.file' | 'conversation.chat.user.images' | 'conversation.chat.message.images'
/** Public Slot handles retain the original component, locale, stores and injected seats. */
export function installSourceChatFiles(ctx: Context, client: SourceFileClient): () => void {
    const style = document.createElement('style')
    style.textContent = '.hhpi-source-document-open{font:inherit;color:inherit;text-align:left;max-width:100%;min-width:0;cursor:pointer}.hhpi-source-document-card{appearance:none;background:transparent;border:0;padding:0}.hhpi-source-image-originals{display:flex;flex-wrap:wrap;gap:6px;max-width:100%;padding-top:4px}.hhpi-source-image-originals button{overflow-wrap:anywhere}'
    document.head.append(style)
    // The official gallery already opens and downloads images. Only file cards
    // need source navigation; adding another image action exposes storage IDs.
    const stops = (['conversation.chat.user.file'] as const).map(name => ctx.slots.inject(name, () => {
        let original: StoredEntry | undefined, wrapped: ComponentType<PropsRuntime<ChatSlot>> | undefined, remove: (() => void) | undefined, changing = false
        const update = () => {
            if (changing) return
            const entry = ctx.slots.entries(name).find(value => value.component !== wrapped)
            if (entry === original) return
            changing = true
            try {
                remove?.(); remove = undefined; original = entry
                if (!entry || entry.children) return
                const Official = entry.component as ComponentType<PropsRuntime<ChatSlot>>
                wrapped = props => {
                    const content = createElement(Official, props)
                    if (!isSourceSessionId(props.sessionId)) return content
                    if ('file' in props) return <SourceChatFileCard ctx={ctx} client={client} sessionId={props.sessionId} file={props.file}>{content}</SourceChatFileCard>
                    return content
                }
                const register = ctx.slots.register.bind(ctx.slots) as (options: { name: ChatSlot; priority: number; locale?: string; store?: StoredEntry['store']; inject?: StoredEntry['inject'] }, component: unknown) => () => void
                remove = register({ name, priority: (entry.options.priority ?? 0) - 1, ...(entry.locale ? { locale: entry.locale } : {}),
                    ...(entry.store ? { store: entry.store } : {}), ...(entry.inject ? { inject: entry.inject } : {}) }, wrapped)
            } finally { changing = false }
        }
        const stop = ctx.slots.subscribe(name, update); update()
        return () => { stop(); remove?.() }
    }))
    return () => { for (const stop of stops.reverse()) stop(); style.remove() }
}
