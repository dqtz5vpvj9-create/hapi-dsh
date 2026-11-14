import { installSourceConversation } from './source-conversation.ts'
import { createSourceReadHead } from './source-reading-head.ts'
import { installWorkspaceReadSync } from './source-reading-sync.ts'
import { installWorkspaceSharing } from './source-share-navigation.tsx'
import { createSessionSourceExporter } from './source-export-state.ts'
import { createAppTargetNavigation } from './app-target-navigation.ts'
import { installBrowserRecovery } from './source-browser-recovery.tsx'
import { armOrdinaryReadingForReload } from './ordinary-reading-checkpoint.ts'
import { createWorkspaceUiBridge } from './workspace-ui.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceViewportSession } from './source-session-types.ts'
import { remoteReadingOwner } from './remote-reading-owner.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
/** Workspace composition loaded by the official DSH plugin runtime. */
import { taggedRemote } from '../client-api.ts'
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { WorkspaceController } from './controller.ts'
import { installFederation } from './federation.tsx'
import { en, zh } from './locales.ts'
import { createWorkspacePersistence } from './persistence.ts'
import { SessionSidebar, WorkspaceRoot } from './ui.tsx'
import type { SessionSidebarProps, WorkspaceRootProps } from './slots.ts'
import { installWorkspaceStyles } from './styles.ts'
import { installSeamlessHistory } from './seamless/index.ts'
import { requestOlderThroughMountedChat, resolveMountedChatForPane, resolveMountedChatLatestForPane, toLatestThroughMountedChat } from './mounted-chat-control.ts'
import { installSidebarNavigation } from './sidebar-navigation.ts'
import { installWorkspaceMenus } from './menus.ts'
import { installNewSessionShortcut } from './shortcuts.ts'
import { hasDirtyNativeDocument } from './workbench-drafts.ts'
import { installNativeComposerAdmission } from './native-composer.ts'
import type {} from './pane-navigation.ts'
import { installSourceComposerBridge } from './source-composer.tsx'
import { installSourceTerminalActions } from './source-terminal-actions.tsx'
import { installSourceVoice } from './source-voice/index.tsx'
import { installSourceNotifications } from './source-notifications/index.tsx'
import type {} from './remote-sessions.ts'
import { createWorkspaceNotifications } from '../workspace/notifications.ts'
import { installShareInbox } from './share-inbox.tsx'
import { installDraftHandoff } from './draft-handoff-dialog.tsx'
import { installSourceAppearance } from './appearance/index.tsx'
import { installWorkspaceLinkSettings } from './workspace-links.tsx'
import { installDeferredPlugins, workspaceDeferredDemand } from './deferred-plugins.ts'
import { COMPACT_WORKSPACE_QUERY, workspaceViewportPolicy } from '../shared/workspace-presentation.ts'

export { WorkspaceController, sessionResourceId, parseSessionResourceId } from './controller.ts'
export type { WorkspaceHost, WorkspaceOptions, WorkspaceSnapshot, WorkspacePersistence } from './controller.ts'
export { WorkspaceStore, parseWorkspaceState } from './model.ts'
export type { WorkspaceState } from './model.ts'
export { installRemotePane } from './remote-pane.tsx'
export type { WorkspacePaneNavigation } from './pane-navigation.ts'
export type { WorkspaceUpdatePreparations } from './update-preparation.ts'
export type { DshPaneTarget, NavigationValue } from '../workspace/dsh-view.ts'

declare module '@deepseek-ai/cordis' {
    interface Context { hapiWorkspace: WorkspaceController }
}

export const name = 'hapi-dsh-client'
export const inject = ['slots', 'sessions', 'hapiSourceSessions', 'hhpiSessions', 'sourceFiles', 'workspaces', 'uiWorkspace', 'layout', 'locale', 'remote', 'remote.hapi', 'connection', 'uiConversation', 'conversation', 'modules', 'loader', 'shortcuts', 'sidebarRight', 'sidebarRightTabs', 'fileUpload', 'fileDrag']

/** Consume the namespace installed by the source-session provider. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
    // Composition opt-in for ext 0004 (programmatic live-edge following). The
    // patched upstream ui-chat defaults to the stock behavior; only a shell that
    // marks its document root with the generic attribute enables the extra path.
    if (typeof document !== 'undefined'
        && Reflect.get(globalThis, '__hapiDshFollowEdgeDisabled') !== true) {
        try { document.documentElement.dataset.dshFollowEdge = '1' } catch { /* non-DOM composition */ }
    }
    // Pane graphs exclude this bundle and receive their context-bound
    // contributions from Federation, including exact source navigation.
    let preferenceStorage: Storage | undefined, windowStorage: Storage | undefined
    try { preferenceStorage = localStorage } catch { /* Preferences can remain in memory. */ }
    try { windowStorage = sessionStorage } catch { /* A window still has its own share owner. */ }
    const workspaceUi = createWorkspaceUiBridge(preferenceStorage, window, windowStorage, report => ctx.remote.hapi.uploadFailure(report))
    const unprovideUi = ctx.reflect.provide('hapiWorkspaceUi', workspaceUi.root)
    let child: ReturnType<Context['inject']> | undefined
    try {
        child = ctx.inject(['remote.hapi', 'remote.hhpi', 'remote.session', 'remote.appServices', 'remote.sourceNavigation', 'remote.sourceAliases', 'sessions', 'hhpiSessions', 'sourceFiles', 'hapiWorkspaceUi'], owner => installWorkspace(owner, workspaceUi))
        await child
        return async () => { try { await child?.dispose() } finally { unprovideUi(); await workspaceUi.dispose() } }
    } catch (error) {
        console.error('[hapi-dsh] Client activation failed: await the source provider and install workspace', error)
        try { await child?.dispose() } finally { unprovideUi(); await workspaceUi.dispose() }
        throw error
    }
}

function diagnosticMark(name: string): void {
    try { performance.clearMarks(name); performance.mark(name) } catch { /* diagnostics are optional */ }
}

async function installWorkspace(ctx: Context, workspaceUi: ReturnType<typeof createWorkspaceUiBridge>): Promise<() => Promise<void>> {
    const disposers: Array<() => void | Promise<void>> = []
    let disposed = false
    let stage = 'consume native API'
    try {
    const api = taggedRemote(ctx.remote.hapi)
    let storage: Storage | undefined
    try { storage = globalThis.localStorage } catch { /* The controller still works when browser persistence is unavailable. */ }
    stage = 'create workspace controller'
    const sourceQuery = new URL(location.href).searchParams
    const controller = new WorkspaceController({
        viewport: workspaceViewportPolicy(window.matchMedia(COMPACT_WORKSPACE_QUERY)),
        sourceExporter: createSessionSourceExporter(ctx.sessions, 'local', () => !disposed, ctx.remote.session, ctx.remote.hhpi),
        readHead: createSourceReadHead('local', ctx.remote.session, ctx.remote.hhpi),
        locateSourcePosition: (request, signal) => ctx.remote.sourceNavigation.locatePosition(request, signal),
        resumeContext: (request, signal) => ctx.remote.sourceNavigation.resumeContext(request, signal),
        sourceDirectories: (request, signal) => ctx.remote.sourceWorkspace.directories(request, signal),
        application: workspaceUi.root.application,
        sessions: ctx.sessions, sourceCreation: ctx.hhpiSessions, sourceActions: ctx.hhpiSessions.sourceActions, navigation: ctx.uiWorkspace, workspaceState: ctx.workspaces.list, workspaces: ctx.workspaces,
        directoryBrowsing: [...ctx.loader.entries()].some(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-directory-picker-browse'),
        deferHiddenSessions: true,
        storageKey: `hapi-dsh:workspace:v1:${location.origin}${location.pathname}`,
        ...(storage ? { storage } : {}),
        persistence: createWorkspacePersistence(api), reveal: () => ctx.layout.selectPanel(null),
        ...(sourceQuery.get('hapiSession') ? { sourceSessionQuery: sourceQuery.get('hapiSession')!,
            ...(sourceQuery.has('hapiMessage') ? { sourceMessageQuery: sourceQuery.get('hapiMessage')! } : {}),
            ...(sourceQuery.has('hapiRequest') ? { sourceRequestQuery: sourceQuery.get('hapiRequest')! } : {}),
            ...(sourceQuery.has('hapiHub') ? { sourceHubQuery: sourceQuery.get('hapiHub')! } : {}) } : {}),
        beforeRemove: resources => !resources.some(hasDirtyNativeDocument) || window.confirm(ctx.locale.bind('hapiWorkspace')('closeUnsavedDocument')),
    })
    ctx.reflect.provide('hapiWorkspace', controller)
    disposers.push(() => { controller.dispose() })
    const onPreference = (event: StorageEvent): void => {
        if (!event.storageArea || event.storageArea === storage) controller.sidebar.receiveOriginalPreference(event.key, event.newValue)
    }
    window.addEventListener('storage', onPreference)
    disposers.push(() => { window.removeEventListener('storage', onPreference) })
    stage = 'register workspace styles and locale'
    const composer = installSourceComposerBridge(ctx)
    disposers.push(() => composer.dispose())
    disposers.push(installWorkspaceStyles(document))
    disposers.push(installWorkspaceMenus(document))
    disposers.push(ctx.locale.register('hapiWorkspace', { en, zh }))
    // Page-global: covers local and remote Host panes. Automates the official
    // Load earlier control so upstream paging/anchoring stays authoritative.
    // The optional data seams below are only the public source facade's forward
    // page and explicit live-tail restore; they never write scroll state.
    type PagingControl = {
        cancelOlderPage?: (reason?: unknown) => void
        prefetchOlderPage?: () => unknown
        loadAfter?: () => Promise<boolean>
        returnToLive?: (signal?: AbortSignal) => boolean | Promise<boolean>
        sourceWindow?: { getSnapshot(): import('./source-session-types.ts').SourceWindowProgress; subscribe(listener: () => void): () => void }
    }
    const sourceControl = (sessionId: string | null, pane?: HTMLElement): PagingControl | undefined => {
        const reader = pane ? remoteReadingOwner(pane) : undefined
        if (reader) return reader.sessionId === sessionId ? reader : undefined
        if (!sessionId || isSourceSessionId(sessionId)) return undefined
        return ctx.sessions.binding(sessionId as SessionId)?.session as unknown as PagingControl | undefined
    }
    disposers.push(installSeamlessHistory(document, {
        loadEarlierLabel: () => ctx.locale.bind('chat')('chat.loadOlder'),
        loadOlderProgrammatically: async (pane, sessionId, signal) => {
            if (signal.aborted) return false
            const cancel = (): void => sourceControl(sessionId, pane)?.cancelOlderPage?.(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            try { return await requestOlderThroughMountedChat(resolveMountedChatForPane(pane), signal) }
            finally { signal.removeEventListener('abort', cancel) }
        },
        prefetchOlderPage: (sessionId, pane) => { void sourceControl(sessionId, pane)?.prefetchOlderPage?.() },
        cancelSourcePage: (sessionId, reason, pane) => { sourceControl(sessionId, pane)?.cancelOlderPage?.(reason) },
        sourceWindowProgress: (sessionId, pane) => {
            const value = sourceControl(sessionId, pane)?.sourceWindow?.getSnapshot()
            return value?.before === undefined ? undefined : { before: value.before,
                historyId: value.historyId, historyVersion: value.historyVersion, olderRevision: value.olderRevision }
        },
        subscribeSourceWindow: (sessionId, listener, pane) => sourceControl(sessionId, pane)?.sourceWindow?.subscribe(listener),
        loadAfter: async (pane, sessionId) => {
            const control = sourceControl(sessionId, pane)
            return control?.loadAfter ? await control.loadAfter() : false
        },
        returnToLive: async (pane, sessionId, signal) => {
            const control = resolveMountedChatLatestForPane(pane)
            if (control && await toLatestThroughMountedChat(control, signal)) return true
            return sourceControl(sessionId, pane)?.returnToLive?.(signal) ?? false
        },
    }))
    disposers.push(installSourceAppearance(ctx))
    const navigateSourceTarget = createAppTargetNavigation(controller)
    disposers.push(installSourceConversation(ctx, composer, {
        hostId: 'local', workspace: controller, navigate: (target, signal) => navigateSourceTarget(target, undefined, signal),
    }))
    disposers.push(installWorkspaceLinkSettings(ctx))
    disposers.push(installSourceTerminalActions(ctx))
    disposers.push(installSourceVoice(ctx, ctx.locale.getSnapshot().active))
    disposers.push(installNativeComposerAdmission(ctx.sessions, ctx.conversation.blocks, {
        t: ctx.locale.bind('hapiWorkspace'), subscribe: listener => ctx.locale.subscribe(listener),
    }))
    const prepareWorkspaceDeparture = async (): Promise<void> => {
        const ui = ctx.get('hapiWorkspaceUi')
        const tr = (en: string, zh: string): string => ctx.locale.getSnapshot().active.startsWith('zh') ? zh : en
        if (!ui) throw new Error(tr('The workspace editors are not ready.', '工作区编辑器尚未就绪。'))
        if (ui.voice.getSnapshot()) throw new Error(tr('Finish the active voice call before leaving the workspace.', '请先结束正在进行的语音通话，再离开工作区。'))
        if (controller.getSnapshot().creation) throw new Error(tr('Finish or close the new-session form before leaving the workspace.', '请先完成或关闭新建会话表单，再离开工作区。'))
        if (['loading', 'creating', 'inserting'].includes(ui.shareInbox.getSnapshot().phase)) throw new Error(tr('Wait for the incoming share to finish preparing.', '请等待正在接收的分享完成准备。'))
        await ui.updates.checkpoint()
    }
    const Root = (props: Omit<WorkspaceRootProps, 'controller' | 'language' | 'preferences' | 'prepareNavigation'>) => createElement(WorkspaceRoot, { ...props, controller, language: ctx.locale.getSnapshot().active, preferences: ctx.get('hapiWorkspaceUi')?.preferences, prepareNavigation: prepareWorkspaceDeparture })
    const Sidebar = (props: Omit<SessionSidebarProps, 'controller'>) => createElement(SessionSidebar, { ...props, controller })
    stage = 'register workspace slots'
    // Shadow one existing main cell while preserving official shell, plugin
    // pages, settings, overlays, and every Conversation factory contribution.
    disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'conversation', priority: -100, locale: 'hapiWorkspace',
    }, Root)))
    disposers.push(ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
        name: 'sidebar.workspaces', priority: -100, locale: 'hapiWorkspace',
    }, Sidebar)))
    // The target conversation must not wait for the independent sidebar
    // new-session adaptation. Start federation/local target first, then adapt
    // the official sidebar in the background; disposal awaits both.
    stage = 'start workspace federation'
    diagnosticMark('hapi-dsh:workspace:federation-start')
    disposers.push(installNewSessionShortcut(ctx.shortcuts, controller.requestNewSession))
    disposers.push(installFederation(ctx, controller, workspaceUi))
    disposers.push(installWorkspaceSharing(ctx, controller))
    disposers.push(installBrowserRecovery(ctx))
    disposers.push(ctx.hapiWorkspaceUi.updates.registerCheckpoint({ kind: 'workspace', label: 'Workspace layout',
        revision: () => controller.store.getSnapshot().revision, current: () => !disposed,
        save: signal => controller.checkpoint(signal) }))
    stage = 'bind official sidebar navigation'
    diagnosticMark('hapi-dsh:sidebar:start')
    const sidebarNavigation = installSidebarNavigation(ctx, controller)
    void sidebarNavigation.then(dispose => {
        diagnosticMark('hapi-dsh:sidebar:ready')
        return dispose
    }, error => {
        diagnosticMark('hapi-dsh:sidebar:failed')
        console.error('[hapi-dsh] official sidebar navigation adaption failed', error)
        controller.report(error)
    })
    disposers.push(async () => {
        try { await (await sidebarNavigation)?.() } catch { /* startup failure already reported */ }
    })
    disposers.push(installDeferredPlugins(ctx, undefined, workspaceDeferredDemand(controller)))
    disposers.push(installShareInbox(ctx, controller))
    disposers.push(installDraftHandoff(ctx, controller))
    const notifications = createWorkspaceNotifications(controller, createAppTargetNavigation(controller))
    disposers.push(() => { notifications.dispose() })
    disposers.push(installWorkspaceReadSync(controller, ctx.remote.appServices, ctx.hapiWorkspaceUi, notifications.readStatus, (ctx.get('connection') as ConnectionHandle).state))
    disposers.push(() => { ctx.hapiWorkspaceUi.application.clear(); ctx.hapiWorkspaceUi.shareInbox.setScope(undefined) })
    disposers.push(installSourceNotifications(ctx, ctx.remote.appServices, { ...notifications,
        onReady: (scope, deviceId) => {
            ctx.hapiWorkspaceUi.application.set(scope, deviceId)
            ctx.hapiWorkspaceUi.shareInbox.setScope(scope)
        }, armForReload: () => armOrdinaryReadingForReload(ctx.hapiWorkspaceUi.updates), prepareUpdate: async () => {
        const ui = ctx.get('hapiWorkspaceUi')
        if (!ui) throw new Error('The workspace editors are not ready.')
        if (ui.voice.getSnapshot()) throw new Error('Finish the active voice call before updating the workspace.')
        if (controller.getSnapshot().creation) throw new Error('Finish or close the new-session form before updating the workspace.')
        if (['loading', 'creating', 'inserting'].includes(ui.shareInbox.getSnapshot().phase)) throw new Error('Wait for the incoming share to finish preparing.')
        await ui.updates.checkpoint()
    } }))
    return async () => {
        if (disposed) return
        disposed = true
        for (const dispose of disposers.reverse()) await dispose()
    }
    } catch (error) {
        // The official loader deliberately presents a compact failed-entry
        // message. Preserve its original exception and the failing composition
        // stage for browser diagnostics without logging requests or credentials.
        console.error(`[hapi-dsh] Client activation failed: ${stage}`, error)
        for (const dispose of disposers.reverse()) {
            try { await dispose() } catch { /* Preserve the activation exception. */ }
        }
        throw error
    }
}
