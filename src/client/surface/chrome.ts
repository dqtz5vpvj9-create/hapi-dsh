/**
 * Pane chrome policy.
 *
 * A pane boots a full official graph, but the official AppFrame contributes
 * window-level chrome from the same slot tree. The workspace already owns
 * exactly one unified sidebar per window in the primary graph, so a pane
 * shadows the sidebar's duplicate session-list seat (`sidebar.workspaces`) with
 * an empty occupant. The pane then hides the remaining official sidebar shell
 * with CSS. Panel navigation and footer actions stay declared because the pane
 * tools seat reads their registrations.
 *
 * The `sidebar` shell itself and the `sidebar.settings` subtree must stay
 * mounted: the official Settings root (trigger + modal + sections) is declared
 * as a child of the sidebar, and it is the only public way to open Settings in
 * a pane graph. Hiding the launcher is done by the pane tools seat, not by
 * unmounting the owner.
 *
 * The right column (`rightbar`) intentionally stays: Files, Document preview and
 * Terminal are opened as workspace panes through the official rightbar
 * occurrence, so the focused pane's graph must keep rendering it. The official
 * settings modal and third-party dialogs stay in the pane graph as well, which
 * is what preserves per-pane isolation (see CHROME_OWNERSHIP in contracts.ts).
 *
 * Shadowing is a public slot operation: a second entry in the same cell at a
 * distinct (lower) priority coexists and wins the cell; the official entry's
 * declarations are untouched, so its child slots remain declared and any
 * third-party registration into them fails open into an unrendered seat instead
 * of throwing.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Seats a pane never renders; the primary graph owns them once per window. */
export const PANE_SHADOWED_SLOTS = ['sidebar.workspaces', 'shell.leading'] as const

const Empty = (): null => null

/**
 * Shadow the window-level chrome seats of one pane graph.
 *
 * @param ctx - an activated pane graph Context.
 * @returns disposer that removes both shadow entries when the pane graph stops.
 */
export function installPaneChrome(ctx: Context): () => void {
    const disposers: Array<() => void> = []
    // Declarations land while ui-layout activates; wait through the public
    // declaration-lifetime hook instead of assuming plugin order.
    for (const name of PANE_SHADOWED_SLOTS) disposers.push(ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -100 }, Empty)))
    return () => { for (const dispose of disposers.reverse()) dispose() }
}
