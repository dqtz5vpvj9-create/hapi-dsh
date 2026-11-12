/** A finalized native message names its original turn; display sequence numbers never define a fork. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { isSourceSessionId, sourceSessionId } from '../remote/protocol.ts'
import type { NativeActionRecord } from './remote-operation-contracts.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import { boundedSourceRead } from './remote-read-recovery.ts'
import { useWorkspacePane } from './surface/pane-context.tsx'

export function nativeForkTurn(messageId: string, nativeId: string): string | undefined {
  const parts = messageId.split(':')
  if (parts.length !== 4 || parts[0] !== 'codex') return undefined
  try {
    const [thread, turn, item] = parts.slice(1).map(decodeURIComponent)
    return thread === nativeId && turn && item ? turn : undefined
  } catch { return undefined }
}
const noRecords: readonly NativeActionRecord[] = []
const emptyStore = { subscribe: () => () => {}, getSnapshot: () => noRecords }

export function RemoteNativeForkAction({ session, messageId, finished, chinese, open }: {
  session: RemoteSourceSession; messageId: string; finished: boolean; chinese: boolean; open(sessionId: string): void
}) {
  const metadata = useSyncExternalStore(session.metadata.subscribe, session.metadata.getSnapshot)
  const owner = session.nativeActions, intent = `fork:${messageId}`, turn = nativeForkTurn(messageId, metadata.nativeId)
  const store = useMemo(() => owner?.view(session.sessionId) ?? emptyStore, [owner, session])
  const records = useSyncExternalStore(store.subscribe, store.getSnapshot), original = records.find(record => record.intent === intent)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), gate = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const active = new AbortController(); lifetime.current = active
    ++generation.current; gate.current = false; setBusy(false); setError('')
    return () => { ++generation.current; active.abort(); if (lifetime.current === active) lifetime.current = null }
  }, [owner, session, messageId])
  const tr = (en: string, zh: string) => chinese ? zh : en
  if (!metadata.codex || !turn || !finished || !owner) return null
  const run = async () => {
    const active = lifetime.current
    if (gate.current || sourceIsOffline(metadata) || !active || active.signal.aborted) return
    gate.current = true; setBusy(true); setError('')
    const revision = generation.current
    try {
      const assertCurrent = owner.captureAuthorization(session.sessionId)
      await owner.restore(); assertCurrent()
      if (generation.current !== revision) return
      const previous = owner.get(session.sessionId, intent)
      let result = previous
      if (!previous || previous.phase === 'rejected' || previous.phase === 'prepared') {
        const directory = session.sourceDirectory()
        const capability = directory && await boundedSourceRead(signal => directory.capabilities(signal), active.signal)
        assertCurrent(); active.signal.throwIfAborted()
        if (capability?.methods['thread/fork'] !== 'write') throw new Error(tr('This source does not support creating a message branch.', '此来源未提供消息分支能力。'))
        result = await owner.submit(previous?.phase === 'prepared'
          ? { sessionId: session.sessionId, intent, kind: 'fork', request: previous.request }
          : { sessionId: session.sessionId, intent, kind: 'fork', newAttempt: previous?.phase === 'rejected',
            request: { sourceId: metadata.sourceId, method: 'thread/fork', params: { threadId: metadata.nativeId, lastTurnId: turn, excludeTurns: true } } })
      } else if (previous.phase !== 'accepted') result = await owner.recover(session.sessionId, intent)
      assertCurrent()
      if (revision !== generation.current || active.signal.aborted) return
      const nativeId = result?.phase === 'accepted' ? result.outcome?.targetNativeId : undefined
      if (nativeId && nativeId !== metadata.nativeId) open(sourceSessionId({ ...metadata, nativeId }))
      else if (result?.phase === 'accepted') setError(tr('The source accepted this branch but did not return its target. Check the original source; this action will not create another branch.', '来源已接受分支，但未返回目标。请检查原来源；此操作不会重新创建分支。'))
      else if (result?.phase === 'rejected') setError(tr('The source did not create this message branch. Your conversation and draft are kept; check the original source before trying again.', '来源未创建此消息分支，会话与草稿已保留；请在原来源确认后重试。'))
    } catch (cause) { if (revision === generation.current && !active.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (revision === generation.current) { gate.current = false; setBusy(false) } }
  }
  const label = original?.phase === 'accepted' ? tr('Open message branch', '打开消息分支')
    : original && !['prepared', 'rejected'].includes(original.phase) ? tr('Check original message branch', '检查原消息分支')
      : original?.phase === 'prepared' ? tr('Continue original message branch', '继续原消息分支') : tr('Branch from this message', '从此消息分支')
  return <span data-hhpi-message-fork>
    <button className="hapi-native-fork-action" type="button" aria-label={label} title={label} disabled={busy || sourceIsOffline(metadata)} onClick={() => { void run() }}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7v2a4 4 0 0 1-4 4H6"/></svg>
    </button>
    {original && !['accepted', 'rejected'].includes(original.phase) && <span role="status">{tr('The original branch is awaiting source confirmation.', '原分支正在等待来源确认。')}</span>}
    {error && <span role="alert">{error}</span>}
  </span>
}

export function installRemoteNativeFork(ctx: Context): () => void {
  const Action = (props: PropsRuntime<'conversation.chat.assistant-actions'>) => {
    const pane = useWorkspacePane(ctx), binding = props.sessionBinding
    const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
    if (!pane || !binding || binding.sessionId !== props.sessionId || !isSourceSessionId(props.sessionId)) return null
    // This official slot receives finalized assistant messages only. It already
    // owns completion admission, so each action adds no transcript scan/read.
    return <RemoteNativeForkAction key={JSON.stringify([binding.sessionId, props.messageId])} session={binding.session as RemoteSourceSession}
      messageId={props.messageId} finished chinese={language.startsWith('zh')} open={sessionId => {
        if (pane.state.getSnapshot().visible && !binding.session.getSnapshot().removed) pane.openSession(sessionId, { beside: 'horizontal' })
      }}/>
  }
  return ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'hhpi.native-message-fork', order: 45 }, Action))
}
