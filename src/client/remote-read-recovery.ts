/** Recover only source/transport availability failures, never malformed data or denied access. */
export function sourceReadFailureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = error as { code?: unknown; details?: { sourceCode?: unknown } }
  return typeof value.details?.sourceCode === 'string' ? value.details.sourceCode : typeof value.code === 'string' ? value.code : undefined
}

export function recoverableSourceRead(error: unknown): boolean {
  const code = sourceReadFailureCode(error)
  if (code === 'TARGET_UNAVAILABLE') return true
  if (code !== 'gateway/internal' || !(error instanceof Error)) return false
  // The pinned Gateway wraps unary carrier failures with this public prefix.
  // Its other internal failures describe retired methods or local protocol bugs.
  if (!/^client api: hhpi\/(?:read|changes) failed: /.test(error.message)) return false
  const http = /HTTP (\d{3})\b/.exec(error.message)
  if (http) return [408, 425, 429].includes(Number(http[1])) || Number(http[1]) >= 500
  return /fetch|network|connection|socket|offline|timed? ?out/i.test(error.message)
}

/** Explicit authorization failures invalidate durable source content, not just a retry attempt. */
export function revokedSourceRead(error: unknown): boolean {
  const code = sourceReadFailureCode(error)
  if (code === 'UNSUPPORTED' || code === 'remote-access/denied') return true
  return code === 'gateway/internal' && error instanceof Error
    && /^client api: hhpi\/(?:read|changes) failed: /.test(error.message) && /HTTP (?:401|403)\b/.test(error.message)
}

/** Backoff is bounded and paused offline; foreground/online events immediately retry a pending read. */
export function waitForSourceReadRecovery(attempt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const target = typeof window === 'undefined' ? undefined : window
    const document = target?.document
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      target?.removeEventListener('online', wake)
      target?.removeEventListener('pageshow', wake)
      document?.removeEventListener('visibilitychange', visible)
    }
    const wake = (): void => { cleanup(); resolve() }
    const stop = (): void => { cleanup(); reject(signal.reason ?? new DOMException('Reading released.', 'AbortError')) }
    const visible = (): void => { if (document?.visibilityState === 'visible') wake() }
    target?.addEventListener('online', wake)
    target?.addEventListener('pageshow', wake)
    document?.addEventListener('visibilitychange', visible)
    signal.addEventListener('abort', stop, { once: true })
    if (target?.navigator.onLine !== false) {
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)) * (0.8 + Math.random() * 0.4)
      timer = setTimeout(wake, delay)
      timer.unref?.()
    }
    if (signal.aborted) stop()
  })
}
