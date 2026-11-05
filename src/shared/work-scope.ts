/** Commit eligibility for one asynchronous owner, independent of cancellation. */
export class WorkScope {
  private revision = 0
  invalidate(): void { ++this.revision }
  capture(...facts: Array<() => unknown>): () => boolean {
    const revision = this.revision, values = facts.map(read => read())
    return () => revision === this.revision && facts.every((read, index) => Object.is(read(), values[index]))
  }
}
