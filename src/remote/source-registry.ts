/** Directory observations belong to their source; omission never revokes a
 * previously readable session. Authorization is evaluated by the carrier. */
import type { SourceSession } from './protocol.ts';
import type { SourceError } from './errors.ts';
export interface SourceCatalogState {
    sessions?: SourceSession[];
    online?: boolean;
    error?: SourceError;
    pending?: Promise<void>;
    nextRefresh: number;
}
export class SourceRegistry {
    private readonly states = new Map<string, SourceCatalogState>();
    entry(id: string): SourceCatalogState {
        let state = this.states.get(id);
        if (!state) { state = { nextRefresh: 0 }; this.states.set(id, state); }
        return state;
    }
    get observed(): boolean { return [...this.states.values()].some(state => state.online !== undefined); }
    clear(): void { this.states.clear(); }
}
