import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceController } from './controller.ts'
import type { NativeActionsApi } from './native-actions.tsx'
import type {} from './locales.ts'
import type { HapiRemoteApi } from '../client-api.ts'
import type { NativeControlLedger } from './native-control-state.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'hapi.workspace.conversation': { kind: 'single'; scope: 'session' }
    }
}

export type WorkspaceRootProps = PropsRuntime<'main'> & PropsRenderSlots<'hapi.workspace.conversation'>
    & PropsLocale<'hapiWorkspace'> & { controller: WorkspaceController; api: HapiRemoteApi }
export type SessionSidebarProps = PropsRuntime<'sidebar.workspaces'> & PropsLocale<'hapiWorkspace'>
    & { wide: boolean; expandSidebar: () => void; controller: WorkspaceController; controls?: NativeControlLedger }
export type ConversationPaneProps = PropsRuntime<'hapi.workspace.conversation'> & PropsRenderFactories
    & PropsLocale<'hapiWorkspace'> & { native: NativeActionsApi }
