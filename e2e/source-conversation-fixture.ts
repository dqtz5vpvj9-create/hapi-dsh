/** Synthetic source wire only. No private transcript, credentials, or real model execution.
 * Shape follows pinned HAPI nativeHistoryIndexed.ts materialize()/write():
 * real source IDs/localId, outer execution metadata, completed item snapshots,
 * and pagination by invokedAt/seq independently of item creation time. */
import type { HapiMessage, HapiMessagesPage } from '../src/codex/contracts.ts'
import type { NativeFixture } from './hapi-fixture.ts'

export function nativeIndexedHistory(threadId: string, turns = 180, steps = 25): HapiMessage[] {
    const rows: HapiMessage[] = []
    const start = 1_760_000_000_000
    for (let turn = 0; turn < turns; turn++) {
        const turnId = `synthetic-turn-${turn}`, at = start + turn * 60_000
        const execution = { threadId, turnId, turn: { status: 'completed', started: true, ended: true } }
        const append = (itemId: string, ordinal: number, role: 'user' | 'agent', content: unknown, localId: string): void => {
            rows.push({ id: `native:${threadId}:${turnId}:${itemId}:${encodeURIComponent(localId)}`, localId,
                seq: (turn * (steps + 1) + ordinal + 1) * 10_000 + 1, createdAt: at + ordinal * 100, invokedAt: at + ordinal * 100,
                scheduledAt: null, content: { role, content, meta: { sentFrom: 'cli', nativeExecution: { ...execution, itemId } } } })
        }
        append('input', 0, 'user', { type: 'text', text: `Synthetic original input ${turn + 1}.` }, `codex-native:${threadId}:${turnId}:input`)
        for (let step = 0; step < steps; step++) {
            const itemId = `item-${step}`, id = `codex:${threadId}:${turnId}:${itemId}:${step === steps - 1 ? 'agent_message' : 'agent_reasoning'}`
            const reasoning = step < steps - 1
            append(itemId, step + 1, 'agent', { type: 'codex', data: { type: reasoning ? 'reasoning' : 'message', id,
                message: reasoning ? `Synthetic reasoning ${turn + 1}.${step + 1}.` : `Synthetic final answer ${turn + 1}.`,
                ...(!reasoning ? { streamSnapshot: true } : {}), nativeExecution: { threadId, turnId, itemId,
                    ...(!reasoning ? { phase: 'final_answer' } : {}) } } }, id)
        }
    }
    return rows
}

/** Activate an actual bounded wire fixture instead of returning all rows for limit=200. */
export function useBoundedSourceHistory(fixture: NativeFixture): { readonly requests: string[] } {
    const requests: string[] = []
    fixture.readHistory = url => {
        requests.push(url.search)
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50)))
        const beforeSeq = url.searchParams.get('beforeSeq'), beforeAt = url.searchParams.get('beforeAt')
        const all = fixture.rows.filter(row => beforeSeq === null || beforeAt === null
            || (row.invokedAt ?? row.createdAt) < Number(beforeAt)
            || (row.invokedAt ?? row.createdAt) === Number(beforeAt) && row.seq! < Number(beforeSeq))
        const selected = all.slice(-limit), first = selected[0], last = selected.at(-1), head = fixture.rows.at(-1)
        const value: HapiMessagesPage = { messages: structuredClone(selected), page: {
            direction: beforeSeq === null ? 'latest' : 'before', limit, epoch: 1, reset: false,
            nextBeforeAt: first ? first.invokedAt ?? first.createdAt : null, nextBeforeSeq: first?.seq ?? null,
            nextAfterAt: last ? last.invokedAt ?? last.createdAt : null, nextAfterSeq: last?.seq ?? null,
            snapshotHeadAt: head ? head.invokedAt ?? head.createdAt : null, snapshotHeadSeq: head?.seq ?? null, hasMore: all.length > selected.length,
        } }
        return value
    }
    return { requests }
}
