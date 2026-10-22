import type { WorkspaceCatalogRow } from './controller.ts'
import { isSourceChild, sourceIdentity } from '../workspace/legacy.ts'
import { nativeProjection, observedProjection } from '../workspace/presentation.ts'

export interface SourceResumeIdentity {
    engine: string | null
    nativeId: string | null
    directory: string | null
    machineId: string | null
    machineName: string | null
    codexHome?: string | null
}

export type ResumeUnavailableReason = 'not-source' | 'unverified-engine' | 'missing-native-id' | 'invalid-native-id'
    | 'missing-machine' | 'missing-directory' | 'unsupported-directory' | 'unsupported-codex-home'

export type SourceResumeCommand = {
    available: true
    engine: 'codex' | 'claude'
    nativeId: string
    directory: string
    machineId: string
    machineName: string | null
    codexHome: string | null
    command: string
} | { available: false; reason: ResumeUnavailableReason }

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const control = /[\x00-\x1f\x7f]/
const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const posixAbsolute = (value: string): boolean => value.startsWith('/') && !value.startsWith('//') && !control.test(value)
const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`

/** Source metadata only. Never use the serving Host, display ID or HAPI ID as
 * a substitute, including when a source projection has not hydrated yet. */
export function sourceResumeIdentity(row: Pick<WorkspaceCatalogRow, 'projectionValues' | 'cwd'>): SourceResumeIdentity | null {
    if (isSourceChild(row) || !sourceIdentity(row)) return null
    const native = nativeProjection(row), observed = observedProjection(row)
    const source = native ?? observed
    if (!source) return null
    return {
        engine: native ? 'codex' : text(observed?.flavor), nativeId: text(source.nativeId),
        directory: text(observed ? observed.path : row.cwd),
        machineId: text(source.machineId), machineName: text(source.machineName),
        codexHome: native ? text(native.nativeHome) : null,
    }
}

/** Verified primary CLI references (2026-10-22):
 * https://developers.openai.com/codex/cli/reference/#codex-resume
 * https://code.claude.com/docs/en/cli-reference
 * Exact native UUIDs only: never --last, names, or an invented engine syntax.
 * This constructs text for a POSIX shell on the ORIGINAL machine; no RPC or
 * execution happens here. Published Codex homes select the existing store.
 */
export function buildSourceResumeCommand(identity: SourceResumeIdentity | null): SourceResumeCommand {
    const unavailable = (reason: ResumeUnavailableReason): SourceResumeCommand => ({ available: false, reason })
    if (!identity) return unavailable('not-source')
    if (identity.engine !== 'codex' && identity.engine !== 'claude') return unavailable('unverified-engine')
    if (!text(identity.nativeId)) return unavailable('missing-native-id')
    if (!nativeUuid.test(identity.nativeId!)) return unavailable('invalid-native-id')
    if (!text(identity.machineId) || control.test(identity.machineId!)) return unavailable('missing-machine')
    if (!text(identity.directory)) return unavailable('missing-directory')
    if (!posixAbsolute(identity.directory!)) return unavailable('unsupported-directory')
    const codexHome = identity.engine === 'codex' ? identity.codexHome ?? null : null
    if (codexHome !== null && !posixAbsolute(codexHome)) return unavailable('unsupported-codex-home')
    const prefix = codexHome === null ? '' : `env CODEX_HOME=${quote(codexHome)} `
    const invocation = identity.engine === 'codex' ? 'codex resume' : 'claude --resume'
    return { available: true, engine: identity.engine, nativeId: identity.nativeId!, directory: identity.directory!,
        machineId: identity.machineId!, machineName: text(identity.machineName), codexHome,
        command: `cd ${quote(identity.directory!)} && ${prefix}${invocation} ${quote(identity.nativeId!)}` }
}

/** A clipboard port keeps this operation incapable of source execution. */
export async function copySourceResumeCommand(result: SourceResumeCommand, writeText: (text: string) => Promise<void>): Promise<boolean> {
    if (!result.available) return false
    await writeText(result.command)
    return true
}
