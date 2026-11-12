/** Source-authorized access to the pinned Codex protocol. Session-only grants do not grant this API. */
export interface CodexCall {
    sourceId: string; method: string; params: Record<string, unknown> | null;
    /** Mandatory for writes; stable across lost acknowledgements. */
    operationId?: string;
}
export interface CodexCallResult {
    status: 'accepted' | 'rejected' | 'indeterminate'; message: string;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
    /** Durable outcomes survive restart; sensitive native response bodies do not. */
    resultUnavailable?: true;
}
export interface CodexEvent {
    sequence: number; generation: number; method: string; params: Record<string, unknown>;
}
export interface CodexPendingRequest { id: string; method: string; params: Record<string, unknown>; generation: number }
export interface CodexEvents {
    generation: number; cursor: number; reset: boolean; events: CodexEvent[]; pending: CodexPendingRequest[];
}
export interface CodexEventsRequest { sourceId: string; generation?: number; after?: number }
export interface CodexReply { sourceId: string; operationId: string; requestId: string; result: unknown }
export interface CodexCapabilities {
    protocolVersion: '0.165.0'; runtime: string;
    methods: Record<string, 'read' | 'write'>; unavailable: Record<string, string>;
}

/** HHPI source-adapter action, not a Codex-native JSON-RPC method. */
export const QUEUED_STEER_METHOD = 'hhpi/queue/steer';
/** Source queue view, including its exact in-flight transfer ownership. */
export const QUEUE_VIEW_METHOD = 'hhpi/queue/list';
