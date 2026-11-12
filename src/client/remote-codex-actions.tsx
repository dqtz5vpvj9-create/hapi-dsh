/** Native actions use the canonical operation owner; a menu never owns a write. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SourceSession } from '../remote/protocol.ts'
import { sourceSessionId } from '../remote/protocol.ts'
import type { CodexCapabilities } from '../remote/codex-access.ts'
import type { NativeActionKind, NativeActionRecord } from './remote-operation-contracts.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import { useWorkspacePane } from './surface/pane-context.tsx'
import { RemoteNativeServicesPanel } from './remote-native-services.tsx'
const empty: readonly NativeActionRecord[] = []
const emptyStore = { getSnapshot: () => empty, subscribe: () => () => {} }
export function CodexActions({ ctx, session, metadata, zh }: { ctx: Context; session: RemoteSourceSession; metadata: SourceSession; zh: boolean }) {
  const owner = session.nativeActions, pane = useWorkspacePane(ctx)
  const store = useMemo(() => owner?.view(metadata.id) ?? emptyStore, [owner, metadata.id])
  const records = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [capabilities, setCapabilities] = useState<CodexCapabilities | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [name, setName] = useState(metadata.title), [lastIntent, setLastIntent] = useState<string | null>(null)
  const [servicesOpen, setServicesOpen] = useState(false)
  const captureServiceAccess = useCallback(() => ctx.hhpiSessions.captureWorkspaceAccess(session.sessionId), [ctx, session])
  const servicesButton = useRef<HTMLButtonElement>(null), returningFromServices = useRef(false)
  useEffect(() => { setServicesOpen(false) }, [session])
  useEffect(() => { if (!servicesOpen && returningFromServices.current) { returningFromServices.current = false; servicesButton.current?.focus({ preventScroll: true }) } }, [servicesOpen])
  const generation = useRef(0)
  useEffect(() => { ++generation.current; setBusy(false); setLastIntent(null); return () => { ++generation.current } }, [session])
  useEffect(() => setName(metadata.title), [metadata.id, metadata.title])
  useEffect(() => {
    const abort = new AbortController()
    setCapabilities(null)
    void session.sourceDirectory()?.capabilities(abort.signal).then(value => { if (!abort.signal.aborted) { setCapabilities(value); setError('') } }, cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => abort.abort()
  }, [session, metadata.connection?.state])
  const disabled = busy || !owner || sourceIsOffline(metadata)
  const unresolved = records.filter(record => !['accepted', 'rejected'].includes(record.phase))
  const intentOf = (kind: NativeActionKind): string => kind === 'plan' ? 'settings' : kind
  const blocked = (kind: NativeActionKind, method: string): boolean => disabled || capabilities?.methods[method] !== 'write' || unresolved.some(record => record.intent === intentOf(kind))
  const openFork = (record: NativeActionRecord): void => {
    if (record.phase === 'accepted' && record.outcome?.targetNativeId) pane?.openSession(sourceSessionId({ ...metadata, nativeId: record.outcome.targetNativeId }), { beside: 'horizontal' })
  }
  const run = async (kind: NativeActionKind, method: string, params: Record<string, unknown>): Promise<void> => {
    if (!owner || blocked(kind, method)) return
    const intent = intentOf(kind)
    const current = generation.current
    setBusy(true); setError(''); setLastIntent(intent)
    try {
      const result = await owner.submit({ sessionId: metadata.id, intent, kind, newAttempt: true,
        request: { sourceId: metadata.sourceId, method, params: { threadId: metadata.nativeId, ...params } } })
      if (current === generation.current && kind === 'fork') openFork(result)
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  const check = async (record: NativeActionRecord): Promise<void> => {
    if (!owner || disabled) return
    const current = generation.current
    setBusy(true); setError(''); setLastIntent(record.intent)
    try {
      const result = record.phase === 'prepared' ? await owner.submit({ sessionId: metadata.id, intent: record.intent, kind: record.kind, request: record.request })
        : await owner.recover(metadata.id, record.intent)
      if (current === generation.current && result?.kind === 'fork') openFork(result)
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  const last = records.find(record => record.intent === lastIntent)
  const fork = records.find(record => record.kind === 'fork' && record.phase === 'accepted' && record.outcome?.targetNativeId)
  if (servicesOpen) return <RemoteNativeServicesPanel session={session} api={ctx.remote.hhpi} chinese={zh} captureAccess={captureServiceAccess} back={() => { returningFromServices.current = true; setServicesOpen(false) }}/>
  return <div className="hapi-native-actions">
    <button ref={servicesButton} type="button" onClick={() => setServicesOpen(true)}>{zh ? '源连接与后台任务' : 'Source connections & background work'}</button>
    {metadata.codex?.model && <button type="button" disabled={blocked('plan', 'thread/settings/update')} onClick={() => {
      const settings = metadata.codex?.settings?.collaborationMode
      const plan = settings && typeof settings === 'object' && 'mode' in settings && settings.mode === 'plan'
      void run('plan', 'thread/settings/update', { collaborationMode: { mode: plan ? 'default' : 'plan', settings: { model: metadata.codex!.model, reasoning_effort: metadata.codex!.reasoningEffort, developer_instructions: null } } })
    }}>{zh ? '切换计划 / 执行模式' : 'Switch plan / execution mode'}</button>}
    <button type="button" disabled={blocked('compact', 'thread/compact/start') || metadata.status !== 'idle'} onClick={() => { void run('compact', 'thread/compact/start', {}) }}>{zh ? '压缩上下文' : 'Compact context'}</button>
    <button type="button" disabled={blocked('review', 'review/start') || metadata.status !== 'idle'} onClick={() => { void run('review', 'review/start', { target: { type: 'uncommittedChanges' }, delivery: 'inline' }) }}>{zh ? '审查未提交更改' : 'Review uncommitted changes'}</button>
    <button type="button" disabled={blocked('fork', 'thread/fork')} onClick={() => { void run('fork', 'thread/fork', { excludeTurns: true }) }}>{zh ? '分支会话' : 'Fork conversation'}</button>
    {fork && pane && <button type="button" onClick={() => openFork(fork)}>{zh ? '打开分支会话' : 'Open forked conversation'}</button>}
    <form onSubmit={event => { event.preventDefault(); if (name.trim()) void run('rename', 'thread/name/set', { name: name.trim() }) }}>
      <label>{zh ? '会话名称' : 'Conversation name'}<input value={name} disabled={disabled} onChange={event => setName(event.target.value)}/></label>
      <button type="submit" disabled={blocked('rename', 'thread/name/set') || !name.trim() || name === metadata.title}>{zh ? '重命名' : 'Rename'}</button>
    </form>
    {last?.outcome && !unresolved.includes(last) && <p role={last.phase === 'rejected' ? 'alert' : 'status'}>{last.outcome.message}</p>}
    {unresolved.map(record => <div key={record.intent}><p role="status">{record.outcome?.message ?? (zh ? '原操作等待源端确认。' : 'Waiting for the original source action.')}</p>
      <button type="button" disabled={disabled} onClick={() => { void check(record) }}>{record.phase === 'prepared' ? zh ? '继续原请求' : 'Continue original request' : zh ? '检查原请求结果' : 'Check original request'}</button></div>)}
    {error && <p role="alert">{error}</p>}
  </div>
}
