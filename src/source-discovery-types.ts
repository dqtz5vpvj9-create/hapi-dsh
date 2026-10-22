/** Original HAPI identities discovered before a DSH display is ready. */
import { z } from 'zod'

const identity = z.string().min(1).max(512)
export const discoveredSourceSessionSchema = z.object({
    hubId: identity,
    sourceSessionId: identity,
    title: z.string(),
    engine: z.string().nullable(),
    machineId: identity.nullable(),
    machineName: z.string().nullable(),
    cwd: z.string().nullable(),
    nativeId: z.string().nullable(),
    updatedAt: z.number().finite(),
    active: z.boolean(),
    thinking: z.boolean(),
    lifecycleState: z.string().nullable(),
    summary: z.string().nullable(),
    worktree: z.object({ name: z.string(), basePath: z.string(), worktreePath: z.string().optional(), branch: z.string().optional() }).nullable(),
    subagentSearch: z.array(z.string()),
    pendingRequestsCount: z.number().int().nonnegative().nullable(),
    waitingOn: z.array(z.enum(['approval', 'input'])),
    binding: z.enum(['pending', 'attached', 'failed']),
    error: z.string().nullable(),
})
export const sourceDiscoverySchema = z.object({
    phase: z.enum(['pending', 'ready', 'stale', 'unavailable']),
    /** Last successful complete source summary list, not an attach timestamp. */
    observedAt: z.number().finite().nullable(),
    error: z.string().nullable(),
    sessions: z.array(discoveredSourceSessionSchema),
})
export type DiscoveredSourceSession = z.infer<typeof discoveredSourceSessionSchema>
export type SourceDiscovery = z.infer<typeof sourceDiscoverySchema>

/** A UI key only: it is never a display SessionId or a retain target. */
export const discoveredSourceKey = (source: Pick<DiscoveredSourceSession, 'hubId' | 'sourceSessionId'>): string =>
    JSON.stringify([source.hubId, source.sourceSessionId])
