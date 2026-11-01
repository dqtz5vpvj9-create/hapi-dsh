/** Additive controls for capabilities owned by the native source engine. */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isSourceSessionId, type SourceApproval, type SourceReceipt } from '../remote/protocol.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import type { SourceDelivery } from './remote-outbox.ts'

function deliveryLabel(delivery: SourceDelivery, zh: boolean): string {
  const labels = { queued: ['已保存在本机，等待连接后发送', 'Saved on this device; waiting to send'],
    sending: ['正在发送已保存的消息', 'Sending saved message'],
    confirming: ['正在确认投递结果，消息仍保留', 'Confirming delivery; your message is retained'],
    accepted: ['源端已接收，等待正文同步', 'Accepted by the source; waiting for history'],
    rejected: ['源端未接受，消息仍保留', 'The source did not accept this saved message'] } as const
  return labels[delivery.state][zh ? 0 : 1]
}

/** Delivery feedback augments the official pending submission bubble. */
export function SourceDeliveryStatus({ session, zh }: { session: Pick<RemoteSourceSession, 'deliveries' | 'discardSubmission'>; zh: boolean }) {
  const deliveries = useSyncExternalStore(session.deliveries.subscribe, session.deliveries.getSnapshot)
  if (!deliveries.length) return null
  return <div className="hhpi-source-deliveries" style={{ maxHeight: 128, overflowY: 'auto', overscrollBehavior: 'contain' }}>{deliveries.map(delivery => <p key={delivery.operation.operationId} role={delivery.state === 'rejected' ? 'alert' : 'status'} data-hhpi-delivery={delivery.state}>
    {deliveryLabel(delivery, zh)}
    {delivery.state === 'rejected' && <> · “{delivery.operation.text?.slice(0, 40)}{(delivery.operation.text?.length ?? 0) > 40 ? '…' : ''}” · {delivery.message} <button type="button" onClick={() => { session.discardSubmission(delivery.operation.operationId) }}>{zh ? '移除' : 'Dismiss'}</button></>}
  </p>)}</div>
}

interface ApprovalProps {
  session: Pick<RemoteSourceSession, 'sessionId' | 'operate'>
  request: SourceApproval
  zh: boolean
}
export function SourceApprovalControl(props: ApprovalProps) {
  return <SourceApprovalButtons key={JSON.stringify([props.session.sessionId, props.request.id])} {...props}/>
}
function SourceApprovalButtons({ session, request, zh }: ApprovalProps) {
  const [receipt, setReceipt] = useState<SourceReceipt | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const lifetime = useRef(0)
  // A reconnect may replace the Session face without changing its native ID.
  // Invalidate old callbacks before the new owner can receive an input event.
  useLayoutEffect(() => {
    ++lifetime.current; inFlight.current = false
    setReceipt(undefined); setError(undefined); setBusy(false)
    return () => { ++lifetime.current }
  }, [session, request.id])
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
    const session = (props.sessionBinding ?? ctx.sessions.binding(props.sessionId))?.session as RemoteSourceSession | undefined
    const metadata = session?.metadata.getSnapshot()
    const zh = ctx.locale.getSnapshot().active.startsWith('zh')
    if (!metadata) return null
    const scope = `[data-conversation-session="${CSS.escape(props.sessionId)}"]`
    return <>
      <style>{`${scope} [data-slot="conversation.input.model"],${scope} [data-slot="conversation.input.permission"],${scope} [data-slot="conversation.input.plan"]{display:none!important}`}</style>
      {metadata.capabilities.steer && state.running && <button type="button" className="hhpi-source-steer" aria-label="Steer"
        disabled={input.phase === 'submitting' || input.phase === 'adjudicating' || !input.draft.trim() || !metadata.activeTurnId}
        onClick={() => {
          const scope = props.sessionBinding?.ctx ?? ctx.sessions.scope(props.sessionId)
          if (scope) ctx.conversation.input.for(scope).submit('steer', 'click')
        }}>{zh ? '立即插话' : 'Steer'}</button>}
    </>
  }
  const DockBody = ({ session }: { session: RemoteSourceSession }) => {
    const metadata = useSyncExternalStore(session.metadata.subscribe, session.metadata.getSnapshot)
    const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
    const zh = ctx.locale.getSnapshot().active.startsWith('zh')
    return <div className="hhpi-source-dock" data-hhpi-source={metadata.id}>
      {metadata.status === 'offline' && <p role="status">{zh ? '源机器连接中断，已读历史仍然保留。' : 'The source is disconnected. Accepted history is retained.'}</p>}
      {state.promptError && <p role="alert">{state.promptError.error.message}</p>}
      <SourceDeliveryStatus session={session} zh={zh}/>
      {metadata.pendingRequests.map(request => <SourceApprovalControl key={request.id} session={session} request={request} zh={zh}/>)}
    </div>
  }
  const Dock = (props: PropsRuntime<'conversation.input.dock'>) => {
    if (!isSourceSessionId(props.sessionId)) return null
    const session = (props.sessionBinding ?? ctx.sessions.binding(props.sessionId))?.session as RemoteSourceSession | undefined
    return session ? <DockBody session={session}/> : null
  }
  const right = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'hhpi.source-steer', order: 85 }, SourceRight))
  const dock = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'hhpi.source-approval', order: -90 }, Dock))
  const style = document.createElement('style')
  style.textContent = `.hhpi-source-dock:empty{display:none}.hhpi-source-dock{max-width:960px;margin:0 auto;font:13px/1.5 system-ui;padding:0 12px}.hhpi-source-dock p{margin:4px 0}.hhpi-source-approval{border:1px solid var(--dsw-alias-border-l1,#8884);border-radius:12px;padding:8px}.hhpi-source-approval pre{max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.hhpi-source-approval button,.hhpi-source-steer{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,#8884);background:var(--dsw-alias-bg-base,transparent);border-radius:8px;padding:5px 10px;cursor:pointer}.hhpi-source-approval button+button{margin-left:8px}.hhpi-source-approval button:disabled,.hhpi-source-steer:disabled{opacity:.5;cursor:default}.hhpi-source-dock [role=alert]{color:var(--text-error,#c44)}@media(pointer:coarse){.hhpi-source-steer,.hhpi-source-approval button{min-height:44px}}`
  document.head.append(style)
  return () => { right(); dock(); style.remove() }
}
