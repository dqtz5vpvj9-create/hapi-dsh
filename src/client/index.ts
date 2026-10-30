import type { SourceViewportSession } from './source-sessions.ts'
import { remoteReadingOwner } from './remote-reading-owner.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
/** HAPI's workspace composition, loaded by DSH's unchanged official plugin runtime. */
import { taggedRemote } from '../client-api.ts'
import type { Context } from '@deepseek-ai/cordis'
import { createElement, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { WorkspaceController } from './controller.ts'
import { installFederation } from './federation.tsx'
import { en, zh } from './locales.ts'
import { NativeActionLedger } from './native-state.ts'
import { NativeControlLedger } from './native-control-state.ts'
import { NativeForkAction, type NativeForkActionProps } from './native-fork-action.tsx'
import { createNativeActions } from './native-action-api.ts'
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
import { installSourceReadSync } from '../workspace/read-sync.ts'
import { installNativeRewindAction } from './native-rewind-action.tsx'
import { installNativeComposerAdmission } from './native-composer.ts'
import { installPaneNative } from './pane-native.ts'
import type {} from './pane-navigation.ts'
import { installHapiTabs } from './hapi-tabs.tsx'
import { installSourceAdmin } from './source-admin.tsx'
import { installSourceCompanion } from './source-companion.tsx'
import { ObservedControlLedger } from './observed-controls.tsx'
import { installSourcePathActions } from './source-path-actions.tsx'
import { installSourceFileActions } from './source-file-actions.tsx'
import { installSourceTerminalActions } from './source-terminal-actions.tsx'
import { installLegacyTerminalView } from './legacy-terminal-view.tsx'
import { installArtifactPreview } from './artifact-preview.tsx'
import { installSourceMarkdown } from './source-markdown.tsx'
import { installNotifySummaryDisplay } from './notify-summary-display.tsx'
import { installSourceVoice } from './source-voice/index.tsx'
import { installGeneratedMediaDisplay } from './generated-media-display.tsx'
import { installToolProgressDisplay } from './tool-progress-display.tsx'
import { installCodexReviewDisplay } from './codex-review-display.tsx'
import { installNativeActionDock } from './native-action-dock.tsx'
import { installSourceUsage } from './source-usage.tsx'
import { installComposerPicker } from './composer-picker/index.tsx'
import { installTurnSharing } from './turn-share.tsx'
import { installSourceNotifications } from './source-notifications/index.tsx'
import { installWithLegacyHapiCapability } from './source-notifications/capability.ts'
import type {} from './remote-sessions.ts'
import { installSourceDshChildControls } from './source-dsh-child.tsx'
import { createWorkspaceNotifications } from '../workspace/notifications.ts'
import { installShareInbox } from './share-inbox.tsx'
import { installDraftHandoff } from './draft-handoff-dialog.tsx'
import { installSourceAppearance } from './appearance/index.tsx'
import { installWorkspaceLinkSettings } from './workspace-links.tsx'
import { installDeferredPlugins } from './deferred-plugins.ts'
import { installRemoteSourceControls } from './remote-controls.tsx'

export { WorkspaceController, sessionResourceId, parseSessionResourceId } from './controller.ts'
export type { WorkspaceHost, WorkspaceOptions, WorkspaceSnapshot, WorkspacePersistence } from './controller.ts'
export { WorkspaceStore, parseWorkspaceState } from './model.ts'
export type { WorkspaceState } from './model.ts'
export { installRemotePane } from './remote-pane.tsx'
export type { WorkspacePaneNavigation } from './pane-navigation.ts'
export type { WorkspaceUpdatePreparations } from './update-preparation.ts'
export type { DshPaneTarget, NavigationValue } from '../workspace/dsh-view.ts'
export { LEGACY_TERMINAL_TAB_KIND, LEGACY_TERMINAL_SEAT_ID, legacyTerminalPaneTarget, legacyTerminalNavigationParams, canOpenLegacyTerminalAddress } from './legacy-session-terminal.tsx'
export type { LegacyTerminalParams } from './legacy-session-terminal.tsx'
export type { LegacyTerminalInjected, LegacyTerminalBodyProps, LegacyTerminalTitleProps, LegacyTerminalOccurrence, LegacyTerminalViewState } from './legacy-terminal-view.tsx'

declare module '@deepseek-ai/cordis' {
    interface Context { hapiWorkspace: WorkspaceController }
}

export const name = 'hapi-dsh-client'
export const inject = ['slots', 'sessions', 'hapiSourceSessions', 'hhpiSessions', 'workspaces', 'uiWorkspace', 'layout', 'locale', 'remote', 'uiConversation', 'conversation', 'modules', 'loader', 'shortcuts', 'sidebarRight', 'sidebarRightTabs', 'fileUpload']

/** Consume the namespace installed by the source-session provider. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
    // Composition opt-in for ext 0004 (programmatic live-edge following). The
    // patched upstream ui-chat defaults to the stock behavior; only a shell that
    // marks its document root with the generic attribute enables the extra path.
    if (typeof document !== 'undefined'
        && Reflect.get(globalThis, '__hapiDshFollowEdgeDisabled') !== true) {
        try { document.documentElement.dataset.dshFollowEdge = '1' } catch { /* non-DOM composition */ }
    }
    // Pane graphs exclude this bundle; this branch only remains for the primary
    // graph and for profiles that still scan the row.
    if (Reflect.get(globalThis, '__HAPI_DSH_PANE__') === true) {
        let child: ReturnType<Context['inject']> | undefined
        try {
            child = ctx.inject(['remote.hapi', 'sessions', 'hhpiSessions'], installPaneNative)
            await child
            return async () => { await child?.dispose() }
        } catch (error) {
            await child?.dispose()
            throw error
        }
    }
    let child: ReturnType<Context['inject']> | undefined
    try {
        child = ctx.inject(['remote.hapi', 'sessions', 'hhpiSessions'], installWorkspace)
        await child
        return async () => { await child?.dispose() }
    } catch (error) {
        console.error('[hapi-dsh] Client activation failed: await the source provider and install workspace', error)
        await child?.dispose()
        throw error
    }
}

function diagnosticMark(name: string): void {
    try { performance.clearMarks(name); performance.mark(name) } catch { /* diagnostics are optional */ }
}

function attachSourceSessions(ctx: Context, api: HapiRemoteApi): void {
    ctx.hapiSourceSessions.attach({
        sourceWindowFollow: (request, signal) => api.sourceWindowFollow(request, signal),
        sourceHistoryOutline: request => api.sourceHistoryOutline(request),
        sourceHistoryOutlinePage: request => api.sourceHistoryOutlinePage(request),
        sourceHistoryWindowPage: request => api.sourceHistoryWindowPage(request),
        sourceHistoryWindowPageStream: (request, signal) => api.sourceHistoryWindowPageStream(request, signal),
        sourceHistoryHead: request => api.sourceHistoryHead(request),
        sourceHistoryAttachment: request => api.sourceHistoryAttachment(request),
        sourceReadingAnchor: request => api.sourceReadingAnchor(request),
    })
}

async function installWorkspace(ctx: Context): Promise<() => Promise<void>> {
    const disposers: Array<() => void | Promise<void>> = []
    let stage = 'consume native API'
    try {
    const api = taggedRemote(ctx.remote.hapi)
    const sourceCapability = ctx.hhpiSessions.capabilities
    let administration: ReturnType<typeof installSourceAdmin> | undefined
    attachSourceSessions(ctx, api)
    const ledger = new NativeActionLedger()
    const controls = new NativeControlLedger(api)
    const observedControls = new ObservedControlLedger(api)
    disposers.push(() => { ledger.clear(); controls.clear(); observedControls.clear() })
    const native = createNativeActions(ctx, api, ledger, controls, observedControls)
    let storage: Storage | undefined
    try { storage = globalThis.localStorage } catch { /* The controller still works when browser persistence is unavailable. */ }
    stage = 'create workspace controller'
    const sourceQuery = new URL(location.href).searchParams
    const controller = new WorkspaceController({
        sessions: ctx.sessions, navigation: ctx.uiWorkspace, workspaceState: ctx.workspaces.list, workspaces: ctx.workspaces,
        deferHiddenSessions: true,
        storageKey: `hapi-dsh:workspace:v1:${location.origin}${location.pathname}`,
        ...(storage ? { storage } : {}),
        persistence: createWorkspacePersistence(api), reveal: () => ctx.layout.selectPanel(null),
        legacy: async signal => { signal.throwIfAborted(); const result = remoteValue(await api.workspaceLegacy()); signal.throwIfAborted(); return result },
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
    disposers.push(installWorkspaceStyles(document))
    disposers.push(installRemoteSourceControls(ctx))
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
        sourceWindow?: { getSnapshot(): import('../shared/source-frames.ts').SourceWindowProgress; subscribe(listener: () => void): () => void }
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
    disposers.push(installWithLegacyHapiCapability(sourceCapability, () => {
        const installed: Array<() => void> = []
        installed.push(installHapiTabs(ctx, api))
        administration = installSourceAdmin(ctx, api)
        installed.push(administration)
        installed.push(installSourceCompanion(ctx, api))
        installed.push(installNativeRewindAction(ctx, api, () => { void controller.refresh() }))
        return () => {
            for (const dispose of installed.reverse()) dispose()
            administration = undefined
        }
    }))
    disposers.push(installSourceAppearance(ctx))
    disposers.push(installWorkspaceLinkSettings(ctx))
    disposers.push(installSourcePathActions(ctx, api))
    disposers.push(installSourceFileActions(ctx, api))
    disposers.push(installSourceTerminalActions(ctx, api))
    disposers.push(installLegacyTerminalView(ctx, api))
    disposers.push(installArtifactPreview(ctx, api))
    disposers.push(installSourceMarkdown(ctx))
    disposers.push(installNotifySummaryDisplay(ctx, api))
    disposers.push(installSourceVoice(ctx, api))
    disposers.push(installGeneratedMediaDisplay(ctx))
    disposers.push(installToolProgressDisplay(ctx))
    disposers.push(installCodexReviewDisplay(ctx))
    disposers.push(installNativeActionDock(ctx, native, api))
    disposers.push(installSourceUsage(ctx))
    disposers.push(installComposerPicker(ctx, controls, observedControls))
    disposers.push(installSourceDshChildControls(ctx, api))
    disposers.push(installTurnSharing(ctx))
    disposers.push(installNativeComposerAdmission(ctx.sessions, ctx.conversation.blocks, {
        t: ctx.locale.bind('hapiWorkspace'), subscribe: listener => ctx.locale.subscribe(listener),
    }))
    const uploadInitialFile = async (sessionId: string, file: File, signal?: AbortSignal) => remoteValue(await ctx.fileUpload.upload(sessionId as SessionId, file, file.name, signal))
    const prepareWorkspaceDeparture = async (): Promise<void> => {
        const ui = ctx.get('hapiWorkspaceUi')
        const tr = (en: string, zh: string): string => ctx.locale.getSnapshot().active.startsWith('zh') ? zh : en
        if (!ui) throw new Error(tr('The workspace editors are not ready.', '工作区编辑器尚未就绪。'))
        if (ui.voice.getSnapshot()) throw new Error(tr('Finish the active voice call before leaving the workspace.', '请先结束正在进行的语音通话，再离开工作区。'))
        if (controller.getSnapshot().creation) throw new Error(tr('Finish or close the new-session form before leaving the workspace.', '请先完成或关闭新建会话表单，再离开工作区。'))
        if (['loading', 'creating', 'inserting'].includes(ui.shareInbox.getSnapshot().phase)) throw new Error(tr('Wait for the incoming share to finish preparing.', '请等待正在接收的分享完成准备。'))
        await ui.updates.checkpoint()
    }
    const RunnerSkew = () => {
        const capability = useSyncExternalStore(sourceCapability.subscribe, sourceCapability.getSnapshot)
        return capability.catalogReady && capability.legacyHapi && administration
            ? createElement(administration.RunnerSkew) : null
    }
    const Root = (props: Omit<WorkspaceRootProps, 'controller' | 'api' | 'language' | 'uploadInitialFile' | 'preferences' | 'prepareNavigation' | 'runnerSkew'>) => createElement(WorkspaceRoot, { ...props, controller, api, language: ctx.locale.getSnapshot().active, uploadInitialFile, preferences: ctx.get('hapiWorkspaceUi')?.preferences, prepareNavigation: prepareWorkspaceDeparture, runnerSkew: createElement(RunnerSkew) })
    const Sidebar = (props: Omit<SessionSidebarProps, 'controller' | 'controls' | 'api'>) => createElement(SessionSidebar, { ...props, controller, controls, api })
    stage = 'register workspace slots'
    // Shadow one existing main cell while preserving official shell, plugin
    // pages, settings, overlays, and every Conversation factory contribution.
    disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'conversation', priority: -100, locale: 'hapiWorkspace',
    }, Root)))
    disposers.push(ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
        name: 'sidebar.workspaces', priority: -100, locale: 'hapiWorkspace',
    }, Sidebar)))
    disposers.push(ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark', priority: -100 },
        ({ size }) => createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
            createElement('path', { d: 'M3 3h18v18H3zM12 3v18M3 12h18' })))))
    disposers.push(ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', priority: -100 },
        () => createElement('strong', { style: { fontSize: 16, letterSpacing: '-.02em' } }, 'HAPI'))))
    const Fork = (props: Omit<NativeForkActionProps, 'controls' | 'open'>) => createElement(NativeForkAction, { ...props, controls, open: sessionId => {
        void controller.refresh(); controller.openSession(sessionId, 'horizontal')
    } })
    disposers.push(ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions', id: 'hapi.native-fork', order: 100, locale: 'hapiWorkspace',
    }, Fork)))
    // The target conversation must not wait for the independent sidebar
    // new-session adaptation. Start federation/local target first, then adapt
    // the official sidebar in the background; disposal awaits both.
    stage = 'start workspace federation'
    diagnosticMark('hapi-dsh:workspace:federation-start')
    disposers.push(installNewSessionShortcut(ctx.shortcuts, controller.requestNewSession))
    disposers.push(installFederation(ctx, controller))
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
    disposers.push(installDeferredPlugins(ctx))
    disposers.push(installShareInbox(ctx, controller))
    disposers.push(installDraftHandoff(ctx, controller))
    const notifications = createWorkspaceNotifications(controller)
    disposers.push(() => { notifications.dispose() })
    disposers.push(installWithLegacyHapiCapability(sourceCapability, () => {
        const installed: Array<() => void> = [installSourceReadSync(controller, api, notifications.readStatus)]
        installed.push(installSourceNotifications(ctx, api, { ...notifications, prepareUpdate: async () => {
            const ui = ctx.get('hapiWorkspaceUi')
            if (!ui) throw new Error('The workspace editors are not ready.')
            if (ui.voice.getSnapshot()) throw new Error('Finish the active voice call before updating the workspace.')
            if (controller.getSnapshot().creation) throw new Error('Finish or close the new-session form before updating the workspace.')
            if (['loading', 'creating', 'inserting'].includes(ui.shareInbox.getSnapshot().phase)) throw new Error('Wait for the incoming share to finish preparing.')
            await ui.updates.checkpoint()
        } }))
        return () => { for (const dispose of installed.reverse()) dispose() }
    }))
    let disposed = false
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
