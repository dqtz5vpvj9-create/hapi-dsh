export interface PickerChoice<T> { value: T; label: string; detail?: string }
export interface PickerData {
    model: string | null
    models: readonly PickerChoice<string | null>[]
    effort: string | null
    efforts: readonly PickerChoice<string | null>[]
    permission: string | null
    permissions: readonly string[]
    approvalPolicy?: string | null
    approvalPolicies?: readonly string[]
    readOnly: boolean
    serviceTier: string | null
    fast: boolean
    fastAvailable: boolean
    editable: { model: boolean; effort: boolean; permission: boolean; fast: boolean; approvalPolicy?: boolean }
    warnings: readonly string[]
}
export type PickerAction = { kind: 'model'; value: string | null }
    | { kind: 'effort'; value: string | null } | { kind: 'permission'; value: string } | { kind: 'fast'; value: boolean }
    | { kind: 'approvalPolicy'; value: string }
export type PickerChange = { kind: 'model'; value: string | null } | { kind: 'effort'; value: string | null }
    | { kind: 'permission'; value: string } | { kind: 'serviceTier'; value: string }
    | { kind: 'collaboration'; value: string }
    | { kind: 'approvalPolicy'; value: string }
export interface PickerPending { operationId: string; change: PickerChange }

/** An explicitly reported Medium is still explicit even when the model's
 * catalog default is Medium. Only an actual default/empty value is folded. */
export function explicitEffort(value: string | null): string | null {
    return value && value !== 'default' ? value : null
}
export function visibleServiceTier(value: string | null): string | null {
    return value && value !== 'standard' ? value : null
}
/** Capability belongs to the source; connection/read-only is a separate lock.
 * A locked but supported permission picker can still show the current value. */
export function permissionPickerAvailable(capable: boolean, data: PickerData | null): boolean {
    return capable && (data === null || data.permissions.length > 0 || !!data.approvalPolicies?.length)
}
/** Model identifiers are source values; labels never become operation values. */
export function modelKey(value: string | null): string { return JSON.stringify(value) }
export function modelLabel(value: string | null, choices: readonly PickerChoice<string | null>[]): string | null {
    return choices.find(choice => choice.value === value)?.label ?? value
}

/** Recheck the latest capability snapshot at dispatch, including after a popup
 * has remained open while its source changes. Unknown values stay descriptive. */
export function validPickerAction(data: PickerData, action: PickerAction): boolean {
    if (!data.editable[action.kind]) return false
    if (action.kind === 'model') return data.models.some(row => modelKey(row.value) === modelKey(action.value))
    if (action.kind === 'effort') return data.efforts.some(row => row.value === action.value)
    if (action.kind === 'permission') return data.permissions.includes(action.value)
    if (action.kind === 'approvalPolicy') return data.approvalPolicies?.includes(action.value) === true
    return data.fastAvailable
}
