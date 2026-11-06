/** Explicit native actions in the existing composer overflow. No operation runs on mount. */
import { useEffect, useRef, useState } from 'react'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { SourceSession } from '../remote/protocol.ts'
import type { CodexCall, CodexCallResult } from '../remote/codex-access.ts'
export function CodexActions({ api, metadata, zh }: { api: HhpiRemoteApi; metadata: SourceSession; zh: boolean }) {
  const [result, setResult] = useState<CodexCallResult | null>(null)
  const [request, setRequest] = useState<CodexCall | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [name, setName] = useState(metadata.title)
  const flight = useRef(false), generation = useRef(0)
  useEffect(() => { ++generation.current; return () => { ++generation.current } }, [metadata.id, api])
  const run = async (method: string, params: Record<string, unknown>): Promise<void> => {
    if (!api.nativeCall || flight.current || result?.status === 'indeterminate') return
    const value: CodexCall = { sourceId: metadata.sourceId, method, params: { threadId: metadata.nativeId, ...params }, operationId: crypto.randomUUID() }
    flight.current = true; setBusy(true); setError(''); setRequest(value)
    const current = generation.current
    try {
      const response = await api.nativeCall(value)
      if (current !== generation.current) return
      if (!response.ok) throw new Error(response.error.message)
      setResult(response.value)
    } catch (error) {
      if (current === generation.current) { setError(error instanceof Error ? error.message : String(error)); setResult({ status: 'indeterminate', message: zh ? '结果待确认，不会重发。' : 'Awaiting confirmation; this action will not be resent.' }) }
    } finally { if (current === generation.current) { flight.current = false; setBusy(false) } }
  }
  const check = async (): Promise<void> => {
    if (!request || !api.nativeReceipt || flight.current) return
    const current = generation.current; flight.current = true; setBusy(true)
    try { const response = await api.nativeReceipt(request); if (current === generation.current && response.ok) setResult(response.value) }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (current === generation.current) { flight.current = false; setBusy(false) } }
  }
  const disabled = busy || result?.status === 'indeterminate' || metadata.connection?.state === 'offline'
  const loaded = metadata.capabilities.steer
  return <div className="hapi-native-actions">
    {metadata.codex?.model && <button type="button" disabled={disabled || !loaded} onClick={() => {
      const settings = metadata.codex?.settings?.collaborationMode
      const plan = settings && typeof settings === 'object' && 'mode' in settings && settings.mode === 'plan'
      void run('thread/settings/update', { collaborationMode: { mode: plan ? 'default' : 'plan', settings: { model: metadata.codex!.model, reasoning_effort: metadata.codex!.reasoningEffort, developer_instructions: null } } })
    }}>{zh ? '切换计划 / 执行模式' : 'Switch plan / execution mode'}</button>}
    <button type="button" disabled={disabled || !loaded || metadata.status !== 'idle'} onClick={() => { void run('thread/compact/start', {}) }}>{zh ? '压缩上下文' : 'Compact context'}</button>
    <button type="button" disabled={disabled || !loaded || metadata.status !== 'idle'} onClick={() => { void run('review/start', { target: { type: 'uncommittedChanges' }, delivery: 'inline' }) }}>{zh ? '审查未提交更改' : 'Review uncommitted changes'}</button>
    <button type="button" disabled={disabled} onClick={() => { void run('thread/fork', { excludeTurns: true }) }}>{zh ? '分支会话' : 'Fork conversation'}</button>
    <form onSubmit={event => { event.preventDefault(); if (name.trim()) void run('thread/name/set', { name: name.trim() }) }}>
      <label>{zh ? '会话名称' : 'Conversation name'}<input value={name} disabled={disabled} onChange={event => setName(event.target.value)}/></label>
      <button type="submit" disabled={disabled || !name.trim() || name === metadata.title}>{zh ? '重命名' : 'Rename'}</button>
    </form>
    {result && <p role={result.status === 'rejected' ? 'alert' : 'status'}>{result.message}{result.status === 'accepted' && request?.method === 'thread/fork' ? zh ? ' 新会话会出现在会话列表中。' : ' The new conversation will appear in the session list.' : ''}</p>}
    {error && <p role="alert">{error}</p>}
    {result?.status === 'indeterminate' && <button type="button" disabled={busy} onClick={() => { void check() }}>{zh ? '检查原请求结果' : 'Check original request'}</button>}
  </div>
}
