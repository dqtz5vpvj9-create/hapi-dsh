/** Bounded canonical evidence for a request that this source actually received.
 * This does not discover requests, resume threads, or infer validity from waiting. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { NativeRequest } from './codex-rpc.ts';

const MAX_TAIL = 4 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export interface PendingCallAnchor {
    version: 1; path: string; file: string; offset: number; ordinal: number; line: string;
    threadId: string; turnId: string; callId: string;
}
export type PendingCallEvidence = 'pending' | 'resolved' | 'unknown';
const fileIdentity = (stat: { dev: bigint; ino: bigint; birthtimeNs: bigint }): string => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const sameSnapshot = (a: { size: bigint; mtimeNs: bigint; ctimeNs: bigint }, b: typeof a): boolean => a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
interface Snapshot { bytes: Buffer; start: number; file: string; header: Record<string, unknown> }

async function snapshot(home: string, path: string, offset?: number): Promise<Snapshot | undefined> {
    try {
        if (!isAbsolute(path) || !path.endsWith('.jsonl')) return;
        const base = await realpath(home), actual = await realpath(path), local = relative(base, actual);
        if (actual !== path || local.startsWith(`..${sep}`) || isAbsolute(local)
            || !['sessions', 'archived_sessions'].includes(local.split(sep)[0]!)) return;
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return;
            const size = Number(before.size), start = offset ?? Math.max(0, size - MAX_TAIL);
            if (!Number.isSafeInteger(start) || start < 0 || start >= size || size - start > MAX_TAIL) return;
            const header = Buffer.alloc(Math.min(size, HEADER_BYTES));
            const first = await handle.read(header, 0, header.length, 0), newline = header.subarray(0, first.bytesRead).indexOf(10);
            if (newline < 0) return;
            const line: unknown = JSON.parse(header.subarray(0, newline).toString('utf8'));
            if (!record(line) || line.type !== 'session_meta' || !record(line.payload) || line.payload.history_mode !== 'paginated') return;
            const bytes = Buffer.alloc(size - start), read = await handle.read(bytes, 0, bytes.length, start);
            const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
            if (read.bytesRead !== bytes.length || !sameSnapshot(before, after) || !sameSnapshot(after, named)
                || fileIdentity(before) !== fileIdentity(named) || bytes.at(-1) !== 10) return;
            return { bytes, start, file: fileIdentity(before), header: line.payload };
        } finally { await handle.close(); }
    } catch { return; }
}
function lines(bytes: Buffer, start: number): Array<{ value: Record<string, unknown>; offset: number; raw: Buffer }> | undefined {
    const output: Array<{ value: Record<string, unknown>; offset: number; raw: Buffer }> = [];
    let at = 0;
    try {
        while (at < bytes.length) {
            const end = bytes.indexOf(10, at);
            if (end < 0) return;
            const raw = bytes.subarray(at, end), value: unknown = JSON.parse(raw.toString('utf8'));
            if (!record(value) || !Number.isSafeInteger(value.ordinal)) return;
            if (output.length && value.ordinal !== Number(output.at(-1)!.value.ordinal) + 1) return;
            output.push({ value, offset: start + at, raw }); at = end + 1;
        }
        return output;
    } catch { return; }
}

/** Capture only a native request_user_input call in its original thread/turn.
 * Older data without this receipt-time binding is deliberately not migrated. */
export async function capturePendingCall(home: string, path: string, request: NativeRequest): Promise<PendingCallAnchor | undefined> {
    if (request.method !== 'item/tool/requestUserInput') return;
    const { threadId, turnId, itemId } = request.params;
    if (typeof threadId !== 'string' || typeof turnId !== 'string' || typeof itemId !== 'string') return;
    const read = await snapshot(home, path);
    if (!read || read.header.id !== threadId) return;
    const skip = read.start ? read.bytes.indexOf(10) + 1 : 0;
    if (read.start && skip <= 0) return;
    const entries = lines(read.bytes.subarray(skip), read.start + skip);
    if (!entries) return;
    let currentTurn: unknown, found: PendingCallAnchor | undefined;
    for (const { value, offset, raw } of entries) {
        const payload = value.payload;
        if (!record(payload)) continue;
        if (value.type === 'turn_context') currentTurn = payload.turn_id;
        if (value.type === 'event_msg' && payload.type === 'task_started') currentTurn = payload.turn_id;
        if (value.type === 'response_item' && payload.type === 'function_call' && payload.name === 'request_user_input' && payload.call_id === itemId) {
            if (found || currentTurn !== turnId) return;
            found = { version: 1, path, file: read.file, offset, ordinal: Number(value.ordinal), line: hash(raw), threadId, turnId, callId: itemId };
        }
    }
    return found && await pendingCallEvidence(home, found) === 'pending' ? found : undefined;
}

/** Every byte from the pinned call through a complete, contiguous canonical EOF
 * must be read. Truncation, replacement, partial lines, gaps and budget overflow
 * are unknown; a missed output is never interpreted as its absence. */
export async function pendingCallEvidence(home: string, anchor: PendingCallAnchor): Promise<PendingCallEvidence> {
    if (anchor.version !== 1) return 'unknown';
    const read = await snapshot(home, anchor.path, anchor.offset);
    if (!read || read.file !== anchor.file || read.header.id !== anchor.threadId) return 'unknown';
    const entries = lines(read.bytes, read.start), first = entries?.[0];
    if (!first || first.value.ordinal !== anchor.ordinal || hash(first.raw) !== anchor.line) return 'unknown';
    let superseded = false;
    for (const { value } of entries!) {
        const payload = value.payload;
        if (!record(payload)) return 'unknown';
        if (value.type === 'response_item' && payload.type === 'function_call_output' && payload.call_id === anchor.callId) return 'resolved';
        if (value.type === 'retained_context' && payload.type === 'verified_answer' && payload.call_id === anchor.callId && payload.turn_id === anchor.turnId) return 'resolved';
        if (value.type === 'event_msg' && payload.type === 'task_complete' && payload.turn_id === anchor.turnId) return 'resolved';
        if (value.type === 'response_item' && payload.type === 'function_call' && payload.name === 'request_user_input' && payload.call_id !== anchor.callId) superseded = true;
        if (value.type === 'turn_context' && payload.turn_id !== anchor.turnId) return 'unknown';
    }
    return superseded ? 'unknown' : 'pending';
}
