import type { Context } from '@deepseek-ai/cordis'
import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from 'react'
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
const emptySubscribe = (): (() => void) => () => {}
const noMenuTarget = (): null => null

/**
 * Retain the official AppFrame's global overlays and plugin pages. One isolated
 * Client Context belongs to each pane, so modal state is never duplicated by
 * rendering one Host's shell several times. Only navigation chrome is hidden.
 */
export function installRemotePane(ctx: Context, options: {
    native?: NativeActionsApi; hostLabel?: string
    /** An outlet owned by the workspace chrome, never an official slot's DOM. */
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
    const SettingsTarget = createContext<HTMLSpanElement | null>(null)
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
    disposers.push(ctx.slots.subscribe('sidebar.panellist', changed))
    disposers.push(ctx.locale.subscribe(changed))
    const Tools = ({ settingsTarget }: { settingsTarget: (target: HTMLSpanElement | null) => void }) => {
        useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => toolsRevision)
        const panel = useSyncExternalStore(listener => ctx.layout.panelInfo.subscribe(listener), () => ctx.layout.panelInfo.getSnapshot())
        const t = ctx.locale.bind('hapiWorkspace')
        const panels = ctx.slots.entriesOfSlot('sidebar.panellist').map(entry => ({
            id: entry.options.id as MainPanelId, label: resolveSlotLabel(entry.options.label) ?? String(entry.options.id), order: entry.options.order ?? 0,
        })).sort((a, b) => a.order - b.order)
        const select = (id: MainPanelId | null, label: string): void => {
            try {
                if (state.target) bridge.navigated(id ? { type: 'panel', panelId: id } : { type: 'conversation' }, label)
                ctx.layout.selectPanel(id); bridge.failed(null)
            } catch (reason) { bridge.failed(reason) }
        }
        return <div className="hapi-host-tools" role="group" aria-label={t('hostTools')}>
            <span className="hapi-host-tools-heading">{t('hostTools')}{options.hostLabel && options.hostLabel !== 'DSH' ? ` · ${options.hostLabel}` : ''}</span>
            <button type="button" aria-pressed={panel.activePanelId === null} onClick={() => select(null, t('conversation'))}>{t('conversation')}</button>
            {panels.map(item => <button type="button" key={item.id} aria-pressed={panel.activePanelId === item.id} onClick={() => select(item.id, item.label)}>{item.label}</button>)}
            <span className="hapi-host-settings-launcher" ref={settingsTarget}/>
            <button type="button" onClick={() => {
                try {
                    if (state.target) bridge.navigated({ type: 'tab', kind: 'guide' }, t('pluginViews'))
                    ctx.layout.selectPanel(null); ctx.sidebarRight.openTab('guide'); bridge.failed(null)
                }
                catch (reason) { bridge.failed(reason) }
            }}>{t('pluginViews')}</button>
        </div>
    }
    const Launcher = ({ openSettings, settingsOpen, t }: SettingsLauncherOwnerProps & PropsLocale<'hapiWorkspace'>) => {
        const target = useContext(SettingsTarget)
        return target ? createPortal(<button type="button" onClick={openSettings} aria-pressed={settingsOpen}>{t('hostSettings')}</button>, target) : null
    }
    const Shell = ({ reference }: { reference: SessionReference }) => {
        const [target, setTarget] = useState<HTMLSpanElement | null>(null)
        const pane = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot)
        const menuTarget = useSyncExternalStore(options.toolsTarget?.subscribe ?? emptySubscribe, options.toolsTarget?.getSnapshot ?? noMenuTarget)
        const visibleError = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => error)
        useLayoutEffect(() => {
            if (pane.target?.type === 'panel') {
                try { ctx.layout.selectPanel(pane.target.panelId as MainPanelId) } catch (reason) { bridge.failed(reason) }
            } else if (pane.target) ctx.layout.selectPanel(null)
        }, [pane.target?.type, pane.target?.type === 'panel' ? pane.target.panelId : null])
        return <Reference.Provider value={reference}><SettingsTarget.Provider value={target}>
            {menuTarget && createPortal(<Tools settingsTarget={setTarget}/>, menuTarget)}
            <div className={`hapi-remote-shell${pane.target && pane.target.type !== 'panel' && pane.target.type !== 'conversation' ? ' hapi-plugin-view-shell' : ''}`} data-hapi-view-visible={pane.visible}
                onKeyDownCapture={event => options.keyboard?.capture(event.nativeEvent)} onKeyDown={event => options.keyboard?.bubble(event.nativeEvent)}>
                {!options.toolsTarget && <details className="hapi-menu hapi-standalone-host-menu"><summary aria-label={ctx.locale.bind('hapiWorkspace')('hostTools')}>⋯</summary><div className="hapi-menu-content"><Tools settingsTarget={setTarget}/></div></details>}
                {visibleError && <div className="hapi-pane-tool-error" role="alert">{visibleError}</div>}
                <div className="hapi-host-frame">{ctx.slots.renderSlot('root', {})}</div>
            </div>
        </SettingsTarget.Provider></Reference.Provider>
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
