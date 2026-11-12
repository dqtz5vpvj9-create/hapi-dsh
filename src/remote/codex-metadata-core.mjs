/** Native sparse metadata queries, adapted from HAPI nativeHistoryMetadata.ts (AGPL-3.0-only).
 * Source: hapi commit 55166cf8d87814ccfb383b538a8e8c55283bed81.
 * This file runs unchanged on the native machine; no item body is read here. */
import { DatabaseSync } from 'node:sqlite';
import { globSync, statSync, opendirSync } from 'node:fs';
import { readRolloutHeader, resolveRolloutPath } from './codex-rollout.mjs';
import { basename, join } from 'node:path';
export class NativeMetadataUnavailable extends Error {
    retryable = true;
    constructor() { super('Native Codex history metadata is unavailable or not yet synchronized; retry the history read'); }
}
/** Distinct from an existing, unreadable or corrupt sparse index. Only a
 * source-confirmed, unmaterialized native thread may accept this absence. */
export class NativeMetadataIndexMissing extends NativeMetadataUnavailable {}

/** Private, bounded proof for already-unloaded catalog candidates. No bodies,
 * recursive home scan, or missing database is interpreted as an empty thread. */
export function readNativeLifecycles({ home, candidates }) {
    if (typeof home !== 'string' || !Array.isArray(candidates) || candidates.length > 32) throw new Error('Invalid lifecycle request');
    let db;
    try {
        db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
        const query = db.prepare('SELECT id FROM threads WHERE id = ?');
        const eligible = new Map(), folders = new Set([join(home, 'archived_sessions')]);
        for (const candidate of candidates) {
            const { threadId, createdAt } = candidate;
            if (typeof threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)
                || !Number.isSafeInteger(createdAt) || Math.abs(parseInt(threadId.replaceAll('-', '').slice(0, 12), 16) - createdAt * 1000) > 60_000) continue;
            if (query.get(threadId)) continue;
            eligible.set(threadId.toLowerCase(), threadId);
            // The native v7 creation clock bounds its dated rollout directory.
            // Include adjacent UTC days; unfamiliar layouts remain unknown.
            for (const offset of [-86400, 0, 86400]) {
                const day = new Date((createdAt + offset) * 1000).toISOString().slice(0, 10).split('-');
                folders.add(join(home, 'sessions', ...day));
            }
        }
        if (!eligible.size || folders.size > 16) return { absent: [] };
        let seen = 0;
        for (const path of folders) {
            let folder;
            try { folder = opendirSync(path); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            try {
                let entry;
                while ((entry = folder.readSync())) {
                    if (++seen > 20_000 || entry.isDirectory() || entry.isSymbolicLink()) return { absent: [] };
                    for (const [id] of eligible) if (entry.name.toLowerCase().includes(id)) eligible.delete(id);
                }
            } finally { folder.closeSync(); }
        }
        // A concurrent first input may have persisted while directories were read.
        return { absent: [...eligible.values()].filter(id => !query.get(id)) };
    } catch { return { absent: [] }; }
    finally { db?.close(); }
}
/** Read only the native sparse index. Never select item_json or replay rollouts. */
export function openNativeMetadata(home) {
    const path = join(home, 'thread_history_1.sqlite');
    let database;
    try { database = new DatabaseSync(path, { readOnly: true }); }
    catch (error) {
        if (statSync(path, { throwIfNoEntry: false }) === undefined) throw new NativeMetadataIndexMissing();
        throw error;
    }
    return { query: sql => database.prepare(sql), close: () => database.close() };
}
const TURN_COLUMNS = 'turn_id, status, started_at, completed_at, rollout_ordinal, rollout_end_ordinal';
const ITEM_COLUMNS = 'turn_id, item_id, rollout_ordinal, created_at_ms, started_at_ms, completed_at_ms, updated_at_ordinal';
/** Native execution replacement retains the public thread ID but stores the
 * current rollout projection under the execution suffix in its official path. */
export function nativeMetadataThreadId(threadId, rolloutPath) {
    const suffix = rolloutPath && basename(rolloutPath).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i);
    return suffix ? suffix[1] : threadId;
}
async function sessionHeader(path, threadId, options) {
    const metadata = JSON.parse(await readRolloutHeader(path, options));
    if (options?.allowLegacy && metadata.ordinal == null) metadata.ordinal = 0;
    if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadId || !Number.isSafeInteger(metadata.ordinal))
        throw new NativeMetadataUnavailable();
    return metadata;
}
/** Session headers define replacement cutovers and inherited fork ranges.
 * Read only these headers, never transcript lines or SQLite item bodies. */
export async function nativeMetadataGenerations(home, threadId, options = {}) {
    const ids = [];
    const cutovers = new Map();
    const paths = new Map();
    const ancestry = new Set();
    const visit = async (id, inheritedCutoff) => {
        options.signal?.throwIfAborted();
        if (ancestry.has(id))
            throw new NativeMetadataUnavailable();
        if (ancestry.size >= 128) throw new NativeMetadataUnavailable();
        ancestry.add(id);
        const logicalPaths = new Set([
            ...globSync(join(home, 'sessions', '*', '*', '*', `rollout-*-${id}*.jsonl{,.zst}`)),
            ...globSync(join(home, 'archived_sessions', '**', `rollout-*-${id}*.jsonl{,.zst}`)),
        ].map(path => path.replace(/\.zst$/, '')));
        if (logicalPaths.size > 128) throw new NativeMetadataUnavailable();
        const headers = [];
        for (const path of [...logicalPaths].sort()) {
            const actual = resolveRolloutPath(path) ?? path;
            const generationId = nativeMetadataThreadId(id, actual);
            headers.push({ id: generationId, header: await sessionHeader(actual, id, options) });
            paths.set(generationId, actual);
        }
        // A revert creates a replacement execution header with the reduced
        // inherited cutoff. The original fork header describes its old branch;
        // using it would expose parent items the native API no longer accepts.
        const parent = headers.at(-1)?.header.payload;
        // Older forks copied their inherited history into the child's rollout.
        // Only sparse forks with an explicit cutoff read the parent index; a
        // legacy fork must use its own index to avoid adding the parent's later branch.
        if (parent?.forked_from_id && parent.forked_from_ordinal_exclusive != null) {
            if (!Number.isSafeInteger(parent.forked_from_ordinal_exclusive))
                throw new NativeMetadataUnavailable();
            await visit(parent.forked_from_id, inheritedCutoff === undefined ? parent.forked_from_ordinal_exclusive : Math.min(parent.forked_from_ordinal_exclusive, inheritedCutoff));
        }
        const generations = [{ id, ordinal: 0 }, ...headers.filter(value => value.id !== id).map(value => ({ id: value.id, ordinal: value.header.ordinal }))];
        for (const [index, generation] of generations.entries()) {
            if (inheritedCutoff !== undefined && generation.ordinal >= inheritedCutoff)
                break;
            const next = generations[index + 1]?.ordinal;
            const cutoff = next === undefined ? inheritedCutoff : inheritedCutoff === undefined ? next : Math.min(next, inheritedCutoff);
            ids.push(generation.id);
            if (cutoff !== undefined)
                cutovers.set(generation.id, cutoff);
        }
        ancestry.delete(id);
    };
    await visit(threadId);
    return { ids, cutovers, paths };
}
export async function nativeMetadataThreadIds(home, threadId) {
    return (await nativeMetadataGenerations(home, threadId)).ids;
}
export async function nativeMetadataCutovers(home, threadId) {
    return (await nativeMetadataGenerations(home, threadId)).cutovers;
}
export class NativeHistoryMetadata {
    database;
    threadId;
    generations = [];
    interruptedWithoutEnd = new Set();
    /** The native API marks stale open turns interrupted without writing an end
     * event. Preserve that status without inventing a timestamp or ordinal. */
    setInterruptedWithoutEnd(turnIds) { this.interruptedWithoutEnd = turnIds; }
    get coordinates() { return this.generations.map(generation => `${generation.id}:${generation.offset}:${generation.cutoff ?? 'head'}`).join('|'); }
    constructor(database, threadId, aliases = [threadId], cutovers = new Map()) {
        this.database = database;
        this.threadId = threadId;
        let offset = 0;
        for (const id of aliases) {
            const generation = { id, offset, cutoff: cutovers.get(id) };
            this.generations.push(generation);
            const max = database.query(`SELECT MAX(value) AS ordinal FROM (
                SELECT MAX(rollout_ordinal) AS value FROM thread_items WHERE thread_id = ? ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`}
                UNION ALL SELECT MAX(rollout_end_ordinal) FROM thread_turns WHERE thread_id = ? ${generation.cutoff === undefined ? '' : `AND rollout_end_ordinal < ${generation.cutoff}`}
                UNION ALL SELECT MAX(rollout_ordinal) FROM thread_turns WHERE thread_id = ? ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`})`)
                .get(id, id, id);
            offset += (max.ordinal ?? 0) + 1;
        }
    }
    /** A newly created paginated thread is visible in state_5.sqlite before it
     * has a rollout file or sparse-history rows. That is a valid empty history. */
    isEmpty() {
        return this.generations.every(generation => {
            const row = this.database.query(`SELECT 1 AS present FROM thread_items WHERE thread_id = ?
                UNION ALL SELECT 1 FROM thread_turns WHERE thread_id = ? LIMIT 1`).get(generation.id, generation.id);
            return row == null;
        });
    }
    latest(table, key, values) {
        for (const generation of [...this.generations].reverse()) {
            const row = this.database.query(`SELECT ${table === 'thread_items' ? ITEM_COLUMNS : TURN_COLUMNS}
                FROM ${table} WHERE thread_id = ? AND ${key} ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`}`).get(generation.id, ...values);
            if (row)
                return this.shift(row, generation.offset);
        }
        return undefined;
    }
    shift(row, offset) {
        return { ...row, rollout_ordinal: row.rollout_ordinal + offset,
            ...('rollout_end_ordinal' in row ? { rollout_end_ordinal: row.rollout_end_ordinal == null ? null : row.rollout_end_ordinal + offset } : {}) };
    }
    positionAt(ordinal) {
        for (const generation of [...this.generations].reverse()) {
            if (ordinal < generation.offset)
                continue;
            const row = this.database.query(`SELECT started_at, completed_at FROM thread_turns WHERE thread_id = ?
                AND rollout_ordinal <= ? ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`} ORDER BY rollout_ordinal DESC LIMIT 1`).get(generation.id, ordinal - generation.offset);
            if (row && (row.started_at != null || row.completed_at != null))
                return (row.started_at ?? row.completed_at) * 1000;
        }
        throw new NativeMetadataUnavailable();
    }
    turn(turnId) {
        const row = this.latest('thread_turns', 'turn_id = ?', [turnId]);
        if (!row || !['inProgress', 'completed', 'interrupted', 'failed'].includes(row.status)
            || (row.started_at == null && row.completed_at == null) || !Number.isSafeInteger(row.rollout_ordinal)
            || (row.status !== 'inProgress' && !Number.isSafeInteger(row.rollout_end_ordinal)))
            throw new NativeMetadataUnavailable();
        return this.interruptedWithoutEnd.has(turnId) && row.status === 'inProgress'
            && row.completed_at === null && row.rollout_end_ordinal === null
            ? { ...row, status: 'interrupted' } : row;
    }
    /** Error metadata is read only for the failed turn currently being paged. */
    failure(turnId) {
        for (const generation of [...this.generations].reverse()) {
            const row = this.database.query(`SELECT error_json FROM thread_turns WHERE thread_id = ? AND turn_id = ?
                ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`}`)
                .get(generation.id, turnId);
            if (row)
                return row.error_json == null ? null : JSON.parse(row.error_json);
        }
        throw new NativeMetadataUnavailable();
    }
    item(turnId, itemId) {
        const row = this.latest('thread_items', 'turn_id = ? AND item_id = ?', [turnId, itemId]);
        if (!row || !Number.isSafeInteger(row.rollout_ordinal))
            throw new NativeMetadataUnavailable();
        return row;
    }
    /** One turn-prefix lookup per native generation; never enumerate thread bodies or earlier turns. */
    firstItem(turnId) {
        const rows = [];
        for (const [generationIndex, generation] of this.generations.entries()) {
            const newer = this.generations.slice(generationIndex + 1);
            const shadow = newer.length ? `AND NOT EXISTS (SELECT 1 FROM thread_items newer WHERE (${newer.map(value => `(newer.thread_id = ? ${value.cutoff === undefined ? '' : `AND newer.rollout_ordinal < ${value.cutoff}`})`).join(' OR ')}) AND newer.turn_id = thread_items.turn_id AND newer.item_id = thread_items.item_id)` : '';
            const row = this.database.query(`SELECT ${ITEM_COLUMNS} FROM thread_items WHERE thread_id = ? AND turn_id = ?
                ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`} ${shadow} ORDER BY rollout_ordinal ASC LIMIT 1`)
                .get(generation.id, turnId, ...newer.map(value => value.id));
            if (row) rows.push(this.shift(row, generation.offset));
        }
        return rows.sort((a, b) => a.rollout_ordinal - b.rollout_ordinal)[0];
    }
    predecessor(item) {
        // Scope to the selected execution; an old projection must not anchor a
        // body read into a different execution's duplicate item.
        const generation = [...this.generations].reverse().find(g => item.rollout_ordinal >= g.offset);
        const row = this.database.query(`SELECT ${ITEM_COLUMNS} FROM thread_items WHERE thread_id = ? AND turn_id = ?
            AND rollout_ordinal < ? ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`} ORDER BY rollout_ordinal DESC LIMIT 1`).get(generation.id, item.turn_id, item.rollout_ordinal - generation.offset);
        return row && this.shift(row, generation.offset);
    }
    page(table, boundary, direction, limit, userOnly = false) {
        const column = table === 'thread_items' ? 'rollout_ordinal' : 'rollout_end_ordinal';
        const rows = [];
        for (const [generationIndex, generation] of this.generations.entries()) {
            const newer = this.generations.slice(generationIndex + 1);
            const shadow = newer.length ? `AND NOT EXISTS (SELECT 1 FROM ${table} newer WHERE (${newer.map(value => `(newer.thread_id = ? ${value.cutoff === undefined ? '' : `AND newer.${column} < ${value.cutoff}`})`).join(' OR ')}) AND newer.turn_id = ${table}.turn_id ${table === 'thread_items' ? `AND newer.item_id = ${table}.item_id` : ''})` : '';
            const local = boundary - generation.offset;
            if (direction === 'desc' && local < 0)
                continue;
            const candidates = this.database.query(`SELECT ${table === 'thread_items' ? ITEM_COLUMNS : TURN_COLUMNS}
                FROM ${table} WHERE thread_id = ? AND ${column} ${direction === 'asc' ? '>=' : '<='} ?
                ${generation.cutoff === undefined ? '' : `AND ${column} < ${generation.cutoff}`} ${shadow} ${userOnly ? "AND item_type = 'userMessage'" : ''} ORDER BY ${column} ${direction} LIMIT ?`)
                .all(generation.id, local, ...newer.map(value => value.id), limit);
            for (const raw of candidates) {
                const row = this.shift(raw, generation.offset);
                rows.push(row);
            }
        }
        return rows.sort((a, b) => ((column === 'rollout_ordinal' ? a.rollout_ordinal : a.rollout_end_ordinal) - (column === 'rollout_ordinal' ? b.rollout_ordinal : b.rollout_end_ordinal)) * (direction === 'asc' ? 1 : -1)).slice(0, limit);
    }
    items(boundary, direction, limit = 33, userOnly = false) {
        return this.page('thread_items', boundary, direction, limit, userOnly);
    }
    turns(boundary, direction, limit = 33) {
        return this.page('thread_turns', boundary, direction, limit);
    }
}

/** Bounded keyset lookup in source-native order. Cursors are native ordinals. */
export async function readNativeMetadata(request) {
    const { home, threadId, before, after, around, limit = 160, userOnly = false, position, unmaterialized } = request;
    if (typeof home !== 'string' || typeof threadId !== 'string' || !threadId || threadId.includes('\0')
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
        || unmaterialized !== undefined && unmaterialized !== true
        || position !== undefined && (!position || typeof position.turnId !== 'string' || !position.turnId || position.turnId.includes('\0')
            || position.itemId !== undefined && (typeof position.itemId !== 'string' || !position.itemId || position.itemId.includes('\0')))
        || [before, after, around].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
        throw new Error('Invalid native metadata request');
    }
    let db;
    try { db = openNativeMetadata(home); }
    catch (error) {
        // The adapter obtained the exact native "not materialized yet" reply.
        // Reopen first: a concurrent first turn may already have made its real
        // index available. An existing rollout without an index is not empty.
        if (!(error instanceof NativeMetadataIndexMissing) || unmaterialized !== true) throw error;
        for (const directory of ['sessions', 'archived_sessions']) {
            if (globSync(join(home, directory, '**', `rollout-*-${threadId}*.jsonl{,.zst}`)).length) throw error;
        }
        return { items: [], turns: [], coordinates: `${threadId}:0:head`, first: null, last: null,
            hasBefore: false, hasAfter: false, ...(position ? { positionMissing: true } : {}) };
    }
    try {
        const generations = await nativeMetadataGenerations(home, threadId);
        db.query('BEGIN').get();
        const index = new NativeHistoryMetadata(db, threadId, generations.ids, generations.cutovers);
        const direction = after === undefined ? 'desc' : 'asc';
        const boundary = around ?? before ?? after ?? Number.MAX_SAFE_INTEGER;
        let positionMissing = false;
        let sources;
        if (position) {
            try {
                if (position.itemId !== undefined) {
                    const item = index.item(position.turnId, position.itemId);
                    sources = [{ kind: 'item', ordinal: item.rollout_ordinal, item }];
                } else {
                    const turn = index.turn(position.turnId);
                    const item = index.firstItem(position.turnId);
                    sources = item ? [{ kind: 'item', ordinal: item.rollout_ordinal, item }]
                        : [{ kind: 'turn', ordinal: turn.rollout_ordinal, turn }];
                }
            } catch (error) {
                if (!(error instanceof NativeMetadataUnavailable)) throw error;
                sources = []; positionMissing = true;
            }
        } else sources = [
            ...index.items(boundary, direction, limit + 1, userOnly).map(item => ({ kind: 'item', ordinal: item.rollout_ordinal, item })),
            ...(userOnly ? [] : index.turns(boundary, direction, limit + 1).map(turn => ({ kind: 'turn', ordinal: turn.rollout_end_ordinal, turn }))),
        ].sort((a, b) => (a.ordinal - b.ordinal) * (direction === 'asc' ? 1 : -1)).slice(0, limit);
        const items = sources.filter(source => source.kind === 'item').map(({ item }) => ({
            turnId: item.turn_id, itemId: item.item_id, ordinal: item.rollout_ordinal,
            startedAtMs: item.started_at_ms ?? item.created_at_ms, completedAtMs: item.completed_at_ms,
            revision: item.updated_at_ordinal, predecessorId: index.predecessor(item)?.item_id ?? null,
        }));
        const turnIds = [...new Set([...items.map(item => item.turnId), ...sources.filter(source => source.kind === 'turn').map(source => source.turn.turn_id)])];
        const turns = turnIds.map(turnId => {
            const turn = index.turn(turnId);
            return { id: turn.turn_id, status: turn.status, startedAt: turn.started_at, completedAt: turn.completed_at,
                ordinal: turn.rollout_ordinal, endOrdinal: turn.rollout_end_ordinal,
                ...(turn.status === 'failed' ? { error: index.failure(turnId) } : {}) };
        });
        const first = sources.length ? Math.min(...sources.map(source => source.ordinal)) : null;
        const last = sources.length ? Math.max(...sources.map(source => source.ordinal)) : null;
        const result = { items, turns, coordinates: index.coordinates, first, last, ...(position ? { positionMissing } : {}),
            hasBefore: first !== null && (index.items(first - 1, 'desc', 1).length > 0 || index.turns(first - 1, 'desc', 1).length > 0),
            hasAfter: last !== null && (index.items(last + 1, 'asc', 1).length > 0 || index.turns(last + 1, 'asc', 1).length > 0) };
        db.query('COMMIT').get();
        return result;
    } finally { db.close(); }
}
