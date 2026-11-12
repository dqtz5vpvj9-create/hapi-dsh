/** Human requests keep native identities; answers remain in memory and never enter browser persistence. */
import { NativeElicitation } from './remote-elicitation.tsx'
import { useLayoutEffect, useRef, useState } from 'react'
import type { SourceApproval, SourceOperation, SourceReceipt } from '../remote/protocol.ts'
import { sourceControlOperationId } from '../shared/source-operation-policy.ts'
import { nativePermissionDescriptions } from './native-tool-admission.ts'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface Props {
  session: { sessionId: string; operate(request: SourceOperation): Promise<SourceReceipt>; metadata?: { getSnapshot(): { pendingRequests: readonly SourceApproval[] } } }
  request: SourceApproval; zh: boolean; disabled?: boolean
}
export function SourceNativeQuestion({ session, request, zh, disabled }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [receipt, setReceipt] = useState<SourceReceipt | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const flight = useRef(false), generation = useRef(0), original = useRef<SourceOperation | null>(null)
  const signature = JSON.stringify([request.id, request.method, request.turnId, request.itemId, request.params])
  useLayoutEffect(() => {
    ++generation.current; flight.current = false; original.current = null
    setAnswers({}); setReceipt(null); setError(''); setBusy(false)
    return () => { ++generation.current }
  }, [session, signature])
  const assertRequest = () => {
    if (!session.metadata) return
    const current = session.metadata.getSnapshot().pendingRequests.find(value => value.id === request.id)
    if (!current || JSON.stringify([current.id, current.method, current.turnId, current.itemId, current.params]) !== signature) throw new Error(zh ? '原请求已结束或发生变化；未提交此回答。' : 'The original request was resolved or changed. This answer was not submitted.')
  }
  const submit = async (response: Record<string, unknown>, recovering = false): Promise<void> => {
    if (disabled || flight.current || receipt?.status === 'accepted' || receipt?.status === 'indeterminate' && !recovering) return
    flight.current = true; setBusy(true); setError('')
    const current = generation.current
    try {
      assertRequest()
      const operationId = original.current?.operationId ?? await sourceControlOperationId(session.sessionId, 'approve', request.id)
      if (current !== generation.current) return
      assertRequest()
      const operation = recovering && original.current ? original.current : { sessionId: session.sessionId, operationId, kind: 'approve' as const, requestId: request.id, response: structuredClone(response) }
      original.current = operation
      const result = await session.operate(operation)
      if (current === generation.current) setReceipt(result)
    } catch (cause) {
      if (current === generation.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
        if (original.current) setReceipt({ sessionId: session.sessionId, operationId: original.current.operationId, status: 'indeterminate', message: zh ? '结果待确认；只能检查原回答，不会自动重发。' : 'Awaiting confirmation. Only the original answer can be checked; it will not be resent automatically.' })
      }
    } finally { if (current === generation.current) { setBusy(false); flight.current = false } }
  }
  const locked = !!disabled || busy || !!receipt && receipt.status !== 'rejected'
  const questions = Array.isArray(request.params.questions) ? request.params.questions.filter(record) : []
  const validQuestions = questions.length > 0 && Array.isArray(request.params.questions) && questions.length === request.params.questions.length
    && questions.every(question => typeof question.id === 'string' && !!question.id && typeof question.question === 'string' && (question.options == null || Array.isArray(question.options) && question.options.every(option => record(option) && typeof option.label === 'string')))
  const userInput = request.method === 'item/tool/requestUserInput', permissions = request.method === 'item/permissions/requestApproval'
  const scope = nativePermissionDescriptions(request.params.permissions, zh)
  return <section className="hhpi-source-approval" data-hhpi-request={request.id} aria-label={zh ? '源端提问' : 'Source question'}>
    <h3>{userInput ? zh ? '需要你的回答' : 'Your answer is needed' : permissions ? zh ? '额外权限请求' : 'Additional permissions' : zh ? '服务请求' : 'Service request'}</h3>
    {request.method === 'mcpServer/elicitation/request' ? <NativeElicitation key={signature} request={request} disabled={locked} zh={zh} submit={submit}/> : userInput && validQuestions ? <form onSubmit={event => {
      event.preventDefault(); event.stopPropagation()
      void submit({ answers: Object.fromEntries(questions.map(question => [String(question.id), { answers: [answers[String(question.id)] ?? ''] }])) })
    }}>
      {questions.map(question => {
        const id = String(question.id), options = Array.isArray(question.options) ? question.options.filter(record) : []
        return <fieldset key={id} disabled={locked}><legend>{String(question.question)}</legend>
          {options.map(option => <label key={String(option.label)} style={{ display: 'block' }}><input type="radio" name={`${request.id}:${id}`} value={String(option.label)} checked={answers[id] === option.label} onChange={() => setAnswers(value => ({ ...value, [id]: String(option.label) }))}/>{String(option.label)}{typeof option.description === 'string' && <small> · {option.description}</small>}</label>)}
          {(question.isOther === true || !options.length) && <label>{options.length ? zh ? '其他回答' : 'Other answer' : String(question.header ?? question.question)}<input type={question.isSecret ? 'password' : 'text'} autoComplete={question.isSecret ? 'off' : undefined} aria-label={String(question.header ?? question.question)} value={options.some(option => option.label === answers[id]) ? '' : answers[id] ?? ''} onChange={event => setAnswers(value => ({ ...value, [id]: event.target.value }))}/></label>}
        </fieldset>
      })}
      <button type="submit" disabled={locked || questions.some(question => !answers[String(question.id)]?.trim())}>{zh ? '提交回答' : 'Submit answers'}</button>
    </form> : permissions && record(request.params.permissions) ? <>
      <p>{typeof request.params.reason === 'string' ? request.params.reason : zh ? 'Codex 请求额外权限' : 'Codex requests additional permissions'}</p>
      {typeof request.params.cwd === 'string' && <p>{zh ? '工作目录：' : 'Working directory: '}{request.params.cwd}</p>}
      {scope.length ? <ul>{scope.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>{zh ? '请在技术详情中核对原生权限范围。' : 'Review the native permission scope in technical details.'}</p>}
      <button type="button" disabled={locked} onClick={() => { void submit({ permissions: request.params.permissions, scope: 'turn' }) }}>{zh ? '允许本轮' : 'Allow for this turn'}</button>
      <button type="button" disabled={locked} onClick={() => { void submit({ permissions: {}, scope: 'turn' }) }}>{zh ? '拒绝' : 'Deny'}</button>
    </> : <p>{zh ? '此请求需要对应的原生界面，不能使用通用批准。' : 'This request requires its native interface; a generic approval is unavailable.'}</p>}
    <details><summary>{zh ? '技术详情' : 'Technical details'}</summary><p>{request.method} · {request.id} · {request.turnId ?? '—'} · {request.itemId ?? '—'}</p><pre>{JSON.stringify(request.params, null, 2)}</pre></details>
    {receipt?.status === 'indeterminate' && original.current && <button type="button" disabled={disabled || busy} onClick={() => { void submit({}, true) }}>{zh ? '检查原回答结果' : 'Check original answer'}</button>}
    {receipt && <p role={receipt.status === 'rejected' ? 'alert' : 'status'}>{receipt.message}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
