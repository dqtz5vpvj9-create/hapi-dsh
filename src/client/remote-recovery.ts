/** Coalesces the same recovery target while always advancing to its replacement. */
export class RemoteRecovery {
  private target = ''
  private running: Promise<void> | undefined
  get pending(): Promise<void> | undefined { return this.running }
  request(target: string, perform: (current: () => boolean) => Promise<void>): Promise<void> {
    this.target = target
    if (this.running) return this.running
    const work = (async () => {
      try {
        for (;;) {
          const requested = this.target
          try { await perform(() => requested === this.target) }
          catch (error) { if (requested === this.target) throw error }
          if (requested === this.target) return
        }
      } finally {
        // Clear synchronously before resolving. A later microtask must never
        // join an already completed Promise for a different recovery target.
        this.running = undefined
      }
    })()
    this.running = work
    return work
  }
}
