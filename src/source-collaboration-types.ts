/** Source: HAPI 0f8ef697 shared/src/{schemas,workGraph}.ts (AGPL-3.0-only). */
import { z } from 'zod';
export const sourceTeamSchema = z.object({
    teamName: z.string(), description: z.string().optional(),
    members: z.array(z.object({ name: z.string(), agentType: z.string().optional(), status: z.enum(['active', 'idle', 'shutdown']).optional() })).optional(),
    tasks: z.array(z.object({ id: z.string(), title: z.string(), description: z.string().optional(), status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(), owner: z.string().optional() })).optional(),
    messages: z.array(z.object({ from: z.string(), to: z.string(), summary: z.string(), type: z.enum(['message', 'broadcast', 'shutdown_request', 'shutdown_response']), timestamp: z.number() })).optional(),
    updatedAt: z.number().optional(),
});
export type SourceTeam = z.infer<typeof sourceTeamSchema>;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function sourceTeamProjection(value: unknown): { team: SourceTeam | null; teamRevision: number | null; teamError: string | null } {
    const session = object(value), raw = session?.teamState, revision = session?.teamStateUpdatedAt;
    if (raw === undefined || raw === null) return { team: null, teamRevision: typeof revision === 'number' ? revision : null, teamError: null };
    const team = sourceTeamSchema.safeParse(raw);
    return { team: team.success ? team.data : null, teamRevision: typeof revision === 'number' ? revision : null,
        teamError: team.success ? null : 'The original team state uses an unsupported format. Its source data has not been changed.' };
}

/** HAPI's todos/team watermarks are independent from metadata and agentState.
 * A late full REST snapshot must not resurrect state cleared by a newer one. */
export function acceptSourceStructuredState(previousValue: unknown, nextValue: unknown): Record<string, unknown> {
    const previous = object(previousValue), next = object(nextValue), retained: Record<string, unknown> = {};
    for (const [field, watermark] of [['teamState', 'teamStateUpdatedAt'], ['todos', 'todosUpdatedAt']] as const) {
        const before = previous?.[watermark], after = next?.[watermark];
        if (typeof before === 'number' && Number.isFinite(before)
            && (typeof after !== 'number' || !Number.isFinite(after) || after <= before)) {
            retained[field] = previous?.[field] ?? (field === 'todos' ? [] : null);
            retained[watermark] = before;
        }
    }
    return retained;
}
const id = z.string().min(1).max(512);
const principal = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('human'), id: z.string() }),
    z.object({ kind: z.enum(['agent', 'service']), id: z.string(), on_behalf_of: z.string() }),
]);
export const sourceWorkEventSchema = z.object({
    id, ts: z.number(), sourceKind: z.string(), sourceRef: z.string(), sinkKind: z.string().nullable(), sinkRef: z.string().nullable(), eventType: z.string(), summary: z.string().nullable(),
    payloadJson: z.json().nullable(), artifactRefs: z.array(z.object({ kind: z.string(), url: z.string().optional(), title: z.string().optional(), ref: z.string().nullable().optional(), source: z.string().optional(), created_at: z.number().optional() })),
    tags: z.array(z.string()), relatedSessionId: z.string().nullable(), relatedEventId: z.string().nullable(), provenance: z.string().nullable(),
    idempotencyKey: z.string().nullable(), dedupeKey: z.string().nullable(), confidence: z.number().nullable(), severity: z.string().nullable(), expiresAt: z.number().nullable(), principal,
});
export type SourceWorkEvent = z.infer<typeof sourceWorkEventSchema>;
export const sourceWorkLinkSchema = z.object({ id, fromEventId: id, toEventId: id, relationType: z.string(), createdAt: z.number(), metadataJson: z.json().nullable() });
export type SourceWorkLink = z.infer<typeof sourceWorkLinkSchema>;
