/** Versioned transport envelopes. DSH HTTP and WebSocket payloads are opaque bytes. */
export const FEDERATION_PROTOCOL = 1;
export const RUNNER_PATH = '/hapi-dsh/runner';
export const SOCKET_PATH = '/hapi-dsh/socket';
export const MACHINE_PREFIX = '/hapi-dsh/machine';
export const MACHINES_PATH = '/hapi-dsh/machines';
export const BOOTSTRAP_PATH = '/hapi-dsh/bootstrap';
export const CHUNK_BYTES = 128 * 1024;
export const MAX_FRAME_BYTES = 48 * 1024 * 1024;
export const MAX_SOCKET_BYTES = 32 * 1024 * 1024;
export const MAX_CHANNELS = 128;

export interface FederatedMachine {
    id: string;
    name: string;
    online: boolean;
    dshVersion: string;
    generation?: string;
    connectedAt?: number;
    disconnectedAt?: number;
    baseUrl: string;
    socketUrl: string;
}

export type WireHeaders = Array<[string, string]>;
export type DataLane = 'request' | 'response' | 'socket';
export type FederationFrame =
    | { type: 'hello'; protocol: 1; machineId: string; name: string; dshVersion: string; generation: string }
    | { type: 'welcome'; protocol: 1 }
    | { type: 'http-open'; id: string; method: string; path: string; headers: WireHeaders }
    | { type: 'http-head'; id: string; status: number; headers: WireHeaders }
    | { type: 'data'; id: string; lane: DataLane; data: string; ticket: string; binary?: boolean }
    | { type: 'ack'; ticket: string }
    | { type: 'http-end'; id: string; lane: 'request' | 'response' }
    | { type: 'http-cancel'; id: string }
    | { type: 'http-error'; id: string; code: 'upstream-unavailable' | 'request-rejected' | 'limit-exceeded' }
    | { type: 'ws-open'; id: string; path: string; protocols: string[] }
    | { type: 'ws-ready'; id: string; protocol: string }
    | { type: 'ws-close'; id: string; code: number; reason: string };

export function validIdentifier(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(value);
}

export function validMachineId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

/** All targets stay under the already authenticated local DSH listener. */
export function validateUpstreamPath(value: unknown): string {
    if (typeof value !== 'string' || value.length > 16_384 || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n\0]/.test(value)) {
        throw new Error('Invalid DSH upstream path');
    }
    const parsed = new URL(value, 'http://dsh.local');
    if (parsed.origin !== 'http://dsh.local' || parsed.hash) throw new Error('Invalid DSH upstream path');
    return value;
}

function headers(value: unknown): value is WireHeaders {
    return Array.isArray(value) && value.length <= 128 && value.every((entry: unknown) => Array.isArray(entry)
        && entry.length === 2 && typeof entry[0] === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry[0])
        && typeof entry[1] === 'string' && entry[1].length <= 16_384 && !/[\r\n\0]/.test(entry[1]));
}

export function parseFrame(raw: string): FederationFrame {
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new Error('Federation frame exceeds its limit');
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid federation frame');
    const frame = value as Record<string, unknown>;
    let valid = false;
    switch (frame.type) {
        case 'hello': valid = frame.protocol === 1 && validMachineId(frame.machineId) && validIdentifier(frame.generation)
            && typeof frame.name === 'string' && frame.name.length > 0 && frame.name.length <= 128
            && typeof frame.dshVersion === 'string' && frame.dshVersion.length < 80; break;
        case 'welcome': valid = frame.protocol === 1; break;
        case 'ack': valid = validIdentifier(frame.ticket); break;
        case 'http-open': valid = validIdentifier(frame.id) && typeof frame.method === 'string' && /^[A-Z]{1,20}$/.test(frame.method)
            && headers(frame.headers); if (valid) validateUpstreamPath(frame.path); break;
        case 'http-head': valid = validIdentifier(frame.id) && Number.isInteger(frame.status) && Number(frame.status) >= 100
            && Number(frame.status) <= 599 && headers(frame.headers); break;
        case 'data': valid = validIdentifier(frame.id) && validIdentifier(frame.ticket) && ['request', 'response', 'socket'].includes(String(frame.lane))
            && typeof frame.data === 'string' && frame.data.length <= Math.ceil(MAX_SOCKET_BYTES / 3) * 4
            && frame.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)
            && (frame.binary === undefined || typeof frame.binary === 'boolean'); break;
        case 'http-end': valid = validIdentifier(frame.id) && (frame.lane === 'request' || frame.lane === 'response'); break;
        case 'http-cancel': valid = validIdentifier(frame.id); break;
        case 'http-error': valid = validIdentifier(frame.id) && ['upstream-unavailable', 'request-rejected', 'limit-exceeded'].includes(String(frame.code)); break;
        case 'ws-open': valid = validIdentifier(frame.id) && Array.isArray(frame.protocols) && frame.protocols.length <= 16
            && frame.protocols.every((item: unknown) => typeof item === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(item));
            if (valid) validateUpstreamPath(frame.path); break;
        case 'ws-ready': valid = validIdentifier(frame.id) && typeof frame.protocol === 'string'
            && (frame.protocol === '' || /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(frame.protocol)); break;
        case 'ws-close': valid = validIdentifier(frame.id) && Number.isInteger(frame.code) && Number(frame.code) >= 1000 && Number(frame.code) <= 4999
            && typeof frame.reason === 'string' && Buffer.byteLength(frame.reason) <= 123; break;
    }
    if (!valid) throw new Error('Invalid federation frame');
    return frame as unknown as FederationFrame;
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
export function filterHeaders(entries: WireHeaders, direction: 'request' | 'response'): WireHeaders {
    const connectionTokens = entries.filter(([name]) => name.toLowerCase() === 'connection').flatMap(([, value]) => value.toLowerCase().split(',').map((part) => part.trim()));
    return entries.filter(([name]) => {
        const lower = name.toLowerCase();
        if (HOP_HEADERS.has(lower) || connectionTokens.includes(lower)) return false;
        if (direction === 'request') return !['host', 'cookie', 'authorization', 'origin', 'referer'].includes(lower)
            && !lower.startsWith('x-forwarded-') && !lower.startsWith('sec-fetch-');
        return lower !== 'set-cookie';
    });
}

export function safeSocketClose(code: number): number {
    return code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : 1011;
}
