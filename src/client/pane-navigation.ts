import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DshPaneTarget, NavigationValue } from '../workspace/dsh-view.ts'
import type { SplitAxis } from './model.ts'
import type { WorkspaceUiScope } from './workspace-ui.ts'
import type { WorkspaceCatalogRow } from './controller.ts'

/**
 * Optional embedding capability available to ordinary DSH plugins. Rendering
 * registrations still use sidebarRightTabs and the official slot registry.
 * These methods only choose where an existing DSH view is displayed.
 */
export interface WorkspacePaneNavigation extends WorkspaceUiScope {
    readonly paneId: string
    readonly hostId: string
    readonly state: ObservableSnapshot<{ focused: boolean; visible: boolean }>
    /** Read-only source metadata from the unified catalog, never a foreign SessionReference. */
    readonly catalog: ObservableSnapshot<WorkspaceCatalogRow | undefined>
    /** Veto removal/replacement of this pane's view; hiding or moving does not close it. */
    registerCloseGuard(guard: () => boolean): () => void
    /** Retain this own input graph until a source-successor draft CAS settles.
     * Removing its visual pane still hides it and disables navigation. */
    retainForDraftTransfer(): () => void
    /** Only call after a confirmed source operation returns a ready successor. */
    openSuccessor(displaySessionId: string): Promise<void>
    /** Reveal this graph's own unchanged Conversation, retaining every tab. */
    revealConversation(): void
    openResource(address: string, options?: { kind?: string; params?: NavigationValue; beside?: SplitAxis }): void
    openTab(kind: string, options?: { address?: string; params?: NavigationValue; beside?: SplitAxis; title?: string }): void
    openPanel(panelId: string, options?: { beside?: SplitAxis }): void
    /** Copy a real occurrence's navigation into a workspace pane. */
    openView(target: DshPaneTarget, options?: { beside?: SplitAxis; title?: string }): void
}

declare module '@deepseek-ai/cordis' {
    interface Context { hapiWorkspacePane: WorkspacePaneNavigation }
}
