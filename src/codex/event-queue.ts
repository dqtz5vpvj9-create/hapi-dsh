import type { HapiEvent } from './contracts.js'
import type { HistoryCheckpoint } from './history-journal.js'
import { canonicalJson, envelopeFor, nativeExecutionFor, record } from './native.js'

export interface QueuedSourceEvent<Agent> {
  event: HapiEvent
  version: number
  checkpoint?: HistoryCheckpoint | undefined
  removedAgent?: Agent | undefined
}

/** Only provisional native text snapshots replace each other. Transport row IDs
 * are not item identities. Unknown wrappers, lifecycle metadata and durable
 * records stay in order, even if their text happens to share a prefix. */
export function replacesCumulativeSnapshot<Agent>(previous: QueuedSourceEvent<Agent>, next: QueuedSourceEvent<Agent>): boolean {
  if (previous.version !== next.version || previous.checkpoint?.generation !== next.checkpoint?.generation) return false
  const left = previous.event, right = next.event
  if (left.type !== 'message-received' || right.type !== 'message-received' || left.sessionId !== right.sessionId) return false
  const snapshot = (event: typeof left) => {
    const row = event.message, envelope = envelopeFor(row.content), content = record(envelope?.content), data = record(content?.data)
    if (row.localId !== null || row.deliveryState || row.invokedAt != null || row.scheduledAt != null || row.steered
      || envelope?.role !== 'agent' || content?.type !== 'codex' || !data
      || (data.type !== 'message' && data.type !== 'reasoning') || typeof data.id !== 'string' || typeof data.message !== 'string') return undefined
    const execution = nativeExecutionFor(record(envelope.meta)?.nativeExecution ?? data.nativeExecution)
    if (!execution?.itemId || execution.turn) return undefined
    return { text: data.message, identity: canonicalJson({ ...envelope, content: { ...content, data: { ...data, message: undefined } } }) }
  }
  const a = snapshot(left), b = snapshot(right)
  return !!a && !!b && a.identity === b.identity && b.text.startsWith(a.text)
}

interface Job<T> { value?: T; operation?: () => Promise<unknown>; resolve?: (value: unknown) => void; reject?: (error: unknown) => void; bytes: number }
export interface SourceQueueBudget { maxItems: number; maxBytes: number }
export const sourceQueueBudget: Readonly<SourceQueueBudget> = { maxItems: 128, maxBytes: 8 * 1024 * 1024 }

/** The transport awaits enqueue's pressure promise before publishing another
 * event. One SSE producer and at most one deduplicated explicit reconciliation
 * may wait for admission; payloads never form an unbounded Promise chain.
 * Active work counts toward the budget. A single oversized event runs alone. */
export class SourceEventQueue<T> {
  private readonly jobs: Job<T>[] = []
  private bytes = 0
  private active: Job<T> | undefined
  private task: Promise<void> | undefined
  private admission: Promise<void> | undefined
  private wake: (() => void) | undefined
  private changed: Promise<void> | undefined
  private closed = false
  private pressured = false
  constructor(private readonly consume: (value: T) => Promise<void>,
    private readonly replace: (previous: T, next: T) => boolean,
    private readonly onError: (error: unknown) => void,
    private readonly onDrain: () => void,
    readonly budget: Readonly<SourceQueueBudget> = sourceQueueBudget,
    private readonly onIdle: () => void = () => {}) {}

  get pending(): Readonly<{ items: number; bytes: number }> { return { items: this.jobs.length + Number(!!this.active), bytes: this.bytes } }
  private fits(bytes: number, replacementBytes = 0): boolean {
    const count = this.pending.items
    return count === 0 || (count - Number(replacementBytes > 0) < this.budget.maxItems && this.bytes - replacementBytes + bytes <= this.budget.maxBytes)
  }
  enqueue(value: T, bytes: number): void | Promise<void> {
    return this.offer({ value, bytes: Math.max(1, bytes) })
  }
  run<R>(operation: () => Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const admission = this.offer({ operation, resolve: value => resolve(value as R), reject, bytes: 1 })
      void admission?.catch(reject)
    })
  }
  private offer(job: Job<T>): void | Promise<void> {
    if (this.closed) { job.reject?.(new Error('The source event queue was disposed')); return }
    const tail = this.jobs.at(-1)
    if (!this.admission && job.value !== undefined && tail?.value !== undefined && this.replace(tail.value, job.value)
      && this.fits(job.bytes, tail.bytes)) {
      this.bytes += job.bytes - tail.bytes; this.jobs[this.jobs.length - 1] = job
    } else if (!this.admission && this.fits(job.bytes)) {
      this.jobs.push(job); this.bytes += job.bytes
    } else {
      this.pressured = true
      // Ordered admission also keeps explicit lifecycle reconciliations from
      // overtaking a source event waiting for byte capacity.
      const before = this.admission
      const admission = (async () => {
        await before
        while (!this.closed && !this.fits(job.bytes)) await this.progress()
        if (this.closed) { job.reject?.(new Error('The source event queue was disposed')); return }
        this.jobs.push(job); this.bytes += job.bytes; this.start()
      })()
      this.admission = admission
      return admission.then(() => this.waitBelowBudget()).finally(() => {
        if (this.admission === admission) this.admission = undefined
        this.notifyDrain()
      })
    }
    this.start()
    // Stop reading at the watermark, before another ordinary event is parsed.
    if (this.pending.items >= this.budget.maxItems || this.bytes >= this.budget.maxBytes) {
      this.pressured = true
      return this.waitBelowBudget()
    }
  }
  private async waitBelowBudget(): Promise<void> {
    while (!this.closed && (this.pending.items >= this.budget.maxItems || this.bytes >= this.budget.maxBytes)) await this.progress()
  }
  private progress(): Promise<void> {
    return this.changed ??= new Promise(resolve => { this.wake = resolve })
  }
  private signal(): void { const wake = this.wake; this.wake = undefined; this.changed = undefined; wake?.() }
  private start(): void {
    if (this.task || this.closed) return
    this.task = Promise.resolve().then(async () => {
      while (!this.closed && this.jobs.length) {
        const job = this.jobs.shift()!; this.active = job
        try { if (job.operation) job.resolve?.(await job.operation()); else await this.consume(job.value!) }
        catch (error) { if (job.reject) job.reject(error); this.onError(error) }
        finally { this.bytes -= job.bytes; this.active = undefined; this.signal() }
      }
    }).finally(() => {
      this.task = undefined
      if (this.jobs.length && !this.closed) this.start()
      else this.notifyDrain()
    })
  }
  private notifyDrain(): void {
    if (this.task || this.admission || this.closed) return
    if (this.pressured) { this.pressured = false; this.onDrain() }
    this.onIdle()
  }
  async settled(): Promise<void> {
    while (this.task || this.admission) { await this.admission; await this.task }
    this.notifyDrain()
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const job of this.jobs.splice(0)) { this.bytes -= job.bytes; job.reject?.(new Error('The source event queue was disposed')) }
    this.signal()
    await this.admission
    await this.task
  }
}

export function sourceEventBytes(event: HapiEvent): number {
  // UTF-16 is a conservative retained-string estimate, including escaped JSON.
  return JSON.stringify(event).length * 2 + 256
}
