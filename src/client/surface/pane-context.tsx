import { createContext, useContext, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspacePaneNavigation } from '../pane-navigation.ts'

/**
 * A shared Host graph has several session trees, so pane identity belongs to
 * the rendered occurrence. React portals preserve this provider. The legacy
 * graph capability remains a fallback for isolated plugin-view panes.
 */
const PaneContext = createContext<WorkspacePaneNavigation | undefined>(undefined)

export function WorkspacePaneProvider({ value, children }: {
    value: WorkspacePaneNavigation
    children?: ReactNode
}) {
    return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>
}

/** Resolve once in the component; callbacks retain their originating pane. */
export function useWorkspacePane(ctx: Pick<Context, 'get'>): WorkspacePaneNavigation | undefined {
    return useContext(PaneContext) ?? ctx.get('hapiWorkspacePane')
}

/** Shared conversation views use workspace navigation for graph-global tools. */
export function useSharedWorkspacePane(): WorkspacePaneNavigation | undefined {
    return useContext(PaneContext)
}
