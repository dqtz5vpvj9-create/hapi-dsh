/** Private, offline recovery format. No product runtime imports this module. */
import { z } from 'zod'
import { appSourceRouteSchema, type AppSourceRoute } from '../../../src/workspace/app-service-types.ts'
const id = z.string().min(1).max(2048).refine(value => !value.includes('\0'))
export const snapshotInputSchema = z.strictObject({ id, path: id, format: z.enum(['json', 'jsonl', 'sqlite-backup', 'binary']), version: id })
export const snapshotSchema = z.strictObject({ id, root: id, inputs: z.array(snapshotInputSchema) })
export const offlineRequestSchema = z.strictObject({ version: z.literal(1), packageId: id, scope: id, snapshot: snapshotSchema,
    requiredStages: z.array(z.strictObject({ id, version: id })).default([]) }).refine(value => new Set(value.requiredStages.map(stage => stage.id)).size === value.requiredStages.length,
    'Migration stage IDs must be unique.')
export type SnapshotInput = z.infer<typeof snapshotInputSchema>
export type OfflineRequest = z.infer<typeof offlineRequestSchema>
export interface NativeLocator { machineId: string; engine: string; nativeId: string; sourceId?: string }
export interface ExactTarget { identity: NativeLocator; target: AppSourceRoute }
export type ExactIdentityMatch = { status: 'matched'; target: AppSourceRoute } | { status: 'unmapped' } | { status: 'ambiguous'; candidates: readonly AppSourceRoute[] }
export interface RecoveryObject {
    /** Stable original key, including its old Hub/namespace when necessary. */
    id: string; family: 'sessions' | 'files' | 'terminals' | 'application'; inputId: string
    state: 'preserved' | 'mapped' | 'unresolved'; value: unknown
    target?: AppSourceRoute; reason?: string
}
export const recoveryObjectSchema = z.strictObject({ id, family: z.enum(['sessions', 'files', 'terminals', 'application']), inputId: id,
    state: z.enum(['preserved', 'mapped', 'unresolved']), value: z.json(), target: appSourceRouteSchema.optional(), reason: z.string().optional() })
    .refine(value => value.state !== 'mapped' || value.target !== undefined, 'A mapped object requires an exact current target.')
export interface RecoveryInputIndex { id: string; file: string; format: SnapshotInput['format']; version: string; bytes: number; originalPath: string }
export interface RecoveryObjectIndex { id: string; family: RecoveryObject['family']; inputId: string; state: RecoveryObject['state']; file: string; target?: AppSourceRoute; reason?: string }
export interface RecoveryIndex {
    version: 1; packageId: string; snapshotId: string; scope: string; status: 'preserved' | 'incomplete' | 'needs-review' | 'complete'
    inputs: RecoveryInputIndex[]; objects: RecoveryObjectIndex[]; unresolved: number
    stages: Array<{ id: string; version: string; state: 'pending' | 'running' | 'failed' | 'complete'; error: string | null }>
}
