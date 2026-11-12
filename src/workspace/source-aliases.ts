/** Finite, account-scoped aliases installed by offline migration. No Hub discovery or owner control. */
import { z } from 'zod'
import { appAccountScopeSchema, appSourceRouteSchema, type AppAccountScope, type AppSourceRoute } from './app-service-types.ts'

const id = z.string().min(1).max(2048).refine(value => !value.includes('\0'))
export const legacySourceReferenceSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('hapi-session'), hubId: id, sessionId: id, namespace: id.optional() }),
    z.strictObject({ kind: z.literal('hapi-display'), hostId: id, displayId: id }),
])
export type LegacySourceReference = z.infer<typeof legacySourceReferenceSchema>
export type SourceReference = AppSourceRoute | LegacySourceReference
export const recoveryReferenceSchema = z.strictObject({ packageId: id, family: z.enum(['sessions', 'files', 'terminals', 'application']), objectId: id })
export type RecoveryReference = z.infer<typeof recoveryReferenceSchema>
export const sourceAliasDocumentSchema = z.strictObject({
    version: z.literal(1), scope: appAccountScopeSchema,
    entries: z.array(z.strictObject({ legacy: legacySourceReferenceSchema, target: appSourceRouteSchema.nullable(), recovery: z.array(recoveryReferenceSchema).default([]) })),
})
export type SourceAliasDocument = z.infer<typeof sourceAliasDocumentSchema>

/** Both hooks must use the authenticated target Host/source, never the focused pane or old Hub. */
export interface SourceAliasPolicy {
    scope: AppAccountScope
    /** Captured account/connection generation remains current across every await. */
    current(): boolean
    authorize(source: AppSourceRoute, signal?: AbortSignal): Promise<boolean>
    /** Resolve only this complete route against the target's current source directory. */
    locate(source: AppSourceRoute, signal?: AbortSignal): Promise<AppSourceRoute | null>
}
export type SourceAliasResolution =
    | { status: 'resolved'; source: AppSourceRoute; via: 'current' | 'alias'; recovery: RecoveryReference[] }
    | { status: 'unmapped' | 'ambiguous' | 'unavailable'; recovery: RecoveryReference[] }
    | { status: 'denied' | 'scope-invalid' | 'aborted' | 'invalid' }

const sameScope = (a: AppAccountScope, b: AppAccountScope) => a.accountId === b.accountId && a.origin === b.origin
const legacyKey = (value: LegacySourceReference) => value.kind === 'hapi-session'
    ? JSON.stringify([value.kind, value.hubId, value.namespace ?? null, value.sessionId]) : JSON.stringify([value.kind, value.hostId, value.displayId])
const sourceKey = (value: AppSourceRoute) => JSON.stringify([value.kind, value.hostId, value.sessionId,
    ...(value.kind === 'hhpi' ? [value.identity.machineId, value.identity.sourceId, value.identity.engine, value.identity.nativeId] : [])])
const recoveryKey = (value: RecoveryReference) => JSON.stringify([value.packageId, value.family, value.objectId])

export class SourceAliasIndex {
    private readonly scope: AppAccountScope
    private readonly entries = new Map<string, SourceAliasDocument['entries']>()
    constructor(input: unknown, expectedScope: AppAccountScope) {
        const document = sourceAliasDocumentSchema.parse(input)
        this.scope = appAccountScopeSchema.parse(expectedScope)
        if (!sameScope(document.scope, this.scope)) throw new Error('The alias document belongs to another account or application origin.')
        for (const entry of document.entries) {
            const key = legacyKey(entry.legacy), previous = this.entries.get(key) ?? []
            previous.push(entry); this.entries.set(key, previous)
        }
    }
    /** Recovery references identify private archive objects; they are never file or source access grants. */
    async resolve(input: unknown, policy: SourceAliasPolicy, signal?: AbortSignal): Promise<SourceAliasResolution> {
        const guard = (): SourceAliasResolution | null => signal?.aborted ? { status: 'aborted' }
            : !sameScope(this.scope, policy.scope) || !policy.current() ? { status: 'scope-invalid' } : null
        const stopped = guard(); if (stopped) return stopped
        const current = appSourceRouteSchema.safeParse(input), legacy = legacySourceReferenceSchema.safeParse(input)
        let source: AppSourceRoute, via: 'current' | 'alias', recovery: RecoveryReference[] = []
        if (current.success) { source = current.data; via = 'current' }
        else if (legacy.success) {
            const entries = this.entries.get(legacyKey(legacy.data)) ?? []
            recovery = [...new Map(entries.flatMap(entry => entry.recovery).map(value => [recoveryKey(value), value])).values()]
                .map(value => ({ ...value }))
            const targets = new Map(entries.filter(entry => entry.target !== null).map(entry => [sourceKey(entry.target!), entry.target!]))
            if (!targets.size) return { status: 'unmapped', recovery }
            if (targets.size > 1) return { status: 'ambiguous', recovery }
            source = appSourceRouteSchema.parse([...targets.values()][0]); via = 'alias'
        } else return { status: 'invalid' }
        let authorized = false
        try {
            authorized = await policy.authorize(appSourceRouteSchema.parse(source), signal)
            const afterAuthorization = guard(); if (afterAuthorization) return afterAuthorization
            if (!authorized) return { status: 'denied' }
            const located = await policy.locate(appSourceRouteSchema.parse(source), signal)
            const afterLocation = guard(); if (afterLocation) return afterLocation
            const stillAuthorized = await policy.authorize(appSourceRouteSchema.parse(source), signal)
            const afterRecheck = guard(); if (afterRecheck) return afterRecheck
            if (!stillAuthorized) return { status: 'denied' }
            const parsed = appSourceRouteSchema.safeParse(located)
            if (!parsed.success || sourceKey(parsed.data) !== sourceKey(source)) return { status: 'unavailable', recovery }
            return { status: 'resolved', source: parsed.data, via, recovery }
        } catch {
            return guard() ?? { status: 'unavailable', recovery: authorized ? recovery : [] }
        }
    }
}
