/** Original HAPI sessionStorage keys and one-hour dismissal semantics (0f8ef697). */
export const RUNNER_SKEW_MINIMIZED_KEY = 'hapi.runnerSkew.minimized.v1';
export const RUNNER_SKEW_DISMISS_UNTIL_KEY = 'hapi.runnerSkew.dismissUntil.v1';
export const RUNNER_SKEW_TEMP_DISMISS_MS = 60 * 60_000;
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface RunnerSkewState { minimized: boolean; dismissUntil: number }

/** Keep the UI usable when sessionStorage is blocked or full; never use localStorage. */
export class RunnerSkewPreferences {
    private state: RunnerSkewState;
    private readonly listeners = new Set<() => void>();
    constructor(private readonly storage?: StorageLike) {
        let minimized = false, dismissUntil = 0;
        try { minimized = storage?.getItem(RUNNER_SKEW_MINIMIZED_KEY) === '1'; } catch { /* Memory state remains available. */ }
        try {
            const value = Number(storage?.getItem(RUNNER_SKEW_DISMISS_UNTIL_KEY) ?? '0');
            if (Number.isFinite(value) && value > 0) dismissUntil = value;
        } catch { /* Memory state remains available. */ }
        this.state = { minimized, dismissUntil };
    }
    getSnapshot = (): RunnerSkewState => this.state;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(patch: Partial<RunnerSkewState>): void {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }
    private save(key: string, value: string | null): void {
        try { if (value === null) this.storage?.removeItem(key); else this.storage?.setItem(key, value); } catch { /* UI-first memory fallback. */ }
    }
    setMinimized(minimized: boolean): void {
        this.publish({ minimized }); this.save(RUNNER_SKEW_MINIMIZED_KEY, minimized ? '1' : null);
    }
    dismiss(now = Date.now()): void {
        const dismissUntil = now + RUNNER_SKEW_TEMP_DISMISS_MS;
        this.publish({ dismissUntil }); this.save(RUNNER_SKEW_DISMISS_UNTIL_KEY, String(dismissUntil));
    }
    expire(now = Date.now()): void {
        if (!this.state.dismissUntil || this.state.dismissUntil > now) return;
        this.publish({ dismissUntil: 0 }); this.save(RUNNER_SKEW_DISMISS_UNTIL_KEY, null);
    }
    dispose(): void { this.listeners.clear(); }
}
