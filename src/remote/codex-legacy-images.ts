/** Import only selected immutable image references from a previous projection.
 * Native identity/order and current bodies always come from the current source. */
import { DatabaseSync } from 'node:sqlite';
import { retainedNativeImageCache } from './codex-attachments.ts';
import { isRecord, nativeItemSchema, type NativeItemEntry, type NativeThread } from './codex-native.ts';
import type { SourceEventIndex } from './event-index.ts';
import type { SourceSession } from './protocol.ts';

export function retainSelectedLegacyImages(paths: readonly string[], index: SourceEventIndex, session: SourceSession,
    thread: NativeThread, items: readonly NativeItemEntry[]): void {
    if (!items.some(({ item }) => item.type === 'imageView' || item.type === 'imageGeneration' || item.type === 'userMessage')) return;
    for (const path of paths) {
        let db: DatabaseSync | undefined;
        try {
            db = new DatabaseSync(path, { readOnly: true });
            const get = (key: string): unknown => {
                const row = db!.prepare('SELECT value FROM native_cache WHERE key=?').get(key);
                return row ? JSON.parse(String(row.value)) : undefined;
            };
            const saved = JSON.parse(String(db.prepare("SELECT value FROM metadata WHERE key='session'").get()?.value)) as SourceSession;
            if (['id', 'machineId', 'sourceId', 'engine', 'nativeId'].some(field => saved[field as keyof SourceSession] !== session[field as keyof SourceSession])) continue;
            const checkpoint = get('native-history-checkpoint:v1');
            if (!isRecord(checkpoint) || checkpoint.version !== 1 || checkpoint.state !== 'complete'
                || checkpoint.updatedAt !== thread.updatedAt || checkpoint.statusType !== thread.status.type) continue;
            const candidates = new Map<string, unknown>(), previousItems: NativeItemEntry[] = [];
            for (const { turnId, item } of items) {
                const state = get(JSON.stringify(['item', turnId, item.id]));
                if (!isRecord(state) || state.turnId !== turnId) continue;
                const previous = nativeItemSchema.safeParse(state.item);
                if (!previous.success || previous.data.id !== item.id) continue;
                previousItems.push({ turnId, item: previous.data });
                const key = JSON.stringify(['codex-image-content', turnId, item.id]);
                const prepared = get(key);
                if (!isRecord(prepared) || !Array.isArray(prepared.content)) continue;
                candidates.set(key, prepared);
                for (const block of prepared.content) if (isRecord(block) && block.type === 'image' && isRecord(block.attachment)
                    && typeof block.attachment.attachmentId === 'string') {
                    const grant = `codex-image-grants:${block.attachment.attachmentId}`;
                    candidates.set(grant, get(grant));
                }
            }
            const accepted = retainedNativeImageCache(retainedNativeImageCache(candidates, previousItems), items);
            if (accepted.size) index.edit(session, () => {
                for (const [key, value] of accepted) {
                    if (key.startsWith('codex-image-grants:')) {
                        const prior = index.cached<unknown[]>(key) ?? [];
                        index.cache(key, [...prior, ...(value as unknown[]).filter(grant => !prior.some(existing => JSON.stringify(existing) === JSON.stringify(grant)))]);
                    } else if (index.cached(key) === undefined) index.cache(key, value);
                }
            });
        } catch { /* An absent or obsolete display cache never blocks a native page. */ }
        finally { db?.close(); }
    }
}
