/** Preserve imported HAPI v2 identities while routing through a normal DSH tab.
 * No terminal emulator or source transport is owned by the workspace renderer. */
import { z } from 'zod'
import type { PaneResource } from './model.ts'
import type { DshPaneTarget } from '../workspace/dsh-view.ts'
import { parseSessionResourceId } from './controller.ts'

export const LEGACY_TERMINAL_TAB_KIND = 'hapi-legacy-terminal'
export const LEGACY_TERMINAL_SEAT_ID = 'hapi-dsh/legacy-session-terminal'
const identity = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value))
export const legacyTerminalParamsSchema = z.strictObject({
    terminalId: identity,
    sourceSessionId: identity.optional(),
    sourceHubId: identity.optional(),
})
export type LegacyTerminalParams = z.infer<typeof legacyTerminalParamsSchema>
const addressIdentity = z.tuple([z.literal(1), z.enum(['source', 'display']), identity.nullable(), identity, identity])
const oldAddressIdentity = z.tuple([identity.nullable(), identity, identity])
const addressSchema = z.union([addressIdentity, oldAddressIdentity])

function readAddress(address: string): z.infer<typeof addressSchema> {
    const prefix = `sidebar://${LEGACY_TERMINAL_TAB_KIND}/`
    if (typeof address !== 'string' || address.length > 16_384 || !address.startsWith(prefix)
        || /[\u0000-\u0020\u007f?#]/u.test(address)) throw new Error('The saved legacy terminal address is invalid')
    try {
        const url = new URL(address)
        if (url.protocol !== 'sidebar:' || url.hostname !== LEGACY_TERMINAL_TAB_KIND || url.username || url.password
            || url.port || url.search || url.hash || !/^\/[^/]+$/u.test(url.pathname)) throw new Error('Invalid address')
        return addressSchema.parse(JSON.parse(decodeURIComponent(url.pathname.slice(1))))
    } catch { throw new Error('The saved legacy terminal address is invalid') }
}

/** The tab registry checks syntax; the body also checks its actual Session. */
export function canOpenLegacyTerminalAddress(address: string): boolean {
    try { readAddress(address); return true } catch { return false }
}

/** Official tab persistence retains contentId but may reconstruct params as
 * undefined. Only our versioned public address can then recover the binding.
 * Present parameters must remain valid and agree with that same identity. */
export function legacyTerminalNavigationParams(navigation: { address: string; params?: unknown }, displaySessionId: string): LegacyTerminalParams {
    const supplied = navigation.params === undefined ? undefined : legacyTerminalParamsSchema.safeParse(navigation.params)
    if (supplied && !supplied.success) throw new Error('The saved legacy terminal parameters are invalid')
    const address = readAddress(navigation.address)
    if (address.length === 3) {
        // This unpublished earlier format did not distinguish source from
        // display IDs. Never infer that distinction after params were lost.
        if (!supplied?.success) throw new Error('The earlier legacy terminal address needs its saved source parameters')
        const params = supplied.data
        if (address[0] !== (params.sourceHubId ?? null) || address[1] !== (params.sourceSessionId ?? displaySessionId)
            || address[2] !== params.terminalId) throw new Error('The saved legacy terminal parameters do not match its address')
        return params
    }
    const [, binding, hubId, boundId, terminalId] = address
    if (binding === 'display' && boundId !== displaySessionId) throw new Error('The saved legacy terminal belongs to another display Session')
    const recovered: LegacyTerminalParams = { terminalId,
        ...(hubId === null ? {} : { sourceHubId: hubId }), ...(binding === 'source' ? { sourceSessionId: boundId } : {}),
    }
    if (!supplied) return recovered
    if (supplied.data.terminalId !== recovered.terminalId || supplied.data.sourceHubId !== recovered.sourceHubId
        || supplied.data.sourceSessionId !== recovered.sourceSessionId) throw new Error('The saved legacy terminal parameters do not match its address')
    return supplied.data
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
    interface SidebarRightTabParamsMap { 'hapi-legacy-terminal': LegacyTerminalParams }
}

/** Layout remains the original terminal resource. This is derived navigation,
 * not an adoption into the newer machine TerminalHost identity namespace. */
export function legacyTerminalPaneTarget(resource: Extract<PaneResource, { kind: 'terminal' }>): Extract<DshPaneTarget, { type: 'tab' }> & { address: string } {
    const params = legacyTerminalParamsSchema.parse({ terminalId: resource.terminalId,
        ...(resource.sourceSessionId === undefined ? {} : { sourceSessionId: resource.sourceSessionId }),
        ...(resource.sourceHubId === undefined ? {} : { sourceHubId: resource.sourceHubId }),
    })
    const key = encodeURIComponent(JSON.stringify([1, params.sourceSessionId === undefined ? 'display' : 'source',
        params.sourceHubId ?? null, params.sourceSessionId ?? identity.parse(parseSessionResourceId(resource.sessionId).sessionId), params.terminalId]))
    return { type: 'tab', kind: LEGACY_TERMINAL_TAB_KIND, address: `sidebar://${LEGACY_TERMINAL_TAB_KIND}/${key}`, params: {
        terminalId: params.terminalId,
        ...(params.sourceSessionId === undefined ? {} : { sourceSessionId: params.sourceSessionId }),
        ...(params.sourceHubId === undefined ? {} : { sourceHubId: params.sourceHubId }),
    } }
}
