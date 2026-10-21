import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StoreHandle } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightState, SurfaceActions, TabRecord, SidebarRightNavigationParams, SidebarRightResourceParams } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DshPaneTarget } from '../workspace/dsh-view.ts'
import { parseDshPaneTarget, parseNavigationValue } from '../workspace/dsh-view.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap { 'hapi.remote.bridge': { kind: 'single'; scope: 'session' } }
}

type BridgeStore = StoreHandle<SidebarRightState, {
    [K in keyof SurfaceActions]: (state: SidebarRightState, ...args: Parameters<SurfaceActions[K]>) => ReturnType<SurfaceActions[K]>
}>
type BridgeProps = PropsRuntime<'hapi.remote.bridge'> & PropsStore<BridgeStore>

export interface PaneBridgeState {
    target: DshPaneTarget | undefined
    visible: boolean
    focused: boolean
}

export interface PaneBridgeSource {
    getSnapshot(): PaneBridgeState
    subscribe(listener: () => void): () => void
    navigated(target: DshPaneTarget, title: string): void
    failed(error: unknown): void
}

/** Only official addresses and provider-owned navigation data enter layout. */
export function targetForTab(tab: Pick<TabRecord, 'kind' | 'contentId'>, params?: unknown): DshPaneTarget {
    const navigation = params === undefined ? {} : { params: parseNavigationValue(params) }
    return parseDshPaneTarget(tab.contentId.startsWith('dsh-resource://')
        ? { type: 'resource', address: tab.contentId, ...navigation }
        : { type: 'tab', kind: tab.kind, address: tab.contentId, ...navigation })
}

/**
 * Restore through the original surface's public actions, including its exact
 * multiple-page content identity. Never calls close/replace or a cleanup hook.
 */
export function restoreOfficialPaneTarget(ctx: Pick<Context, 'sidebarRight' | 'sidebarRightTabs' | 'layout'>, sessionId: SessionId, actions: SurfaceActions, target: DshPaneTarget): void {
    if (target.type === 'panel') { ctx.layout.selectPanel(target.panelId as never); return }
    ctx.layout.selectPanel(null)
    if (target.type === 'conversation') { actions.setExpanded(sessionId, false); return }
    if (target.type === 'resource') {
        ctx.sidebarRight.openResourceIn(sessionId, target.address, {
            ...(target.kind === undefined ? {} : { kind: target.kind }),
            ...(target.params === undefined ? {} : { params: target.params as unknown as SidebarRightResourceParams }),
        })
        return
    }
    const definition = ctx.sidebarRightTabs.get(target.kind)
    if (!definition) throw new Error(`The DSH plugin for “${target.kind}” is unavailable. This view’s original address is preserved.`)
    if (!target.address) {
        ctx.sidebarRight.openTabIn(sessionId, target.kind, target.params === undefined ? {} : { params: target.params as never })
        return
    }
    if (definition.canOpen && !definition.canOpen(target.address)) throw new Error(`The active DSH plugin refuses this saved “${target.kind}” address`)
    actions.openContent(sessionId, { kind: target.kind, contentId: target.address, title: definition.title(target.address) }, tabId => {
        ctx.sidebarRight.tabDomain.navigate(sessionId, tabId, { address: target.address!, params: target.params as SidebarRightNavigationParams })
    })
}

/**
 * This additional seat borrows the SAME public store handle as RightbarSeat
 * and ExpandButton. The renderer owns the instance; there is no create(),
 * injected mock, alternate TabProvider, or replacement body renderer here.
 */
export function installPaneBridge(ctx: Context, source: PaneBridgeSource): () => void {
    let activeStore: unknown
    let unseat: (() => void) | undefined
    let disposed = false
    const reconcile = (): void => {
        if (disposed) return
        const entry = ctx.slots.entriesOfSlot('rightbar.session')[0]
        if (entry?.store === activeStore) return
        unseat?.(); unseat = undefined; activeStore = entry?.store
        if (!entry?.store || typeof entry.store === 'function') return
        const store = entry.store as BridgeStore
        const Bridge = ({ sessionId, useStore, actions }: BridgeProps) => {
            const state = useSyncExternalStore(source.subscribe, source.getSnapshot)
            const surface = useStore(value => value.bySession[sessionId])
            const requested = state.target ? JSON.stringify(state.target) : ''
            const applied = useRef<string | null>(null)
            const opening = useRef(false)
            const restoredThisCommit = useRef(false)
            const hiddenExpansion = useRef<boolean | undefined>(undefined)
            const restoredWhileHidden = useRef(false)
            const surfaceRef = useRef(surface); surfaceRef.current = surface
            const activePane = surface?.layout.nodes[surface.layout.activePaneId]
            const currentTab = activePane?.kind === 'pane' && activePane.activeTabId ? surface?.layout.tabs[activePane.activeTabId] : undefined
            const occurrence = currentTab ? ctx.sidebarRight.tabDomain.occurrence(sessionId, currentTab) : undefined
            const navigation = useSyncExternalStore(listener => occurrence?.navigation.subscribe(listener) ?? (() => {}), () => occurrence?.navigation.getSnapshot())
            // Registry changes retry a preserved missing-plugin destination.
            const types = useSyncExternalStore(listener => ctx.sidebarRightTabs.subscribe(listener), () => ctx.sidebarRightTabs.entries())
            useLayoutEffect(() => {
                if (!state.target || applied.current === requested) return
                if (typeof actions.openContent !== 'function' || typeof actions.setExpanded !== 'function') {
                    source.failed(new Error('The installed right-sidebar replacement does not expose the official surface actions'))
                    return
                }
                opening.current = true
                // Effects from this render still see the surface from before
                // restore. In particular, its previously expanded tab must not
                // overwrite an explicit request to reveal Conversation.
                restoredThisCommit.current = true
                try {
                    restoreOfficialPaneTarget(ctx, sessionId, actions, state.target)
                    if (!state.visible && state.target.type !== 'panel') {
                        // Opening a saved resource and hiding this graph can
                        // happen in the same commit. Remember the requested
                        // expansion, not the previous render's empty surface.
                        hiddenExpansion.current = state.target.type !== 'conversation'
                        actions.setExpanded(sessionId, false)
                        restoredWhileHidden.current = true
                    }
                    applied.current = requested
                    source.failed(null)
                } catch (error) { source.failed(error) }
                finally { opening.current = false }
            }, [requested, sessionId, actions, types])
            useEffect(() => {
                if (restoredThisCommit.current) { restoredThisCommit.current = false; return }
                if (!state.target || state.target.type === 'panel' || !currentTab || !navigation || opening.current || applied.current === null) return
                // A normal Conversation pane keeps its own rightbar behavior.
                // Only an explicitly saved Conversation destination needs to
                // follow a later visible expansion back into a plugin view.
                if (state.target.type === 'conversation' && (!state.visible || !surface?.layout.expanded
                    || !ctx.sidebarRight.isExpanded() || ctx.layout.panelInfo.getSnapshot().activePanelId !== null
                    || hiddenExpansion.current !== undefined || restoredWhileHidden.current)) return
                try {
                    const target = targetForTab(currentTab, navigation.params)
                    // An explicit viewer choice is retained; otherwise the next
                    // restore re-runs the official extension-priority resolver.
                    if (target.type === 'resource' && state.target.type === 'resource' && state.target.kind) target.kind = state.target.kind
                    applied.current = JSON.stringify(target)
                    source.navigated(target, currentTab.title)
                } catch (error) { source.failed(error) }
            }, [requested, state.visible, surface?.layout.expanded, currentTab?.id, currentTab?.contentId, currentTab?.title, navigation])
            useLayoutEffect(() => {
                if (restoredWhileHidden.current) { restoredWhileHidden.current = false; return }
                const current = surfaceRef.current
                if (!state.visible) {
                    if (hiddenExpansion.current === undefined) hiddenExpansion.current = current?.layout.expanded ?? false
                    if (current?.layout.expanded) {
                        // An official provider can open its retained surface
                        // after the initial hidden render. Keep that intent so
                        // selecting the window reveals the original occurrence.
                        hiddenExpansion.current = true
                        actions.setExpanded(sessionId, false)
                    }
                } else if (hiddenExpansion.current !== undefined) {
                    const expanded = hiddenExpansion.current; hiddenExpansion.current = undefined
                    if (expanded) actions.setExpanded(sessionId, true)
                }
            }, [state.visible, sessionId, actions, surface?.layout.expanded])
            return null
        }
        unseat = ctx.slots.register({ name: 'hapi.remote.bridge', store }, Bridge)
    }
    const stop = ctx.slots.subscribe('rightbar.session', reconcile)
    const stopSlot = ctx.slots.inject('hapi.remote.bridge', () => { reconcile(); return () => { unseat?.(); unseat = undefined; activeStore = undefined } })
    return () => { disposed = true; stop(); stopSlot(); unseat?.() }
}
