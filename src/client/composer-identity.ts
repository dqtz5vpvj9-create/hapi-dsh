/** Draft owners pin the authenticated application and exact native source generation. */
import { useMemo, useRef, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { isSourceSessionId } from '../remote/protocol.ts'
import type { ComposerAuthenticatedIdentity } from './composer-autosave.ts'
import type { CapturedWorkspaceAccess } from './source-workspace-client.ts'
import type {} from './remote-sessions.ts'

export interface ComposerIdentity { readonly scope: string; readonly signal: AbortSignal; current(): boolean }
const emptySubscribe = () => () => {}
const absent = () => undefined

export function useComposerIdentity(ctx: Context, sessionId: string, application?: ComposerAuthenticatedIdentity): ComposerIdentity | undefined {
  const account = useSyncExternalStore(application?.subscribe ?? emptySubscribe, application?.getSnapshot ?? absent)
  const authority = isSourceSessionId(sessionId) ? ctx.get('hhpiSessions') : undefined
  const catalog = useSyncExternalStore(authority?.list.subscribe ?? emptySubscribe, authority?.list.getSnapshot ?? absent)
  const previous = useRef<{ authority: typeof authority; sessionId: string; access: CapturedWorkspaceAccess }>()
  const source = useMemo(() => {
    if (!isSourceSessionId(sessionId) || !authority) return undefined
    const cached = previous.current
    if (cached?.authority === authority && cached.sessionId === sessionId && !cached.access.signal.aborted) {
      try { cached.access.assertCurrent(); return cached.access } catch { /* A source/account replacement needs a new capture. */ }
    }
    try {
      const access = authority.captureWorkspaceAccess(sessionId)
      previous.current = { authority, sessionId, access }; return access
    } catch { return undefined }
  }, [authority, sessionId, catalog, account])
  return useMemo(() => {
    if (!account || account.signal.aborted || isSourceSessionId(sessionId) && !source) return undefined
    const signal = source ? AbortSignal.any([account.signal, source.signal]) : account.signal
    return { scope: source ? JSON.stringify([account.scope, source.scope]) : account.scope, signal,
      current() {
        if (signal.aborted || application?.getSnapshot()?.signal !== account.signal) return false
        try { source?.assertCurrent(); return true } catch { return false }
      } }
  }, [account, application, sessionId, source])
}
