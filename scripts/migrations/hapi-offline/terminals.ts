/** X3: snapshot terminal identities/output and record exit blockers. No PTY or subprocess API is imported. */
import { z } from 'zod'
import type { OfflineStage } from './index.ts'
import type { RecoveryObjectIndex } from './common.ts'
import { domainObject, domainReport, isRecord, jsonInput, originalKey } from './domain.ts'

const id = z.string().min(1), number = z.number().int().nonnegative()
const legacySource = z.strictObject({ sourceHubId: id, sourceSessionId: id, machineId: id })
/** Explicitly collected process evidence; a close-request registry is not this evidence. */
export const terminalExitEvidenceSchema = z.strictObject({ version: z.literal(1), records: z.array(z.strictObject({
    source: legacySource, terminalId: id, ownerId: id, pid: z.number().int().positive(), processBirthId: id,
    state: z.enum(['running', 'exited']), observedAt: number, exitCode: z.number().int().nullable(),
})) })
/** Frozen from machine-terminals.ts machineTerminalInfoSchema, not imported from its Socket.IO owner. */
const machineInfo = z.object({ terminalId: id, title: z.string(), cwd: z.string(), pid: z.number().int().nullable(), createdAt: z.number(), endedAt: z.number().nullable(),
    status: z.enum(['starting', 'running', 'closing', 'exited', 'lost']), exitCode: z.number().int().nullable(), cols: z.number().int().min(2), rows: z.number().int().positive(),
    seq: number, controllerId: id.nullable(), controlVersion: number })
export interface TerminalMigrationInput {
    inputId: string
    kind: 'closed-registry' | 'machine-inventory' | 'machine-replay' | 'legacy-state' | 'legacy-text' | 'native-text' | 'process-evidence'
    /** Required for machine exports, whose original payload does not carry the source. Never infer a hashed prefix. */
    source?: z.infer<typeof legacySource>
}
export function createTerminalsStage(inputs: readonly TerminalMigrationInput[]): OfflineStage {
    return { id: 'terminals', version: '1', configuration: { inputs }, async run({ snapshot, recovery }) {
        const outputs: RecoveryObjectIndex[] = [], blockers: string[] = []
        const evidence: z.infer<typeof terminalExitEvidenceSchema>['records'] = []
        for (const input of inputs.filter(value => value.kind === 'process-evidence')) {
            const raw = await jsonInput(snapshot, input.inputId), parsed = terminalExitEvidenceSchema.safeParse(raw.value)
            if (parsed.success) evidence.push(...parsed.data.records)
            outputs.push(await domainObject(recovery, 'terminals', { key: originalKey(input.inputId, 'evidence'), inputId: input.inputId,
                disposition: parsed.success ? 'archive' : 'offline-recovery', original: raw.value, unresolved: !parsed.success,
                ...(!parsed.success ? { reason: raw.error ?? 'Unsupported terminal owner/process evidence; no exit is inferred.' } : {}) }))
        }
        let inventories = 0
        for (const input of inputs.filter(value => value.kind !== 'process-evidence')) {
            const raw = await jsonInput(snapshot, input.inputId)
            if (raw.error || !isRecord(raw.value) && !Array.isArray(raw.value)) {
                outputs.push(await domainObject(recovery, 'terminals', { key: originalKey(input.inputId, 'unknown'), inputId: input.inputId, disposition: 'offline-recovery', original: raw.value, unresolved: true, reason: raw.error ?? 'Unrecognized terminal export.' })); continue
            }
            if (['machine-inventory', 'machine-replay', 'legacy-state'].includes(input.kind)) inventories++
            if (input.kind === 'closed-registry') {
                const parsed = z.strictObject({ version: z.literal(1), terminals: z.record(z.string(), z.enum(['requested', 'confirmed'])) }).safeParse(raw.value)
                outputs.push(await domainObject(recovery, 'terminals', { key: originalKey(input.inputId, 'closed-identities'), inputId: input.inputId, disposition: parsed.success ? 'archive' : 'offline-recovery', original: raw.value,
                    unresolved: !parsed.success, reason: 'Retain closed identities to prevent replacement shell creation. Neither requested nor confirmed proves that a process exited.' }))
                continue
            }
            const values = Array.isArray(raw.value) ? raw.value : [raw.value]
            for (const [position, original] of values.entries()) {
                const value = isRecord(original) ? original : {}, machine = input.kind === 'machine-replay' ? machineInfo.safeParse(value.terminal) : machineInfo.safeParse(value)
                const terminalId = machine.success ? machine.data.terminalId : typeof value.terminalId === 'string' ? value.terminalId : null
                const source = legacySource.safeParse(input.source ?? value.source)
                const validText = Array.isArray(value.lines) && value.lines.every(line => typeof line === 'string') && typeof value.sequence === 'number'
                const recognized = input.kind === 'machine-inventory' ? machine.success : input.kind === 'machine-replay' ? machine.success && typeof value.data === 'string' && typeof value.seq === 'number'
                    : input.kind === 'legacy-state' ? ['opening', 'replaying', 'ready', 'disconnected', 'failed', 'exited'].includes(String(value.phase)) && isRecord(value.compatibility) && value.compatibility.open === 'attach-or-create'
                    : input.kind === 'legacy-text' ? validText && value.provenance === 'adapter-observed' && value.replay === 'bounded-source-tail'
                    : validText && value.sourceHistory === 'bounded-unknown'
                const identity = terminalId && source.success ? originalKey(source.data.sourceHubId, source.data.sourceSessionId, source.data.machineId, terminalId) : originalKey(input.inputId, position)
                let exited = false, reason = 'Archive only. No supported contract transfers this legacy PTY into a new DSH owner; a new shell would be another process.'
                if (input.kind === 'machine-inventory' || input.kind === 'machine-replay' || input.kind === 'legacy-state') {
                    const matches = source.success && terminalId ? evidence.filter(record => record.source.sourceHubId === source.data.sourceHubId && record.source.sourceSessionId === source.data.sourceSessionId
                        && record.source.machineId === source.data.machineId && record.terminalId === terminalId) : []
                    const owners = new Set(matches.map(record => originalKey(record.ownerId, record.pid, record.processBirthId)))
                    const latest = matches.toSorted((a, b) => b.observedAt - a.observedAt)[0]
                    exited = recognized && owners.size === 1 && latest?.state === 'exited' && matches.filter(record => record.observedAt === latest.observedAt).every(record => record.state === 'exited')
                        && (!machine.success || machine.data.pid === null || machine.data.pid === latest.pid)
                    if (!exited) blockers.push(`Terminal ${identity} needs exact owner/process exit evidence or a separately verified supported same-process attach.`)
                    else reason = 'Exact selected owner/process evidence records exit; root must revalidate that evidence before the actual cutover.'
                }
                outputs.push(await domainObject(recovery, 'terminals', { key: originalKey(input.inputId, identity), inputId: input.inputId, disposition: recognized ? 'archive' : 'offline-recovery', original,
                    converted: { version: 1, terminalId, source: source.success ? source.data : null, reuse: 'none', exitEvidenceSatisfied: exited, outputOnly: true,
                        outputCoverage: input.kind === 'legacy-text' ? 'adapter-observed-bounded-source-tail' : input.kind === 'native-text' ? 'bounded-unknown' : input.kind === 'machine-replay' ? 'captured-replay' : 'not-a-text-snapshot' },
                    unresolved: !recognized || !source.success || !terminalId || (!exited && ['machine-inventory', 'machine-replay', 'legacy-state'].includes(input.kind)), reason }))
            }
        }
        if (!inventories) blockers.push('No actual terminal/process inventory was selected. A closed-ID registry or text snapshot alone cannot satisfy G_PTY_EXIT.')
        await domainReport(recovery, 'terminals', inputs, outputs, blockers)
    } }
}
