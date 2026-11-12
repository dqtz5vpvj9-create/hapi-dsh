import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { useEffect, useMemo, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { isSourceSessionId } from '../remote/protocol.ts'
import { sourceFileMutationKey, type SourceFileOwner } from './source-file-mutation-journal.ts'
import type {} from './remote-sessions.ts'
import type {} from './source-workspace-client.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { useWorkspacePane } from './surface/pane-context.tsx'
import { selectionQuote } from './document-selection-text.ts'
export { selectionQuote } from './document-selection-text.ts'

export const documentSelectionKey = (owner: SourceFileOwner) => `hhpi:document-selection:v2:${sourceFileMutationKey(owner)}`
export function DocumentSelectionButton({ ctx, sessionId, owner, path, version, zh }: {
    ctx: Context; sessionId: SessionId; owner: SourceFileOwner; path: string; version?: string | undefined; zh: boolean
}) {
    const pane = useWorkspacePane(ctx)
    const [message, setMessage] = useState(''), [pending, setPending] = useState<string | null>(null), [busy, setBusy] = useState(false)
    const lifetime = useMemo(() => new AbortController(), [ctx, sessionId, owner, path])
    const key = documentSelectionKey(owner)
    useEffect(() => {
        try { setPending(localStorage.getItem(key)); setMessage('') } catch (error) { setMessage(String(error)) }
        return () => lifetime.abort()
    }, [key, lifetime])
    const append = async (text: string): Promise<void> => {
        setBusy(true)
        try {
            const saved = localStorage.getItem(key)
            if (saved !== text) { setPending(saved); throw new Error(zh ? '保留的选区已在另一视图中处理或更改，未追加文字。' : 'The saved selection was handled or changed in another view. No text was added.') }
            const access = ctx.hhpiSessions.captureWorkspaceAccess(sessionId), application = ctx.hapiWorkspaceUi.application.getSnapshot()
            access.signal.throwIfAborted(); access.assertCurrent(); lifetime.signal.throwIfAborted()
            const hostId = pane?.hostId ?? ctx.get('sourceWorkspaceTransport')?.hostId ?? 'local'
            if (access.scope !== owner.scope || owner.binding.target.sessionId !== sessionId || owner.binding.target.hostId !== hostId) throw new Error('This document belongs to an earlier account or source. Reopen it before quoting.')
            if (!pane || !application) throw new Error('Open this document from its original conversation before adding the selection.')
            const signal = AbortSignal.any([lifetime.signal, access.signal, application.signal, AbortSignal.timeout(10_000)])
            const paneId = pane.focusConversation()
            await ctx.hapiWorkspaceUi.handoffs.appendText({ hubId: JSON.stringify([application.scope, hostId]), hostId,
                sessionId, displayId: sessionId }, paneId, text, signal)
            access.assertCurrent(); signal.throwIfAborted()
            if (localStorage.getItem(key) === text) localStorage.removeItem(key)
            setPending(localStorage.getItem(key))
            setMessage(zh ? '已追加到原聊天草稿。' : 'Added to the original conversation draft.')
        } catch (error) { if (!lifetime.signal.aborted) setMessage(error instanceof Error ? error.message : String(error)) }
        finally { if (!lifetime.signal.aborted) setBusy(false) }
    }
    return <><Button type="button" variant="toolbar" size="sm" disabled={busy} aria-label={zh ? '引用选区' : 'Quote selection'} title={zh ? '引用选区' : 'Quote selection'}
        style={{ flexShrink: 0, width: 32, height: 32, padding: 6 }} onPointerDown={event => event.preventDefault()} onClick={event => {
        const selection = window.getSelection(), root = event.currentTarget.closest('.hapi-artifact') ?? event.currentTarget.closest('[data-sidebar-right-panel]')
        if (!selection || !selection.rangeCount || selection.isCollapsed || !root?.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
            setMessage(zh ? '先在当前文档中选择文字。' : 'Select text in this document first.'); return
        }
        const text = selectionQuote(path, selection.toString(), version)
        try {
            const access = ctx.hhpiSessions.captureWorkspaceAccess(sessionId)
            access.signal.throwIfAborted(); access.assertCurrent()
            const hostId = pane?.hostId ?? ctx.get('sourceWorkspaceTransport')?.hostId ?? 'local'
            if (access.scope !== owner.scope || owner.binding.target.sessionId !== sessionId || owner.binding.target.hostId !== hostId) throw new Error('This document belongs to an earlier account or source. Reopen it before quoting.')
            if (localStorage.getItem(key)) throw new Error(zh ? '此前选区仍未加入草稿，请先重试已保留的选区。' : 'A previous selection is still retained. Retry that saved selection before quoting another.')
            localStorage.setItem(key, text); setPending(text)
            void append(text)
        } catch (error) { setMessage(String(error)) }
    }}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 4h4v5H2V4Zm8 0h4v5h-4V4ZM6 9c0 2-1 3-3 3m11-3c0 2-1 3-3 3"/></svg></Button>
        {pending && <button type="button" disabled={busy} onClick={() => { void append(pending) }}>{zh ? '重试保留的选区' : 'Retry saved selection'}</button>}
        {message && <small role="status">{message}</small>}</>
}

export function installDocumentSelections(ctx: Context): () => void {
    const BoundAction = (props: PropsRuntime<'sidebar.right.tab.document.actions'>) => {
        const [owner, setOwner] = useState<SourceFileOwner>()
        useEffect(() => { const stop = new AbortController(); void ctx.sourceFiles.resolve(props.sessionId, stop.signal).then(value => { if (!stop.signal.aborted) setOwner(value.owner) }).catch(() => {}); return () => stop.abort() }, [props.sessionId])
        return owner ? <DocumentSelectionButton ctx={ctx} sessionId={props.sessionId} owner={owner} path={props.absolutePath} zh={ctx.locale.getSnapshot().active.startsWith('zh')}/> : null
    }
    const Action = (props: PropsRuntime<'sidebar.right.tab.document.actions'>) => isSourceSessionId(props.sessionId) ? <BoundAction {...props}/> : null
    const stops = [ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: 'hhpi.document-selection' }, Action))]
    return () => { for (const stop of stops) stop() }
}
