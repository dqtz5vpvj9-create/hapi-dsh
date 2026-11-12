/** Opaque application links retain authenticated account/origin and exact stored source targets. */
import { remoteValue } from '../client-api.ts'
import { appScopeKey, appShareRecordSchema, type AppAccountScope, type AppShareTarget, type AppServiceApi } from '../workspace/app-service-types.ts'
import type { Context } from '@deepseek-ai/cordis'
export type AppShareApi = Pick<AppServiceApi, 'appShareCreate' | 'appShareResolve'>
export interface SourceSharing { create(target: AppShareTarget, signal: AbortSignal): Promise<string> }
declare module '@deepseek-ai/cordis' { interface Context { sourceSharing: SourceSharing } }
function sameScope(scope: AppAccountScope, other: AppAccountScope): void {
    if (appScopeKey(scope) !== appScopeKey(other)) throw new Error('This source share belongs to another authenticated account or application origin')
}
export function createSourceSharing(api: AppShareApi, scope: AppAccountScope, deviceId: string, base: string, lifetime: AbortSignal): SourceSharing {
    const address = new URL(base)
    if (address.origin !== scope.origin) throw new Error('Source links must use the authenticated application origin')
    return { async create(target, callerSignal) {
        const signal = AbortSignal.any([lifetime, callerSignal]); signal.throwIfAborted()
        const record = appShareRecordSchema.parse(remoteValue(await api.appShareCreate({ deviceId, target }, signal)))
        signal.throwIfAborted(); sameScope(scope, record.scope)
        const url = new URL('.', address); url.searchParams.set('hhpiShare', record.id)
        url.searchParams.set('hhpiShareAccount', scope.accountId); url.searchParams.set('hhpiShareOrigin', scope.origin)
        return url.href
    } }
}
/** Call after authentication; wrong-account/failed targets remain in the URL for an explicit retry. */
export async function resumeSourceShare(api: AppShareApi, scope: AppAccountScope, address: string,
    openTarget: (target: AppShareTarget, signal: AbortSignal) => void | Promise<void>, signal: AbortSignal): Promise<string | null> {
    const url = new URL(address), id = url.searchParams.get('hhpiShare')
    if (!id) return null
    sameScope(scope, { accountId: url.searchParams.get('hhpiShareAccount') ?? '', origin: url.searchParams.get('hhpiShareOrigin') ?? '' })
    if (url.origin !== scope.origin) throw new Error('Source links must use the authenticated application origin')
    signal.throwIfAborted()
    const record = appShareRecordSchema.parse(remoteValue(await api.appShareResolve({ shareId: id }, signal)))
    signal.throwIfAborted(); sameScope(scope, record.scope)
    await openTarget(record.target, signal); signal.throwIfAborted()
    for (const key of ['hhpiShare', 'hhpiShareAccount', 'hhpiShareOrigin']) url.searchParams.delete(key)
    return url.href
}
/** The caller owns the authenticated graph lifetime and destroys this capability on replacement. */
export function installSourceSharing(ctx: Context, sharing: SourceSharing): () => void { return ctx.reflect.provide('sourceSharing', sharing) }
