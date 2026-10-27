/**
 * Shared reader-activity clock: history and live window commits must not run
 * heavy synchronous updates while a wheel/touch/key gesture is moving the
 * transcript. DSH keeps one scroll owner; this only defers our own commits.
 */
let lastActivityAt = Number.NEGATIVE_INFINITY

/** Record that the reader is actively moving the transcript. */
export function markReaderActivity(now = performance.now()): void {
    lastActivityAt = now
}

/** Whether a reader gesture happened recently enough to defer heavy commits. */
export function readerBusy(now = performance.now(), quietMs = 140): boolean {
    return now - lastActivityAt < quietMs
}
