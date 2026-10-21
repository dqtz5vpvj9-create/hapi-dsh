/**
 * Durable navigation into DSH's existing resource and tab registries.
 * This is layout data only: protocols, renderers, stores and disposal belong
 * to the official resources/sidebarRight services and their plugins.
 */
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

export type NavigationValue = null | boolean | number | string | NavigationValue[] | { [key: string]: NavigationValue }

export type DshPaneTarget =
    | { type: 'conversation' }
    | { type: 'resource'; address: string; kind?: string; params?: NavigationValue }
    | { type: 'tab'; kind: string; address?: string; params?: NavigationValue }
    | { type: 'panel'; panelId: string }

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, limit = 16_384): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/u.test(value)
}

/** Reject executable/non-JSON values before layout ever reaches another Client. */
export function parseNavigationValue(value: unknown, depth = 0): NavigationValue {
    if (depth > 16) throw new Error('Plugin view parameters are too deeply nested')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.length <= 65_536) return value
    if (Array.isArray(value) && value.length <= 2048) return value.map(item => parseNavigationValue(item, depth + 1))
    if (object(value) && Object.keys(value).length <= 2048) {
        const result: Record<string, NavigationValue> = {}
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid plugin view parameter name')
            result[key] = parseNavigationValue(item, depth + 1)
        }
        return result
    }
    throw new Error('Plugin view parameters must be finite JSON data')
}

/** Unknown registered kinds remain restorable when their plugin is installed later. */
export function parseDshPaneTarget(value: unknown): DshPaneTarget {
    if (!object(value)) throw new Error('Invalid DSH view destination')
    if (value.type === 'conversation') return { type: 'conversation' }
    if (value.type === 'panel' && text(value.panelId, 256)) return { type: 'panel', panelId: value.panelId }
    const params = value.params === undefined ? {} : { params: parseNavigationValue(value.params) }
    if (JSON.stringify(params).length > 131_072) throw new Error('Plugin view parameters are too large')
    if (value.type === 'resource') {
        if (!text(value.address)) throw new Error('Invalid DSH resource address')
        const address = new URL(value.address)
        if (address.protocol !== 'dsh-resource:' || !address.hostname || address.username || address.password) throw new Error('Expected an official dsh-resource address')
        if (value.kind !== undefined && !text(value.kind, 256)) throw new Error('Invalid DSH resource viewer kind')
        return { type: 'resource', address: value.address, ...(value.kind === undefined ? {} : { kind: value.kind }), ...params }
    }
    if (value.type === 'tab' && text(value.kind, 256)) {
        if (value.address !== undefined) {
            if (!text(value.address)) throw new Error('Invalid DSH page address')
            const address = new URL(value.address)
            if (address.protocol !== 'sidebar:' || address.hostname !== value.kind || address.username || address.password) throw new Error('Saved page address does not match its DSH tab kind')
        }
        return { type: 'tab', kind: value.kind, ...(value.address === undefined ? {} : { address: value.address }), ...params }
    }
    throw new Error('Invalid DSH view destination')
}

export function dshPaneTitle(target: DshPaneTarget): string {
    if (target.type === 'conversation') return 'Conversation'
    if (target.type === 'panel') return target.panelId
    if (target.type === 'tab') return target.kind
    const address = new URL(target.address)
    try { return decodeURIComponent(address.pathname.split('/').filter(Boolean).at(-1) ?? address.hostname) }
    catch { return address.hostname }
}

/** Rebind only the public file protocol's exact old Session scope; opaque plugin addresses stay untouched. */
export function rebindSessionFileTarget(target: DshPaneTarget, previousSessionId: string, nextSessionId: string): DshPaneTarget {
    if (target.type !== 'resource') return target
    const file = parseFileAddress(target.address)
    return file?.scope === 'session' && file.sessionId === previousSessionId
        ? { ...target, address: sessionFileAddress(nextSessionId, file.path) }
        : target
}
