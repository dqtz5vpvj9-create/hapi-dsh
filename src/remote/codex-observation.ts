/** Concurrent preparation with one guarded synchronous commit per native thread. */
import { WorkScope } from '../shared/work-scope.ts';
import { SourceError } from './errors.ts';

export class SupersededObservation extends SourceError {
    constructor() { super('TARGET_UNAVAILABLE', 'A newer native observation superseded this read. Existing history is unchanged.'); }
}
export class CodexObservation {
    private readonly scope = new WorkScope();
    private readonly historyScope = new WorkScope();
    invalidate(): void { this.scope.invalidate(); }
    /** Source replacement/loss invalidates fixed pages as well as live observations. */
    invalidateHistory(): void { this.scope.invalidate(); this.historyScope.invalidate(); }
    capture(...facts: Array<() => unknown>): () => boolean { return this.scope.capture(...facts); }
    /** A revision-verified fixed page may merge across unrelated tail publications. */
    captureHistory(...facts: Array<() => unknown>): () => boolean { return this.historyScope.capture(...facts); }
    commit<T>(current: () => boolean, apply: () => T): T {
        if (!current()) throw new SupersededObservation();
        const value = apply();
        this.scope.invalidate();
        return value;
    }
}
