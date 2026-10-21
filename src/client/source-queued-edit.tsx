import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HapiRemoteApi, WorkbenchSource } from '../client-api.ts'
import type { DeliveryView } from '../codex/projection-types.ts'
import { queuedEditRestoreSchedule, queuedEditRestoreText } from '../codex/queued-edit-types.ts'
import { captureScheduleDraft, restoreCancelledSchedule, scheduleRestoredEvent, type ScheduleStorage } from './schedule-draft.ts'
import { queuedEditComposerMatches, SourceQueuedEditController, type QueuedEditComposer } from './source-queued-edit-state.ts'
import type { NativeActionsApi } from './native-actions.tsx'
import type {} from './pane-navigation.ts'

type DockProps = PropsRuntime<'conversation.input.dock'>
const empty = { receipts: [], pending: [], restored: [], busy: false, loaded: false, error: null } as const
const nothing = () => () => {}
function browserStorage(): ScheduleStorage | undefined { try { return localStorage } catch { return undefined } }

/** Own queue actions, official editor; a cancellation never implicitly sends. */
export function useSourceQueuedEditing(ctx: Context, api: HapiRemoteApi, props: DockProps): {
  actions: NativeActionsApi['queuedEditing']; panel: React.ReactNode
} {
  const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), projection = native ?? observed
  const latest = useRef(props); latest.current = props
  const [viewId] = useState(() => crypto.randomUUID())
  const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
  const tr = (en: string, zh: string): string => language.startsWith('zh') ? zh : en
  const pane = ctx.get('hapiWorkspacePane')
  const value = useMemo(() => {
    if (!projection || observed?.sidechain) return null
    const source: WorkbenchSource = { sourceHubId: projection.hubId, sourceSessionId: projection.hapiSessionId,
      ...(projection.machineId ? { machineId: projection.machineId } : {}) }
    const store = browserStorage()
    const scheduleStore = ctx.get('hapiWorkspaceUi')?.sourceScheduleDrafts ?? pane?.sourceScheduleDrafts ?? store
    const input = () => {
      const binding = ctx.sessions.binding(props.sessionId)
      if (!binding) throw new Error('The original conversation is no longer open; its edit receipt is retained')
      const facade = ctx.conversation.input.for(binding.ctx), current = facade.state.getSnapshot()
      const composer: QueuedEditComposer = { viewId, draft: current.draft, draftRev: current.draftRev, attachmentIds: [...current.attachmentIds], phase: current.phase }
      return { binding, facade, composer }
    }
    return new SourceQueuedEditController(api, props.sessionId, store,
      `hapi-dsh:queue-edits:v1:${JSON.stringify([source.sourceHubId, source.sourceSessionId, props.sessionId, pane?.paneId ?? 'root'])}`, {
        capture(messageId) {
          const { composer } = input()
          if (composer.phase !== 'plain') throw new Error('Finish the current submission or remove its command chip before editing a queued message')
          return { composer, schedule: captureScheduleDraft(scheduleStore, source, props.sessionId, messageId) }
        },
        restore(receipt, before) {
          if (receipt.status !== 'cancelled' || receipt.proof === null) return { ok: false, reason: 'The original source has not confirmed cancellation' }
          if (receipt.hubId !== source.sourceHubId || receipt.sourceSessionId !== source.sourceSessionId || receipt.sessionId !== props.sessionId) return { ok: false, reason: 'The original edit belongs to a different source owner' }
          const current = input()
          if (!queuedEditComposerMatches(before.composer, current.composer)) return { ok: false,
            reason: 'The composer changed or was reopened while cancellation was pending. Your newer draft was kept; the cancelled message remains below for explicit recovery.' }
          if (queuedEditRestoreSchedule(receipt.candidate, Date.now()) !== null) {
            const restored = restoreCancelledSchedule(scheduleStore, source, props.sessionId, before.schedule, receipt)
            if (!restored.ok) return restored
            window.dispatchEvent(new CustomEvent(scheduleRestoredEvent, { detail: { key: before.schedule.key } }))
            if (pane) pane.openTab('hapi-schedule')
            else ctx.sidebarRight.openTab('hapi-schedule')
          } else {
            // Compare and write are in one synchronous JS turn. This public
            // operation replaces semantic chips intentionally after the user
            // selected Edit, without touching attachments or sending a prompt.
            latest.current.inputActions.setDraft(queuedEditRestoreText(receipt.candidate))
            latest.current.inputActions.persistDraft(); current.facade.focus()
          }
          return { ok: true }
        },
      }, undefined, { hubId: projection.hubId, sourceSessionId: projection.hapiSessionId, logicalSessionId: projection.logicalSessionId })
  }, [api, props.sessionId, projection?.hubId, projection?.hapiSessionId, projection?.machineId, projection?.logicalSessionId, Boolean(observed?.sidechain), pane?.paneId, viewId])
  const state = useSyncExternalStore(value?.subscribe ?? nothing, value?.getSnapshot ?? (() => empty))
  useEffect(() => { if (value) void value.load() }, [value])
  const unsettled = [...state.receipts.filter(row => row.status === 'unknown' || row.status === 'submitting').map(row => row.operationId), ...state.pending.map(row => row.operationId)]
  const unsettledKey = unsettled.join(',')
  useEffect(() => {
    if (!value || !unsettled.length) return
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') for (const operationId of unsettled) void value.read(operationId) }, 2500)
    return () => { clearInterval(timer) }
  }, [value, unsettledKey])
  const [opened, setOpened] = useState(false)
  const readyForRecovery = state.receipts.filter(receipt => receipt.sessionId === props.sessionId && receipt.status === 'cancelled'
    && receipt.proof !== null && !state.restored.includes(receipt.operationId)).map(receipt => receipt.operationId).join(',')
  // A source event may settle an unknown cancellation after remount. Keep its
  // manual recovery visible without automatically replacing the new draft.
  useEffect(() => { if (readyForRecovery) setOpened(true) }, [readyForRecovery])
  if (!value) return { actions: undefined, panel: null }
  const actions: NativeActionsApi['queuedEditing'] = { busy: state.busy, label: tr('Edit queued message', '编辑排队消息'),
    edit: (sessionId: string, delivery: DeliveryView) => {
      if (sessionId !== props.sessionId || !delivery.editable) return
      setOpened(true); void value.start(delivery.localId, delivery.messageId)
    } }
  const visible = state.receipts.length > 0 || state.pending.length > 0 || state.error || state.busy
  const panel = visible ? <details className="hapi-queued-edit-recovery" open={opened || Boolean(state.error) || unsettled.length > 0} data-hapi-queued-edits={props.sessionId}>
    <summary onClick={event => { event.preventDefault(); setOpened(!opened) }}>{tr('Queued message edits', '排队消息编辑')} · {state.receipts.length + state.pending.length}</summary>
    <p>{tr('Edit first cancels the original queued message. Only a confirmed cancellation restores its text; a future time opens the scheduled-message editor. Nothing is sent automatically.',
      '编辑会先取消原排队消息。只有原端明确确认取消后才恢复文本；尚未到期的计划会进入定时消息编辑页，不会自动发送。')}</p>
    {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
    {state.pending.map(request => <section key={request.operationId} data-queue-edit-operation={request.operationId} data-queue-edit-status="unknown">
      <p role="status">{tr('Host acknowledgement is missing. This identity is retained and will only be read.', '缺少 Host 回执，已保留原意图，后续仅查询。')} · {request.operationId}</p>
      <button type="button" disabled={state.busy} onClick={() => { void value.read(request.operationId) }}>{tr('Read this edit', '查询本次编辑')}</button></section>)}
    {state.receipts.map(receipt => <section key={receipt.operationId} data-queue-edit-operation={receipt.operationId} data-queue-edit-status={receipt.status}
      data-queue-edit-generation={receipt.sessionId === props.sessionId ? 'current' : 'previous'}>
      <p role="status">{receipt.status}{state.restored.includes(receipt.operationId) ? ` · ${tr('Draft restored; not sent', '草稿已恢复，尚未发送')}` : ''}</p>
      <pre>{queuedEditRestoreText(receipt.candidate)}</pre>
      {receipt.candidate.scheduledAt && <time dateTime={new Date(receipt.candidate.scheduledAt).toISOString()}>{new Date(receipt.candidate.scheduledAt).toLocaleString()}</time>}
      {receipt.error && <p>{receipt.error}</p>}
      {receipt.sessionId !== props.sessionId && <p>{tr('Previous display generation: retained read-only. This receipt cannot replace the current composer.', '此回执属于上一显示代次，仅供读取，不会替换当前输入框。')}</p>}
      {receipt.sessionId === props.sessionId && receipt.status === 'cancelled' && receipt.proof !== null && !state.restored.includes(receipt.operationId)
        && <button type="button" disabled={state.busy} onClick={() => { void value.restoreNow(receipt.operationId) }}>{tr('Restore cancelled draft', '恢复已取消的草稿')}</button>}
      {['unknown', 'submitting'].includes(receipt.status) && <button type="button" disabled={state.busy} onClick={() => { void value.read(receipt.operationId) }}>{tr('Read this edit', '查询本次编辑')}</button>}
      {['busy', 'invoked'].includes(receipt.status) && <p>{tr('The original message is being consumed or already invoked; it cannot be restored as an unsent edit.', '原消息正在消费或已执行，不能恢复为未发送草稿。')}</p>}
      <small>{receipt.operationId}</small>
    </section>)}
  </details> : null
  return { actions, panel }
}
