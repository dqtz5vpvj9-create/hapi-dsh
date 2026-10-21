/**
 * Internal seams of the pane surface ("TMUX for DSH").
 *
 * The pane surface owns the *workspace* around an official Client graph: which
 * official plugin rows a pane boots, how the window-level chrome is shared, and
 * which HAPI surfaces are installed inside a pane graph. It does not own the
 * Conversation renderer itself; the official AppFrame is still the only public
 * seat from which the official `main.conversation` tree can be rendered.
 *
 * These contracts stay inside this single plugin package. They exist so that
 * federation, the pane graph policy, and the pane chrome policy can be changed
 * and tested independently instead of growing one module.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One official Host whose graph a pane can boot. */
export interface PaneHost {
    /** Federation identity: `local` for the primary Host, otherwise the paired Host id. */
    readonly hostId: string
    /** Human-readable Host label used in status and diagnostics. */
    readonly hostLabel: string
    /** Prefix under which every Host request is mounted. */
    readonly basePath: string
}

/**
 * Durable identity of a pane's resource. The Host identity is part of the
 * address, so equal session ids on two machines never collide.
 */
export interface SessionSource {
    readonly hostId: string
    readonly sessionId: SessionId
}

/**
 * One mounted official conversation surface. A session view is tied to exactly
 * one official Client Context and one retained SessionReference; the workspace
 * moves the surface element, never the graph identity.
 */
export interface SessionView {
    readonly source: SessionSource
    readonly reference: SessionReference
    readonly context: Context
    dispose(): Promise<void>
}

/**
 * A pane graph policy decides which official rows one pane boots and how the
 * shared Host event stream is projected onto that subset. The primary graph and
 * catalog graphs use the unchanged Host graph.
 */
export interface PaneGraphPolicy {
    /** Row ids the pane never evaluates. Data-driven; see `paneBootGraph`. */
    readonly exclude: ReadonlySet<string>
    /** Project the unchanged Host graph onto the pane subset. */
    transform(graph: WebBootGraph): WebBootGraph
}

/**
 * Chrome ownership for a window that hosts several pane graphs.
 *
 * - `window`: one owner per browser window, owned by the primary graph (unified
 *   session sidebar, window tabs, plugin pages, global tools). Panes never
 *   render a second copy.
 * - `focused-pane`: owned by the pane graph that currently has focus. This is
 *   the official right column (Files/Document/Terminal tabs), the settings
 *   modal, and third-party dialogs; keeping them inside the pane graph preserves
 *   per-pane isolation and their original Context ownership.
 * - `deferred`: inapplicable inside a pane until a public upstream seam exists;
 *   the pane renders the official conversation only.
 */
export interface ChromeOwnership {
    readonly sidebar: 'window'
    readonly windowTabs: 'window'
    readonly globalTools: 'window'
    readonly rightbar: 'focused-pane'
    readonly settings: 'focused-pane'
    readonly dialogs: 'focused-pane'
    readonly pluginPages: 'deferred'
}

/** The one supported chrome ownership table for the current upstream pin. */
export const CHROME_OWNERSHIP: ChromeOwnership = {
    sidebar: 'window',
    windowTabs: 'window',
    globalTools: 'window',
    rightbar: 'focused-pane',
    settings: 'focused-pane',
    dialogs: 'focused-pane',
    pluginPages: 'deferred',
}
