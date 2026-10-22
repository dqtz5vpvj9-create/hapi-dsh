import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SourceQueuedEditReceipt, SourceQueuedEditRequest } from '../src/codex/queued-edit-types.ts'
import { SourceQueuedEditController, queuedEditComposerMatches, type QueuedEditCapture } from '../src/client/source-queued-edit-state.ts'
import { captureScheduleDraft, createSourceScheduleDrafts, readScheduleDraft, restoreCancelledSchedule, saveScheduleDraft, scheduleKey, type ScheduleStorage } from '../src/client/schedule-draft.ts'

const uuid = '11111111-1111-4111-8111-111111111111'
const source = { sourceHubId: 'fixture-hub', sourceSessionId: 'original-source', machineId: 'original-runner' }
function store(): ScheduleStorage { const data = new Map<string, string>(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) } } }
function receipt(request: SourceQueuedEditRequest, status: SourceQueuedEditReceipt['status'] = 'cancelled'): SourceQueuedEditReceipt {
  return { operationId: request.operationId, sessionId: request.sessionId, logicalSessionId: 'logical', hubId: source.sourceHubId, sourceSessionId: source.sourceSessionId,
    candidate: { localId: request.localId, messageId: 'source-uuid', text: '@"/runner/original file"\nOriginal message', attachmentNames: ['original file'], scheduledAt: null,
      createdAt: 100, delivery: 'queued' }, status, proof: status === 'cancelled' ? 'source-reply' : null, createdAt: 200, updatedAt: 200, error: null }
}
const capture = (): QueuedEditCapture => ({ composer: { viewId: 'current-view', draft: 'Existing draft', draftRev: 3, attachmentIds: ['existing-image'], phase: 'plain' },
  schedule: { key: 'fixture-schedule', raw: null, replaceIntentMessageId: null } })
class Api {
  writes: SourceQueuedEditRequest[] = []; reads = 0; saved: SourceQueuedEditReceipt | null = null
  status: SourceQueuedEditReceipt['status'] = 'cancelled'; loseReply = false; beforeReply: (() => void) | undefined
  async sourceQueuedEdit(request: SourceQueuedEditRequest) {
    this.writes.push(request); this.saved = receipt(request, this.status); this.beforeReply?.()
    if (this.loseReply) throw new Error('Browser reply lost')
    return { ok: true as const, value: this.saved }
  }
  async sourceQueuedEditRead() { this.reads++; return { ok: true as const, value: this.saved } }
  async sourceQueuedEdits() { return { ok: true as const, value: this.saved ? [this.saved] : [] } }
}

test('queue edit only restores after source cancellation and exact current editor CAS; changed revision, attachments, command or view are kept', async () => {
  for (const change of [
    (value: QueuedEditCapture) => { value.composer.draftRev++ },
    (value: QueuedEditCapture) => { value.composer.viewId = 'reopened-view' },
    (value: QueuedEditCapture) => { value.composer.attachmentIds = ['new-image'] },
    (value: QueuedEditCapture) => { value.composer.phase = 'submitting' },
  ]) {
    const api = new Api(), saved = store(), current = capture(); let restored = 0
    const controller = new SourceQueuedEditController(api, 'display', saved, 'journal', { capture: () => structuredClone(current),
      restore: (_receipt, before) => queuedEditComposerMatches(before.composer, current.composer) ? (restored++, { ok: true }) : { ok: false, reason: 'Newer draft retained' } }, () => uuid)
    api.beforeReply = () => change(current); await controller.start('original-local')
    assert.equal(api.writes.length, 1); assert.equal(restored, 0); assert.equal(controller.getSnapshot().receipts[0]?.status, 'cancelled')
    assert.match(controller.getSnapshot().error ?? '', /retained/)
  }
})

test('lost cancellation replies recover only by source read, and restart never submits or automatically restores the old view', async () => {
  const api = new Api(), saved = store(); api.loseReply = true; api.status = 'unknown'; let restored = 0
  const target = { capture, restore: () => { restored++; return { ok: true as const } } }
  let controller = new SourceQueuedEditController(api, 'display', saved, 'journal', target, () => uuid)
  await controller.start('original-local'); assert.equal(api.writes.length, 1); assert.equal(restored, 0)
  controller = new SourceQueuedEditController(api, 'display', saved, 'journal', target, () => uuid)
  await controller.load(); await controller.start('original-local'); assert.equal(api.writes.length, 1); assert.equal(restored, 0)
  api.saved!.status = 'cancelled'; api.saved!.proof = 'source-event'
  await controller.read(uuid); assert.equal(restored, 0, 'Reload does not restore an old pane capture')
  await controller.restoreNow(uuid); assert.equal(restored, 1); assert.equal(api.writes.length, 1)
  assert.ok(controller.getSnapshot().restored.includes(uuid))
})

test('busy, invoked and missing durable storage cannot prefill or dispatch another message', async () => {
  for (const status of ['busy', 'invoked'] as const) {
    const api = new Api(); api.status = status; let restored = 0
    const controller = new SourceQueuedEditController(api, 'display', store(), 'journal', { capture, restore: () => { restored++; return { ok: true } } }, () => uuid)
    await controller.start('original-local'); await controller.restoreNow(uuid); assert.equal(restored, 0); assert.equal(api.writes.length, 1)
  }
  const api = new Api(), controller = new SourceQueuedEditController(api, 'display', undefined, 'journal', { capture, restore: () => ({ ok: true }) }, () => uuid)
  await controller.start('original-local'); assert.equal(api.writes.length, 0); assert.match(controller.getSnapshot().error ?? '', /storage/)
})

test('previous-generation receipts require explicit recovery and matching original source ownership', async () => {
  const api = new Api(); api.saved = receipt({ sessionId: 'previous-display', operationId: uuid, localId: 'local' })
  let restored = 0
  const controller = new SourceQueuedEditController(api, 'current-display', store(), 'current-journal',
    { capture, restore: () => { restored++; return { ok: true } } }, () => uuid,
    { hubId: source.sourceHubId, sourceSessionId: source.sourceSessionId, logicalSessionId: 'logical' })
  await controller.load(); assert.equal(controller.getSnapshot().error, null)
  assert.equal(controller.getSnapshot().receipts[0]?.sessionId, 'previous-display')
  assert.equal(restored, 0); await controller.restoreNow(uuid); assert.equal(restored, 1)
  assert.equal(controller.getSnapshot().error, null)
  assert.equal(api.writes.length, 0)
  api.saved.hubId = 'another-hub'
  const foreign = new SourceQueuedEditController(api, 'current-display', store(), 'other-journal',
    { capture, restore: () => { restored++; return { ok: true } } }, () => uuid,
    { hubId: source.sourceHubId, sourceSessionId: source.sourceSessionId, logicalSessionId: 'logical' })
  await foreign.load(); assert.equal(foreign.getSnapshot().receipts.length, 0)
  assert.match(foreign.getSnapshot().error ?? '', /another source owner/)
})

test('confirmed queue edit restores the exact future absolute schedule and original attachment references, without replacing a newer or unrelated schedule', () => {
  const saved = store(), now = Date.now(), original = receipt({ sessionId: 'display', operationId: uuid, localId: 'local' })
  original.candidate.scheduledAt = now + 60_000
  const initial = readScheduleDraft(saved, source, 'display'); saveScheduleDraft(saved, source, 'display', initial)
  const before = captureScheduleDraft(saved, source, 'display')
  assert.deepEqual(restoreCancelledSchedule(saved, source, 'display', before, original, now), { ok: true })
  const restored = readScheduleDraft(saved, source, 'display')
  assert.equal(restored.text, original.candidate.text); assert.deepEqual(restored.selection, { type: 'absolute', ms: original.candidate.scheduledAt })
  assert.equal(restored.intent, null, 'Recovery is a draft, not a scheduled submission')
  assert.equal(restoreCancelledSchedule(saved, source, 'display', before, original, now).ok, false, 'A newer schedule wins')
  const cancelledIntent = { sessionId: 'display', operationId: uuid, text: 'Previously scheduled', scheduledAt: now + 60_000 }
  saveScheduleDraft(saved, source, 'display', { ...initial, intent: cancelledIntent })
  assert.equal(restoreCancelledSchedule(saved, source, 'display', captureScheduleDraft(saved, source, 'display'), original, now).ok, false)
  assert.deepEqual(restoreCancelledSchedule(saved, source, 'display', captureScheduleDraft(saved, source, 'display', `hapi-schedule:${uuid}`), original, now), { ok: true })
  assert.equal(restoreCancelledSchedule(saved, source, 'display', captureScheduleDraft(saved, source, 'display'), { ...original, status: 'unknown' }, now).ok, false)
})

test('explicit shared schedule storage makes a restored future draft visible to another pane while refusing other plugin keys', () => {
  const underlying = store(), shared = createSourceScheduleDrafts(underlying), updates: string[] = []
  const unsubscribe = shared.subscribe(key => updates.push(key)), now = Date.now()
  const original = receipt({ sessionId: 'display', operationId: uuid, localId: 'local' }); original.candidate.scheduledAt = now + 60_000
  const before = captureScheduleDraft(shared, source, 'display')
  assert.deepEqual(restoreCancelledSchedule(shared, source, 'display', before, original, now), { ok: true })
  assert.deepEqual(updates, [scheduleKey(source, 'display')])
  const newPane = readScheduleDraft(shared, source, 'display')
  assert.equal(newPane.text, original.candidate.text)
  assert.deepEqual(newPane.selection, { type: 'absolute', ms: original.candidate.scheduledAt })
  assert.equal(readScheduleDraft(shared, { ...source, sourceHubId: 'another-hub' }, 'display').text, '')
  assert.throws(() => shared.getItem('official-plugin-storage'), /Only source schedule/)
  assert.throws(() => shared.setItem('hapi-dsh:queue-edits:another-operation', '{}'), /Only source schedule/)
  assert.throws(() => shared.getItem('hapi-dsh:schedule:[null,"original-source"]:display'), /Invalid original/)
  assert.throws(() => createSourceScheduleDrafts().getItem(scheduleKey(source, 'display')), /unavailable/)
  unsubscribe(); shared.dispose()
})
