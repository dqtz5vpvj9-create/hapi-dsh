/** Concrete native queue and Goal workflows. The main composer and its draft remain under their own owner. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, Menu, Modal, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconGoalOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, IconQueueOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import type { NativeActionRecord } from './remote-operation-contracts.ts'
import { queueIntent, queueTextBlocks, queueInputSummary, remoteNativeTasks, nativeQueueItem, type NativeQueueItem, type RemoteNativeTasks } from './remote-native-task-state.ts'
import { randomId } from './random-id.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'

const emptyRecords: readonly NativeActionRecord[] = []
const emptyStore = { getSnapshot: () => emptyRecords, subscribe: () => () => {} }
type Edit = { original: NativeQueueItem; texts: readonly string[] }
function TaskHeader({ language, refresh, loading, close }: { language: string; refresh?: (() => void) | undefined; loading?: boolean; close?: (() => void) | undefined }) {
  const zh = language.startsWith('zh'), tr = (en: string, cn: string) => zh ? cn : en
  return <header className="hhpi-task-header"><h2>{tr('Queue & Goal', '队列与目标')}</h2><div className="hhpi-task-actions">
    {refresh && <Button variant="toolbar" size="sm" className="hhpi-task-icon" aria-label={tr('Refresh source state', '刷新来源状态')} title={tr('Refresh source state', '刷新来源状态')} disabled={loading} onClick={refresh}><IconRefreshOutlineRegular size={16}/></Button>}
    {close && <Button variant="toolbar" size="sm" className="hhpi-task-icon" aria-label={tr('Close', '关闭')} title={tr('Close', '关闭')} onClick={close}><IconCloseOutlineRegular size={16}/></Button>}
  </div></header>
}
function elapsedTime(seconds: number, zh: boolean): string {
  let remaining = Math.max(0, Math.floor(seconds))
  const units = [[86400, zh ? '天' : 'd'], [3600, zh ? '小时' : 'h'], [60, zh ? '分钟' : 'm'], [1, zh ? '秒' : 's']] as const
  const parts: string[] = []
  for (const [size, suffix] of units) {
    const value = Math.floor(remaining / size)
    if (value) { parts.push(`${value}${suffix}`); remaining %= size }
    if (parts.length === 2) break
  }
  return parts.join(' ') || (zh ? '0秒' : '0s')
}
function TaskBody({ controller, language, close }: { controller: RemoteNativeTasks; language: string; close?: () => void }) {
  const zh = language.startsWith('zh'), tr = (en: string, cn: string) => zh ? cn : en
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), session = controller.session
  const metadata = useSyncExternalStore(session.metadata.subscribe, session.metadata.getSnapshot)
  const owner = session.nativeActions
  const actionStore = useMemo(() => owner?.view(session.sessionId) ?? emptyStore, [owner, session.sessionId])
  const actions = useSyncExternalStore(actionStore.subscribe, actionStore.getSnapshot)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [last, setLast] = useState<NativeActionRecord | null>(null)
  const [edits, setEdits] = useState<ReadonlyMap<string, Edit>>(() => new Map())
  const [objective, setObjective] = useState(''), [budget, setBudget] = useState(''), [goalDirty, setGoalDirty] = useState(false)
  const [goalEditing, setGoalEditing] = useState(false), [goalMenu, setGoalMenu] = useState(false)
  const goalInput = useRef<HTMLTextAreaElement>(null)
  const generation = useRef(0)
  useEffect(() => { ++generation.current; void controller.refresh(); void owner?.restore().catch(() => {}); return () => { ++generation.current } }, [controller, owner])
  const originalGoal = actions.find(action => action.intent === 'goal' && !['accepted', 'rejected'].includes(action.phase))
  useEffect(() => { if (goalEditing && !originalGoal) goalInput.current?.focus() }, [goalEditing, originalGoal])
  useEffect(() => {
    if (goalDirty) return
    const proposed = originalGoal?.request.method === 'thread/goal/set' ? originalGoal.request.params : undefined
    if (typeof proposed?.objective === 'string') { setObjective(proposed.objective); setBudget(proposed.tokenBudget == null ? '' : String(proposed.tokenBudget)) }
    else if (state.goal !== undefined) { setObjective(state.goal?.objective ?? ''); setBudget(state.goal?.tokenBudget == null ? '' : String(state.goal.tokenBudget)) }
  }, [state.goal, goalDirty, originalGoal])
  useEffect(() => {
    setEdits(old => {
      const next = new Map(old)
      for (const action of actions) {
        if (action.request.method !== 'thread/queue/update' || ['accepted', 'rejected'].includes(action.phase)) continue
        const params = action.request.params, id = params?.queuedSubmissionId
        if (typeof id !== 'string' || next.has(id) || !Array.isArray(params?.input)) continue
        const current = state.queue?.find(row => row.id === id)
        const desired = nativeQueueItem({ id, clientUserMessageId: current?.clientUserMessageId ?? '', input: params.input })
        next.set(id, { original: current ?? desired, texts: queueTextBlocks(desired) })
      }
      return next.size !== old.size ? next : old
    })
  }, [actions, state.queue])
  if (!state.current) return <div className="hhpi-native-task-panel"><TaskHeader language={language} close={close}/><div className="hhpi-task-content"><p role="status">{tr('This account or source changed. Close this panel and reopen it from the current conversation.', '账号或来源已改变，请关闭此页后从当前会话重新打开。')}</p></div></div>
  const pending = actions.filter(action => !['accepted', 'rejected'].includes(action.phase) && (action.kind === 'queue' || action.kind === 'goal'))
  const unavailable = busy || sourceIsOffline(metadata)
  const blocked = (intent: string, method: string) => unavailable || state.capabilities?.methods[method] !== 'write' || pending.some(action => action.intent === intent)
  const run = async (work: () => Promise<NativeActionRecord | undefined>, accepted?: () => void) => {
    if (busy) return
    const current = generation.current
    setBusy(true); setError('')
    try {
      const result = await work()
      if (current !== generation.current) return
      setLast(result ?? null)
      if (result?.phase === 'accepted') accepted?.()
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  const closeEdit = (id: string) => setEdits(old => { const next = new Map(old); next.delete(id); return next })
  const goalEditorOpen = goalEditing || originalGoal?.request.method === 'thread/goal/set' && originalGoal.request.params?.status === undefined
  const goalLabel = state.goal && ({ active: tr('Active', '进行中'), paused: tr('Paused', '已暂停'), blocked: tr('Blocked', '受阻'), usageLimited: tr('Usage limited', '已达使用限制'), budgetLimited: tr('Budget limited', '已达预算限制'), complete: tr('Complete', '已完成') })[state.goal.status]
  const number = (value: number) => new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  const finishGoalEdit = () => { setGoalDirty(false); setGoalEditing(false) }
  return <div className="hhpi-native-task-panel">
    <TaskHeader language={language} refresh={() => { void controller.refresh() }} loading={state.loading} close={close}/>
    <div className="hhpi-task-content">
      {sourceIsOffline(metadata) && <p className="hhpi-task-notice" role="status">{tr('Source offline. Your edits are kept; reconnect before saving.', '来源离线，编辑已保留。重新连接后可保存。')}</p>}
      <section aria-label={tr('Persistent goal', '持续目标')} className="hhpi-task-section">
        <div className="hhpi-task-section-heading"><h3><IconGoalOutlineRegular size={16}/>{tr('Goal', '持续目标')}</h3>{state.goal && <span className="hhpi-task-state" data-status={state.goal.status} role="status">{goalLabel}</span>}</div>
        {state.capabilities && state.capabilities.methods['thread/goal/get'] !== 'read' && <p className="hhpi-task-muted">{tr('Goals are unavailable for this source.', '此来源暂不支持持续目标。')}</p>}
        {state.goal === undefined && state.loading && <p className="hhpi-task-muted" role="status">{tr('Loading goal…', '正在读取目标…')}</p>}
        {!goalEditorOpen && <>
          {state.goal && <p className="hhpi-task-objective">{state.goal.objective}</p>}
          {state.goal === null && <p className="hhpi-task-muted">{tr('No persistent goal.', '尚无持续目标。')}</p>}
          {state.goal !== undefined && <div className="hhpi-task-actions">
            {state.goal && <>
              <Button size="sm" variant="outline" icon={state.goal.status === 'active' ? <IconPauseOutlineRegular size={14}/> : <IconPlayOutlineRegular size={14}/>} disabled={blocked('goal', 'thread/goal/set') || goalDirty}
                onClick={() => { void run(() => controller.setGoal(state.goal!.objective, state.goal!.tokenBudget, state.goal!.status === 'active' ? 'paused' : 'active')) }}>{state.goal.status === 'active' ? tr('Pause goal', '暂停目标') : tr('Resume goal', '继续目标')}</Button>
              {state.goal.status !== 'complete' && <Button size="sm" icon={<IconCheckOutlineRegular size={14}/>} disabled={blocked('goal', 'thread/goal/set') || goalDirty} onClick={() => { void run(() => controller.setGoal(state.goal!.objective, state.goal!.tokenBudget, 'complete')) }}>{tr('Mark goal complete', '标记目标完成')}</Button>}
            </>}
            <Button size="sm" variant={state.goal ? 'ghost' : 'outline'} icon={<IconEditOutlineRegular size={14}/>} disabled={blocked('goal', 'thread/goal/set')} onClick={() => setGoalEditing(true)}>{state.goal ? tr('Edit goal', '编辑目标') : tr('Set goal', '设置目标')}</Button>
            {state.goal && <Menu open={goalMenu} onClose={() => setGoalMenu(false)} align="end" portal compact items={[{ id: 'clear', label: tr('Clear goal', '清除目标'), icon: <IconTrashOutlineRegular size={16}/>, danger: true, disabled: blocked('goal', 'thread/goal/clear') }]}
              onSelect={() => { setGoalMenu(false); void run(() => controller.clearGoal(), finishGoalEdit) }} anchor={<Button variant="toolbar" size="sm" className="hhpi-task-icon" aria-label={tr('More goal actions', '更多目标操作')} title={tr('More goal actions', '更多目标操作')} aria-haspopup="menu" aria-expanded={goalMenu} onClick={() => setGoalMenu(value => !value)}><IconEllipsisOutlineRegular size={16}/></Button>}/>}
          </div>}
        </>}
        {goalEditorOpen && <form aria-label={tr('Edit goal', '编辑目标')} className="hhpi-task-form" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void run(() => controller.setGoal(objective, budget.trim() ? Number(budget) : null), finishGoalEdit) }}>
          <label>{tr('Goal objective', '持续目标')}<textarea ref={goalInput} rows={4} data-modal-autofocus disabled={busy || Boolean(originalGoal)} value={objective} onChange={event => { setObjective(event.target.value); setGoalDirty(true) }}/></label>
          <label className="hhpi-task-budget">{tr('Token budget (optional)', 'Token 预算（可选）')}<Input type="number" min="1" step="1" placeholder={tr('No limit', '不设上限')} disabled={busy || Boolean(originalGoal)} value={budget} onChange={event => { setBudget(event.target.value); setGoalDirty(true) }}/></label>
          <div className="hhpi-task-actions"><Button variant="primary" size="sm" type="submit" disabled={blocked('goal', 'thread/goal/set') || !objective.trim()}>{tr('Save goal', '保存目标')}</Button><Button size="sm" disabled={busy || Boolean(originalGoal)} onClick={finishGoalEdit}>{tr('Cancel editing', '取消编辑')}</Button></div>
        </form>}
        {state.goal && <details className="hhpi-task-usage"><summary>{tr('Usage details', '用量详情')}</summary><dl>
          <div><dt>{tr('Tokens used', '已用 Token')}</dt><dd>{number(state.goal.tokensUsed)}</dd></div>
          <div><dt>{tr('Token budget', 'Token 预算')}</dt><dd>{state.goal.tokenBudget == null ? tr('No limit', '不设上限') : number(state.goal.tokenBudget)}</dd></div>
          <div><dt>{tr('Recorded time', '累计时间')}</dt><dd>{elapsedTime(state.goal.timeUsedSeconds, zh)}</dd></div>
        </dl></details>}
      </section>
      <section aria-label={tr('Native queue', '原生队列')} className="hhpi-task-section">
        <div className="hhpi-task-section-heading"><h3><IconQueueOutlineRegular size={16}/>{tr('Queue', '排队消息')}</h3>{!!state.queue?.length && <span className="hhpi-task-count">{state.queue.length}</span>}</div>
        {state.capabilities && state.capabilities.methods['thread/queue/list'] !== 'read' && <p className="hhpi-task-muted">{tr('Queue is unavailable for this source.', '此来源暂不支持排队消息。')}</p>}
        {state.queue === undefined && state.loading && <p className="hhpi-task-muted" role="status">{tr('Loading queued messages…', '正在读取排队消息…')}</p>}
        {state.queue?.length === 0 && <p className="hhpi-task-muted">{tr('No queued messages.', '没有排队消息。')}</p>}
        {!!state.queue?.length && metadata.status !== 'idle' && <p className="hhpi-task-muted">{tr('Stop the current turn before starting a queued message.', '停止当前轮次后，可开始排队消息。')}</p>}
        {!!state.queue?.length && <ol className="hhpi-task-queue">{state.queue.map((row, index) => <li key={row.id} data-native-queue-id={row.id}>
          <div className="hhpi-task-queue-body"><span className="hhpi-task-queue-position">{index + 1}</span><p>{queueInputSummary(row)}</p></div>
          <div className="hhpi-task-actions hhpi-task-queue-actions">
            <Button size="sm" variant="outline" icon={<IconPlayOutlineRegular size={14}/>} disabled={metadata.status !== 'idle' || blocked(queueIntent(row.id), 'thread/queue/start')} onClick={() => { void run(() => controller.start(row.id)) }}>{tr('Start this message', '开始这条消息')}</Button>
            <Button size="sm" icon={<IconEditOutlineRegular size={14}/>} disabled={blocked(queueIntent(row.id), 'thread/queue/update') || edits.has(row.id)} onClick={() => setEdits(old => new Map(old).set(row.id, { original: row, texts: queueTextBlocks(row) }))}>{tr('Edit', '编辑')}</Button>
            <span className="hhpi-task-order"><Button variant="toolbar" size="sm" className="hhpi-task-icon" aria-label={tr('Move up', '上移')} title={tr('Move up', '上移')} disabled={index === 0 || blocked('queue-order', 'thread/queue/reorder')} onClick={() => { void run(() => controller.move(row.id, -1)) }}><IconChevronUpOutlineRegular size={16}/></Button>
              <Button variant="toolbar" size="sm" className="hhpi-task-icon" aria-label={tr('Move down', '下移')} title={tr('Move down', '下移')} disabled={index === state.queue!.length - 1 || blocked('queue-order', 'thread/queue/reorder')} onClick={() => { void run(() => controller.move(row.id, 1)) }}><IconChevronDownOutlineRegular size={16}/></Button></span>
            <Button variant="toolbar" size="sm" className="hhpi-task-icon" aria-label={tr('Cancel queued message', '取消排队消息')} title={tr('Cancel queued message', '取消排队消息')} disabled={blocked(queueIntent(row.id), 'thread/queue/delete')} onClick={() => { void run(() => controller.remove(row.id)) }}><IconCloseOutlineRegular size={16}/></Button>
          </div>
        </li>)}</ol>}
        {[...edits].map(([id, edit]) => <form key={id} className="hhpi-task-form hhpi-task-queue-editor" aria-label={tr('Edit queued message', '编辑排队消息')} onSubmit={event => { event.preventDefault(); event.stopPropagation(); void run(() => controller.edit(edit.original, edit.texts), () => closeEdit(id)) }}>
          {!state.queue?.some(row => row.id === id) && <p className="hhpi-task-notice" role="status">{tr('This item has left the native queue. Your edit is kept here; it will not be added again.', '这条消息已离开原生队列。编辑内容保留在这里，不会重新入队。')}</p>}
          {edit.texts.map((text, index) => <label key={index}>{tr('Message text', '消息正文')} {index + 1}<textarea rows={3} disabled={busy || pending.some(action => action.intent === queueIntent(id))} value={text} onChange={event => setEdits(old => { const next = new Map(old), texts = [...edit.texts]; texts[index] = event.target.value; next.set(id, { ...edit, texts }); return next })}/></label>)}
          {!edit.texts.length && <p className="hhpi-task-muted">{tr('This message has no editable text.', '这条消息没有可编辑正文。')}</p>}
          <div className="hhpi-task-actions"><Button variant="primary" size="sm" type="submit" disabled={!edit.texts.length || !state.queue?.some(row => row.id === id) || blocked(queueIntent(id), 'thread/queue/update')}>{tr('Save queued edit', '保存排队编辑')}</Button><Button size="sm" onClick={() => closeEdit(id)}>{tr('Close editor', '关闭编辑')}</Button></div>
        </form>)}
      </section>
      {pending.map(action => <div className="hhpi-task-notice" key={action.intent}><p role="status">{action.outcome?.message ?? tr('Waiting for source confirmation.', '等待来源确认。')}</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(() => controller.check(action.intent)) }}>{action.phase === 'prepared' ? tr('Continue original request', '继续原请求') : tr('Check original request', '检查原请求结果')}</Button></div>)}
      {last?.outcome && ['accepted', 'rejected'].includes(last.phase) && <p className="hhpi-task-feedback" role={last.phase === 'rejected' ? 'alert' : 'status'}>{last.outcome.message}</p>}
      {(state.error || error) && <p className="hhpi-task-feedback" role="alert">{error || state.error}</p>}
    </div>
  </div>
}
export function RemoteTaskPanel({ session, api, language = 'en', close }: { session: RemoteSourceSession; api: Pick<HhpiRemoteApi, 'nativeCall'>; language?: string; close?: () => void }) {
  const controller = useMemo(() => remoteNativeTasks(session, api), [session, api])
  const viewKey = useMemo(() => randomId(), [controller])
  if (!controller) return <div className="hhpi-native-task-panel"><TaskHeader language={language} close={close}/><div className="hhpi-task-content"><p role="status">{language.startsWith('zh') ? '原生操作服务未装配。' : 'Native task actions are not connected.'}</p></div></div>
  return <TaskBody key={viewKey} controller={controller} language={language} {...(close ? { close } : {})}/>
}

/** Mount this beside the exact Pane composer; the task tab can mount RemoteTaskPanel with the same props. */
export function RemoteTaskEntry({ session, api, language = 'en' }: { session: RemoteSourceSession; api: Pick<HhpiRemoteApi, 'nativeCall'>; language?: string }) {
  const [open, setOpen] = useState(false)
  const zh = language.startsWith('zh')
  useEffect(() => { setOpen(false) }, [session])
  return <><Button variant="toolbar" size="sm" className="hhpi-task-entry" aria-label={zh ? '队列与目标' : 'Queue & Goal'} title={zh ? '队列与目标' : 'Queue & Goal'} aria-haspopup="dialog" onClick={() => setOpen(true)}><IconGoalOutlineRegular size={16}/></Button>
    <Modal open={open} headless title={zh ? '队列与目标' : 'Queue & Goal'} className="hhpi-native-task-dialog" onClose={() => setOpen(false)}>
      {open && <RemoteTaskPanel session={session} api={api} language={language} close={() => setOpen(false)}/>}
    </Modal>
  </>
}

export const remoteNativeTaskStyles = `
.hhpi-native-task-dialog{width:min(600px,100%);max-height:100%;padding:0;gap:0;color:var(--dsw-alias-label-primary)}
.hhpi-native-task-panel{display:flex;flex-direction:column;min-width:0;min-height:0;font:var(--dsw-font-sm-14,14px/1.5 Inter,system-ui,sans-serif);color:var(--dsw-alias-label-primary)}
.hhpi-task-header{display:flex;flex-shrink:0;justify-content:space-between;align-items:center;gap:16px;padding:18px 20px 12px}.hhpi-task-header h2{margin:0;font-size:16px;line-height:24px;font-weight:500}
.hhpi-task-content{display:grid;gap:20px;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 24px 24px}.hhpi-task-section{display:grid;gap:12px;min-width:0}.hhpi-task-section+.hhpi-task-section{padding-top:18px;border-top:1px solid var(--dsw-alias-border-l2,#8883)}
.hhpi-task-section-heading{display:flex;align-items:center;gap:8px;min-width:0}.hhpi-task-section-heading h3{display:flex;align-items:center;gap:8px;flex:1;min-width:0;margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.hhpi-native-task-panel p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.hhpi-task-objective{font-size:14px;line-height:22px;max-height:264px;overflow-y:auto}.hhpi-task-muted{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.hhpi-task-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.hhpi-task-actions button{flex-shrink:0}.hhpi-task-icon{width:28px;padding:0!important;display:inline-flex;align-items:center;justify-content:center}.hhpi-task-state,.hhpi-task-count{font-size:12px;line-height:20px;padding:0 7px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.hhpi-task-state[data-status=active]{color:var(--dsw-alias-state-business-primary)}.hhpi-task-usage{color:var(--dsw-alias-label-tertiary);font-size:12px}.hhpi-task-usage summary{cursor:pointer;width:fit-content}.hhpi-task-usage dl{display:flex;gap:12px 24px;flex-wrap:wrap;margin:10px 0 0}.hhpi-task-usage dl div{display:grid;gap:2px}.hhpi-task-usage dt,.hhpi-task-usage dd{margin:0}.hhpi-task-usage dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.hhpi-task-form,.hhpi-task-form label{display:grid;gap:8px;min-width:0}.hhpi-task-form{gap:14px}.hhpi-task-form label{color:var(--dsw-alias-label-secondary);font-size:13px}.hhpi-task-form textarea{box-sizing:border-box;width:100%;min-width:0;max-height:264px;padding:9px 10px;border:.5px solid var(--dsw-alias-border-l4,#8886);border-radius:var(--dsw-radius-sm,8px);outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;line-height:20px;resize:vertical}.hhpi-task-form textarea:focus{border-color:var(--dsw-alias-state-business-primary)}.hhpi-task-budget{max-width:240px}.hhpi-task-budget input{width:100%}
.hhpi-task-queue{display:grid;gap:10px;margin:0;padding:0;list-style:none}.hhpi-task-queue li{display:grid;gap:8px;min-width:0;border:1px solid var(--dsw-alias-border-l2,#8883);border-radius:var(--dsw-radius-md,10px);padding:12px}.hhpi-task-queue-body{display:flex;gap:10px;align-items:baseline;min-width:0}.hhpi-task-queue-body p{flex:1;min-width:0;font-size:13px;line-height:20px;max-height:160px;overflow-y:auto}.hhpi-task-queue-position{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}.hhpi-task-queue-actions{padding-left:16px}.hhpi-task-order{display:flex;margin-left:auto}.hhpi-task-queue-editor{padding:12px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1)}
.hhpi-task-notice{display:grid;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px}.hhpi-task-notice button{justify-self:start}.hhpi-task-feedback{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}.hhpi-task-feedback[role=alert]{color:var(--dsw-alias-state-error-primary,#b53232)}
`
