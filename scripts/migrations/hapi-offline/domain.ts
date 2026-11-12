/** Shared offline object dispositions. These outputs are plans/recovery data, never runtime commands. */
import type { RecoveryPackage, RecoveryObject, RecoveryObjectIndex, SnapshotReader } from './common.ts'
export type MigrationDisposition = 'migrate' | 'archive' | 'offline-recovery' | 'replace' | 'delete'
export interface SelectedInput { inputId: string; kind: string }
export interface DomainOutput {
    key: string; inputId: string; disposition: MigrationDisposition; original: unknown
    converted?: unknown; reason?: string; target?: RecoveryObject['target']; unresolved?: boolean
}
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const originalKey = (...parts: Array<string | number | null>) => JSON.stringify(parts)
export async function jsonInput(snapshot: SnapshotReader, inputId: string): Promise<{ value: unknown; error: string | null }> {
    try { return { value: await snapshot.json(inputId), error: null } }
    catch { return { value: { rawInputId: inputId }, error: 'The selected input is not a supported JSON export. Original bytes remain available.' } }
}
export async function domainObject(recovery: RecoveryPackage, family: RecoveryObject['family'], output: DomainOutput): Promise<RecoveryObjectIndex> {
    return recovery.putObject({ family, id: output.key, inputId: output.inputId,
        state: output.unresolved ? 'unresolved' : output.target ? 'mapped' : 'preserved',
        value: { disposition: output.disposition, original: output.original, ...(output.converted === undefined ? {} : { converted: output.converted }) },
        ...(output.reason === undefined ? {} : { reason: output.reason }), ...(output.target === undefined ? {} : { target: output.target }) })
}
export async function domainReport(recovery: RecoveryPackage, family: RecoveryObject['family'], selected: readonly SelectedInput[], objects: readonly RecoveryObjectIndex[], blockers: readonly string[]): Promise<void> {
    if (!selected.length) throw new Error('Select at least one input for this domain stage.')
    await recovery.putObject({ family, id: originalKey('report', family), inputId: selected[0]!.inputId,
        state: blockers.length || objects.some(object => object.state === 'unresolved') ? 'unresolved' : 'preserved',
        value: { version: 1, family, inputs: selected.map(input => ({ ...input, version: recovery.request.snapshot.inputs.find(value => value.id === input.inputId)?.version ?? null })),
            counts: { objects: objects.length, mapped: objects.filter(object => object.state === 'mapped').length, unresolved: objects.filter(object => object.state === 'unresolved').length },
            blockers, productionCutoverPerformed: false, objects: objects.map(object => ({ id: object.id, state: object.state, file: object.file })) },
        ...(blockers.length ? { reason: blockers.join(' ') } : {}) })
}
