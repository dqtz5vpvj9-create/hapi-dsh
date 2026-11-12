/** Native queue and Goal state. Read refreshes never dispatch writes or replay pending operations. */
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { CodexCapabilities } from '../remote/codex-access.ts'
import type { SourceSession } from '../remote/protocol.ts'
import type { NativeActionRecord } from './remote-operation-contracts.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import { boundedSourceRead } from './remote-read-recovery.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export interface NativeQueueItem { id: string; clientUserMessageId: string; input: readonly Readonly<Record<string, unknown>>[]; delivery?: 'sending' | 'confirming' | 'failed';
  resumeOperationId?: string; resumeTurnId?: string; transferHeld?: boolean }
export type NativeGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
export interface NativeGoal { objective: string; status: NativeGoalStatus; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number }
export interface NativeTaskSnapshot {
  current: boolean
  capabilities: CodexCapabilities | undefined
  queue: readonly NativeQueueItem[] | undefined
  goal: NativeGoal | null | undefined
  loading: boolean
  error: string | null
}
export const queueIntent = (id: string): string => `queue:${id}`
const goalStates = new Set<unknown>(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'])
export function nativeQueueItem(value: unknown): NativeQueueItem {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.clientUserMessageId !== 'string'
    || !Array.isArray(value.input) || value.input.some(input => !record(input) || typeof input.type !== 'string')) throw new Error('The source returned an invalid native queue item.')
  return Object.freeze({ id: value.id, clientUserMessageId: value.clientUserMessageId, input: Object.freeze(value.input.map(input => Object.freeze(structuredClone(input) as Record<string, unknown>))),
    ...(['sending', 'confirming', 'failed'].includes(String(value.hhpiDelivery)) ? { delivery: value.hhpiDelivery as NonNullable<NativeQueueItem['delivery']> } : {}),
    ...(typeof value.hhpiResumeOperationId === 'string' && typeof value.hhpiResumeTurnId === 'string' ? {
      resumeOperationId: value.hhpiResumeOperationId, resumeTurnId: value.hhpiResumeTurnId, transferHeld: value.hhpiTransferHeld === true,
    } : {}) })
}
export const queueTextBlocks = (row: NativeQueueItem): readonly string[] => row.input.flatMap(input => input.type === 'text' && typeof input.text === 'string' ? [input.text] : [])
export function queueInputSummary(row: NativeQueueItem): string {
  return row.input.map(input => input.type === 'text' ? String(input.text ?? '')
    : input.type === 'skill' || input.type === 'mention' ? String(input.name ?? input.type)
      : input.type === 'image' || input.type === 'localImage' ? '[Image]' : input.type === 'audio' || input.type === 'localAudio' ? '[Audio]' : '[Native input]').join(' ')
}
function goalOf(value: unknown, nativeId: string): NativeGoal | null {
  if (!record(value)) throw new Error('The source returned an invalid native Goal.')
  if (value.goal === null || value.goal === undefined) return null
  const goal = value.goal
  if (!record(goal) || goal.threadId !== nativeId || typeof goal.objective !== 'string' || !goalStates.has(goal.status)
    || typeof goal.tokensUsed !== 'number' || typeof goal.timeUsedSeconds !== 'number' || goal.tokenBudget != null && typeof goal.tokenBudget !== 'number') throw new Error('The source returned a Goal for an invalid native thread.')
  return { objective: goal.objective, status: goal.status as NativeGoalStatus, tokenBudget: goal.tokenBudget as number | null ?? null, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds }
}
export class RemoteNativeTasks {
  private snapshot: NativeTaskSnapshot = { current: true, capabilities: undefined, queue: undefined, goal: undefined, loading: false, error: null }
  private readonly listeners = new Set<() => void>()
  private readFlight: Promise<void> | undefined
  private readonly assertAuthorization: () => void
  private readonly lifetime = new AbortController()
  private stopOwner: (() => void) | undefined
  constructor(readonly session: RemoteSourceSession, private readonly api: Pick<HhpiRemoteApi, 'nativeCall'>) {
    if (!session.nativeActions) throw new Error('The native operation owner is unavailable.')
    try { this.assertAuthorization = session.nativeActions.captureAuthorization(session.sessionId) }
    catch (cause) { this.assertAuthorization = () => { throw cause }; this.invalidate(); return }
    this.stopOwner = session.nativeActions.subscribe(() => { if (!this.current()) this.invalidate() })
  }
  readonly getSnapshot = (): NativeTaskSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  current(): boolean { try { this.lifetime.signal.throwIfAborted(); this.assertAuthorization(); return true } catch { return false } }
  private invalidate(): void {
    if (!this.snapshot.current) return
    this.lifetime.abort(); this.stopOwner?.(); this.stopOwner = undefined
    this.snapshot = { current: false, capabilities: undefined, queue: undefined, goal: undefined, loading: false, error: null }
    for (const listener of this.listeners) listener()
  }
  private publish(patch: Partial<NativeTaskSnapshot>): void {
    if (!this.current()) { this.invalidate(); return }
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
  private metadata(): SourceSession { this.assertAuthorization(); return this.session.metadata.getSnapshot() }
  private async read(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const metadata = this.metadata(), directory = this.session.sourceDirectory()
    if (!directory || !this.api.nativeCall) throw new Error('The native source reader is unavailable.')
    const lifetime = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    const capabilities = await boundedSourceRead(signal => directory.capabilities(signal), lifetime); this.assertAuthorization()
    if (capabilities.methods[method] !== 'read') throw new Error(capabilities.unavailable[method] ?? 'This source does not provide this native read.')
    const response = await boundedSourceRead(signal => this.api.nativeCall!({ sourceId: metadata.sourceId, method, params: { threadId: metadata.nativeId, ...params } }, signal), lifetime)
    this.assertAuthorization(); signal?.throwIfAborted()
    if (!response.ok) throw response.error
    if (response.value.status !== 'accepted') throw new Error(response.value.message)
    return response.value.result
  }
  private async readQueue(): Promise<readonly NativeQueueItem[]> {
    const rows: NativeQueueItem[] = [], cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const page = await this.read('thread/queue/list', { cursor, limit: 100 })
      if (!record(page) || !Array.isArray(page.data)) throw new Error('The source returned an invalid native queue page.')
      rows.push(...page.data.map(nativeQueueItem))
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
      if (cursor && cursors.has(cursor)) throw new Error('The native queue cursor did not advance.')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return Object.freeze(rows)
  }
  /** Capability reads and current state only. Mount/reconnect never executes pending actions. */
  refresh = (): Promise<void> => {
    if (!this.current()) { this.invalidate(); return Promise.resolve() }
    if (this.readFlight) return this.readFlight
    const work = (async () => {
      this.publish({ loading: true, error: null })
      try {
        const capabilities = await boundedSourceRead(signal => this.session.sourceDirectory()?.capabilities(signal) ?? Promise.resolve(undefined), this.lifetime.signal)
        this.assertAuthorization()
        if (!capabilities) throw new Error('Native task discovery is unavailable.')
        this.publish({ capabilities })
        const results = await Promise.allSettled([
          capabilities.methods['thread/queue/list'] === 'read' ? this.readQueue() : Promise.resolve(undefined),
          capabilities.methods['thread/goal/get'] === 'read' ? this.read('thread/goal/get', {}).then(value => goalOf(value, this.metadata().nativeId)) : Promise.resolve(undefined),
        ])
        this.assertAuthorization()
        const errors: string[] = []
        const queue = results[0]!, goal = results[1]!
        if (queue.status === 'fulfilled') this.publish({ queue: queue.value })
        else errors.push(queue.reason instanceof Error ? queue.reason.message : String(queue.reason))
        if (goal.status === 'fulfilled') this.publish({ goal: goal.value })
        else errors.push(goal.reason instanceof Error ? goal.reason.message : String(goal.reason))
        this.publish({ error: errors.length ? errors.join('；') : null })
      } catch (error) { if (this.current()) this.publish({ error: error instanceof Error ? error.message : String(error) }) }
      finally { if (this.current()) this.publish({ loading: false }) }
    })().finally(() => { if (this.readFlight === work) this.readFlight = undefined })
    this.readFlight = work
    return work
  }
  private async mutate(intent: string, kind: 'queue' | 'goal', method: string, params: Record<string, unknown>): Promise<NativeActionRecord> {
    const metadata = this.metadata(), owner = this.session.nativeActions!
    if (sourceIsOffline(metadata)) throw new Error('The source is offline. Your edits have been kept.')
    const capabilities = await this.session.sourceDirectory()?.capabilities(); this.assertAuthorization()
    if (capabilities?.methods[method] !== 'write') throw new Error(capabilities?.unavailable[method] ?? 'This source does not support this action.')
    await owner.restore(); this.assertAuthorization()
    const result = await owner.submit({ sessionId: metadata.id, intent, kind, newAttempt: true,
      request: { sourceId: metadata.sourceId, method, params: { threadId: metadata.nativeId, ...params } } })
    this.assertAuthorization()
    if (result.phase === 'accepted' || result.phase === 'rejected') await this.refresh()
    return result
  }
  async check(intent: string): Promise<NativeActionRecord | undefined> {
    this.assertAuthorization()
    const original = this.session.nativeActions!.get(this.session.sessionId, intent)
    const result = original?.phase === 'prepared' ? await this.session.nativeActions!.submit({ sessionId: this.session.sessionId, intent, kind: original.kind, request: original.request })
      : await this.session.nativeActions!.recover(this.session.sessionId, intent)
    this.assertAuthorization()
    if (result?.phase === 'accepted' || result?.phase === 'rejected') await this.refresh()
    return result
  }
  async edit(original: NativeQueueItem, texts: readonly string[]): Promise<NativeActionRecord> {
    const queue = await this.readQueue()
    this.assertAuthorization()
    this.publish({ queue })
    const current = queue.find(row => row.id === original.id)
    if (!current || current.clientUserMessageId !== original.clientUserMessageId) throw new Error('This exact item has started or left the native queue. Your edit is kept; it was not added again.')
    if (JSON.stringify(current.input) !== JSON.stringify(original.input)) throw new Error('The source changed this queued message. Your edit is kept; read the current item before replacing it.')
    if (texts.length !== queueTextBlocks(original).length) throw new Error('The original native input structure changed. Your edit has been kept.')
    let index = 0
    const input = original.input.map(part => part.type === 'text' && typeof part.text === 'string' ? { ...part, text: texts[index++]!, text_elements: [] } : part)
    return this.mutate(queueIntent(original.id), 'queue', 'thread/queue/update', { queuedSubmissionId: original.id, input })
  }
  remove(id: string): Promise<NativeActionRecord> { return this.mutate(queueIntent(id), 'queue', 'thread/queue/delete', { queuedSubmissionId: id }) }
  start(id: string): Promise<NativeActionRecord> { return this.mutate(queueIntent(id), 'queue', 'thread/queue/start', { queuedSubmissionId: id }) }
  async move(id: string, direction: -1 | 1): Promise<NativeActionRecord> {
    const queue = await this.readQueue(), index = queue.findIndex(row => row.id === id), target = index + direction
    this.assertAuthorization()
    this.publish({ queue })
    if (index < 0 || target < 0 || target >= queue.length) throw new Error('This item cannot move in the current native queue.')
    const ids = queue.map(row => row.id); [ids[index], ids[target]] = [ids[target]!, ids[index]!]
    return this.mutate('queue-order', 'queue', 'thread/queue/reorder', { queuedSubmissionIds: ids })
  }
  setGoal(objective: string, tokenBudget: number | null, status?: NativeGoalStatus): Promise<NativeActionRecord> {
    if (!objective.trim() || tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) throw new Error('Enter a goal and a positive whole-number token budget, or leave the budget empty.')
    return this.mutate('goal', 'goal', 'thread/goal/set', { objective: objective.trim(), tokenBudget, origin: 'user', ...(status ? { status } : {}) })
  }
  clearGoal(): Promise<NativeActionRecord> { return this.mutate('goal', 'goal', 'thread/goal/clear', { origin: 'user' }) }
}
const controllers = new WeakMap<RemoteSourceSession['metadata'], RemoteNativeTasks>()
/** The same account/session controller is shared by the task tab and every Pane entry. */
export function remoteNativeTasks(session: RemoteSourceSession, api: Pick<HhpiRemoteApi, 'nativeCall'>): RemoteNativeTasks | undefined {
  if (!session.nativeActions) return undefined
  let controller = controllers.get(session.metadata)
  if (!controller?.current()) { controller = new RemoteNativeTasks(session, api); controllers.set(session.metadata, controller) }
  return controller
}
