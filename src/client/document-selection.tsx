import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchSource } from '../workbench-types.ts'
import { handoffDetectEnd } from './draft-handoff-receiver.tsx'
import { sourcePathAddress } from './source-path-actions.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'

const seats = new Map<string, Set<(text: string) => boolean>>()
const keyFor = (source: WorkbenchSource) => `hapi-dsh:document-selection:${JSON.stringify([source.sourceHubId, source.sourceSessionId])}`
export function selectionQuote(path: string, quote: string, version?: string): string {
    return `[选区引用 / Document selection]\nSource: ${path}\nRevision: ${version ?? 'not reported'}\n${quote.split('\n').map(line => `> ${line}`).join('\n')}\n`
}
export function DocumentSelectionButton({ sessionId, source, path, version, zh }: {
    sessionId: SessionId; source: WorkbenchSource; path: string; version?: string | undefined; zh: boolean
}) {
    const [message, setMessage] = useState('')
    return <><button type="button" onPointerDown={event => event.preventDefault()} onClick={event => {
        const selection = window.getSelection(), root = event.currentTarget.closest('.hapi-artifact') ?? event.currentTarget.closest('[data-sidebar-right-panel]')
        if (!selection || !selection.rangeCount || selection.isCollapsed || !root?.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
            setMessage(zh ? '先在当前文档中选择文字。' : 'Select text in this document first.'); return
        }
        const text = selectionQuote(path, selection.toString(), version), key = keyFor(source)
        try {
            // Save before asking the official editor; a hidden/unmounted composer
            // leaves a recoverable selection for this original source only.
            const previous = localStorage.getItem(key)
            const pending = previous ? `${previous}\n${text}` : text
            localStorage.setItem(key, pending)
            const inserted = [...seats.get(`${key}:${sessionId}`) ?? []].some(insert => insert(pending))
            if (inserted) localStorage.removeItem(key)
            window.dispatchEvent(new Event('hapi-document-selection'))
            setMessage(inserted ? zh ? '已追加到草稿。' : 'Added to draft.' : zh ? '引用已保存，回到聊天后可加入草稿。' : 'Selection saved. Return to the conversation to add it to your draft.')
        } catch (error) { setMessage(String(error)) }
    }}>{zh ? '引用选区' : 'Quote selection'}</button>{message && <small role="status">{message}</small>}</>
}

export function installDocumentSelections(ctx: Context): () => void {
    const Receiver = (props: PropsRuntime<'conversation.input.dock'>) => {
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), projection = native ?? observed
        const source = sourcePathAddress(projection), input = props.useInput(value => value), latest = useRef({ props, input })
        latest.current = { props, input }
        const [pending, setPending] = useState<string | null>(null), [error, setError] = useState('')
        const key = source && !observed?.sidechain ? keyFor(source) : null
        const insert = (text: string): boolean => {
            const current = latest.current, state = current.input
            if (!state || state.phase === 'adjudicating' || state.phase === 'submitting') return false
            const end = handoffDetectEnd(state)
            return current.props.inputActions.insertText(`${state.draft ? '\n\n' : ''}${text}`, { start: end, end, draftRev: state.draftRev })
        }
        useEffect(() => {
            if (!key) return
            const id = `${key}:${props.sessionId}`, all = seats.get(id) ?? new Set(), receive = (text: string) => insert(text)
            seats.set(id, all); all.add(receive)
            const refresh = () => { try { setPending(localStorage.getItem(key)) } catch { setPending(null) } }
            refresh(); window.addEventListener('hapi-document-selection', refresh); window.addEventListener('storage', refresh)
            return () => { all.delete(receive); if (!all.size) seats.delete(id); window.removeEventListener('hapi-document-selection', refresh); window.removeEventListener('storage', refresh) }
        }, [key, props.sessionId])
        if (!pending || !key) return null
        return <div className="hapi-draft-recovery"><button type="button" onClick={() => {
            if (!insert(pending)) { setError('输入框正忙，请稍后重试。'); return }
            localStorage.removeItem(key); setPending(null); setError('')
        }}>将文档选区加入草稿 / Add selection</button>{error && <span role="alert">{error}</span>}</div>
    }
    const Action = (props: PropsRuntime<'sidebar.right.tab.document.actions'>) => {
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), source = sourcePathAddress(native ?? observed)
        if (!source || observed?.sidechain) return null
        return <DocumentSelectionButton sessionId={props.sessionId} source={source} path={props.absolutePath} zh={ctx.locale.getSnapshot().active.startsWith('zh')}/>
    }
    const stops = [ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'hapi.document-selection' }, Receiver)),
        ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: 'hapi.document-selection' }, Action))]
    return () => { for (const stop of stops) stop() }
}
