/** Browser cause capture for the diagnostics ring buffer.
 *
 * Console text, error messages and stacks are NOT stored (they can carry
 * prompts, URLs, tokens and file content). Only an allowlisted classification,
 * the error name and explicit connection-state changes are recorded.
 * Console hooks always call the original handler (guarded pass-through).
 */
import { diagnosticsCore, safeToken, type DiagnosticsCore } from './state.ts'

const CONNECTION_PATTERN = /reconnect|connection lost|disconnect|websocket|socket|retry|throttl|backoff|connection closed|network error/i
const CONNECTION_CLASS = /connection|websocket|socket|reconnect/i
const WINDOW_KEY = Symbol.for('hapi-dsh.diagnostics.capture')

type CaptureWindow = Window & { [WINDOW_KEY]?: boolean }

/** Fixed classifier tokens only; never a substring of the message itself. */
function classify(args: unknown[]): string | undefined {
  for (const argument of args) {
    if (typeof argument === 'string') {
      if (CONNECTION_PATTERN.test(argument)) return 'connection'
      if (CONNECTION_CLASS.test(argument)) return 'connection'
      if (/\b(?:fetch|request|http|rpc|gateway)\b/i.test(argument)) return 'request'
      if (/\b(?:render|react|component)\b/i.test(argument)) return 'render'
    }
  }
  const first = args[0]
  if (first instanceof Error) return safeToken(first.name) ?? 'error'
  return undefined
}

function errorName(value: unknown): string | undefined {
  if (value instanceof Error) return safeToken(value.name) ?? 'Error'
  return undefined
}

interface ConsoleLike { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }

/** The capture is page-global; repeated pane installs are no-ops. */
export function installBrowserCapture(core: DiagnosticsCore = diagnosticsCore()): () => void {
  if (typeof window === 'undefined') return () => {}
  const target = window as CaptureWindow
  if (target[WINDOW_KEY]) return () => {}
  target[WINDOW_KEY] = true
  const consoleLike = globalThis.console as unknown as ConsoleLike
  const original = { error: consoleLike.error, warn: consoleLike.warn }
  const record = (level: 'error' | 'warn', args: unknown[]): void => {
    try {
      const code = classify(args), name = errorName(args[0])
      core.add({ source: code === 'connection' ? 'connection' : 'console', event: level === 'error' ? 'console.error' : 'console.warn',
        ...(code ? { code } : {}), ...(name ? { errorName: name } : {}) })
    } catch { /* diagnostics must never break the console */ }
  }
  consoleLike.error = (...args: unknown[]): void => {
    record('error', args)
    try { original.error.apply(consoleLike, args) } catch { /* preserve caller semantics */ }
  }
  consoleLike.warn = (...args: unknown[]): void => {
    record('warn', args)
    try { original.warn.apply(consoleLike, args) } catch { /* preserve caller semantics */ }
  }
  const onError = (event: ErrorEvent): void => {
    try {
      const name = errorName(event.error)
      core.add({ source: 'window', event: 'window.error', ...(name ? { errorName: name } : {}) })
    } catch { /* ignore */ }
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    try {
      const name = errorName(event.reason)
      core.add({ source: 'window', event: 'window.unhandledrejection', ...(name ? { errorName: name } : {}) })
    } catch { /* ignore */ }
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    consoleLike.error = original.error
    consoleLike.warn = original.warn
    delete target[WINDOW_KEY]
  }
}
