/** Exact offline aliases use the authenticated application carrier, not HHPI v1. */
import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { appSourceRouteSchema } from './app-service-types.ts'
import { legacySourceReferenceSchema, recoveryReferenceSchema } from './source-aliases.ts'

export const sourceAliasRequestSchema = z.strictObject({ reference: legacySourceReferenceSchema })
export const sourceAliasResultSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('resolved'), source: appSourceRouteSchema, via: z.enum(['current', 'alias']), recovery: z.array(recoveryReferenceSchema) }),
    z.strictObject({ status: z.enum(['unmapped', 'ambiguous', 'unavailable']), recovery: z.array(recoveryReferenceSchema) }),
    z.strictObject({ status: z.enum(['denied', 'scope-invalid', 'aborted', 'invalid']) }),
])
export interface SourceAliasApi {
    resolve(request: z.infer<typeof sourceAliasRequestSchema>, signal?: AbortSignal): Promise<RemoteResult<z.infer<typeof sourceAliasResultSchema>>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { sourceAliases: SourceAliasApi }
    interface TypertRemoteMap { 'sourceAliases/resolve': SourceAliasApi['resolve'] }
}
export const SOURCE_ALIAS_REMOTE: TypertRemoteContribution = { package: 'hapi-dsh', descriptors: [{
    id: 'hapi-dsh#sourceAliases/resolve', service: 'sourceAliases', namespace: 'sourceAliases', method: 'resolve',
    invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
        mode: 'strict', typeSymbol: 'hapi-dsh#SourceAliasRequest', create: () => sourceAliasRequestSchema,
    } }],
    result: { mode: 'strict', typeSymbol: 'hapi-dsh#SourceAliasResult', create: () => sourceAliasResultSchema },
}] }
export const SOURCE_ALIAS_HOST_CONTRACT = { invocations: SOURCE_ALIAS_REMOTE.descriptors,
    services: [{ key: 'sourceAliases', exportName: 'SourceAliasService', tags: [], members: [], types: [], summary: 'Account-scoped exact offline source aliases.' }],
}
