/** Reproject a verified v1 native cache without rereading remote item bodies. */
import { DatabaseSync } from 'node:sqlite';
import { CodexHistory } from './codex-history.ts';
import { isRecord, nativeItemSchema, nativeTurnSchema, type NativeItemEntry, type NativeThread, type NativeTurn } from './codex-native.ts';
import { SourceEventIndex } from './event-index.ts';
import type { SourceSession } from './protocol.ts';

const checkpointKey = 'native-history-checkpoint:v1';
const key = (...parts: string[]): string => JSON.stringify(parts);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
interface Checkpoint { version: 1; state: 'complete'; updatedAt: number; statusType: string }
interface CachedTurn { turn: NativeTurn; time: number; entries: Array<NativeItemEntry & { sequence: number }> }
interface Candidate { turns: CachedTurn[]; checkpoint: Checkpoint }
interface EventRow { seq: number; source_key: string; type: string; time: number }

function candidate(path: string, session: SourceSession, thread: NativeThread): Candidate | undefined {
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(path, { readOnly: true });
        const prior = JSON.parse(String(db.prepare("SELECT value FROM metadata WHERE key='session'").get()?.value)) as SourceSession;
        if (thread.id !== session.nativeId || ['id', 'machineId', 'sourceId', 'engine', 'nativeId'].some(field =>
            prior[field as keyof SourceSession] !== session[field as keyof SourceSession])) return;
        const cache = new Map(db.prepare('SELECT key,value FROM native_cache').all().map(row => [String(row.key), JSON.parse(String(row.value)) as unknown]));
        const checkpoint = cache.get(checkpointKey), order = cache.get('turn-order');
        if (!isRecord(checkpoint) || checkpoint.version !== 1 || checkpoint.state !== 'complete' ||
            checkpoint.updatedAt !== thread.updatedAt || checkpoint.statusType !== thread.status.type ||
            !Array.isArray(order) || order.some(id => typeof id !== 'string') || new Set(order).size !== order.length) return;
        const rows = db.prepare("SELECT seq,source_key,json_extract(event,'$.type') AS type,json_extract(event,'$.time') AS time FROM events ORDER BY seq").all() as unknown as EventRow[];
        const events = new Map(rows.map(row => [row.source_key, row])), consumed = new Set<string>();
        const event = (sourceKey: string, type: string, time?: number): EventRow => {
            const value = events.get(sourceKey);
            if (!value || value.type !== type || !finite(value.time) || time !== undefined && value.time !== time) throw new Error('Incomplete native display index');
            consumed.add(sourceKey); return value;
        };
        const turns = new Map<string, CachedTurn>();
        for (const id of order as string[]) {
            const state = cache.get(key('turn', id));
            if (!isRecord(state) || !finite(state.time)) return;
            const turn = nativeTurnSchema.parse(state.turn);
            if (turn.id !== id) return;
            event(key('turn', id, 'start'), 'turn/start', state.time);
            if (turn.status !== 'inProgress') event(key('turn', id, 'end'), 'turn/end', turn.completedAt == null ? state.time : turn.completedAt * 1000);
            turns.set(id, { turn, time: state.time, entries: [] });
        }
        let priorStart = 0;
        for (const id of order as string[]) {
            const start = events.get(key('turn', id, 'start'))!.seq;
            if (start <= priorStart) return;
            priorStart = start;
        }
        for (const [sourceKey, state] of cache) {
            if (!sourceKey.startsWith('[')) continue;
            const parts: unknown = JSON.parse(sourceKey);
            if (!Array.isArray(parts)) return;
            if (parts[0] === 'turn') { if (parts.length !== 2 || !turns.has(parts[1])) return; continue; }
            if (parts[0] !== 'item') continue;
            if (parts.length !== 3 || !isRecord(state) || !finite(state.time) || typeof state.completed !== 'boolean') return;
            const item = nativeItemSchema.parse(state.item), turn = turns.get(parts[1]);
            if (!turn || state.turnId !== parts[1] || item.id !== parts[2] || turn.turn.status !== 'inProgress' && !state.completed) return;
            const message = event(key(sourceKey, 'message'), item.type === 'userMessage' ? 'user/message' : 'assistant/message', state.time);
            if (message.seq <= events.get(key('turn', turn.turn.id, 'start'))!.seq) return;
            let completedAtMs: number | undefined;
            if (item.type !== 'userMessage') {
                event(key(sourceKey, 'step/start'), 'step/start', state.time);
                if (state.completed) completedAtMs = event(key(sourceKey, 'step/end'), 'step/end').time;
                for (const suffix of ['tool/call', 'tool/result']) if (events.has(key(sourceKey, suffix))) event(key(sourceKey, suffix), suffix, state.time);
            }
            if (state.completedAtMs !== undefined && (!finite(state.completedAtMs) || !state.completed || completedAtMs !== undefined && state.completedAtMs !== completedAtMs)) return;
            turn.entries.push({ turnId: turn.turn.id, item, startedAtMs: state.time, sequence: message.seq,
                ...(state.completed ? { completedAtMs: completedAtMs ?? state.completedAtMs as number | undefined ?? state.time } : {}) });
        }
        if (consumed.size !== events.size) return;
        for (const turn of turns.values()) {
            turn.entries.sort((a, b) => a.sequence - b.sequence);
            const tail = cache.get(`tail:${turn.turn.id}`);
            if (tail !== undefined && (!isRecord(tail) || tail.last !== turn.entries.at(-1)?.item.id || tail.previous !== (turn.entries.at(-2)?.item.id ?? null))) return;
        }
        return { turns: [...turns.values()], checkpoint: checkpoint as unknown as Checkpoint };
    } catch { return; }
    finally { db?.close(); }
}

function importCandidate(history: CodexHistory, session: SourceSession, value: Candidate): void {
    // Retain accepted fallback timestamps even if the original native turn lacked one.
    history.index.edit(session, () => { for (const state of value.turns) history.index.cache(key('turn', state.turn.id), { turn: state.turn, time: state.time }); });
    for (const state of value.turns) {
        history.beginTurn(session, state.turn);
        history.acceptItems(session, state.entries, false);
        history.acceptTurn(session, state.turn);
    }
    history.index.edit(session, () => {
        history.index.cache('turn-order', value.turns.map(state => state.turn.id));
        for (const state of value.turns) if (state.entries.length) history.index.cache(`tail:${state.turn.id}`,
            { last: state.entries.at(-1)!.item.id, previous: state.entries.at(-2)?.item.id ?? null });
        history.index.cache(checkpointKey, value.checkpoint);
    });
}

/** False leaves an empty destination untouched; the caller uses its normal authoritative scan. */
export function migrateLegacyCodexHistory(path: string, history: CodexHistory, session: SourceSession, thread: NativeThread): boolean {
    if (history.index.count || history.index.cached('turn-order') !== undefined || history.index.cached(checkpointKey) !== undefined) return false;
    const value = candidate(path, session, thread);
    if (!value) return false;
    const validation = new SourceEventIndex(':memory:', session);
    try { importCandidate(new CodexHistory(validation), session, value); }
    catch { return false; }
    finally { validation.dispose(); }
    // A durable failure propagates and leaves no complete checkpoint. Never adopt partial work.
    importCandidate(history, session, value);
    return true;
}
