/** Source-owned, versioned display index. No DSH execution Session is created. */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { validateSessionEventData, validateSurfaceMetadata } from '@deepseek-ai/dsh-session/surface';
import { SourceError } from './errors.ts';
import type { SourceChanges, SourceChangesRequest, SourceEntry, SourcePage, SourceReadRequest, SourceSession } from './protocol.ts';

interface EventRow { seq: number; source_key: string; event: string; dependencies: string }
interface MetaRow { value: string }
export type EventInput = Omit<SessionEvent, 'seq'>;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const PAGE_BYTES = 8 * 1024 * 1024;
const JOURNAL_BYTES = 16 * 1024 * 1024;
const JOURNAL_VERSIONS = 256;

/** IDs, chronological sequence, source version and a reader's cursor are separate facts. */
export class SourceEventIndex {
    private readonly db: DatabaseSync;
    private readonly listeners = new Set<() => void>();
    private readonly lifetime = new AbortController();
    private editing = false;
    private readonly upserts = new Map<number, SourceEntry>();
    private readonly removed = new Set<number>();
    private reset = false;

    constructor(path: string, session: SourceSession) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        if (path !== ':memory:') chmodSync(path, 0o600);
        this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE NOT NULL,
                event TEXT NOT NULL, dependencies TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS coordinates (
                kind TEXT NOT NULL, parent TEXT NOT NULL, native_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
                PRIMARY KEY(kind,parent,native_key), UNIQUE(kind,parent,ordinal));
            CREATE TABLE IF NOT EXISTS native_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS journal (version INTEGER PRIMARY KEY, frame TEXT NOT NULL, bytes INTEGER NOT NULL);`);
        const prior = this.meta('session');
        if (prior && (JSON.parse(prior) as SourceSession).id !== session.id) {
            this.db.close();
            throw new SourceError('INVALID_REQUEST', 'This history index belongs to another source session.');
        }
        if (!prior) {
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.setMeta('session', JSON.stringify(session)); this.setMeta('epoch', randomUUID()); this.setMeta('version', '0');
                this.db.exec('COMMIT');
            } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
        }
    }
    private meta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as MetaRow | undefined)?.value; }
    private setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
    get epoch(): string { return this.meta('epoch')!; }
    get version(): number { return Number(this.meta('version')); }
    get session(): SourceSession { return JSON.parse(this.meta('session')!) as SourceSession; }
    get count(): number { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n); }
    cached<T>(key: string): T | undefined {
        const row = this.db.prepare('SELECT value FROM native_cache WHERE key=?').get(key) as MetaRow | undefined;
        return row ? JSON.parse(row.value) as T : undefined;
    }
    cache(key: string, value: unknown): void {
        this.assertEditing();
        this.db.prepare('INSERT INTO native_cache VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    }
    forget(prefix: string): void {
        this.assertEditing();
        this.db.prepare('DELETE FROM native_cache WHERE substr(key,1,?)=?').run(prefix.length, prefix);
    }
    /** Allocate once in source chronology; never an offset selected by a browser page. */
    coordinate(kind: string, parent: string, nativeKey: string): number {
        this.assertEditing();
        const row = this.db.prepare('SELECT ordinal FROM coordinates WHERE kind=? AND parent=? AND native_key=?').get(kind, parent, nativeKey);
        if (row) return Number(row.ordinal);
        const next = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM coordinates WHERE kind=? AND parent=?').get(kind, parent)!.n);
        this.db.prepare('INSERT INTO coordinates VALUES (?,?,?,?)').run(kind, parent, nativeKey, next);
        return next;
    }
    sequence(key: string): number | undefined {
        const row = this.db.prepare('SELECT seq FROM events WHERE source_key=?').get(key);
        return row ? Number(row.seq) : undefined;
    }
    entry(key: string): SourceEntry | undefined {
        const row = this.db.prepare('SELECT event FROM events WHERE source_key=?').get(key);
        return row ? { type: 'event', event: JSON.parse(String(row.event)) as SessionEvent } : undefined;
    }
    private assertEditing(): void { if (!this.editing) throw new Error('Source index changes require an atomic edit'); }

    /** Atomically publish one accepted source revision, including metadata and the replay journal. */
    edit(session: SourceSession, update: () => void): void {
        this.lifetime.signal.throwIfAborted();
        if (session.id !== this.session.id) throw new SourceError('INVALID_REQUEST', 'Source metadata crossed session scope.');
        if (this.editing) throw new Error('Source index edits cannot nest');
        this.db.exec('BEGIN IMMEDIATE'); this.editing = true; this.reset = false;
        this.upserts.clear(); this.removed.clear();
        let published = false;
        try {
            const base = this.version, before = this.meta('session'), next = JSON.stringify(session);
            update();
            this.setMeta('session', next);
            if (before !== next || this.upserts.size || this.removed.size || this.reset) {
                const version = base + 1;
                const frame: SourceChanges = { session, epoch: this.epoch, base, version, reset: this.reset,
                    upserts: [...this.upserts.values()].sort((a, b) => a.event.seq - b.event.seq), removed: [...this.removed].sort((a, b) => a - b) };
                const serialized = JSON.stringify(frame);
                this.setMeta('version', String(version));
                this.db.prepare('INSERT INTO journal VALUES (?,?,?)').run(version, serialized, Buffer.byteLength(serialized));
                this.db.prepare('DELETE FROM journal WHERE version<=?').run(version - JOURNAL_VERSIONS);
                let bytes = Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM journal').get()!.n);
                for (const row of this.db.prepare('SELECT version,bytes FROM journal ORDER BY version').all()) {
                    if (bytes <= JOURNAL_BYTES) break;
                    // Even an oversized revision has a latest checkpoint. A fallen-behind reader explicitly recovers.
                    this.db.prepare('DELETE FROM journal WHERE version=?').run(row.version!);
                    bytes -= Number(row.bytes);
                }
                published = true;
            }
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        finally { this.editing = false; this.upserts.clear(); this.removed.clear(); }
        if (published) for (const listener of [...this.listeners]) listener();
    }

    put(key: string, input: EventInput, dependencyKeys: readonly string[] = []): number {
        this.assertEditing();
        const old = this.db.prepare('SELECT seq,event,dependencies FROM events WHERE source_key=?').get(key) as EventRow | undefined;
        const seq = old?.seq ?? Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM sqlite_sequence WHERE name=\'events\'').get()?.n ?? 1);
        // Validate against the pinned public DSH vocabulary at the source boundary.
        const event = { ...input, seq: SessionSeq(seq) } as SessionEvent;
        validateSessionEventData(event, 'HHPI source event'); validateSurfaceMetadata(event);
        const encoded = JSON.stringify(event);
        if (Buffer.byteLength(encoded) > MAX_ENTRY_BYTES) throw new SourceError('CAPACITY_EXCEEDED', 'A source event exceeds the 4 MiB display limit. Existing history is unchanged.');
        const dependencies = dependencyKeys.map(dependency => {
            const value = this.sequence(dependency);
            if (value === undefined || value >= seq) throw new SourceError('INVALID_REQUEST', 'A source dependency must precede its content.');
            return value;
        });
        const encodedDependencies = JSON.stringify([...new Set(dependencies)]);
        if (old?.event === encoded && old.dependencies === encodedDependencies) return seq;
        if (old) this.db.prepare('UPDATE events SET event=?,dependencies=? WHERE seq=?').run(encoded, encodedDependencies, seq);
        else this.db.prepare('INSERT INTO events(seq,source_key,event,dependencies) VALUES (?,?,?,?)').run(seq, key, encoded, encodedDependencies);
        this.upserts.set(seq, { type: 'event', event }); this.removed.delete(seq);
        return seq;
    }

    /** An authoritative history rewrite revokes cursors and in-flight older reads. */
    removeFrom(seq: number): void {
        this.assertEditing();
        const rows = this.db.prepare('SELECT seq FROM events WHERE seq>=? ORDER BY seq').all(seq);
        if (!rows.length) return;
        for (const row of rows) { const id = Number(row.seq); this.removed.add(id); this.upserts.delete(id); }
        this.db.prepare('DELETE FROM events WHERE seq>=?').run(seq);
        this.setMeta('epoch', randomUUID()); this.reset = true;
    }

    read(request: SourceReadRequest): SourcePage {
        this.lifetime.signal.throwIfAborted();
        const session = this.session, epoch = this.epoch;
        if (request.sessionId !== session.id) throw new SourceError('INVALID_REQUEST', 'A history request belongs to another source.');
        if (request.epoch !== undefined && request.epoch !== epoch) throw new SourceError('STALE_VERSION', 'The source replaced this history cursor.');
        const limit = request.limit ?? 160;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new SourceError('INVALID_REQUEST', 'History page limit must be between 1 and 500.');
        let selected: EventRow[];
        if (request.around !== undefined) {
            const left = this.db.prepare('SELECT * FROM events WHERE seq<? ORDER BY seq DESC LIMIT ?').all(request.around, Math.floor(limit / 2)) as unknown as EventRow[];
            const right = this.db.prepare('SELECT * FROM events WHERE seq>=? ORDER BY seq LIMIT ?').all(request.around, limit - left.length) as unknown as EventRow[];
            selected = [...left.reverse(), ...right];
        } else if (request.after !== undefined) selected = this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(request.after, limit) as unknown as EventRow[];
        else selected = (request.before === undefined
            ? this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit)
            : this.db.prepare('SELECT * FROM events WHERE seq<? ORDER BY seq DESC LIMIT ?').all(request.before, limit)) as unknown as EventRow[];
        if (request.after === undefined && request.around === undefined) selected.reverse();
        // Trim only the returned candidate, in the requested direction. Accepted browser windows are untouched.
        let byteCount = selected.reduce((sum, row) => sum + Buffer.byteLength(row.event), 0);
        while (byteCount > PAGE_BYTES && selected.length > 1) {
            const removed = request.after !== undefined ? selected.pop()! : selected.shift()!;
            byteCount -= Buffer.byteLength(removed.event);
        }
        const entries = new Map(selected.map(row => [row.seq, row])), context = new Set<number>();
        const addDependency = (seq: number): void => {
            if (entries.has(seq)) return;
            const row = this.db.prepare('SELECT * FROM events WHERE seq=?').get(seq) as unknown as EventRow | undefined;
            if (!row) throw new SourceError('STALE_VERSION', 'A source dependency was removed; this window needs recovery.');
            entries.set(seq, row); context.add(seq);
            for (const dependency of JSON.parse(row.dependencies) as number[]) addDependency(dependency);
        };
        for (const row of selected) for (const dependency of JSON.parse(row.dependencies) as number[]) addDependency(dependency);
        const before = selected[0]?.seq ?? null, after = selected.at(-1)?.seq ?? null;
        const hasBefore = before !== null && Boolean(this.db.prepare('SELECT 1 FROM events WHERE seq<? LIMIT 1').get(before));
        const hasAfter = after !== null && Boolean(this.db.prepare('SELECT 1 FROM events WHERE seq>? LIMIT 1').get(after));
        return { session, epoch, version: this.version, entries: [...entries.values()].sort((a, b) => a.seq - b.seq).map(row => ({ type: 'event', event: JSON.parse(row.event) as SessionEvent })),
            before, after, hasBefore, hasAfter, context: [...context].sort((a, b) => a - b) };
    }

    async *changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
        const lifetime = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        if (request.sessionId !== this.session.id) throw new SourceError('INVALID_REQUEST', 'A subscription belongs to another source.');
        let epoch = request.epoch, version = request.version;
        while (!lifetime.aborted) {
            const actual = this.version;
            const next = this.db.prepare('SELECT frame FROM journal WHERE version=?').get(version + 1);
            if (epoch !== this.epoch || version > actual || version < actual && !next) {
                epoch = this.epoch; version = actual;
                yield { session: this.session, epoch, base: request.version, version, reset: true, upserts: [], removed: [] };
                continue;
            }
            if (next) { const frame = JSON.parse(String(next.frame)) as SourceChanges; epoch = frame.epoch; version = frame.version; yield frame; continue; }
            await new Promise<void>((resolve, reject) => {
                const cleanup = (): void => { this.listeners.delete(wake); lifetime.removeEventListener('abort', stop); };
                const wake = (): void => { cleanup(); resolve(); };
                const stop = (): void => { cleanup(); reject(lifetime.reason); };
                this.listeners.add(wake); lifetime.addEventListener('abort', stop, { once: true });
                if (lifetime.aborted) stop(); else if (this.version !== version || this.epoch !== epoch) wake();
            });
        }
        lifetime.throwIfAborted();
    }
    dispose(): void {
        if (this.lifetime.signal.aborted) return;
        this.lifetime.abort(new SourceError('DISPOSED', 'The source index was closed.'));
        this.listeners.clear(); this.db.close();
    }
}
