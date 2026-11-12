/** Plan prose stays in official Conversation; execution uses the shared account-scoped native owner. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CodexCallResult } from '../remote/codex-access.ts'
import type { SourceSession } from '../remote/protocol.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import type { NativeActionRecord } from './remote-operation-contracts.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import { randomId } from './random-id.ts'

export function proposedPlanText(blocks: readonly { kind: string; text?: string }[]): string | null {
  const text = blocks.filter(block => block.kind === 'text').map(block => block.text ?? '').join('\n')
  return /<proposed_plan>\s*([\s\S]+?)\s*<\/proposed_plan>/u.exec(text)?.[1]?.trim() || null
}
const resultOf = (record: NativeActionRecord): CodexCallResult => ({ status: record.phase === 'accepted' ? 'accepted' : record.phase === 'rejected' ? 'rejected' : 'indeterminate', message: record.outcome?.message ?? 'Waiting for the original native plan action.' })
export class SourcePlanOperation {
  private busy = false
  readonly intent: string
  constructor(private readonly session: RemoteSourceSession, planId: string) { this.intent = `plan:${planId}` }
  read(): NativeActionRecord | undefined { return this.session.nativeActions?.get(this.session.sessionId, this.intent) }
  async submit(metadata: SourceSession, text: string, mode: 'default' | 'plan'): Promise<CodexCallResult | null> {
    if (this.busy) return null
    const owner = this.session.nativeActions
    if (!owner) throw new Error('The native plan action owner is unavailable.')
    const assertCurrent = owner.captureAuthorization(this.session.sessionId)
    this.busy = true
    try {
      await owner.restore(); assertCurrent()
      const previous = this.read()
      if (previous && previous.phase !== 'rejected') return this.check()
      if (metadata.id !== this.session.sessionId || !metadata.codex?.model || sourceIsOffline(metadata) || metadata.status !== 'idle') throw new Error('The original source must be idle and report its model before this plan can start.')
      const capabilities = await this.session.sourceDirectory()?.capabilities(); assertCurrent()
      if (capabilities?.methods['turn/start'] !== 'write') throw new Error(capabilities?.unavailable['turn/start'] ?? 'This source does not support starting this plan.')
      const operationId = randomId()
      const record = await owner.submit({ sessionId: metadata.id, intent: this.intent, kind: 'plan', newAttempt: previous?.phase === 'rejected', request: {
        sourceId: metadata.sourceId, method: 'turn/start', operationId, params: {
          threadId: metadata.nativeId, clientUserMessageId: operationId,
          input: [{ type: 'text', text: `${mode === 'default' ? 'Implement this plan.' : 'Continue planning; do not implement yet.'}\n\n${text}`, text_elements: [] }],
          collaborationMode: { mode, settings: { model: metadata.codex.model, reasoning_effort: metadata.codex.reasoningEffort ?? null, developer_instructions: null } },
        },
      } })
      assertCurrent()
      return resultOf(record)
    } finally { this.busy = false }
  }
  async check(): Promise<CodexCallResult | null> {
    const owner = this.session.nativeActions
    if (!owner) throw new Error('The native plan action owner is unavailable.')
    const assertCurrent = owner.captureAuthorization(this.session.sessionId)
    await owner.restore(); assertCurrent()
    const previous = this.read()
    if (!previous) return null
    const record = previous.phase === 'prepared' ? await owner.submit({ sessionId: previous.sessionId, intent: previous.intent, kind: previous.kind, request: previous.request })
      : await owner.recover(previous.sessionId, previous.intent)
    assertCurrent()
    return record ? resultOf(record) : null
  }
}
const none = () => () => {}, empty = () => undefined
const noRecords: readonly NativeActionRecord[] = []
const noActions = { getSnapshot: () => noRecords, subscribe: none }
export function SourcePlanActions({ ctx, sessionId, planId, text, session: supplied }: {
  ctx: Context; sessionId: SessionId; planId: string; text: string; session?: RemoteSourceSession | undefined
}) {
  const session = supplied ?? ctx.sessions.binding(sessionId)?.session as RemoteSourceSession | undefined
  const metadata = useSyncExternalStore(session?.metadata.subscribe ?? none, session?.metadata.getSnapshot ?? empty)
  const operation = useMemo(() => session ? new SourcePlanOperation(session, planId) : undefined, [session, planId])
  const actions = useMemo(() => session?.nativeActions?.view(sessionId) ?? noActions, [session, sessionId])
  const records = useSyncExternalStore(actions.subscribe, actions.getSnapshot)
  const original = records.find(record => record.intent === operation?.intent)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reason, setReason] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    ++generation.current
    const current = generation.current
    setBusy(false); setError(''); setReason(null)
    void session?.nativeActions?.restore().catch(cause => { if (current === generation.current) setError(String(cause)) })
    void session?.sourceDirectory()?.capabilities().then(capabilities => {
      if (current === generation.current) setReason(capabilities.methods['turn/start'] === 'write' ? null : capabilities.unavailable['turn/start'] ?? 'The source does not provide this plan action.')
    }, cause => { if (current === generation.current) setReason(cause instanceof Error ? cause.message : String(cause)) })
    return () => { ++generation.current }
  }, [session, planId])
  const zh = ctx.locale.getSnapshot().active.startsWith('zh')
  const run = async (mode?: 'default' | 'plan') => {
    if (!metadata || !operation || busy) return
    const current = generation.current
    setBusy(true); setError('')
    try { if (mode) await operation.submit(metadata, text, mode); else await operation.check() }
    catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  const disabled = busy || !session?.nativeActions || !metadata?.codex?.model || metadata.status !== 'idle' || sourceIsOffline(metadata) || reason !== null
    || Boolean(original && original.phase !== 'rejected')
  return <section className="hhpi-plan-actions" aria-label={zh ? '计划操作' : 'Plan actions'}>
    <div><button type="button" disabled={disabled} onClick={() => { void run('default') }}>{zh ? '实施计划' : 'Implement plan'}</button>
      <button type="button" disabled={disabled} onClick={() => { void run('plan') }}>{zh ? '继续规划' : 'Continue planning'}</button></div>
    {original && <p role="status">{original.phase === 'accepted' ? zh ? '源端已接收，执行进度见正文。' : 'Accepted by the source. Progress appears in this conversation.' : original.outcome?.message ?? (zh ? '原操作等待确认，不会重复发送。' : 'The original action is awaiting confirmation; it will not be resent.')}</p>}
    {original && !['accepted', 'rejected'].includes(original.phase) && <button type="button" disabled={busy} onClick={() => { void run() }}>{original.phase === 'prepared' ? zh ? '继续原请求' : 'Continue original request' : zh ? '检查原请求结果' : 'Check original request'}</button>}
    {(error || reason) && <p role="alert">{error || reason}</p>}
  </section>
}
