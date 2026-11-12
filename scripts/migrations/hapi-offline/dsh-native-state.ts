/** Source-local, read-only evidence for retiring a legacy DSH owner. Never enters SessionStore or opens a write handle. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply as applyJsonl } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subagent'

export function nativeOwnerExecutionState(events: readonly SessionEvent[]) {
    const turns = new Set<number>(), external = new Map<string, boolean>()
    const inbox = { 'next-turn': [] as string[], 'next-step': [] as string[] }
    for (const event of events) {
        const data = event.data as unknown as Record<string, unknown>
        if (event.type === 'turn/start' && typeof data.turn === 'number') turns.add(data.turn)
        else if (event.type === 'turn/end' && typeof data.turn === 'number') turns.delete(data.turn)
        else if (event.type === 'subagent/catalog' && data.mode === 'external' && typeof data.childId === 'string') external.set(data.childId, false)
        else if (event.type === 'agent/inbox/spliced') {
            const target = data.target
            if (target !== 'next-turn' && target !== 'next-step' || !Array.isArray(data.inserted)) throw new Error('Unsupported original inbox mutation')
            const start = data.start, removed = data.removedCount ?? 0
            if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > inbox[target].length || typeof removed !== 'number' || !Number.isSafeInteger(removed) || removed < 0 || start + removed > inbox[target].length) throw new Error('Invalid original inbox mutation')
            const ids = data.inserted.map(value => { if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Unsupported original inbox input'); return value.id })
            inbox[target].splice(start, removed, ...ids)
        }
        else if (event.type === 'user/message' && data.source && typeof data.source === 'object') {
            const source = data.source as Record<string, unknown>
            if (source.kind === 'subagent-settled' && typeof source.senderSessionId === 'string' && external.has(source.senderSessionId)) external.set(source.senderSessionId, true)
        }
    }
    const goalPhase = foldGoal(events).goal?.phase ?? null
    const pendingMessageIds = [...inbox['next-turn'], ...inbox['next-step']]
    return { openTurns: [...turns], goalPhase, pendingMessageIds, externalChildren: [...external].map(([id, settled]) => ({ id, settled })),
        idle: turns.size === 0 && pendingMessageIds.length === 0 && goalPhase !== 'active' && [...external.values()].every(Boolean) }
}

export async function readNativeOwnerState(root: string, nativeId: string) {
    const ctx = new Context()
    try {
        await applyJsonl(ctx, { root, compression: 'zstd' })
        const id = SessionId(nativeId), before = await ctx.sessionPersistence.stat(id)
        if (!before || before.header.id !== nativeId) throw new Error('Exact native session is unavailable')
        const handle = await ctx.sessionPersistence.open(id, 'read')
        try {
            const result = await handle.read(0, before.eventCount)
            const after = await ctx.sessionPersistence.stat(id)
            if (after?.revision !== before.revision) throw new Error('Native source changed while execution evidence was read')
            return { version: 1, nativeId, revision: before.revision, eventCount: result.events.length, ...nativeOwnerExecutionState(result.events) }
        } finally { await handle.close() }
    } finally { await ctx.fiber.dispose() }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
    const [root, nativeId] = process.argv.slice(2)
    if (!root || !nativeId) throw new Error('Expected the explicit source root and exact native session ID')
    process.stdout.write(JSON.stringify(await readNativeOwnerState(root, nativeId)) + '\n')
}
