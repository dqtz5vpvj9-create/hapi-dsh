/** One persistence owner per original draft, independently of view count. */
export class DraftOwnership {
    private readonly seats = new Map<string, Set<object>>()
    private readonly listeners = new Set<() => void>()
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    owner(key: string): object | undefined { return this.seats.get(key)?.values().next().value }
    retain(key: string, token: object): () => void {
        let seats = this.seats.get(key)
        if (!seats) { seats = new Set(); this.seats.set(key, seats) }
        seats.add(token); this.publish()
        return () => { seats.delete(token); if (!seats.size) this.seats.delete(key); this.publish() }
    }
    private publish(): void { for (const listener of this.listeners) listener() }
}
