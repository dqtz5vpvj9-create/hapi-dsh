import type { Context } from '@deepseek-ai/cordis'
import { createContext, useContext, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { resolveSlotLabel, type PropsLocale, type PropsRenderFactories, type PropsRenderSlots, type PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { NativeActionsApi } from './native-actions.tsx'
import { NativeActionLedger } from './native-state.ts'
import { en, zh } from './locales.ts'
import { ConversationPane } from './ui.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap { 'hapi.remote.conversation': { kind: 'single'; scope: 'session' } }
}

type RemoteRootProps = PropsRuntime<'main'> & PropsRenderSlots<'hapi.remote.conversation'>
type RemotePaneProps = PropsRuntime<'hapi.remote.conversation'> & PropsRenderFactories & PropsLocale<'hapiWorkspace'>

/**
 * Retain the official AppFrame's global overlays and plugin pages. One isolated
 * Client Context belongs to each pane, so modal state is never duplicated by
 * rendering one Host's shell several times. Only navigation chrome is hidden.
 */
export function installRemotePane(ctx: Context, options: {
    native?: NativeActionsApi; hostLabel?: string
    keyboard?: { capture(event: KeyboardEvent): void; bubble(event: KeyboardEvent): void }
} = {}): {
    renderConversation(reference: SessionReference): ReturnType<Context['slots']['renderSlot']>
    dispose(): void
} {
    const unavailable = async (): Promise<never> => { throw new Error('Native HAPI actions are not configured on this Host') }
    const native: NativeActionsApi = options.native ?? {
        ledger: new NativeActionLedger(), answer: unavailable, cancel: unavailable, steer: unavailable, retry: unavailable, resume: unavailable,
    }
    const disposers: Array<() => void> = []
    disposers.push(ctx.locale.register('hapiWorkspace', { en, zh }))
    const Reference = createContext<SessionReference | undefined>(undefined)
    const SettingsTarget = createContext<HTMLSpanElement | null>(null)
    const listeners = new Set<() => void>()
    let toolsRevision = 0
    const changed = (): void => { toolsRevision++; for (const listener of listeners) listener() }
    disposers.push(ctx.slots.subscribe('sidebar.panellist', changed))
    disposers.push(ctx.locale.subscribe(changed))
    const Tools = ({ settingsTarget }: { settingsTarget: (target: HTMLSpanElement | null) => void }) => {
        useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => toolsRevision)
        const panel = useSyncExternalStore(listener => ctx.layout.panelInfo.subscribe(listener), () => ctx.layout.panelInfo.getSnapshot())
        const [error, setError] = useState<string | null>(null)
        const t = ctx.locale.bind('hapiWorkspace')
        const panels = ctx.slots.entriesOfSlot('sidebar.panellist').map(entry => ({
            id: entry.options.id as MainPanelId, label: resolveSlotLabel(entry.options.label) ?? String(entry.options.id), order: entry.options.order ?? 0,
        })).sort((a, b) => a.order - b.order)
        return <div className="hapi-host-tools">
            <span title={options.hostLabel}>{options.hostLabel ?? 'DSH'}</span>
            <select value={panel.activePanelId ?? ''} aria-label={t('hostTools')} onChange={event => {
                try { ctx.layout.selectPanel(event.currentTarget.value ? event.currentTarget.value as MainPanelId : null); setError(null) }
                catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
            }}><option value="">{t('conversation')}</option>{panels.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select>
            <span ref={settingsTarget}/>
            {error && <span role="alert" className="hapi-error">{error}</span>}
        </div>
    }
    const Launcher = ({ openSettings, settingsOpen, t }: SettingsLauncherOwnerProps & PropsLocale<'hapiWorkspace'>) => {
        const target = useContext(SettingsTarget)
        return target ? createPortal(<button type="button" onClick={openSettings} aria-pressed={settingsOpen}>{t('hostSettings')}</button>, target) : null
    }
    const Shell = ({ reference }: { reference: SessionReference }) => {
        const [target, setTarget] = useState<HTMLSpanElement | null>(null)
        return <Reference.Provider value={reference}><SettingsTarget.Provider value={target}>
            <div className="hapi-remote-shell" onKeyDownCapture={event => options.keyboard?.capture(event.nativeEvent)} onKeyDown={event => options.keyboard?.bubble(event.nativeEvent)}><Tools settingsTarget={setTarget}/><div className="hapi-host-frame">{ctx.slots.renderSlot('root', {})}</div></div>
        </SettingsTarget.Provider></Reference.Provider>
    }
    const Main = ({ SessionProvider, renderSlot }: RemoteRootProps) => {
        const reference = useContext(Reference)
        return reference ? <SessionProvider session={reference}>{renderSlot('hapi.remote.conversation', {})}</SessionProvider> : null
    }
    const Pane = (props: RemotePaneProps) => <ConversationPane {...props} native={native}/>
    disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'conversation', priority: -100,
        children: { 'hapi.remote.conversation': { kind: 'single', scope: 'session' } },
    }, Main)))
    disposers.push(ctx.slots.inject('hapi.remote.conversation', () => ctx.slots.register({
        name: 'hapi.remote.conversation', locale: 'hapiWorkspace',
    }, Pane)))
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
        dispose() {
            if (disposed) return
            disposed = true
            for (const dispose of disposers.reverse()) dispose()
            listeners.clear()
            if (!options.native) native.ledger.clear()
        },
    }
}
