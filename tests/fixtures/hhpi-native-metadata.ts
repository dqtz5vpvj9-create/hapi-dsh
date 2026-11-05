/** Explicit source metadata boundary for operation/image tests. Large-history
 * boundedness is tested separately against real native SQLite, not this fixture. */
import type { NativeItem, NativeItemEntry, NativeTurn } from '../../src/remote/codex-native.ts';
import type { NativeMetadataItem, NativeMetadataPage, NativeMetadataRequest, NativeMetadataTurn } from '../../src/remote/codex-metadata-core.mjs';

export function nativeMetadataFixture(snapshot: () => readonly { turn: NativeTurn; items: readonly NativeItem[] }[]) {
    const revisions = new Map<string, { body: string; revision: number }>();
    let revision = 0;
    return async (request: NativeMetadataRequest): Promise<NativeMetadataPage> => {
        let ordinal = 0;
        const turns: NativeMetadataTurn[] = [], items: NativeMetadataItem[] = [];
        const users = new Set<string>();
        for (const value of [...snapshot()].sort((a, b) => (a.turn.startedAt ?? 0) - (b.turn.startedAt ?? 0))) {
            const start = ++ordinal;
            let predecessor: string | null = null;
            for (const item of value.items) {
                const key = JSON.stringify([value.turn.id, item.id]), body = JSON.stringify(item);
                if (item.type === 'userMessage') users.add(key);
                const prior = revisions.get(key);
                if (prior?.body !== body) revisions.set(key, { body, revision: ++revision });
                items.push({ turnId: value.turn.id, itemId: item.id, ordinal: ++ordinal,
                    startedAtMs: (value.turn.startedAt ?? 0) * 1000, completedAtMs: value.turn.completedAt == null ? null : value.turn.completedAt * 1000,
                    revision: revisions.get(key)!.revision, predecessorId: predecessor });
                predecessor = item.id;
            }
            const end = value.turn.status === 'inProgress' ? null : ++ordinal;
            turns.push({ ...value.turn, startedAt: value.turn.startedAt ?? 0, completedAt: value.turn.completedAt ?? null, ordinal: start, endOrdinal: end });
        }
        const userOnly = 'userOnly' in request && request.userOnly === true;
        const all = [...items.filter(item => !userOnly || users.has(JSON.stringify([item.turnId, item.itemId]))).map(item => ({ ordinal: item.ordinal, item, turnId: item.turnId })),
            ...turns.flatMap(turn => userOnly || turn.endOrdinal === null ? [] : [{ ordinal: turn.endOrdinal, turnId: turn.id }])];
        const direction = request.after === undefined ? -1 : 1, boundary = request.around ?? request.before ?? request.after;
        const selected = all.filter(value => boundary === undefined || (direction === -1 ? value.ordinal <= boundary : value.ordinal >= boundary))
            .sort((a, b) => direction * (a.ordinal - b.ordinal)).slice(0, request.limit);
        const ids = new Set(selected.map(value => value.turnId)), positions = selected.map(value => value.ordinal);
        return { items: selected.flatMap(value => 'item' in value ? [value.item] : []), turns: turns.filter(turn => ids.has(turn.id)),
            hasBefore: positions.length > 0 && all.some(value => value.ordinal < Math.min(...positions)),
            hasAfter: positions.length > 0 && all.some(value => value.ordinal > Math.max(...positions)), coordinates: 'synthetic-native-positions-v1', first: positions.length ? Math.min(...positions) : null, last: positions.length ? Math.max(...positions) : null };
    };
}

export function sliceNativeEntries(entries: readonly NativeItemEntry[], params: Record<string, unknown>) {
    const cursor = params.cursor as { itemId: string } | undefined;
    const first = cursor ? entries.findIndex(entry => entry.item.id === cursor.itemId) + 1 : 0;
    const data = entries.slice(first, first + Number(params.limit ?? entries.length));
    return { data, nextCursor: null };
}
