import { randomUUID } from 'node:crypto'
import type { SourceFrameBatch } from './source-frames.ts'

type Reader = {
  pending: SourceFrameBatch | 'baseline' | undefined
  closed: boolean
  wake: (() => void) | undefined
  close(): void
}

/** A source-owned live feed. Readers retain at most one change; a reader that
 * falls behind resumes from the owner's current bounded projection. */
export class SourceFrameFeed {
  readonly historyId = randomUUID()
  private readonly readers = new Set<Reader>()
  private historyVersion = 0
  private disposed = false
  constructor(private readonly current: () => SourceFrameBatch) {}
  get version(): number { return this.historyVersion }

  baseline(): SourceFrameBatch {
    return { ...this.current(), kind: 'replace', historyId: this.historyId, historyVersion: this.historyVersion }
  }

  publish(batch: SourceFrameBatch): void {
    if (this.disposed) return
    if (batch.reset) this.historyVersion++
    const value = { ...batch, historyId: this.historyId, historyVersion: this.historyVersion }
    for (const reader of this.readers) {
      reader.pending = reader.pending === undefined ? value : 'baseline'
      reader.wake?.(); reader.wake = undefined
    }
  }

  watch(signal: AbortSignal): AsyncIterableIterator<SourceFrameBatch> {
    const owner = this
    const reader: Reader = { pending: 'baseline', closed: false, wake: undefined, close() {
      reader.closed = true; reader.pending = undefined
      owner.readers.delete(reader); signal.removeEventListener('abort', reader.close)
      reader.wake?.(); reader.wake = undefined
    } }
    async function* iterate(): AsyncGenerator<SourceFrameBatch> {
      if (owner.disposed || reader.closed || signal.aborted) return
      // Registration and first snapshot run synchronously in one iterator step.
      // No source commit can fall between the snapshot and listener admission.
      owner.readers.add(reader); signal.addEventListener('abort', reader.close, { once: true })
      try {
        while (!owner.disposed && !reader.closed) {
          if (reader.pending === undefined) { await new Promise<void>(resolve => { reader.wake = resolve }); continue }
          const pending = reader.pending; reader.pending = undefined
          yield pending === 'baseline' ? owner.baseline() : pending
        }
      } finally { reader.close() }
    }
    const iterator = iterate()
    return {
      next: value => iterator.next(value),
      return: value => { reader.close(); return iterator.return(value) },
      throw: error => { reader.close(); return iterator.throw(error) },
      [Symbol.asyncIterator]() { return this },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const reader of this.readers) reader.close()
  }
}
