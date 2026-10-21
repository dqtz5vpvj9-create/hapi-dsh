/** HAPI's workspace composition, loaded by DSH's unchanged official plugin runtime. */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { HAPI_REMOTE, remoteValue } from '../client-api.ts'
import { WorkspaceController } from './controller.ts'
import { installFederation } from './federation.tsx'
import { en, zh } from './locales.ts'
import { NativeActionLedger } from './native-state.ts'
import { NativeControlLedger } from './native-control-state.ts'
import { NativeForkAction, type NativeForkActionProps } from './native-fork-action.tsx'
import type { NativeActionsApi } from './native-actions.tsx'
import { createWorkspacePersistence } from './persistence.ts'
import { SessionSidebar, WorkspaceRoot } from './ui.tsx'
import type { SessionSidebarProps, WorkspaceRootProps } from './slots.ts'
import { installWorkspaceStyles } from './styles.ts'
import { installSidebarNavigation } from './sidebar-navigation.ts'
import { installWorkspaceMenus } from './menus.ts'
import { installNewSessionShortcut } from './shortcuts.ts'
import { hasDirtyNativeDocument } from './workbench-drafts.ts'
import { installSourceReadSync } from '../workspace/read-sync.ts'
import { installNativeRewindAction } from './native-rewind-action.tsx'
import { installNativeComposerAdmission } from './native-composer.ts'
import { installNativeIntegration } from './native-integration.tsx'
import type {} from './pane-navigation.ts'
import { installHapiTabs } from './hapi-tabs.tsx'
import { installSourceAdmin } from './source-admin.tsx'
import { ObservedControlLedger } from './observed-controls.tsx'
import { installSourcePathActions } from './source-path-actions.tsx'
import { installSourceFileActions } from './source-file-actions.tsx'
import { installSourceTerminalActions } from './source-terminal-actions.tsx'
import { installArtifactPreview } from './artifact-preview.tsx'
import { installSourceMarkdown } from './source-markdown.tsx'
import { installNotifySummaryDisplay } from './notify-summary-display.tsx'
import { installSourceVoice } from './source-voice/index.tsx'
import { installGeneratedMediaDisplay } from './generated-media-display.tsx'
import { installToolProgressDisplay } from './tool-progress-display.tsx'
import { installCodexReviewDisplay } from './codex-review-display.tsx'
import { installNativeActionDock } from './native-action-dock.tsx'
import { installTurnSharing } from './turn-share.tsx'
import { installSourceNotifications } from './source-notifications/index.tsx'
import { installSourceDshChildControls } from './source-dsh-child.tsx'
import { createWorkspaceNotifications } from '../workspace/notifications.ts'
import { installShareInbox } from './share-inbox.tsx'
import { installDraftHandoff } from './draft-handoff-dialog.tsx'
import { installSourceAppearance } from './appearance/index.tsx'

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
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'locale', 'remote', 'uiConversation', 'conversation', 'modules', 'loader', 'shortcuts', 'sidebarRight', 'sidebarRightTabs', 'fileUpload']

/** Mount the namespace first, then consume it in an explicit Cordis inject scope. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
    let unmount: (() => Promise<void>) | undefined
    let child: ReturnType<Context['inject']> | undefined
    try {
        unmount = await ctx.remote.$mount(HAPI_REMOTE)
        const paneMode = Reflect.get(globalThis, '__HAPI_DSH_PANE__') === true
        child = ctx.inject(['remote.hapi'], paneMode ? installPaneNative : installWorkspace)
        await child
        return async () => { await child?.dispose(); await unmount?.() }
    } catch (error) {
        console.error('[hapi-dsh] Client activation failed: mount native API and injected consumer', error)
        await child?.dispose(); await unmount?.()
        throw error
    }
}

/** The same plugin entry runs in pane graphs without creating a second shell. */
function installPaneNative(ctx: Context): () => void {
    const unlocale = ctx.locale.register('hapiWorkspace', { en, zh })
    const unstyle = installWorkspaceStyles(document)
    const integration = installNativeIntegration(ctx, ctx.remote.hapi, sessionId => {
        // A source fork is a new conversation, so the pane graph's own official
        // navigation emits the selection which its outer workspace observes.
        void ctx.sessions.refresh().then(() => ctx.uiWorkspace.openSession(sessionId as never))
    }, () => { void ctx.sessions.refresh() })
    const unprovide = ctx.reflect.provide('hapiPaneNative', integration)
    const untabs = installHapiTabs(ctx, ctx.remote.hapi)
    const unadmin = installSourceAdmin(ctx, ctx.remote.hapi)
    return () => { unadmin(); untabs(); integration.dispose(); unstyle(); unlocale(); void unprovide() }
}

async function installWorkspace(ctx: Context): Promise<() => Promise<void>> {
    const disposers: Array<() => void | Promise<void>> = []
    let stage = 'consume native API'
    try {
    const api = ctx.remote.hapi
    const ledger = new NativeActionLedger()
    const controls = new NativeControlLedger(api)
    const observedControls = new ObservedControlLedger(api)
    disposers.push(() => { ledger.clear(); controls.clear(); observedControls.clear() })
    const native: NativeActionsApi = {
        ledger, controls, observedControls, branchLabel: () => ctx.locale.bind('chat')('message.branch'),
        cancel: async (sessionId, localId) => remoteValue(await api.nativeCancel({ sessionId, localId })),
        steer: async (sessionId, localId) => remoteValue(await api.nativeSteer({ sessionId, localId })),
        retry: async (sessionId, localId) => remoteValue(await api.nativeRetry({ sessionId, localId })),
        answer: async (sessionId, requestId, answer, deny) => remoteValue(await api.nativeAnswer({ sessionId, requestId, answer, ...(deny === undefined ? {} : { deny }) })),
        resume: async sessionId => remoteValue(await api.resumeSession({ sessionId })),
    }
    let storage: Storage | undefined
    try { storage = globalThis.localStorage } catch { /* The controller still works when browser persistence is unavailable. */ }
    stage = 'create workspace controller'
    const sourceQuery = new URL(location.href).searchParams
    const controller = new WorkspaceController({
        sessions: ctx.sessions, navigation: ctx.uiWorkspace, workspaceState: ctx.workspaces.list, workspaces: ctx.workspaces,
        storageKey: `hapi-dsh:workspace:v1:${location.origin}${location.pathname}`,
        ...(storage ? { storage } : {}),
        persistence: createWorkspacePersistence(api), reveal: () => ctx.layout.selectPanel(null),
        legacy: async signal => { signal.throwIfAborted(); const result = remoteValue(await api.workspaceLegacy()); signal.throwIfAborted(); return result },
        ...(sourceQuery.get('hapiSession') ? { sourceSessionQuery: sourceQuery.get('hapiSession')!,
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
    disposers.push(installWorkspaceMenus(document))
    disposers.push(ctx.locale.register('hapiWorkspace', { en, zh }))
    disposers.push(installHapiTabs(ctx, api))
    disposers.push(installSourceAdmin(ctx, api))
    disposers.push(installSourceAppearance(ctx))
    disposers.push(installSourcePathActions(ctx, api))
    disposers.push(installSourceFileActions(ctx, api))
    disposers.push(installSourceTerminalActions(ctx, api))
    disposers.push(installArtifactPreview(ctx, api))
    disposers.push(installSourceMarkdown(ctx))
    disposers.push(installNotifySummaryDisplay(ctx, api))
    disposers.push(installSourceVoice(ctx, api))
    disposers.push(installGeneratedMediaDisplay(ctx))
    disposers.push(installToolProgressDisplay(ctx))
    disposers.push(installCodexReviewDisplay(ctx))
    disposers.push(installNativeActionDock(ctx, native, api))
    disposers.push(installSourceDshChildControls(ctx, api))
    disposers.push(installTurnSharing(ctx))
    disposers.push(installNativeComposerAdmission(ctx.sessions, ctx.conversation.blocks, {
        t: ctx.locale.bind('hapiWorkspace'), subscribe: listener => ctx.locale.subscribe(listener),
    }))
    const uploadInitialFile = async (sessionId: string, file: File, signal?: AbortSignal) => remoteValue(await ctx.fileUpload.upload(sessionId as SessionId, file, file.name, signal))
    const Root = (props: Omit<WorkspaceRootProps, 'controller' | 'api' | 'language' | 'uploadInitialFile' | 'preferences'>) => createElement(WorkspaceRoot, { ...props, controller, api, language: ctx.locale.getSnapshot().active, uploadInitialFile, preferences: ctx.get('hapiWorkspaceUi')?.preferences })
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
    const Fork = (props: Omit<NativeForkActionProps, 'controls' | 'open'>) => createElement(NativeForkAction, { ...props, controls, open: sessionId => {
        void controller.refresh(); controller.openSession(sessionId, 'horizontal')
    } })
    disposers.push(ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions', id: 'hapi.native-fork', order: 100, locale: 'hapiWorkspace',
    }, Fork)))
    stage = 'bind official sidebar navigation'
    disposers.push(await installSidebarNavigation(ctx, controller))
    disposers.push(installNewSessionShortcut(ctx.shortcuts, controller.requestNewSession))
    disposers.push(installFederation(ctx, controller))
    disposers.push(installShareInbox(ctx, controller))
    disposers.push(installDraftHandoff(ctx, controller))
    const notifications = createWorkspaceNotifications(controller)
    disposers.push(() => { notifications.dispose() })
    disposers.push(installSourceReadSync(controller, api, notifications.readStatus))
    disposers.push(installSourceNotifications(ctx, api, { ...notifications, prepareUpdate: async () => {
        const ui = ctx.get('hapiWorkspaceUi')
        if (!ui) throw new Error('The workspace editors are not ready.')
        if (ui.voice.getSnapshot()) throw new Error('Finish the active voice call before updating the workspace.')
        if (controller.getSnapshot().creation) throw new Error('Finish or close the new-session form before updating the workspace.')
        if (['loading', 'creating', 'inserting'].includes(ui.shareInbox.getSnapshot().phase)) throw new Error('Wait for the incoming share to finish preparing.')
        await ui.updates.checkpoint()
    } }))
    disposers.push(installNativeRewindAction(ctx, api, () => { void controller.refresh() }))
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
