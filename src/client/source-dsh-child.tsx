import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandClaim } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-subagent/remote'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { HapiRemoteApi } from '../client-api.ts'
import type { SourceDshChildReceipt, SourceDshChildState } from '../hapi-agent/dsh-child-types.ts'
import { SourceDshChildController, type SourceDshChildApi, type SourceDshChildStorage } from './source-dsh-child-state.ts'
import { hapiObservedProjectionSchema } from '../hapi-agent/projection-types.ts'
import { SourceDshChildCommand } from './source-dsh-child-command.ts'

const controllers = new WeakMap<SourceDshChildApi, Map<string, SourceDshChildController>>()
function controller(api: SourceDshChildApi, sessionId: string): SourceDshChildController {
  let entries = controllers.get(api)
  if (!entries) { entries = new Map(); controllers.set(api, entries) }
  let current = entries.get(sessionId)
  if (!current) {
    let storage: SourceDshChildStorage | undefined
    try { storage = localStorage } catch { /* A durable intent is required before an interrupt. */ }
    current = new SourceDshChildController(api, sessionId, storage); entries.set(sessionId, current)
  }
  return current
}
const receiptStatus = (receipt: SourceDshChildReceipt, zh: boolean) => ({
  prepared: zh ? '已保存，尚未提交' : 'Saved, not yet submitted',
  dispatching: zh ? '正在等待源端回执' : 'Awaiting the original owner',
  accepted: zh ? '源端已接受；不代表执行完成' : 'Source accepted; execution completion is not implied',
  rejected: zh ? '源端未接受' : 'Not accepted',
  unknown: zh ? '提交结果未知；不会自动重发' : 'Submission unknown; it will not be sent again automatically',
})[receipt.status]

export function SourceDshChildPanel({ api, sessionId, initialState, language = 'en', active = true, compact = false }: {
  api: SourceDshChildApi; sessionId: string; initialState?: SourceDshChildState; language?: string; active?: boolean; compact?: boolean
}) {
  const value = useMemo(() => controller(api, sessionId), [api, sessionId])
  const snapshot = useSyncExternalStore(value.subscribe, value.getSnapshot), zh = language.startsWith('zh')
  useEffect(() => { if (initialState) value.observe(initialState) }, [value, initialState])
  useEffect(() => {
    if (!active) return
    void value.refresh()
    const timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void value.refresh() }, 2000)
    return () => { clearInterval(timer) }
  }, [value, active])
  const data = snapshot.data, title = zh ? 'DSH 源子会话' : 'Original DSH child'
  const content = <>
    {data && <>
      <p className="hapi-dsh-child-status"><strong>{data.descriptor.mode}</strong><span>{data.descriptor.activity === 'running' ? zh ? '运行中' : 'Running' : zh ? '源端空闲' : 'Source idle'}</span>
        <span>{data.readOnly ? zh ? '只读' : 'Read-only' : zh ? '可继续对话 · 仅文本' : 'Continue conversation · text only'}</span></p>
      {!compact && <dl><dt>{zh ? '源 Hub' : 'Source Hub'}</dt><dd>{data.hubId}</dd><dt>{zh ? '所属机器' : 'Runner'}</dt><dd>{data.machineId}</dd>
        <dt>{zh ? '原父会话' : 'Original parent'}</dt><dd>{data.parentDshSessionId}</dd><dt>{zh ? '原子会话' : 'Original child'}</dt><dd>{data.childDshSessionId}</dd></dl>}
      {data.unavailableReason && <p>{data.unavailableReason}</p>}
      <div className="hapi-button-row"><button type="button" disabled={snapshot.reading} onClick={() => { void value.refresh() }}>{zh ? '读取源状态与历史' : 'Read original state and history'}</button>
        {data.descriptor.mode === 'continuable' && <button type="button" disabled={data.readOnly || data.descriptor.activity !== 'running' || snapshot.busy || Boolean(snapshot.pendingInterrupt)}
          onClick={() => { void value.interrupt() }}>{zh ? '中断原子会话' : 'Interrupt original child'}</button>}</div>
      <p className="hapi-dsh-child-explanation">{zh
        ? `已读取 ${data.history.loaded} 条源记录。该源接口保留文本、推理和工具结果，但不提供原始轮次边界或完整附件；当前执行状态以源目录为准。`
        : `${data.history.loaded} original records loaded. This source interface retains text, reasoning and tool results, but does not expose original turn boundaries or full attachments. Execution state comes from the original child catalog.`}</p>
      {data.descriptor.mode === 'continuable' && <p className="hapi-dsh-child-explanation">{zh
        ? '请在官方输入框选择可见的 /child（后续消息）或 /child-steer（实时引导）命令后发送。源历史没有提交请求 ID，因此普通正文发送会被拒绝并保留草稿，避免留下无法确认的消息气泡。'
        : 'Choose the visible /child (follow-up) or /child-steer command in the official composer before sending. This source history omits prompt request IDs, so ordinary text Send is refused and retains the draft instead of leaving an unresolvable message echo.'}</p>}
      {data.history.truncated && <p role="status">{zh ? '源端已明确截断部分长输出；这里没有将其标为完整内容。' : 'The original owner truncated some long output; it is not represented as complete content.'}</p>}
      {data.receipts.length > 0 && <details open={data.receipts.some(receipt => receipt.status === 'unknown' || receipt.status === 'dispatching')}>
        <summary>{zh ? '源操作回执' : 'Original operation receipts'} · {data.receipts.length}</summary>
        {data.receipts.map(receipt => <section className="hapi-dsh-child-receipt" key={receipt.operationId} data-dsh-child-operation={receipt.operationId} data-dsh-child-receipt={receipt.status}>
          <header><strong>{receipt.kind === 'prompt' ? receipt.delivery === 'steer' ? zh ? '实时引导' : 'Steer' : zh ? '后续消息' : 'Follow-up' : zh ? '中断' : 'Interrupt'}</strong><time>{new Date(receipt.createdAt).toLocaleTimeString()}</time></header>
          <p role="status">{receiptStatus(receipt, zh)}</p>{receipt.text && <pre>{receipt.text}</pre>}
          {receipt.error && <p>{receipt.error}</p>}
          <small>{receipt.requestId ?? receipt.operationId}{receipt.sourceMessageId ? ` · ${receipt.sourceMessageId}` : ''}</small>
        </section>)}
      </details>}
    </>}
    {snapshot.pendingInterrupt && <p role="status" data-dsh-child-pending={snapshot.pendingInterrupt}>{zh
      ? `保留原中断意图 ${snapshot.pendingInterrupt}。后续检查只读取，不会提交第二次中断。`
      : `Original interrupt intent ${snapshot.pendingInterrupt} is retained. Further checks only read; they do not submit another interrupt.`}
      {data?.descriptor.activity === 'inactive' && <button type="button" onClick={value.closeInactiveIntent}>{zh ? '源端已空闲，结束本地等待' : 'Source is idle; close local waiting'}</button>}</p>}
    {snapshot.error && <p role="alert" className="hapi-error">{snapshot.error}</p>}
  </>
  return compact ? <details className="hapi-dsh-child-panel" data-dsh-child-controls={sessionId} open={Boolean(data?.receipts.some(receipt => receipt.status === 'unknown'))}>
    <summary>{title}{data ? ` · ${data.descriptor.mode}` : ''}</summary>{content}</details>
    : <section className="hapi-dsh-child-panel hapi-source-panel" data-dsh-child-controls={sessionId} aria-label={title}><h3>{title}</h3>{content}</section>
}

/** An additive control panel; all message input and chat remain official DSH. */
export function installSourceDshChildControls(ctx: Context, api: HapiRemoteApi): () => void {
  const scope = ctx.inject(['slots', 'sessions', 'conversation', 'inputTriggers', 'remote.subagents', 'locale'], owner => {
    const commands = new Map<string, SourceDshChildCommand>()
    const sourceOf = (sessionId: SessionId) => {
      const parsed = hapiObservedProjectionSchema.safeParse(owner.sessions.binding(sessionId)?.session.projections.faceOf('hapiObserved').getSnapshot())
      return parsed.success ? parsed.data?.dshChild : undefined
    }
    const commandOf = (source: SourceDshChildState) => {
      let entry = commands.get(source.sessionId)
      if (!entry) {
        let storage: SourceDshChildStorage | undefined
        try { storage = localStorage } catch { /* No command can be sent without its recovery identity. */ }
        entry = new SourceDshChildCommand(source.sessionId, api, async request => {
          const reply = await owner.remote.subagents.prompt({ childSessionId: request.childSessionId as SessionId,
            parentSessionId: request.parentSessionId as SessionId, mode: 'continuable', requestId: request.requestId as SubagentPromptRequestId,
            delivery: request.delivery, content: [{ type: 'text', text: request.text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          return reply.ok ? { ok: true, messageId: reply.value.messageId } : { ok: false, code: reply.error.code, message: reply.error.message }
        }, storage)
        commands.set(source.sessionId, entry)
      }
      entry.observe(source); return entry
    }
    const claimOf = (sessionId: SessionId, name: string): CommandClaim | undefined => {
      if (name !== 'child' && name !== 'child-steer') return undefined
      const source = sourceOf(sessionId); if (!source || source.descriptor.mode !== 'continuable') return undefined
      return { name, token: `/${name} `, attachments: false,
        hint: owner.locale.getSnapshot().active.startsWith('zh') ? '原 DSH 子任务 · 仅文本 · 回执单独保留' : 'Original DSH child · text only · separate durable receipts',
        submit: (args, actx, attachments) => {
          if (owner.sessions.sessionOf(actx)?.sessionId !== sessionId) return Promise.resolve({ kind: 'error', text: 'The original child input scope changed' })
          if (attachments.length) return Promise.resolve({ kind: 'error', text: 'The original child protocol accepts text only; retain these attachments' })
          const current = sourceOf(sessionId)
          if (!current) return Promise.resolve({ kind: 'error', text: 'The original child is no longer available' })
          return commandOf(current).submit(args, name === 'child-steer' ? 'steer' : 'queue')
        } }
    }
    const stopCommands = owner.inputTriggers.registerSource({ trigger: '/', name: 'hapi-source-child', order: -100,
      candidates: async (session, request) => sourceOf(session.sessionId)?.descriptor.mode === 'continuable' && request.position === 'leading'
        ? ['child', 'child-steer'].filter(name => name.includes(request.query)).map(name => ({ name, description: name === 'child' ? 'Continue the original DSH child' : 'Steer the original DSH child' })) : [],
      onPick: pick => { const claim = claimOf(pick.session.sessionId, pick.candidate.name); return claim ? { claim } : undefined },
      matchSpace: (session, token) => { const claim = claimOf(session.sessionId, token.slice(1)); return claim ? { claim } : undefined },
      matchEnter: async (session, line, signal, envelope) => {
        signal.throwIfAborted(); const claim = claimOf(session.sessionId, /^\/(child(?:-steer)?)(?:\s|$)/u.exec(line)?.[1] ?? '')
        if (claim && envelope.attachments) throw new Error('The original child protocol accepts text only; the attachments are retained')
        return claim ? { claim } : undefined
      },
      matchClaim: async (session, token, signal) => { signal.throwIfAborted(); return claimOf(session.sessionId, token.slice(1)) },
      lexicon: session => sourceOf(session.sessionId)?.descriptor.mode === 'continuable' ? ['child', 'child-steer'] : [],
    })
    const Composer = ({ props, source, language }: { props: PropsRuntime<'conversation.input.dock'>; source: SourceDshChildState; language: string }) => {
      const input = props.useInput(value => value), zh = language.startsWith('zh')
      const command = useMemo(() => commandOf(source), [props.sessionId])
      const state = useSyncExternalStore(command.subscribe, command.getSnapshot)
      const [error, setError] = useState<string | null>(null), [closing, setClosing] = useState(false)
      useEffect(() => { command.observe(source) }, [command, source])
      const enter = (name: string) => {
        const binding = owner.sessions.binding(props.sessionId), claim = claimOf(props.sessionId, name)
        if (!binding || !claim) return
        const facade = owner.conversation.input.for(binding.ctx), before = facade.state.getSnapshot()
        if (before.phase !== 'plain' || !binding.ctx.bail(binding.ctx, 'slash/input-begin-command', { claim,
          span: { start: 0, end: 0, draftRev: before.draftRev } })) { setError(zh ? '输入框已改变，请保留当前草稿后重试。' : 'The input changed. Retain the current draft and try again.'); return }
        props.inputActions.persistDraft(); facade.focus(); setError(null)
      }
      return <section className="hapi-dsh-child-command" data-dsh-child-command={props.sessionId}>
        {source.descriptor.mode === 'continuable' && <>
          <p>{zh ? '使用官方输入框里的源续聊命令。' : 'Use an explicit source command in the official composer.'}</p>
          <div className="hapi-button-row"><button type="button" disabled={source.readOnly || input.phase !== 'plain'} onClick={() => enter('child')}>{zh ? '切入 /child 续聊' : 'Use /child follow-up'}</button>
            <button type="button" disabled={source.readOnly || input.phase !== 'plain'} onClick={() => enter('child-steer')}>{zh ? '切入 /child-steer 引导' : 'Use /child-steer'}</button></div>
          {input.claim?.name === 'child' || input.claim?.name === 'child-steer' ? <p role="status">{zh ? '发送将提交当前可见命令，源回执会单独保留。' : 'Send submits the visible command. Its original receipt is retained separately.'}</p> : null}
        </>}
        {state.pending && <div role="status" data-dsh-child-command-pending={state.pending.status}>
          <p>{zh ? '保留的原命令' : 'Retained original command'} · {state.pending.requestId} · {state.pending.status}</p><pre>{state.pending.text}</pre>
          <button type="button" disabled={state.busy} onClick={() => { void command.inspect() }}>{zh ? '只读取原回执' : 'Read original receipt only'}</button>
          <button type="button" disabled={state.busy} onClick={() => setClosing(true)}>{zh ? '结束本地等待' : 'Close local waiting'}</button>
          {closing && <div role="alert"><p>{zh ? '源端可能已执行。结束本地等待不会取消原任务；再次提交同文可能重复执行。' : 'The source may already have executed this command. Closing local waiting does not cancel it; sending the same text again can duplicate execution.'}</p>
            <button type="button" onClick={() => { command.closeWaiting(); setClosing(false) }}>{zh ? '确认仅结束等待' : 'Confirm close waiting only'}</button>
            <button type="button" onClick={() => setClosing(false)}>{zh ? '继续保留' : 'Keep waiting'}</button></div>}
        </div>}
        {(error || state.error) && <p role="alert" className="hapi-error">{error ?? state.error}</p>}
        <SourceDshChildPanel api={api} sessionId={props.sessionId} initialState={source} language={language} compact/>
      </section>
    }
    const Controls = (props: PropsRuntime<'conversation.input.dock'>) => {
      const source = props.useProjection('hapiObserved')?.dshChild
      const language = useSyncExternalStore(listener => owner.locale.subscribe(listener), () => owner.locale.getSnapshot().active)
      return source ? <Composer props={props} source={source} language={language}/> : null
    }
    const stop = owner.slots.inject('conversation.input.dock', () => owner.slots.register({ name: 'conversation.input.dock', id: 'hapi.dsh-child-controls', order: -90 }, Controls))
    return () => { stop(); stopCommands(); commands.clear() }
  })
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
  return () => { void scope.dispose(); style.remove() }
}
const styles = `.hapi-dsh-child-panel,.hapi-dsh-child-command{font-size:12px;color:var(--text-primary,inherit);padding:8px;border:1px solid var(--border-secondary,#8884);border-radius:8px;min-width:0}.hapi-dsh-child-panel summary{cursor:pointer}.hapi-dsh-child-status,.hapi-dsh-child-receipt header{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}.hapi-dsh-child-explanation{color:var(--text-secondary,#888);font-size:11px}.hapi-dsh-child-panel dd,.hapi-dsh-child-receipt small,.hapi-dsh-child-command p{overflow-wrap:anywhere}.hapi-dsh-child-receipt{padding:6px 0;border-top:1px solid var(--border-secondary,#8884)}.hapi-dsh-child-receipt pre,.hapi-dsh-child-command pre{max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}.hapi-dsh-child-panel button,.hapi-dsh-child-command button{cursor:pointer}.hapi-dsh-child-panel button:disabled,.hapi-dsh-child-command button:disabled{cursor:default;opacity:.5}`
