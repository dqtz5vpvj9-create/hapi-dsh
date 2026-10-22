import { HistoryReadInvalidatedError } from './history-journal.js'

/** A removed source stays retired until an explicit source-added event. */
export class SourceHistoryLifetimes {
  private readonly versions = new Map<string, number>()
  private readonly retired = new Set<string>()
  version(id: string): number { return this.versions.get(id) ?? 0 }
  removed(id: string): boolean { return this.retired.has(id) }
  remove(id: string): void { this.versions.set(id, this.version(id) + 1); this.retired.add(id) }
  revive(id: string): void {
    if (this.retired.delete(id)) this.versions.set(id, this.version(id) + 1)
  }
  current(id: string, version: number): boolean { return !this.retired.has(id) && version === this.version(id) }
  assertCurrent(id: string, version: number): void {
    if (!this.current(id, version)) throw new HistoryReadInvalidatedError('The source was removed while its display was being prepared')
  }
}
