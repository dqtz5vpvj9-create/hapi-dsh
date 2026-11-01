/** Browser durable-storage boundary, including quota and access failures. */
export class BrowserStorage implements Storage {
  private readonly values = new Map<string, string>()
  failWrites = false
  get length(): number { return this.values.size }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('Synthetic full storage', 'QuotaExceededError')
    this.values.set(key, value)
  }
  removeItem(key: string): void { this.values.delete(key) }
  clear(): void { this.values.clear() }
}
