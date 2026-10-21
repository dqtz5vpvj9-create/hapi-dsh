import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceController } from './controller.ts'
import type {} from './locales.ts'
import type { HapiRemoteApi } from '../client-api.ts'
import type { NativeControlLedger } from './native-control-state.ts'
import type { InitialFileUpload } from './initial-task.ts'
import type { WorkspaceUiPreferences } from './ui-preferences.ts'

export type WorkspaceRootProps = PropsRuntime<'main'>
    & PropsLocale<'hapiWorkspace'> & { controller: WorkspaceController; api: HapiRemoteApi; language: string; uploadInitialFile: InitialFileUpload; preferences?: WorkspaceUiPreferences | undefined; prepareNavigation?: (() => Promise<void>) | undefined }
export type SessionSidebarProps = PropsRuntime<'sidebar.workspaces'> & PropsLocale<'hapiWorkspace'>
    & { wide: boolean; expandSidebar: () => void; controller: WorkspaceController; api: HapiRemoteApi; controls?: NativeControlLedger }
