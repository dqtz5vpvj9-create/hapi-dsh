import type { NativeSettingChange, NativeSettings } from '../../client-api.ts'
import type { ObservedModelValue, ObservedSettingChange, ObservedSettings } from '../../hapi-agent/control-types.ts'

export interface PickerChoice<T> { value: T; label: string; detail?: string }
export interface PickerData {
    model: ObservedModelValue
    models: readonly PickerChoice<ObservedModelValue>[]
    effort: string | null
    efforts: readonly PickerChoice<string | null>[]
    permission: string | null
    permissions: readonly string[]
    fast: boolean
    fastAvailable: boolean
    editable: { model: boolean; effort: boolean; permission: boolean; fast: boolean }
    warnings: readonly string[]
}
export type PickerAction = { kind: 'model'; value: ObservedModelValue }
    | { kind: 'effort'; value: string | null } | { kind: 'permission'; value: string } | { kind: 'fast'; value: boolean }

/** Pi model values are compound source identities, never display labels. */
export function modelKey(value: ObservedModelValue): string {
    return value && typeof value === 'object' ? JSON.stringify([value.provider, value.modelId]) : JSON.stringify(value)
}
export function modelLabel(value: ObservedModelValue, choices: readonly PickerChoice<ObservedModelValue>[]): string | null {
    const known = choices.find(choice => modelKey(choice.value) === modelKey(value))
    return known?.label ?? (typeof value === 'string' ? value : value?.modelId ?? null)
}

export function nativePickerData(data: NativeSettings): PickerData {
    const model = data.models.find(row => row.id === data.values.model)
    const writable = !data.readOnly
    return {
        model: data.values.model, models: data.models.map(row => ({ value: row.id, label: row.name })),
        effort: data.values.reasoningEffort,
        efforts: model?.reasoningEfforts.length ? [{ value: null, label: 'Default' }, ...model.reasoningEfforts.map(value => ({ value, label: value }))] : [],
        permission: data.values.permissionMode, permissions: ['default', 'read-only', 'yolo'],
        fast: data.values.serviceTier === 'fast', fastAvailable: model?.serviceTiers.includes('fast') ?? false,
        editable: { model: writable && data.models.length > 0, effort: writable && Boolean(model?.reasoningEfforts.length),
            permission: writable, fast: writable && Boolean(model?.serviceTiers.includes('fast')) },
        warnings: data.warnings,
    }
}

export function observedPickerData(data: ObservedSettings): PickerData {
    const writable = !data.readOnly
    return {
        model: data.values.model,
        models: data.models.map(row => ({ value: row.value, label: row.label, ...(row.provider ? { detail: row.provider } : {}) })),
        effort: data.values.effort, efforts: data.efforts, permission: data.values.permission, permissions: data.permissions,
        fast: data.values.serviceTier === 'fast', fastAvailable: data.serviceTiers.includes('fast'),
        editable: { model: writable && data.editable.model && data.models.length > 0,
            effort: writable && data.editable.effort && data.efforts.length > 0,
            permission: writable && data.editable.permission && data.permissions.length > 0,
            fast: writable && data.editable.serviceTier && data.serviceTiers.includes('standard') && data.serviceTiers.includes('fast') },
        warnings: data.warnings,
    }
}

/** Recheck the latest capability snapshot at dispatch, including after a popup
 * has remained open while its source changes. Unknown values stay descriptive. */
export function validPickerAction(data: PickerData, action: PickerAction): boolean {
    if (!data.editable[action.kind]) return false
    if (action.kind === 'model') return data.models.some(row => modelKey(row.value) === modelKey(action.value))
    if (action.kind === 'effort') return data.efforts.some(row => row.value === action.value)
    if (action.kind === 'permission') return data.permissions.includes(action.value)
    return data.fastAvailable
}
export function nativePickerChange(data: PickerData, action: PickerAction): NativeSettingChange | undefined {
    if (!validPickerAction(data, action)) return undefined
    if (action.kind === 'model') return typeof action.value === 'string' ? { kind: 'model', value: action.value } : undefined
    if (action.kind === 'effort') return { kind: 'reasoningEffort', value: action.value }
    if (action.kind === 'fast') return { kind: 'serviceTier', value: action.value ? 'fast' : 'standard' }
    return action.value === 'default' || action.value === 'read-only' || action.value === 'yolo'
        ? { kind: 'permissionMode', value: action.value } : undefined
}
export function observedPickerChange(data: PickerData, action: PickerAction): ObservedSettingChange | undefined {
    if (!validPickerAction(data, action)) return undefined
    if (action.kind === 'fast') return { kind: 'serviceTier', value: action.value ? 'fast' : 'standard' }
    return action
}
