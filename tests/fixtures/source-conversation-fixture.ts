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

interface SourcePosition { at: number; seq: number }
function sourcePosition(row: HapiMessage): SourcePosition {
    return { at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0 }
}
function compareSourcePosition(left: SourcePosition, right: SourcePosition): number {
    return left.at - right.at || left.seq - right.seq
}
function sourceCursor(url: URL, atKey: string, seqKey: string): SourcePosition | null {
    const at = url.searchParams.get(atKey), seq = url.searchParams.get(seqKey)
    if (at === null || seq === null) return null
    return { at: Number(at), seq: Number(seq) }
}
function boundedSourcePage(direction: 'latest' | 'before' | 'after', selected: HapiMessage[], limit: number,
    epoch: number, reset: boolean, cursors: { before: SourcePosition | null; after: SourcePosition | null;
        snapshotHead: SourcePosition | null }, hasMore: boolean): HapiMessagesPage {
    return { messages: structuredClone(selected), page: {
        direction, limit, epoch, reset,
        nextBeforeAt: cursors.before?.at ?? null, nextBeforeSeq: cursors.before?.seq ?? null,
        nextAfterAt: cursors.after?.at ?? null, nextAfterSeq: cursors.after?.seq ?? null,
        snapshotHeadAt: cursors.snapshotHead?.at ?? null, snapshotHeadSeq: cursors.snapshotHead?.seq ?? null,
        hasMore,
    } }
}

/** Activate an actual bounded wire fixture instead of returning all rows for limit=200.
 * Supports strict before/after/until positions and stale-epoch reset. The current
 * epoch is shared with the outline/context routes through fixture.sourceWindow. */
export interface BoundedSourceHistory {
    readonly requests: string[]
    /** Current wire epoch; mutate to simulate a real source reset. */
    epoch: number
}
export function useBoundedSourceHistory(fixture: NativeFixture): BoundedSourceHistory {
    const requests: string[] = []
    fixture.sourceWindow ??= { epoch: 1, complete: true }
    fixture.readHistory = url => {
        requests.push(url.search)
        const limitValue = Number(url.searchParams.get('limit') ?? 50)
        const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(200, Math.trunc(limitValue))) : 50
        const epochText = url.searchParams.get('epoch')
        const requestedEpoch = epochText === null ? undefined : Number(epochText)
        const reset = requestedEpoch !== undefined && Number.isInteger(requestedEpoch)
            && requestedEpoch !== fixture.sourceWindow!.epoch
        const ordered = [...fixture.rows].sort((left, right) => compareSourcePosition(sourcePosition(left), sourcePosition(right)))
        const head = ordered.at(-1), headPosition = head ? sourcePosition(head) : null
        const before = sourceCursor(url, 'beforeAt', 'beforeSeq')
        const after = sourceCursor(url, 'afterAt', 'afterSeq')
        const until = sourceCursor(url, 'untilAt', 'untilSeq')
        if (reset) {
            const selected = ordered.slice(-limit), first = selected[0]
            return boundedSourcePage('latest', selected, limit, fixture.sourceWindow!.epoch, true, {
                before: first ? sourcePosition(first) : null, after: null, snapshotHead: headPosition,
            }, ordered.length > selected.length)
        }
        if (after !== null) {
            const snapshotHead = until !== null && headPosition !== null && compareSourcePosition(until, headPosition) <= 0
                ? until : headPosition
            if (snapshotHead === null || compareSourcePosition(snapshotHead, after) <= 0) {
                return boundedSourcePage('after', [], limit, fixture.sourceWindow!.epoch, false, {
                    before: null, after, snapshotHead,
                }, false)
            }
            const newer = ordered.filter(row => {
                const position = sourcePosition(row)
                return compareSourcePosition(position, after) > 0
                    && compareSourcePosition(position, snapshotHead) <= 0
            })
            const selected = newer.slice(0, limit), last = selected.at(-1)
            return boundedSourcePage('after', selected, limit, fixture.sourceWindow!.epoch, false, {
                before: null, after: last ? sourcePosition(last) : snapshotHead, snapshotHead,
            }, last !== undefined && compareSourcePosition(sourcePosition(last), snapshotHead) < 0)
        }
        if (before !== null) {
            const older = ordered.filter(row => compareSourcePosition(sourcePosition(row), before) < 0)
            const selected = older.slice(-limit), first = selected[0]
            return boundedSourcePage('before', selected, limit, fixture.sourceWindow!.epoch, false, {
                before: first ? sourcePosition(first) : null, after: null, snapshotHead: headPosition,
            }, older.length > selected.length)
        }
        const pool = until === null ? ordered : ordered.filter(row => compareSourcePosition(sourcePosition(row), until) <= 0)
        const selected = pool.slice(-limit), first = selected[0]
        return boundedSourcePage('latest', selected, limit, fixture.sourceWindow!.epoch, false, {
            before: first ? sourcePosition(first) : null, after: null, snapshotHead: headPosition,
        }, pool.length > selected.length)
    }
    return { requests, get epoch() { return fixture.sourceWindow!.epoch }, set epoch(value: number) { fixture.sourceWindow!.epoch = value } }
}
