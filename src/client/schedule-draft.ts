import type { WorkbenchSource } from '../workbench-types.ts'
import { deliveryViewSchema, type DeliveryView } from '../codex/projection-types.ts'
import { queuedEditRestoreSchedule, queuedEditRestoreText, type SourceQueuedEditReceipt } from '../codex/queued-edit-types.ts'
import { persistSchedule, readScheduleSelection, type ScheduleSelection } from './schedule-selection.ts'

export type ScheduleStorage = Pick<Storage, 'getItem' | 'setItem'> & {
  subscribe?: ((listener: (key: string) => void) => () => void) | undefined
}
export interface SourceScheduleDrafts extends ScheduleStorage {
  subscribe(listener: (key: string) => void): () => void
  dispose(): void
}
export type ScheduleIntent = { sessionId: string; operationId: string; text: string; scheduledAt: number }
export interface ScheduleDraft { text: string; at: string; selection: ScheduleSelection; intent: ScheduleIntent | null; receipt: DeliveryView | null }
export interface ScheduleDraftCapture { key: string; raw: string | null; replaceIntentMessageId: string | null }
export const scheduleRestoredEvent = 'hapi-dsh:schedule-draft-restored'
export function localDateTime(value: number): string { return new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
export function scheduleKey(source: WorkbenchSource, sessionId: string): string {
  return `hapi-dsh:schedule:${JSON.stringify([source.sourceHubId, source.sourceSessionId])}:${sessionId}`
}
/** An explicit root capability for source schedule drafts only. Official plugin
 * stores keep their per-graph namespaces; no arbitrary localStorage is shared. */
export function createSourceScheduleDrafts(storage?: Pick<Storage, 'getItem' | 'setItem'>,
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>): SourceScheduleDrafts {
  const listeners = new Set<(key: string) => void>()
  const check = (key: string): void => {
    const prefix = 'hapi-dsh:schedule:', end = key.lastIndexOf(']:')
    if (!key.startsWith(prefix) || end < prefix.length) throw new Error('Only source schedule drafts are shared between panes')
    const identity: unknown = JSON.parse(key.slice(prefix.length, end + 1)), sessionId = key.slice(end + 2)
    const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(id)
    if (!Array.isArray(identity) || identity.length !== 2 || !validId(identity[0]) || !validId(identity[1]) || !validId(sessionId)
      || scheduleKey({ sourceHubId: identity[0], sourceSessionId: identity[1] }, sessionId) !== key) throw new Error('Invalid original schedule source identity')
  }
  const publish = (key: string): void => { for (const listener of listeners) listener(key) }
  const changed = (event: StorageEvent): void => {
    if (event.key === null) return
    try { check(event.key) } catch { return }
    publish(event.key)
  }
  events?.addEventListener('storage', changed)
  return {
    getItem(key) { check(key); if (!storage) throw new Error('Source schedule recovery storage is unavailable'); return storage.getItem(key) },
    setItem(key, value) {
      check(key)
      if (!storage) throw new Error('Source schedule recovery storage is unavailable')
      if (typeof value !== 'string' || value.length > 6_000_000) throw new Error('The source schedule draft is too large')
      if (storage.getItem(key) === value) return
      storage.setItem(key, value)
      if (storage.getItem(key) !== value) throw new Error('The source schedule draft could not be retained')
      publish(key)
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() { events?.removeEventListener('storage', changed); listeners.clear() },
  }
}
export function readScheduleDraft(store: ScheduleStorage | undefined, source: WorkbenchSource, sessionId: string): ScheduleDraft {
  const empty: ScheduleDraft = { text: '', at: localDateTime(Date.now() + 300_000), selection: { type: 'preset', preset: '+5m' }, intent: null, receipt: null }
  try {
    const value = JSON.parse(store?.getItem(scheduleKey(source, sessionId)) ?? 'null') as ScheduleDraft | null
    if (!value || typeof value.text !== 'string' || value.text.length > 2_000_000 || typeof value.at !== 'string' || !Number.isFinite(new Date(value.at).getTime())) return empty
    const intent = value.intent
    if (intent && (intent.sessionId !== sessionId || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(intent.operationId)
      || typeof intent.text !== 'string' || !intent.text.trim() || intent.text.length > 1_000_000 || !Number.isSafeInteger(intent.scheduledAt))) return empty
    const receipt = deliveryViewSchema.safeParse(value.receipt)
    return { text: value.text, at: value.at, selection: readScheduleSelection(value.selection, value.at), intent: intent ?? null,
      receipt: intent && receipt.success && receipt.data.messageId === `hapi-schedule:${intent.operationId}` ? receipt.data : null }
  } catch { return empty }
}
export function saveScheduleDraft(store: ScheduleStorage | undefined, source: WorkbenchSource, sessionId: string, draft: ScheduleDraft): boolean {
  return persistSchedule(store, scheduleKey(source, sessionId), draft)
}
export function captureScheduleDraft(store: ScheduleStorage | undefined, source: WorkbenchSource, sessionId: string,
  replaceIntentMessageId?: string): ScheduleDraftCapture {
  if (!store) throw new Error('Browser recovery storage is unavailable; the queue has not been changed')
  const key = scheduleKey(source, sessionId)
  return { key, raw: store.getItem(key), replaceIntentMessageId: replaceIntentMessageId ?? null }
}
export function restoreCancelledSchedule(store: ScheduleStorage | undefined, source: WorkbenchSource, sessionId: string,
  before: ScheduleDraftCapture, receipt: SourceQueuedEditReceipt, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  if (receipt.status !== 'cancelled' || receipt.proof === null) return { ok: false, reason: 'Only an original confirmed cancellation can restore an edit' }
  if (receipt.sessionId !== sessionId || receipt.hubId !== source.sourceHubId || receipt.sourceSessionId !== source.sourceSessionId
    || before.key !== scheduleKey(source, sessionId)) return { ok: false, reason: 'The original schedule belongs to another source session' }
  const time = queuedEditRestoreSchedule(receipt.candidate, now)
  if (time === null) return { ok: false, reason: 'The original scheduled time is no longer in the future' }
  try {
    if (!store || store.getItem(before.key) !== before.raw) return { ok: false, reason: 'The schedule draft changed while cancellation was pending. The original text and time remain in the receipt.' }
    const current = readScheduleDraft(store, source, sessionId)
    if (current.intent && `hapi-schedule:${current.intent.operationId}` !== before.replaceIntentMessageId) return { ok: false,
      reason: 'Another scheduled submission is retained. Finish its local review or choose New scheduled message before restoring this edit.' }
    const restored: ScheduleDraft = { text: queuedEditRestoreText(receipt.candidate), at: localDateTime(time),
      selection: { type: 'absolute', ms: time }, intent: null, receipt: null }
    if (!saveScheduleDraft(store, source, sessionId, restored)) return { ok: false, reason: 'The original schedule could not be retained locally; it remains available in the Host receipt.' }
    return { ok: true }
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'The schedule draft could not be restored' } }
}
