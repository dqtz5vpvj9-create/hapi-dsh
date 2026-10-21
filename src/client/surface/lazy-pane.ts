/**
 * Lazy pane boot policy.
 *
 * A restored workspace mounts the DOM for every window (parked windows are
 * hidden, not unmounted) so drafts, dialogs and focus survive window switches.
 * Booting an official pane graph is expensive, so a pane graph starts only when
 * the pane is (or was) actually visible:
 *
 * - panes in the active window boot as soon as the lease resolves;
 * - panes in parked windows wait for their window's first activation;
 * - a booted pane is never unloaded again, so switching windows keeps the
 *   graph, draft, dialogs, terminal and rightbar state.
 */
import type { WorkspaceRenderOptions } from '../controller.ts'

/**
 * Decide whether one pane may start its official graph now.
 *
 * `visible` is the workspace's own presentation fact (`WorkspacePane` passes
 * `!hidden`); it is absent for the primary Host's plugin-page renderer, which
 * always boots. Once a graph has started, this always returns true so a later
 * hidden/visible flip can never tear it down.
 *
 * @param options - render options supplied by the workspace layout.
 * @param booted - whether this pane's graph already started.
 * @returns true when the pane should boot (or already did).
 */
export function shouldBootPane(options: Pick<WorkspaceRenderOptions, 'visible'>, booted: boolean): boolean {
    return booted || options.visible !== false
}

/** Boot lifecycle of one pane surface. `booted` is a one-way latch. */
export type PaneBootPhase = 'deferred' | 'booting' | 'booted'

/**
 * One pane's boot gate: at most one attempt in flight, success latches, failure
 * reopens the gate so a later visibility flip or the Retry button can try again.
 * Keeping this separate from the graph start keeps the "never unload a booted
 * pane" rule explicit and unit-testable.
 */
export interface PaneBootGate {
    /** Current lifecycle phase. */
    phase(): PaneBootPhase
    /**
     * Claim one boot attempt.
     * @returns false while another attempt runs or after a successful boot.
     */
    begin(): boolean
    /** The graph is ready; the pane is booted for the rest of its life. */
    succeed(): void
    /** The attempt failed or was superseded; a later begin may retry. */
    fail(): void
}

/** Create a deferred gate for one new pane surface. */
export function createPaneBootGate(): PaneBootGate {
    let phase: PaneBootPhase = 'deferred'
    return {
        phase: () => phase,
        begin: () => {
            if (phase !== 'deferred') return false
            phase = 'booting'
            return true
        },
        succeed: () => { phase = 'booted' },
        fail: () => { if (phase === 'booting') phase = 'deferred' },
    }
}
