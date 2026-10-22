// Cold catalog discovery can announce many cached sessions in one tick. Keep
// background histories bounded across both source services on this Host.
let activeRefreshes = 0
const waiting: Array<() => void> = []
async function withRefreshSlot(work: () => Promise<void>): Promise<void> {
  if (activeRefreshes >= 4) await new Promise<void>(resolve => waiting.push(resolve))
  else activeRefreshes++
  try { await work() }
  finally {
    const next = waiting.shift()
    if (next) next()
    else activeRefreshes--
  }
}

/** Coalesce read-only reconciliation independently of the live-event queue. */
export class SourceHistorySync {
  private task: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private requested = false
  private history = false
  private stopped = false
  private retryDelay = 1_000
  constructor(private readonly refresh: (history: boolean) => Promise<void>, private readonly failed: (error: unknown) => void) {}
  request(history: boolean): void {
    if (this.stopped) return
    this.requested = true; this.history ||= history
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.task) return
    const task = Promise.resolve().then(async () => {
      while (this.requested && !this.stopped) {
        const history = this.history
        this.requested = false; this.history = false
        try { await withRefreshSlot(async () => { if (!this.stopped) await this.refresh(history) }); this.retryDelay = 1_000 }
        catch (error) {
          if (this.stopped) return
          this.failed(error)
          // The stale state remains visible; absence of another SSE event must
          // not make a cache fallback permanent. Retries only read the source.
          this.history = true
          this.timer = setTimeout(() => { this.timer = undefined; this.request(true) }, this.retryDelay)
          this.timer.unref?.()
          this.retryDelay = Math.min(30_000, this.retryDelay * 2)
          break
        }
      }
    }).finally(() => {
      if (this.task === task) this.task = undefined
      // A request can arrive after the drain loop exits but before this
      // finalizer runs. Do not strand it until another source event happens.
      if (this.requested && !this.timer && !this.stopped) this.request(this.history)
    })
    this.task = task
  }
  async settled(): Promise<void> { while (this.task) await this.task }
  dispose(): void {
    this.stopped = true; this.requested = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
