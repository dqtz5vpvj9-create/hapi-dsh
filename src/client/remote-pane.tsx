import type { Context } from '@deepseek-ai/cordis'
import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel, type PropsLocale, type PropsRenderSlots, type PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { NativeActionsApi } from './native-actions.tsx'
import { en, zh } from './locales.ts'
import { installPaneBridge, targetForTab, type PaneBridgeSource, type PaneBridgeState } from './pane-bridge.tsx'
import type { DshPaneTarget } from '../workspace/dsh-view.ts'
import type { SidebarRightTabMenuOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './pane-navigation.ts'
import { installWorkspaceLinkSettings } from './workspace-links.tsx'

type BridgeSeatProps = PropsRuntime<'shell.overlay'> & PropsRenderSlots<'hapi.remote.bridge'>

const GearIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 6h9M18 6h2M4 12h3M12 12h8M4 18h9M18 18h2"/><circle cx="15" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="15" cy="18" r="2"/></svg>
const PanelsIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>

/**
 * Retain the official AppFrame's global overlays and plugin pages. One isolated
 * Client Context belongs to each pane, so modal state is never duplicated by
 * rendering one Host's shell several times. Only navigation chrome is hidden.
 */
export function installRemotePane(ctx: Context, options: {
    native?: NativeActionsApi; hostLabel?: string
    /** Workspace-owned tools outlet accepted from the Host plumbing. The always
     * visible header cluster replaces the old menu outlet for pane tools. */
    toolsTarget?: ObservableSnapshot<HTMLElement | null>
    localeInstalled?: boolean
    navigated?: (target: DshPaneTarget, title: string) => void
    keyboard?: { capture(event: KeyboardEvent): void; bubble(event: KeyboardEvent): void }
} = {}): {
    renderConversation(reference: SessionReference): ReturnType<Context['slots']['renderSlot']>
    renderView(reference: SessionReference, state: PaneBridgeState): ReturnType<Context['slots']['renderSlot']>
    dispose(): void
} {
    const disposers: Array<() => void> = []
    disposers.push(installWorkspaceLinkSettings(ctx))
    if (!options.localeInstalled) disposers.push(ctx.locale.register('hapiWorkspace', { en, zh }))
    const Reference = createContext<SessionReference | undefined>(undefined)
    const listeners = new Set<() => void>()
    let toolsRevision = 0
    const changed = (): void => { toolsRevision++; for (const listener of listeners) listener() }
    let state: PaneBridgeState = { target: undefined, visible: true, focused: true }
    let error: string | null = null
    const stateListeners = new Set<() => void>()
    const publish = (): void => { for (const listener of stateListeners) listener(); changed() }
    const bridge: PaneBridgeSource = {
        getSnapshot: () => state,
        subscribe(listener) { stateListeners.add(listener); return () => { stateListeners.delete(listener) } },
        navigated(target, title) {
            if (JSON.stringify(state.target) !== JSON.stringify(target)) { state = { ...state, target }; publish() }
            options.navigated?.(target, title)
        },
        failed(reason) {
            const next = reason === null ? null : reason instanceof Error ? reason.message : String(reason)
            if (error !== next) { error = next; changed() }
        },
    }
    // The official settings owner renders its launcher inside the (CSS-hidden)
    // official sidebar. Moving that one button into the pane utility cluster
    // keeps the modal, sections, permissions and plugin contributions owned by
    // this pane graph while the pane itself shows a single compact entry.
    let settingsTarget: HTMLSpanElement | null = null
    const setSettingsTarget = (element: HTMLSpanElement | null): void => {
        if (settingsTarget === element) return
        settingsTarget = element; changed()
    }
    disposers.push(ctx.slots.subscribe('sidebar.panellist', changed))
    disposers.push(ctx.locale.subscribe(changed))
    const HostTools = () => {
        useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => toolsRevision)
        const panel = useSyncExternalStore(listener => ctx.layout.panelInfo.subscribe(listener), () => ctx.layout.panelInfo.getSnapshot())
        const t = ctx.locale.bind('hapiWorkspace')
        const panels = ctx.slots.entriesOfSlot('sidebar.panellist').map(entry => ({
            id: entry.options.id as MainPanelId, label: resolveSlotLabel(entry.options.label) ?? String(entry.options.id), order: entry.options.order ?? 0,
        })).sort((a, b) => a.order - b.order)
        return <div className="hapi-pane-tools" data-hapi-pane-tools="" title={options.hostLabel}>
            <select className="hapi-pane-tools-select" value={panel.activePanelId ?? ''} aria-label={t('hostTools')} title={t('hostTools')} onChange={event => {
                try {
                    const id = event.currentTarget.value
                    if (state.target) bridge.navigated(id ? { type: 'panel', panelId: id } : { type: 'conversation' }, id || t('conversation'))
                    ctx.layout.selectPanel(id ? id as MainPanelId : null); bridge.failed(null)
                }
                catch (reason) { bridge.failed(reason) }
            }}><option value="">{t('conversation')}</option>{panels.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select>
            <span className="hapi-pane-tools-settings" ref={setSettingsTarget}/>
            <button type="button" className="hapi-pane-tools-button" title={t('pluginViews')} aria-label={t('pluginViews')} onClick={() => {
                try {
                    if (state.target) bridge.navigated({ type: 'tab', kind: 'guide' }, t('pluginViews'))
                    ctx.layout.selectPanel(null); ctx.sidebarRight.openTab('guide'); bridge.failed(null)
                }
                catch (reason) { bridge.failed(reason) }
            }}><PanelsIcon/></button>
        </div>
    }
    const Launcher = ({ openSettings, settingsOpen, t }: SettingsLauncherOwnerProps & PropsLocale<'hapiWorkspace'>) => {
        useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => toolsRevision)
        return settingsTarget
            ? createPortal(<button type="button" className="hapi-pane-tools-button" title={t('hostSettingsHelp')}
                onClick={openSettings} aria-pressed={settingsOpen}><GearIcon/><span className="hapi-pane-tools-label">{t('hostSettings')}</span></button>, settingsTarget)
            : null
    }
    const Shell = ({ reference }: { reference: SessionReference }) => {
        const pane = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot)
        // Navigation/tool failures stay visible instead of being swallowed by the
        // compact cluster (upstream hotfix behaviour).
        const visibleError = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => error)
        useLayoutEffect(() => {
            if (pane.target?.type === 'panel') {
                try { ctx.layout.selectPanel(pane.target.panelId as MainPanelId) } catch (reason) { bridge.failed(reason) }
            } else if (pane.target) ctx.layout.selectPanel(null)
        }, [pane.target?.type, pane.target?.type === 'panel' ? pane.target.panelId : null])
        return <Reference.Provider value={reference}>
            <div className={`hapi-remote-shell${pane.target && pane.target.type !== 'panel' && pane.target.type !== 'conversation' ? ' hapi-plugin-view-shell' : ''}`} data-hapi-view-visible={pane.visible}
                onKeyDownCapture={event => options.keyboard?.capture(event.nativeEvent)} onKeyDown={event => options.keyboard?.bubble(event.nativeEvent)}>
                {visibleError && <div className="hapi-pane-tool-error" role="alert">{visibleError}</div>}
                <div className="hapi-host-frame">{ctx.slots.renderSlot('root', {})}</div></div>
        </Reference.Provider>
    }
    const BridgeSeat = ({ SessionProvider, renderSlot }: BridgeSeatProps) => {
        const reference = useContext(Reference)
        return reference ? <SessionProvider session={reference}>
            {renderSlot('hapi.remote.bridge', {})}
        </SessionProvider> : null
    }
    // The official main entry owns its complete ConversationRoot: header,
    // lineage, actions, utilities, view tabs, content factory and width controls.
    // Do not shadow it or attempt to redeclare those owned children. This
    // invisible additive shell seat only restores provider-owned resources.
    disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'hapi.workspace.pane-bridge',
        children: { 'hapi.remote.bridge': { kind: 'single', scope: 'session' } },
    }, BridgeSeat)))
    disposers.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'hapi.pane-tools', order: 100, locale: 'hapiWorkspace',
    }, HostTools)))
    disposers.push(installPaneBridge(ctx, bridge))
    const OpenInWorkspace = ({ sessionId, tab, dismiss, t }: PropsRuntime<'sidebar.right.tab.menu.item'> & SidebarRightTabMenuOwnerProps & PropsLocale<'hapiWorkspace'>) => {
        const navigation = ctx.get('hapiWorkspacePane')
        if (!navigation) return null
        return <button type="button" onClick={() => {
            try {
                const params = ctx.sidebarRight.tabDomain.occurrence(sessionId, tab).navigation.getSnapshot().params
                navigation.openView(targetForTab(tab, params), { beside: 'horizontal', title: tab.title })
                dismiss()
            } catch (reason) { bridge.failed(reason) }
        }}>{t('openInWorkspacePane')}</button>
    }
    disposers.push(ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
        name: 'sidebar.right.tab.menu.item', id: 'hapi.workspace.open-pane', order: 100, locale: 'hapiWorkspace',
    }, OpenInWorkspace)))
    // The official settings owner supplies its real open action. The portal
    // moves only that launcher out of the hidden sidebar; its modal, sections,
    // permissions, and plugin contributions keep their original ownership.
    disposers.push(ctx.slots.inject('settings.launcher', () => ctx.slots.register({
        name: 'settings.launcher', priority: -100, locale: 'hapiWorkspace',
    }, Launcher)))
    let disposed = false
    return {
        renderConversation(reference) {
            if (disposed) throw new Error('The remote Conversation renderer is disposed')
            return <Shell reference={reference}/>
        },
        renderView(reference, next) {
            if (disposed) throw new Error('The DSH pane renderer is disposed')
            if (JSON.stringify(state) !== JSON.stringify(next)) { state = next; publish() }
            return <Shell reference={reference}/>
        },
        dispose() {
            if (disposed) return
            disposed = true
            for (const dispose of disposers.reverse()) dispose()
            listeners.clear()
            stateListeners.clear()
        },
    }
}
