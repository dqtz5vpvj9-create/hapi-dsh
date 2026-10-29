/** Additive controls for capabilities owned by the native source engine. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isSourceSessionId, type SourceApproval, type SourceReceipt } from '../remote/protocol.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'

export function SourceApprovalControl({ session, request, zh }: { session: RemoteSourceSession; request: SourceApproval; zh: boolean }) {
  const [receipt, setReceipt] = useState<SourceReceipt | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const lifetime = useRef(0)
  useEffect(() => { ++lifetime.current; return () => { ++lifetime.current } }, [session, request.id])
  const answer = async (decision: 'accept' | 'decline'): Promise<void> => {
    if (inFlight.current || receipt?.status === 'accepted') return
    inFlight.current = true; setBusy(true); setError(undefined)
    const generation = lifetime.current
    try {
      const result = await session.operate({ sessionId: session.sessionId, operationId: `approval:${request.id}`, kind: 'approve', requestId: request.id, decision })
      if (generation === lifetime.current) setReceipt(result)
    } catch (cause) { if (generation === lifetime.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (generation === lifetime.current) { inFlight.current = false; setBusy(false) } }
  }
  return <section className="hhpi-source-approval" data-hhpi-request={request.id} tabIndex={-1} aria-label={zh ? '源端审批' : 'Source approval'}>
    <strong>{request.method}</strong>
    <pre>{JSON.stringify(request.params, null, 2)}</pre>
    <div><button type="button" disabled={busy || receipt?.status === 'accepted'} onClick={() => { void answer('accept') }}>{zh ? '允许' : 'Allow'}</button>
      <button type="button" disabled={busy || receipt?.status === 'accepted'} onClick={() => { void answer('decline') }}>{zh ? '拒绝' : 'Deny'}</button></div>
    {receipt && <p role={receipt.status === 'accepted' ? 'status' : 'alert'}>{receipt.message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

export function installRemoteSourceControls(ctx: Context): () => void {
  const SourceRight = (props: PropsRuntime<'conversation.input.right'>) => {
    const input = props.useInput(value => value)
    const state = props.useSession(value => value)
    if (!isSourceSessionId(props.sessionId)) return null
    const session = ctx.sessions.binding(props.sessionId)?.session as RemoteSourceSession | undefined
    const metadata = session?.metadata.getSnapshot()
    const zh = ctx.locale.getSnapshot().active.startsWith('zh')
    if (!metadata) return null
    const scope = `[data-conversation-session="${CSS.escape(props.sessionId)}"]`
    return <>
      <style>{`${scope} [data-slot="conversation.input.model"],${scope} [data-slot="conversation.input.permission"],${scope} [data-slot="conversation.input.plan"]{display:none!important}`}</style>
      {metadata.capabilities.steer && state.running && <button type="button" className="hhpi-source-steer" aria-label="Steer"
        disabled={input.phase === 'submitting' || input.phase === 'adjudicating' || !input.draft.trim()}
        onClick={() => props.inputActions.submit('steer')}>{zh ? '立即插话' : 'Steer'}</button>}
    </>
  }
  const DockBody = ({ session }: { session: RemoteSourceSession }) => {
    const metadata = useSyncExternalStore(session.metadata.subscribe, session.metadata.getSnapshot)
    const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
    const zh = ctx.locale.getSnapshot().active.startsWith('zh')
    return <div className="hhpi-source-dock" data-hhpi-source={metadata.id}>
      {metadata.status === 'offline' && <p role="status">{zh ? '源机器连接中断，已读历史仍然保留。' : 'The source is disconnected. Accepted history is retained.'}</p>}
      {state.promptError && <p role="alert">{state.promptError.error.message}</p>}
      {metadata.pendingRequests.map(request => <SourceApprovalControl key={request.id} session={session} request={request} zh={zh}/>)}
    </div>
  }
  const Dock = (props: PropsRuntime<'conversation.input.dock'>) => {
    if (!isSourceSessionId(props.sessionId)) return null
    const session = ctx.sessions.binding(props.sessionId)?.session as RemoteSourceSession | undefined
    return session ? <DockBody session={session}/> : null
  }
  const right = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'hhpi.source-steer', order: 85 }, SourceRight))
  const dock = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'hhpi.source-approval', order: -90 }, Dock))
  const style = document.createElement('style')
  style.textContent = `.hhpi-source-dock:empty{display:none}.hhpi-source-dock{max-width:960px;margin:0 auto;font:13px/1.5 system-ui;padding:0 12px}.hhpi-source-dock p{margin:4px 0}.hhpi-source-approval{border:1px solid var(--dsw-alias-border-l1,#8884);border-radius:12px;padding:8px}.hhpi-source-approval pre{max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.hhpi-source-approval button,.hhpi-source-steer{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,#8884);background:var(--dsw-alias-bg-base,transparent);border-radius:8px;padding:5px 10px;cursor:pointer}.hhpi-source-approval button+button{margin-left:8px}.hhpi-source-approval button:disabled,.hhpi-source-steer:disabled{opacity:.5;cursor:default}.hhpi-source-dock [role=alert]{color:var(--text-error,#c44)}@media(pointer:coarse){.hhpi-source-steer,.hhpi-source-approval button{min-height:44px}}`
  document.head.append(style)
  return () => { right(); dock(); style.remove() }
}
