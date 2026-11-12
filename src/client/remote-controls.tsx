import { SourceNativeQuestion } from './remote-native-question.tsx'
import { simpleApprovalDecisions, nativePermissionDescriptions, type SimpleApprovalDecision } from './native-tool-admission.ts'
import { sourceControlOperationId } from '../shared/source-operation-policy.ts'
/** Additive controls for capabilities owned by the native source engine. */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isSourceSessionId, type SourceApproval, type SourceReceipt } from '../remote/protocol.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import type { SourceDelivery } from './remote-outbox.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import { sourceReadFailureCode } from './remote-read-recovery.ts'
import { NATIVE_ASYNC_QUESTION } from '../shared/native-async-questions.ts'

function awaitingControlReceipt(error: unknown): boolean {
  const code = sourceReadFailureCode(error)
  if (code === 'OUTCOME_UNKNOWN' || code === 'outcome_unknown' || code === 'TARGET_UNAVAILABLE') return true
  if (code !== 'gateway/internal' || !(error instanceof Error) || !/^client api: hhpi\/(?:operate|receipt) failed: /.test(error.message)) return false
  const http = /HTTP (\d{3})\b/.exec(error.message)
  return http ? [408, 425, 429].includes(Number(http[1])) || Number(http[1]) >= 500 : /fetch|network|connection|socket|offline|timed? ?out/i.test(error.message)
}

function deliveryLabel(delivery: SourceDelivery, zh: boolean): string {
  if (delivery.state === 'queued') return zh ? '操作尚未发送。' : 'This action has not been sent.'
  return ['send', 'steer'].includes(delivery.operation.kind)
    ? zh ? '发送失败，原消息仍保留。' : 'Could not send. Your message is retained.'
    : zh ? '操作未完成，请在原入口重试。' : 'The action did not complete. Try again from its original control.'
}

/** Only actionable failures and unsent controls supplement the native message UI. */
export function SourceDeliveryStatus({ session, zh }: { session: Pick<RemoteSourceSession, 'deliveries' | 'discardSubmission'> & Partial<Pick<RemoteSourceSession, 'retrySubmission'>>; zh: boolean }) {
  const all = useSyncExternalStore(session.deliveries.subscribe, session.deliveries.getSnapshot)
  // QueueDock/pending submissions and the original body own message content.
  // Durable acknowledgements remain in the outbox without becoming chat blocks.
  const deliveries = all.filter(delivery => delivery.state === 'rejected'
    || delivery.operation.kind !== 'send' && delivery.operation.kind !== 'steer' && delivery.state === 'queued')
  if (!deliveries.length) return null
  return <div className="hhpi-source-deliveries">{deliveries.map(delivery => <p key={delivery.operation.operationId} role={delivery.state === 'rejected' ? 'alert' : 'status'} data-hhpi-delivery={delivery.state}>
    {deliveryLabel(delivery, zh)}
    {delivery.operation.kind !== 'send' && delivery.state === 'queued' && session.retrySubmission && <Button size="sm" variant="ghost" onClick={() => { session.retrySubmission?.(delivery.operation.operationId) }}>{zh ? '继续原请求' : 'Resume original request'}</Button>}
    {delivery.operation.kind !== 'send' && delivery.state === 'queued' && <Button size="sm" variant="ghost" onClick={() => { session.discardSubmission(delivery.operation.operationId) }}>{zh ? '放弃未发送请求' : 'Abandon unsent request'}</Button>}
    {delivery.state === 'rejected' && <Button size="sm" variant="ghost" onClick={() => { session.discardSubmission(delivery.operation.operationId) }}>{zh ? '移除' : 'Dismiss'}</Button>}
  </p>)}</div>
}

interface ApprovalProps {
  session: Pick<RemoteSourceSession, 'sessionId' | 'operate'> & { metadata?: { getSnapshot(): { pendingRequests: readonly SourceApproval[] } } }
  request: SourceApproval
  zh: boolean
  disabled?: boolean
}
export function SourceApprovalControl(props: ApprovalProps) {
  // The official user-questions composer owns nonblocking native questions.
  if (props.request.method === NATIVE_ASYNC_QUESTION) return null
  if (['item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/call'].includes(props.request.method)) return <SourceNativeQuestion key={JSON.stringify([props.session.sessionId, props.request.id])} {...props}/>
  return <SourceApprovalButtons key={JSON.stringify([props.session.sessionId, props.request.id])} {...props}/>
}
function SourceApprovalButtons({ session, request, zh, disabled = false }: ApprovalProps) {
  const [receipt, setReceipt] = useState<SourceReceipt | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const chosen = useRef<SimpleApprovalDecision | undefined>(undefined)
  const signature = JSON.stringify([request.id, request.method, request.turnId, request.itemId, request.params])
  const decisions = simpleApprovalDecisions(request)
  const lifetime = useRef(0)
  // A reconnect may replace the Session face without changing its native ID.
  // Invalidate old callbacks before the new owner can receive an input event.
  useLayoutEffect(() => {
    ++lifetime.current; inFlight.current = false; chosen.current = undefined
    setReceipt(undefined); setError(undefined); setBusy(false)
    return () => { ++lifetime.current }
  }, [session, signature])
  const answer = async (decision: SimpleApprovalDecision, checking = false): Promise<void> => {
    if (!decisions.includes(decision) || disabled || inFlight.current || receipt?.status === 'accepted' || receipt?.status === 'indeterminate' && (!checking || chosen.current !== decision)) return
    inFlight.current = true; chosen.current = decision; setBusy(true); setError(undefined)
    const generation = lifetime.current
    let operationId = ''
    try {
      const assertRequest = () => {
        if (!session.metadata) return
        const current = session.metadata.getSnapshot().pendingRequests.find(value => value.id === request.id)
        if (!current || JSON.stringify([current.id, current.method, current.turnId, current.itemId, current.params]) !== signature) throw new Error(zh ? '原审批已结束或发生变化；未提交此选择。' : 'The original approval was resolved or changed. This decision was not submitted.')
      }
      assertRequest()
      operationId = await sourceControlOperationId(session.sessionId, 'approve', request.id)
      if (generation !== lifetime.current) return
      assertRequest()
      const result = await session.operate({ sessionId: session.sessionId, operationId, kind: 'approve', requestId: request.id, decision })
      if (generation === lifetime.current) setReceipt(result)
    } catch (cause) {
      if (generation === lifetime.current) {
        if (awaitingControlReceipt(cause)) setReceipt({ sessionId: session.sessionId, operationId, status: 'indeterminate',
          message: zh ? '审批结果待确认，连接恢复后可检查原选择。' : 'Waiting to confirm this approval. Check the original decision after the connection recovers.' })
        else setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    finally { if (generation === lifetime.current) { inFlight.current = false; setBusy(false) } }
  }
  const command = request.method === 'item/commandExecution/requestApproval', files = request.method === 'item/fileChange/requestApproval'
  const title = command ? request.params.kind === 'stdin' ? zh ? '向运行中的命令发送输入' : 'Send input to a running command' : zh ? '执行命令审批' : 'Command approval'
    : files ? zh ? '文件修改审批' : 'File change approval' : zh ? '需要原生处理器' : 'Native handler required'
  const permissions = nativePermissionDescriptions(request.params.additionalPermissions, zh)
  const labels: Record<SimpleApprovalDecision, string> = { accept: zh ? '允许' : 'Allow', acceptForSession: zh ? '允许本会话后续同类操作' : 'Allow similar actions for this session', decline: zh ? '拒绝' : 'Deny', cancel: zh ? '拒绝并停止本轮' : 'Deny and stop this turn' }
  return <section className="hhpi-source-approval" data-hhpi-request={request.id} tabIndex={-1} aria-label={zh ? '源端审批' : 'Source approval'}>
    <h3>{title}</h3>
    {typeof request.params.reason === 'string' && <p>{request.params.reason}</p>}
    {command && typeof request.params.command === 'string' && <pre aria-label={zh ? '待执行命令' : 'Requested command'}>{request.params.command}</pre>}
    {typeof request.params.cwd === 'string' && <p>{zh ? '工作目录：' : 'Working directory: '}{request.params.cwd}</p>}
    {files && <p>{typeof request.params.grantRoot === 'string' ? `${zh ? '请求写入目录：' : 'Requested write root: '}${request.params.grantRoot}` : zh ? '请核对会话正文中的原生文件变更后决定。' : 'Review the native file changes in the conversation before deciding.'}</p>}
    {!!permissions.length && <ul>{permissions.map((permission, index) => <li key={index}>{permission}</li>)}</ul>}
    {!decisions.length && <p>{zh ? '此请求需要对应的原生界面，不能使用通用允许操作。' : 'This request requires its native interface; a generic approval is unavailable.'}</p>}
    <details><summary>{zh ? '技术详情' : 'Technical details'}</summary><p>{request.method}</p><p>{zh ? '请求：' : 'Request: '}{request.id} · {zh ? '轮次：' : 'Turn: '}{request.turnId ?? '—'} · {zh ? '项目：' : 'Item: '}{request.itemId ?? '—'}</p><pre>{JSON.stringify(request.params, null, 2)}</pre></details>
    <div>{decisions.map(decision => <button key={decision} type="button" disabled={disabled || busy || receipt?.status === 'accepted' || receipt?.status === 'indeterminate'} onClick={() => { void answer(decision) }}>{labels[decision]}</button>)}</div>
    {receipt?.status === 'indeterminate' && chosen.current && <button type="button" disabled={disabled || busy} onClick={() => { void answer(chosen.current!, true) }}>{zh ? '检查原审批结果' : 'Check original decision'}</button>}
    {receipt && <p role={receipt.status === 'rejected' ? 'alert' : 'status'}>{receipt.message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

export function installRemoteSourceControls(ctx: Context): () => void {
  const DockBody = ({ session }: { session: RemoteSourceSession }) => {
    const metadata = useSyncExternalStore(session.metadata.subscribe, session.metadata.getSnapshot)
    const controlStatus = useSyncExternalStore(session.controlStatus.subscribe, session.controlStatus.getSnapshot)
    const imagePreparation = session.projections.faceOf('hhpiPreparingImages')
    const preparingImages = useSyncExternalStore(imagePreparation.subscribe, imagePreparation.getSnapshot)
    const zh = ctx.locale.getSnapshot().active.startsWith('zh')
    return <div className="hhpi-source-dock" data-hhpi-source={metadata.id}>
      {sourceIsOffline(metadata) && <p role="status">{zh ? '等待连接恢复，已读内容与已提交消息保留。' : 'Waiting for the source connection. Read history and submitted messages are retained.'}</p>}
      {preparingImages === true && <p role="status">{zh ? '正在本机优化图片…' : 'Optimizing images on this device…'}</p>}
      {controlStatus && <p role="alert">{zh ? '操作未完成，请在原入口重试。' : 'The action did not complete. Try again from its original control.'}</p>}
      <SourceDeliveryStatus session={session} zh={zh}/>
      {metadata.pendingRequests.map(request => <SourceApprovalControl key={request.id} session={session} request={request} zh={zh} disabled={sourceIsOffline(metadata)}/>)}
    </div>
  }
  const Dock = (props: PropsRuntime<'conversation.input.dock'>) => {
    if (!isSourceSessionId(props.sessionId)) return null
    const session = (props.sessionBinding ?? ctx.sessions.binding(props.sessionId))?.session as RemoteSourceSession | undefined
    return session ? <DockBody session={session}/> : null
  }

  const dock = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'hhpi.source-approval', order: -90 }, Dock))
  const style = document.createElement('style')
  style.textContent = `.hhpi-source-dock:empty{display:none}.hhpi-source-dock{max-width:960px;margin:0 auto;font:13px/1.5 system-ui;padding:0 12px}.hhpi-source-dock p{margin:4px 0}.hhpi-source-approval{border:1px solid var(--dsw-alias-border-l1,#8884);border-radius:12px;padding:8px}.hhpi-source-approval pre{max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.hhpi-source-approval button,.hhpi-source-steer{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,#8884);background:var(--dsw-alias-bg-base,transparent);border-radius:8px;padding:5px 10px;cursor:pointer}.hhpi-source-approval button+button{margin-left:8px}.hhpi-source-approval button:disabled,.hhpi-source-steer:disabled{opacity:.5;cursor:default}.hhpi-source-dock [role=alert]{color:var(--text-error,#c44)}@media(pointer:coarse){.hhpi-source-steer,.hhpi-source-approval button{min-height:44px}}`
  document.head.append(style)
  return () => { dock(); style.remove() }
}
