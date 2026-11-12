/** Share links resolve after authentication and retain an explicit retry on failure. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../workspace/app-api.ts'
import type { WorkspaceController } from './controller.ts'
import { createAppTargetNavigation } from './app-target-navigation.ts'
import { createSourceSharing, installSourceSharing, resumeSourceShare } from './source-share.ts'

export function installWorkspaceSharing(ctx: Context, controller: WorkspaceController): () => void {
    const ui = ctx.hapiWorkspaceUi, api = ctx.remote.appServices
    const unprovide = installSourceSharing(ctx, { create(target, signal) {
        const identity = ui.application.getSnapshot()
        if (!identity) throw new Error('Sign in before creating a source link.')
        return createSourceSharing(api, identity.account, identity.deviceId, location.href, identity.signal).create(target, signal)
    } })
    const navigate = createAppTargetNavigation(controller)
    function ResumeShare() {
        const identity = useSyncExternalStore(ui.application.subscribe, ui.application.getSnapshot)
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        const [state, setState] = useState<{ busy: boolean; error: string | null; dismissed: boolean }>({ busy: false, error: null, dismissed: false })
        const attempt = useRef<AbortController>(), sequence = useRef(0)
        const open = async (): Promise<void> => {
            if (!identity || identity.signal.aborted || !new URL(location.href).searchParams.has('hhpiShare')) return
            const mine = ++sequence.current, controllerAtStart = controller.store.getSnapshot()
            attempt.current?.abort(); const active = new AbortController(); attempt.current = active
            const signal = AbortSignal.any([active.signal, identity.signal])
            setState({ busy: true, error: null, dismissed: false })
            try {
                const next = await resumeSourceShare(api, identity.account, location.href, (target, signal) => {
                    if (controller.store.getSnapshot() !== controllerAtStart) throw new Error(language.startsWith('zh')
                        ? '你已切换页面。点击重试后再打开这份分享。' : 'You changed pages. Retry to open this shared conversation.')
                    return navigate(target, undefined, signal)
                }, signal)
                signal.throwIfAborted()
                if (mine !== sequence.current) return
                if (next) history.replaceState(history.state, '', next)
                if (mine === sequence.current) setState({ busy: false, error: null, dismissed: false })
            } catch (error) {
                if (!signal.aborted && mine === sequence.current) setState({ busy: false, error: error instanceof Error ? error.message : String(error), dismissed: false })
            }
        }
        useEffect(() => {
            setState({ busy: false, error: null, dismissed: false })
            void open()
            return () => { ++sequence.current; attempt.current?.abort() }
        }, [identity])
        if (!state.error || state.dismissed) return null
        const zh = language.startsWith('zh')
        return <aside className="hhpi-share-recovery" role="alert"><strong>{zh ? '暂时无法打开分享' : 'Could not open this share'}</strong>
            <p>{state.error}</p><div><button type="button" disabled={state.busy} onClick={() => { void open() }}>{zh ? '重试' : 'Retry'}</button>
                <button type="button" onClick={() => setState(current => ({ ...current, dismissed: true }))}>{zh ? '关闭提示' : 'Dismiss'}</button></div></aside>
    }
    const stop = ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'hhpi-share-recovery', order: 34 }, ResumeShare))
    const style = document.createElement('style')
    style.textContent = '.hhpi-share-recovery{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:71;width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:16px;border:1px solid var(--border-secondary,#8886);border-radius:12px;background:var(--bg-primary,Canvas);color:var(--text-primary,CanvasText);box-shadow:0 4px 24px #0003;font:14px/1.5 system-ui;pointer-events:auto}.hhpi-share-recovery p{overflow-wrap:anywhere;max-height:160px;overflow:auto}.hhpi-share-recovery>div{display:flex;gap:8px}.hhpi-share-recovery button{font:inherit;min-height:40px;border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:6px 12px;background:transparent;color:inherit}'
    document.head.append(style)
    return () => { stop(); style.remove(); unprovide() }
}
