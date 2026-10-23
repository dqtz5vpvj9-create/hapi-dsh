import type { SessionFollowRequest, SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types';

export const OPENING_MESSAGES = 20;

/** An initial viewport does not need the official 500-message ceiling. The
 * official pager chooses a contiguous cut and owns hasMore/live continuity. */
export function openingWindow(request: SessionFollowRequest): SessionFollowRequest {
    const maximum = request.maxMessages ?? 500;
    const turn = request.turnWindow;
    // Leave malformed requests to the official validator, including its errors.
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || turn && (
        !Number.isSafeInteger(turn.minMessages) || turn.minMessages <= 0 || turn.minMessages > maximum
        || !Number.isSafeInteger(turn.minTurns) || turn.minTurns <= 0)) return request;
    if (maximum <= OPENING_MESSAGES) return request;
    return { ...request, maxMessages: OPENING_MESSAGES,
        ...(turn ? { turnWindow: { ...turn, minMessages: Math.min(turn.minMessages, OPENING_MESSAGES) } } : {}) };
}

/** List projection hints are partial by the official contract. The rail is
 * delivered by the unchanged control/follow baselines when it can be used;
 * omitting a list hint never clears an existing sequenced projection. */
export function sessionListHints(value: SessionListValue): SessionListValue {
    return { ...value, items: value.items.map(row => {
        if (!row.projections || !Object.hasOwn(row.projections.values, 'turnOutline')) return row;
        const { turnOutline: _outline, ...values } = row.projections.values;
        return { ...row, projections: { ...row.projections, values } };
    }) };
}
