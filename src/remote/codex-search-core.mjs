/** Cancellable source-local search over Codex's existing visible history index.
 * No transcript mirror/index or execution operation lives here. */
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldRead } from 'node:timers/promises';
import { RolloutSearch, rolloutLength } from './codex-search-rollout.mjs';
import { NativeHistoryMetadata, NativeMetadataIndexMissing, nativeMetadataGenerations, openNativeMetadata } from './codex-metadata-core.mjs';

export class NativeSearchError extends Error {
    constructor(code, message) { super(message); this.name = 'NativeSearchError'; this.code = code; }
}
const invalid = () => new NativeSearchError('INVALID_REQUEST', 'This search continuation is no longer current. Search again.');
const unavailable = () => new NativeSearchError('HISTORY_UNAVAILABLE', 'The source history index is not ready for complete message search. Existing conversations remain available.');
const changed = () => new NativeSearchError('STALE_VERSION', 'The source replaced this search history. Search again.');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKinds = new Set(['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']);
const sortColumns = { created_at: 'created_at', updated_at: 'updated_at', recency_at: 'recency_at' };
const defaults = { items: 128, bytes: 4 * 1024 * 1024, threads: 24, ms: 75, catalog: 10_000, sessions: 4, ttlMs: 5 * 60_000 };

/** This is the native catalog source-kind filter, never a match against titles. */
function sourceKind(value) {
    if (sourceKinds.has(value)) return value;
    try {
        const parsed = JSON.parse(value);
        if (sourceKinds.has(parsed)) return parsed;
        const sub = parsed?.subagent ?? parsed?.subAgent;
        if (sub === 'review' || sub?.review) return 'subAgentReview';
        if (sub === 'compact' || sub?.compact) return 'subAgentCompact';
        if (sub?.thread_spawn ?? sub?.threadSpawn) return 'subAgentThreadSpawn';
        if (sub != null) return 'subAgentOther';
    } catch { /* Older native state stores use the plain source name. */ }
    return 'unknown';
}
function spec(request) {
    if (!request || typeof request.home !== 'string' || !request.home || !request.params || typeof request.params !== 'object') throw invalid();
    const p = request.params, query = p.searchTerm;
    if (typeof query !== 'string' || !query.trim() || query.length > 4096 || query.includes('\0')
        || p.cursor != null && (typeof p.cursor !== 'string' || p.cursor.length > 256)
        || p.archived != null && typeof p.archived !== 'boolean'
        || p.limit != null && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)
        || p.sortKey != null && !Object.hasOwn(sortColumns, p.sortKey)
        || p.sortDirection != null && !['asc', 'desc'].includes(p.sortDirection)
        || p.sourceKinds != null && (!Array.isArray(p.sourceKinds) || p.sourceKinds.some(kind => !sourceKinds.has(kind)))) throw invalid();
    return { home: resolve(request.home), query, archived: p.archived ?? false, limit: p.limit ?? 50,
        sortKey: p.sortKey ?? 'created_at', sortDirection: p.sortDirection ?? 'desc',
        sources: [...new Set(p.sourceKinds?.length ? p.sourceKinds : ['cli', 'vscode', 'exec', 'appServer'])].sort() };
}
function databaseIdentity(home, state, history) {
    return hash([home, ...['state_5.sqlite', 'thread_history_1.sqlite'].map(path => {
        const stat = statSync(join(home, path), { throwIfNoEntry: false });
        // Ordinary WAL appends retain the source generation. Replacement and
        // schema changes retire its cursor; a byte mtime is not a generation.
        return stat ? [stat.dev, stat.ino, stat.birthtimeMs] : null;
    }), state.prepare('PRAGMA schema_version').get(), history?.query('PRAGMA schema_version').get() ?? null]);
}
function searchableText(item) {
    // Same conversation-text boundary as native rollout search: user and
    // assistant prose/code, not tool JSON, reasoning or system metadata.
    if (item.type === 'userMessage' && Array.isArray(item.content))
        return item.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join(' ');
    return item.type === 'agentMessage' && typeof item.text === 'string' ? item.text : '';
}
function excerpt(text, query) {
    const normalized = text.trim().replace(/\s+/gu, ' '), chars = Array.from(normalized);
    const lowered = normalized.toLowerCase(), found = lowered.indexOf(query.toLowerCase());
    if (found < 0) return undefined;
    // Lowercasing may expand a Unicode character. Map its UTF-16 span back to
    // the real text before taking the bounded snippet.
    let offset = 0, first = 0, last = chars.length;
    for (let at = 0; at < chars.length; at++) {
        const end = offset + chars[at].toLowerCase().length;
        if (offset <= found && end > found) first = at;
        if (end >= found + query.toLowerCase().length) { last = at + 1; break; }
        offset = end;
    }
    const start = Math.max(0, first - 48), end = Math.min(chars.length, last + 96);
    return `${start ? '… ' : ''}${chars.slice(start, end).join('')}${end < chars.length ? ' …' : ''}`;
}
const cursor = (id, revision) => `hhpi-history-search-v1:${id}:${revision}`;
function assertCatalogCurrent(state, session, limits) {
    const rows = state.prepare('SELECT id, rollout_path, source, history_mode, archived FROM threads LIMIT ?').all(limits.catalog + 1);
    if (rows.length > limits.catalog) throw unavailable();
    const live = new Map(rows.map(row => [row.id, row]));
    for (const prior of session.catalog) {
        const row = live.get(prior.id);
        if (!row || row.rollout_path !== prior.rollout_path || row.source !== prior.source
            || row.history_mode !== prior.history_mode || Boolean(row.archived) !== session.archived) throw changed();
    }
}

/** Retains only a bounded catalog/cursor, never searched item bodies. */
export class NativeHistorySearch {
    sessions = new Map();
    constructor(options = {}) { this.limits = { ...defaults, ...options }; }
    retire(session) { clearTimeout(session.expiry); for (const scan of session.current?.scans ?? []) scan.close(); this.sessions.delete(session.id); }
    async search(request, signal = new AbortController().signal) {
        signal.throwIfAborted();
        const selected = spec(request), scope = hash(selected), now = Date.now();
        for (const [id, session] of this.sessions) if (now - session.touched > this.limits.ttlMs) this.retire(session);
        let state, history, session;
        try {
            state = new DatabaseSync(join(selected.home, 'state_5.sqlite'), { readOnly: true });
            try { history = openNativeMetadata(selected.home); } catch (error) { if (!(error instanceof NativeMetadataIndexMissing)) throw error; }
            const generation = databaseIdentity(selected.home, state, history);
            const input = request.params.cursor;
            if (input != null) {
                const match = /^hhpi-history-search-v1:([0-9a-f-]{36}):(\d+)$/.exec(input);
                const found = match && this.sessions.get(match[1]);
                if (!found || found.scope !== scope || found.busy) throw invalid();
                session = found;
                if (session.generation !== generation) { this.retire(session); throw changed(); }
                assertCatalogCurrent(state, session, this.limits);
                if (session.lastInput === input && session.lastOutput) return session.lastOutput;
                if (input !== cursor(session.id, session.revision)) throw invalid();
            } else {
                const column = sortColumns[selected.sortKey], direction = selected.sortDirection.toUpperCase();
                const candidates = state.prepare(`SELECT id, rollout_path, source, history_mode FROM threads
                    WHERE archived = ? ORDER BY ${column} ${direction}, id ${direction} LIMIT ?`).all(Number(selected.archived), this.limits.catalog + 1);
                if (candidates.length > this.limits.catalog) throw unavailable();
                const catalog = candidates.filter(thread => selected.sources.includes(sourceKind(thread.source)));
                if (catalog.some(thread => !['paginated', 'legacy'].includes(thread.history_mode) || typeof thread.rollout_path !== 'string'
                    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(thread.id))) throw unavailable();
                if (this.sessions.size >= this.limits.sessions) this.retire(this.sessions.values().next().value);
                session = { id: randomUUID(), scope, generation, archived: selected.archived, catalog, index: 0, current: undefined, revision: 0, touched: now, busy: false };
                this.sessions.set(session.id, session);
            }
            session.busy = true; session.touched = now;
            clearTimeout(session.expiry);
            session.expiry = setTimeout(() => this.retire(session), this.limits.ttlMs);
            session.expiry.unref();
            const page = { data: [], nextCursor: null }, started = performance.now();
            let items = 0, bytes = 0, threads = 0;
            while (session.index < session.catalog.length && page.data.length < selected.limit
                && items < this.limits.items && bytes < this.limits.bytes && threads < this.limits.threads
                && (items + bytes === 0 || performance.now() - started < this.limits.ms)) {
                signal.throwIfAborted();
                const thread = session.catalog[session.index];
                const live = state.prepare('SELECT rollout_path, archived, history_mode FROM threads WHERE id = ?').get(thread.id);
                if (!live || live.rollout_path !== thread.rollout_path || Boolean(live.archived) !== selected.archived || live.history_mode !== thread.history_mode) throw changed();
                let generations;
                try { generations = await nativeMetadataGenerations(selected.home, thread.id, { signal, maxBytes: 64 * 1024, allowLegacy: true }); }
                catch (error) { signal.throwIfAborted(); if (session.current) throw changed(); throw error; }
                signal.throwIfAborted();
                let index = history && thread.history_mode === 'paginated' && !session.current?.raw
                    ? new NativeHistoryMetadata(history, thread.id, generations.ids, generations.cutovers) : undefined;
                const rawCoordinates = generations.ids.map(id => `${id}:${generations.cutovers.get(id) ?? 'head'}`).join('|');
                if (!session.current) {
                    // Native .162 commits projection rows and its checkpoint
                    // atomically, but deliberately permits projection failures.
                    // Only a fully covered canonical prefix is authoritative.
                    let complete = Boolean(index);
                    for (const id of generations.ids) {
                        const projection = index && history.query('SELECT next_rollout_byte_offset AS bytes, next_rollout_ordinal AS ordinal FROM thread_history_projection_state WHERE thread_id = ?').get(id);
                        const cutoff = generations.cutovers.get(id);
                        if (projection && cutoff !== undefined && projection.ordinal >= cutoff) continue;
                        const path = generations.paths.get(id);
                        if (!path) throw unavailable();
                        if (!projection || rolloutLength(path) !== projection.bytes) complete = false;
                    }
                    if (!complete) index = undefined;
                    session.current = { coordinates: index?.coordinates ?? rawCoordinates, raw: !index,
                        before: Number.MAX_SAFE_INTEGER, scans: [] };
                    if (!complete) for (const id of generations.ids) {
                        const cutoff = generations.cutovers.get(id);
                        if (cutoff === 0) continue;
                        const path = generations.paths.get(id);
                        if (!path) throw unavailable();
                        session.current.scans.push(new RolloutSearch(path, 0, rolloutLength(path), cutoff, this.limits.bytes));
                    }
                }
                if (session.current.coordinates !== (index?.coordinates ?? rawCoordinates)) throw changed();
                while (session.current.scans.length && items < this.limits.items && bytes < this.limits.bytes
                    && (items + bytes === 0 || performance.now() - started < this.limits.ms)) {
                    const scan = session.current.scans[0];
                    const result = await scan.read({ items: this.limits.items - items, bytes: this.limits.bytes - bytes,
                        deadline: started + this.limits.ms }, signal, text => excerpt(text, selected.query));
                    bytes += result.bytes; items += result.items;
                    if (scan.done) session.current.scans.shift();
                    if (result.snippet !== undefined) {
                        page.data.push({ threadId: thread.id, snippet: result.snippet });
                        for (const pending of session.current.scans) pending.close();
                        session.current = undefined; ++session.index; ++threads; break;
                    }
                }
                if (!session.current) continue;
                if (session.current.scans.length) break;
                if (!index) { session.current = undefined; ++session.index; ++threads; continue; }
                if (items >= this.limits.items || bytes >= this.limits.bytes || items + bytes > 0 && performance.now() - started >= this.limits.ms) break;
                const anchor = session.current.anchor;
                if (anchor) {
                    let current;
                    try { current = index.item(anchor.turnId, anchor.itemId); } catch { throw changed(); }
                    if (current.rollout_ordinal !== anchor.ordinal || current.updated_at_ordinal !== anchor.revision) throw changed();
                }
                const metadata = index.items(session.current.before, 'desc', Math.min(32, this.limits.items - items));
                if (!metadata.length) { session.current = undefined; ++session.index; ++threads; await yieldRead(undefined, { signal }); continue; }
                let matched = false, budget = false;
                for (const item of metadata) {
                    signal.throwIfAborted();
                    const native = [...index.generations].reverse().find(value => item.rollout_ordinal >= value.offset);
                    const stored = history.query('SELECT item_type, length(CAST(item_json AS BLOB)) AS bytes FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?')
                        .get(native.id, item.turn_id, item.item_id);
                    if (!stored) throw changed();
                    if (['', 'userMessage', 'agentMessage'].includes(stored.item_type)) {
                        if (stored.bytes > this.limits.bytes) throw new NativeSearchError('HISTORY_UNAVAILABLE', 'A source message exceeds the search page budget. Narrow the search to its conversation.');
                        if (bytes + stored.bytes > this.limits.bytes) { budget = true; break; }
                        const body = history.query('SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?').get(native.id, item.turn_id, item.item_id);
                        bytes += stored.bytes;
                        const parsed = JSON.parse(body.item_json);
                        if (stored.item_type && parsed.type !== stored.item_type || parsed.type === 'agentMessage' && typeof parsed.text !== 'string'
                            || parsed.type === 'userMessage' && !Array.isArray(parsed.content)) throw unavailable();
                        const snippet = excerpt(searchableText(parsed), selected.query);
                        session.current.anchor ??= { turnId: item.turn_id, itemId: item.item_id, ordinal: item.rollout_ordinal, revision: item.updated_at_ordinal };
                        if (snippet !== undefined) { page.data.push({ threadId: thread.id, snippet }); matched = true; }
                    }
                    ++items; session.current.before = item.rollout_ordinal - 1;
                    if (matched || items >= this.limits.items || performance.now() - started >= this.limits.ms) break;
                    await yieldRead(undefined, { signal });
                }
                if (matched) { session.current = undefined; ++session.index; ++threads; }
                if (budget) break;
            }
            signal.throwIfAborted();
            assertCatalogCurrent(state, session, this.limits);
            // No body page or execution state is retained. A response advances
            // exactly one opaque continuation; a duplicate gets its old page.
            if (session.index < session.catalog.length) page.nextCursor = cursor(session.id, ++session.revision);
            session.lastInput = request.params.cursor; session.lastOutput = page;
            return page;
        } catch (error) {
            if (session) this.retire(session);
            signal.throwIfAborted();
            if (error instanceof NativeSearchError) throw error;
            if (error?.code === 'STALE_VERSION') throw changed();
            throw unavailable();
        } finally { if (session) session.busy = false; history?.close(); state?.close(); }
    }
    dispose() { for (const session of this.sessions.values()) this.retire(session); }
}
