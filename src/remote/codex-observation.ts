/** Concurrent preparation with one guarded synchronous commit per native thread. */
import { WorkScope } from '../shared/work-scope.ts';
import { SourceError } from './errors.ts';

export class SupersededObservation extends SourceError {
    constructor() { super('TARGET_UNAVAILABLE', 'A newer native observation superseded this read. Existing history is unchanged.'); }
}
export class CodexObservation {
    private readonly scope = new WorkScope();
    invalidate(): void { this.scope.invalidate(); }
    capture(...facts: Array<() => unknown>): () => boolean { return this.scope.capture(...facts); }
    commit<T>(current: () => boolean, apply: () => T): T {
        if (!current()) throw new SupersededObservation();
        const value = apply();
        this.scope.invalidate();
        return value;
    }
}
