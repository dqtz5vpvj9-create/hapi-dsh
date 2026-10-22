import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { StoreHandle } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightState, SurfaceActions, TabRecord } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { WorkspacePaneNavigation } from '../pane-navigation.ts'
import { targetForTab } from '../pane-bridge.tsx'
import { useSharedWorkspacePane } from './pane-context.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap { 'hapi.workspace.shared-rightbar': { kind: 'single'; scope: 'session' } }
}

type SurfaceStore = StoreHandle<SidebarRightState, {
    [K in keyof SurfaceActions]: (state: SidebarRightState, ...args: Parameters<SurfaceActions[K]>) => ReturnType<SurfaceActions[K]>
}>
type RedirectProps = PropsRuntime<'hapi.workspace.shared-rightbar'> & PropsStore<SurfaceStore>
const inactive = { visible: false, focused: false }
const subscribeNothing = () => () => {}

/** Recheck focus when an effect runs; a sibling may have focused since render. */
export function redirectSharedRightbar(pane: Pick<WorkspacePaneNavigation, 'hostId' | 'state' | 'openView'> | undefined, sessionId: SessionId,
    tab: Pick<TabRecord, 'kind' | 'contentId' | 'title'>, params: unknown, actions: Pick<SurfaceActions, 'setExpanded'>): boolean {
    const presentation = pane?.state.getSnapshot()
    if (!pane || pane.hostId === 'local' || !presentation?.visible || !presentation.focused) return false
    if (typeof actions.setExpanded !== 'function') throw new Error('The installed right-sidebar replacement does not expose the official surface actions')
    pane.openView(targetForTab(tab, params), { beside: 'horizontal', title: tab.title })
    actions.setExpanded(sessionId, false)
    return true
}

/**
 * A remote Host's retained AppFrame supplies the public session scopes, while
 * plugin views remain on the isolated compatibility path. Observe the original
 * rightbar store and transfer its address into an explicit workspace pane.
 * The original tab remains retained; no content or execution is closed.
 */
export function installSharedRightbar(ctx: Context): () => void {
    let activeStore: unknown
    let unseat: (() => void) | undefined
    let disposed = false
    const reconcile = (): void => {
        if (disposed) return
        const entry = ctx.slots.entriesOfSlot('rightbar.session')[0]
        if (entry?.store === activeStore) return
        unseat?.(); unseat = undefined; activeStore = entry?.store
        if (!entry?.store || typeof entry.store === 'function') return
        const store = entry.store as SurfaceStore
        const Redirect = ({ sessionId, useStore, actions }: RedirectProps) => {
            const pane = useSharedWorkspacePane()
            const presentation = useSyncExternalStore(pane?.state.subscribe ?? subscribeNothing, pane?.state.getSnapshot ?? (() => inactive))
            const surface = useStore(value => value.bySession[sessionId])
            const activePane = surface?.layout.nodes[surface.layout.activePaneId]
            const tab = activePane?.kind === 'pane' && activePane.activeTabId ? surface?.layout.tabs[activePane.activeTabId] : undefined
            const occurrence = tab ? ctx.sidebarRight.tabDomain.occurrence(sessionId, tab) : undefined
            const navigation = useSyncExternalStore(listener => occurrence?.navigation.subscribe(listener) ?? (() => {}), () => occurrence?.navigation.getSnapshot())
            const redirected = useRef<string | null>(null)
            const [error, setError] = useState<string | null>(null)
            const [retry, setRetry] = useState(0)
            useEffect(() => {
                if (!surface?.layout.expanded) { redirected.current = null; return }
                if (!pane || pane.hostId === 'local' || !presentation.visible || !presentation.focused || !tab || !navigation) return
                // Store notifications may publish the same expansion repeatedly.
                // Capture the originating pane/tab now, never a later focus owner.
                try {
                    const signature = JSON.stringify([pane.paneId, sessionId, tab.id, tab.contentId, navigation.params, retry])
                    if (redirected.current === signature) return
                    redirected.current = signature
                    if (redirectSharedRightbar(pane, sessionId, tab, navigation.params, actions)) setError(null)
                    else redirected.current = null
                } catch (failure) {
                    setError(failure instanceof Error ? failure.message : String(failure))
                }
            }, [pane, sessionId, surface?.layout.expanded, presentation.visible, presentation.focused, tab?.id, tab?.contentId, tab?.title, navigation, actions, retry])
            if (!error) return null
            const chinese = ctx.locale.getSnapshot().active.startsWith('zh')
            return <div className="hapi-pane-tool-error" role="alert"><p>{error}</p>
                <button type="button" onClick={() => setRetry(value => value + 1)}>{chinese ? '重试' : 'Retry'}</button></div>
        }
        unseat = ctx.slots.register({ name: 'hapi.workspace.shared-rightbar', store }, Redirect)
    }
    const stop = ctx.slots.subscribe('rightbar.session', reconcile)
    const stopSlot = ctx.slots.inject('hapi.workspace.shared-rightbar', () => {
        reconcile()
        return () => { unseat?.(); unseat = undefined; activeStore = undefined }
    })
    return () => { disposed = true; stop(); stopSlot(); unseat?.() }
}
