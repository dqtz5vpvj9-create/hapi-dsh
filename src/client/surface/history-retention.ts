/** Only a dormant, idle, empty editor can surrender a large history generation.
 * Reopening uses the official tail loader; live windows are never spliced. */
export function canReleaseHistory(state: {
    visible: boolean; events: number; running: boolean; pending: number;
    draft: string; attachments: number; phase: string; questions: number
}): boolean {
    return !state.visible && state.events > 1500 && !state.running && state.pending === 0
        && !state.draft && state.attachments === 0 && state.phase === 'plain' && state.questions === 0
}
