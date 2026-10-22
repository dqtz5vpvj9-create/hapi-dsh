import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HapiRemoteApi } from '../client-api.ts'
import { NativeGoalEditor } from './native-library.tsx'
import { useWorkspacePane } from './surface/pane-context.tsx'

/** A source operation beside the editor; never a synthetic prompt or a second goal owner. */
export function installComposerGoal(ctx: Context, api: HapiRemoteApi): () => void {
    const Goal = (props: PropsRuntime<'conversation.input.left'>) => {
        const source = props.useProjection('hapi'), pane = useWorkspacePane(ctx)
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        const [open, setOpen] = useState(false), dialog = useRef<HTMLDialogElement>(null)
        const zh = language.startsWith('zh')
        useEffect(() => { if (open) dialog.current?.showModal() }, [open])
        useEffect(() => pane?.state.subscribe(() => { if (!pane.state.getSnapshot().visible) setOpen(false) }), [pane])
        if (!source) return null
        return <><button type="button" className="hapi-goal-trigger" title={zh ? '持续目标' : 'Persistent goal'}
            aria-haspopup="dialog" onClick={() => setOpen(true)}>◎ Goal</button>
            {open && createPortal(<dialog ref={dialog} className="hapi-goal-dialog hapi-source-panel" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
                <header><h2>{zh ? '持续目标' : 'Persistent goal'}</h2><button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={() => setOpen(false)}>×</button></header>
                <NativeGoalEditor api={api} sessionId={props.sessionId} language={language}/>
            </dialog>, document.body)}</>
    }
    const style = document.createElement('style')
    style.textContent = `.hapi-goal-trigger{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 7px;border-radius:6px;cursor:pointer}.hapi-goal-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.hapi-goal-dialog{width:min(480px,calc(100vw - 24px));height:auto;max-height:calc(100dvh - 32px);padding:20px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);box-shadow:0 12px 48px #0002}.hapi-goal-dialog::backdrop{background:#0003}.hapi-goal-dialog textarea{min-height:128px}.hapi-goal-dialog header h2{margin:0}.hapi-goal-dialog header button{border:0;font-size:22px}`
    document.head.append(style)
    const stop = ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'hapi.goal', order: 30 }, Goal))
    return () => { stop(); style.remove() }
}
