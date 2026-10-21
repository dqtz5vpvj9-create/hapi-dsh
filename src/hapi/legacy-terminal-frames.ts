/** Bounded physical-attachment frames; never retained or replayed input. */
import type { TerminalFrame } from '@deepseek-ai/dsh-api-terminal-controller/types'

export class LegacyTerminalFrames {
  private readonly queue: Array<{ frame: TerminalFrame; size: number }> = []
  private bytes = 0
  private error: unknown
  private ended = false
  private wake: (() => void) | undefined
  constructor(private readonly maxBytes: number) {}
  get failed(): boolean { return this.error !== undefined }
  push(frame: TerminalFrame): boolean {
    if (this.ended || this.failed) return false
    const size = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (this.bytes + size > this.maxBytes) { this.fail(new Error('Legacy terminal output receiver fell behind; reconnect to its retained adapter screen.')); return false }
    this.queue.push({ frame, size }); this.bytes += size; this.wake?.()
    return true
  }
  fail(error: unknown): void {
    if (!this.failed) this.error = error ?? new Error('Legacy terminal attachment failed')
    // Once a receiver loses an output boundary, no older ACK/state may make
    // that same attachment appear usable again.
    this.queue.length = 0; this.bytes = 0; this.wake?.()
  }
  close(): void { this.ended = true; this.queue.length = 0; this.bytes = 0; this.wake?.() }
  async *read(signal: AbortSignal): AsyncIterable<TerminalFrame> {
    const abort = (): void => { this.wake?.() }
    signal.addEventListener('abort', abort)
    try {
      while (!signal.aborted) {
        if (this.failed) throw this.error
        const next = this.queue.shift()
        if (next) { this.bytes -= next.size; yield next.frame; continue }
        if (this.ended) return
        await new Promise<void>(resolve => { this.wake = resolve; if (signal.aborted) resolve() })
        this.wake = undefined
      }
    } finally { signal.removeEventListener('abort', abort) }
  }
}
