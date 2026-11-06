/** Human requests preserve native IDs and return native structured answers. */
import { NativeElicitation } from './remote-elicitation.tsx'
import { useEffect, useRef, useState } from 'react'
import type { SourceApproval, SourceOperation, SourceReceipt } from '../remote/protocol.ts'
import { sourceControlOperationId } from '../shared/source-operation-policy.ts'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface Props { session: { sessionId: string; operate(request: SourceOperation): Promise<SourceReceipt> }; request: SourceApproval; zh: boolean; disabled?: boolean }
export function SourceNativeQuestion({ session, request, zh, disabled }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [receipt, setReceipt] = useState<SourceReceipt | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const flight = useRef(false), generation = useRef(0)
  useEffect(() => { ++generation.current; return () => { ++generation.current } }, [session, request.id])
  const submit = async (response: Record<string, unknown>): Promise<void> => {
    if (disabled || flight.current || receipt?.status === 'accepted' || receipt?.status === 'indeterminate') return
    flight.current = true; setBusy(true); setError('')
    const current = generation.current
    try {
      const operationId = await sourceControlOperationId(session.sessionId, 'approve', request.id)
      if (current !== generation.current) return
      const result = await session.operate({ sessionId: session.sessionId, operationId, kind: 'approve', requestId: request.id, response })
      if (current === generation.current) setReceipt(result)
    } catch (cause) {
      if (current === generation.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setReceipt({ sessionId: session.sessionId, operationId: '', status: 'indeterminate', message: zh ? '结果待确认，不会自动重发。' : 'Awaiting confirmation; the answer will not be resent.' })
      }
    } finally { if (current === generation.current) { setBusy(false); flight.current = false } }
  }
  const locked = disabled || busy || !!receipt && receipt.status !== 'rejected'
  const questions = Array.isArray(request.params.questions) ? request.params.questions.filter(record) : []
  const userInput = request.method === 'item/tool/requestUserInput'
  const permissions = request.method === 'item/permissions/requestApproval'
  return <section className="hhpi-source-approval" aria-label={zh ? '源端提问' : 'Source question'}>
    {request.method === 'mcpServer/elicitation/request' ? <NativeElicitation request={request} disabled={!!locked} zh={zh} submit={submit}/> : userInput ? <form onSubmit={event => {
      event.preventDefault()
      void submit({ answers: Object.fromEntries(questions.map(question => [String(question.id), { answers: [answers[String(question.id)] ?? ''] }])) })
    }}>
      {questions.map(question => {
        const id = String(question.id), options = Array.isArray(question.options) ? question.options.filter(record) : []
        return <fieldset key={id} disabled={locked}><legend>{String(question.question ?? question.header ?? '')}</legend>
          {options.map(option => <label key={String(option.label)} style={{ display: 'block' }}><input type="radio" name={`${request.id}:${id}`} value={String(option.label)} checked={answers[id] === option.label} onChange={() => setAnswers(value => ({ ...value, [id]: String(option.label) }))}/>{String(option.label)}{typeof option.description === 'string' && <small> · {option.description}</small>}</label>)}
          <input type={question.isSecret ? 'password' : 'text'} aria-label={String(question.header ?? question.question)} value={answers[id] ?? ''} onChange={event => setAnswers(value => ({ ...value, [id]: event.target.value }))}/>
        </fieldset>
      })}
      <button type="submit" disabled={locked || questions.some(question => !answers[String(question.id)]?.trim())}>{zh ? '提交回答' : 'Submit answers'}</button>
    </form> : permissions ? <>
      <p>{typeof request.params.reason === 'string' ? request.params.reason : zh ? 'Codex 请求额外权限' : 'Codex requests additional permissions'}</p>
      <pre>{JSON.stringify(request.params.permissions, null, 2)}</pre>
      <button disabled={locked} onClick={() => { void submit({ permissions: request.params.permissions, scope: 'turn' }) }}>{zh ? '允许本轮' : 'Allow for this turn'}</button>
      <button disabled={locked} onClick={() => { void submit({ permissions: {}, scope: 'turn' }) }}>{zh ? '拒绝' : 'Deny'}</button>
    </> : <p>{zh ? '此请求需要对应的原生能力处理器：' : 'This request requires its native capability handler: '}{request.method}</p>}
    {receipt && <p role="status">{receipt.message}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
