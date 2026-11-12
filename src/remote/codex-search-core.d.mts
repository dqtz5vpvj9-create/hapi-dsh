export interface NativeHistorySearchRequest { home: string; params: Record<string, unknown> }
export interface NativeHistorySearchPage { data: Array<{ threadId: string; snippet: string }>; nextCursor: string | null }
export class NativeSearchError extends Error { readonly code: 'INVALID_REQUEST' | 'HISTORY_UNAVAILABLE' | 'STALE_VERSION' }
export class NativeHistorySearch {
    constructor(options?: Partial<{ items: number; bytes: number; threads: number; ms: number; catalog: number; sessions: number; ttlMs: number }>);
    search(request: NativeHistorySearchRequest, signal?: AbortSignal): Promise<NativeHistorySearchPage>;
    dispose(): void;
}
