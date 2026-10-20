/** HAPI's workspace composition, loaded by DSH's unchanged official plugin runtime. */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { HAPI_REMOTE, remoteValue } from '../client-api.ts'
import { WorkspaceController } from './controller.ts'
import { installFederation } from './federation.tsx'
import { en, zh } from './locales.ts'
import { NativeActionLedger } from './native-state.ts'
import { NativeControlLedger } from './native-control-state.ts'
import { NativeForkAction, type NativeForkActionProps } from './native-fork-action.tsx'
import type { NativeActionsApi } from './native-actions.tsx'
import { createWorkspacePersistence } from './persistence.ts'
import { ConversationPane, SessionSidebar, WorkspaceRoot } from './ui.tsx'
import type { ConversationPaneProps, SessionSidebarProps, WorkspaceRootProps } from './slots.ts'
import { installWorkspaceStyles } from './styles.ts'
import { installSidebarNavigation } from './sidebar-navigation.ts'
import { installWorkspaceMenus } from './menus.ts'
import { installNewSessionShortcut } from './shortcuts.ts'
import { installNativeComposerAdmission } from './native-composer.ts'

export { WorkspaceController, sessionResourceId, parseSessionResourceId } from './controller.ts'
export type { WorkspaceHost, WorkspaceOptions, WorkspaceSnapshot, WorkspacePersistence } from './controller.ts'
export { WorkspaceStore, parseWorkspaceState } from './model.ts'
export type { WorkspaceState } from './model.ts'
export { installRemotePane } from './remote-pane.tsx'

declare module '@deepseek-ai/cordis' {
    interface Context { hapiWorkspace: WorkspaceController }
}

export const name = 'hapi-dsh-client'
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'locale', 'remote', 'uiConversation', 'conversation', 'modules', 'loader', 'shortcuts']

/** Mount the namespace first, then consume it in an explicit Cordis inject scope. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
    let unmount: (() => Promise<void>) | undefined
    let child: ReturnType<Context['inject']> | undefined
    try {
        unmount = await ctx.remote.$mount(HAPI_REMOTE)
        child = ctx.inject(['remote.hapi'], installWorkspace)
        await child
        return async () => { await child?.dispose(); await unmount?.() }
    } catch (error) {
        console.error('[hapi-dsh] Client activation failed: mount native API and injected consumer', error)
        await child?.dispose(); await unmount?.()
        throw error
    }
}

async function installWorkspace(ctx: Context): Promise<() => Promise<void>> {
    const disposers: Array<() => void | Promise<void>> = []
    let stage = 'consume native API'
    try {
    const api = ctx.remote.hapi
    const ledger = new NativeActionLedger()
    const controls = new NativeControlLedger(api)
    disposers.push(() => { ledger.clear(); controls.clear() })
    const native: NativeActionsApi = {
        ledger, controls, branchLabel: () => ctx.locale.bind('chat')('message.branch'),
        cancel: async (sessionId, localId) => remoteValue(await api.nativeCancel({ sessionId, localId })),
        steer: async (sessionId, localId) => remoteValue(await api.nativeSteer({ sessionId, localId })),
        retry: async (sessionId, localId) => remoteValue(await api.nativeRetry({ sessionId, localId })),
        answer: async (sessionId, requestId, answer, deny) => remoteValue(await api.nativeAnswer({ sessionId, requestId, answer, ...(deny === undefined ? {} : { deny }) })),
        resume: async sessionId => remoteValue(await api.resumeSession({ sessionId })),
    }
    let storage: Storage | undefined
    try { storage = globalThis.localStorage } catch { /* The controller still works when browser persistence is unavailable. */ }
    stage = 'create workspace controller'
    const controller = new WorkspaceController({
        sessions: ctx.sessions, navigation: ctx.uiWorkspace, workspaceState: ctx.workspaces.list, workspaces: ctx.workspaces,
        storageKey: `hapi-dsh:workspace:v1:${location.origin}${location.pathname}`,
        ...(storage ? { storage } : {}),
        persistence: createWorkspacePersistence(api), reveal: () => ctx.layout.selectPanel(null),
    })
    ctx.reflect.provide('hapiWorkspace', controller)
    disposers.push(() => { controller.dispose() })
    stage = 'register workspace styles and locale'
    disposers.push(installWorkspaceStyles(document))
    disposers.push(installWorkspaceMenus(document))
    disposers.push(ctx.locale.register('hapiWorkspace', { en, zh }))
    disposers.push(installNativeComposerAdmission(ctx.sessions, ctx.conversation.blocks, {
        t: ctx.locale.bind('hapiWorkspace'), subscribe: listener => ctx.locale.subscribe(listener),
    }))
    const Root = (props: Omit<WorkspaceRootProps, 'controller' | 'api'>) => createElement(WorkspaceRoot, { ...props, controller, api })
    const Sidebar = (props: Omit<SessionSidebarProps, 'controller' | 'controls'>) => createElement(SessionSidebar, { ...props, controller, controls })
    const Pane = (props: Omit<ConversationPaneProps, 'native'>) => createElement(ConversationPane, { ...props, native })
    stage = 'register workspace slots'
    // Shadow one existing main cell while preserving official shell, plugin
    // pages, settings, overlays, and every Conversation factory contribution.
    disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'conversation', priority: -100, locale: 'hapiWorkspace',
        children: { 'hapi.workspace.conversation': { kind: 'single', scope: 'session' } },
    }, Root)))
    disposers.push(ctx.slots.inject('hapi.workspace.conversation', () => ctx.slots.register({
        name: 'hapi.workspace.conversation', locale: 'hapiWorkspace',
    }, Pane)))
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
