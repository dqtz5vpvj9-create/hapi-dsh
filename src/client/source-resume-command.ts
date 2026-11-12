import type { WorkspaceCatalogRow } from './controller.ts'
import type { SourceSession } from '../remote/protocol.ts'
import { parseSourceSessionId, sourceSessionId } from '../remote/protocol.ts'
import type { SourceResumeContext } from '../workspace/source-navigation-api.ts'

export interface SourceResumeIdentity {
    engine: string | null
    nativeId: string | null
    directory: string | null
    machineId: string | null
    machineName: string | null
    codexHome?: string | null
    platformOs?: string
    platformFamily?: string
}

export type ResumeUnavailableReason = 'not-source' | 'unverified-engine' | 'missing-native-id' | 'invalid-native-id'
    | 'missing-codex-home' | 'missing-machine' | 'missing-directory' | 'unsupported-directory' | 'unsupported-codex-home' | 'unsupported-platform'

export type SourceResumeCommand = {
    available: true
    engine: 'codex' | 'claude'
    nativeId: string
    directory: string
    machineId: string
    machineName: string | null
    codexHome: string | null
    command: string
    shell: 'posix' | 'powershell'
} | { available: false; reason: ResumeUnavailableReason }

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const control = /[\x00-\x1f\x7f]/
const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const posixAbsolute = (value: string): boolean => value.startsWith('/') && !value.startsWith('//') && !control.test(value)
const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`
const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const windowsAbsolute = (value: string): boolean => !control.test(value) && /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value)

/** Source metadata only. Never use the serving Host, display ID or HAPI ID as
 * a substitute, including when a source projection has not hydrated yet. */
export function sourceResumeIdentity(row: Pick<WorkspaceCatalogRow, 'projectionValues' | 'cwd'>): SourceResumeIdentity | null {
    const source = row.projectionValues?.hhpiSource as SourceSession | undefined
    if (!source) return null
    return { engine: source.engine, nativeId: text(source.nativeId), directory: text(source.cwd),
        machineId: text(source.machineId), machineName: null }

}

/** Accept a store only for the exact original identity named by this Host's menu. */
export function sourceResumeIdentityFromContext(identity: SourceResumeIdentity | null, sessionId: string, context: SourceResumeContext): SourceResumeIdentity | null {
    if (!identity || context.sessionId !== sessionId || sourceSessionId(context) !== sessionId) return null
    let source
    try { source = parseSourceSessionId(sessionId) } catch { return null }
    if (source.engine !== identity.engine || source.machineId !== identity.machineId || source.nativeId !== identity.nativeId
        || context.engine !== identity.engine || context.cwd !== identity.directory) return null
    return { ...identity, codexHome: context.codexHome, platformOs: context.platformOs, platformFamily: context.platformFamily }
}

/** Verified primary CLI references (2026-10-22):
 * https://developers.openai.com/codex/cli/reference/#codex-resume
 * https://code.claude.com/docs/en/cli-reference
 * Exact native UUIDs only: never --last, names, or an invented engine syntax.
 * This constructs shell text for the ORIGINAL machine; no RPC or
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
    if (identity.engine === 'codex' && !text(identity.codexHome)) return unavailable('missing-codex-home')
    const shell = identity.platformFamily === 'windows' && identity.platformOs === 'windows' ? 'powershell'
        : identity.platformFamily === 'unix' && ['linux', 'macos', 'freebsd', 'openbsd', 'netbsd', 'dragonfly'].includes(identity.platformOs ?? '') ? 'posix' : null
    if (!shell) return unavailable('unsupported-platform')
    const absolute = shell === 'powershell' ? windowsAbsolute : posixAbsolute
    if (!absolute(identity.directory!)) return unavailable('unsupported-directory')
    const codexHome = identity.engine === 'codex' ? identity.codexHome ?? null : null
    if (codexHome !== null && !absolute(codexHome)) return unavailable('unsupported-codex-home')
    const prefix = codexHome === null ? '' : `env CODEX_HOME=${quote(codexHome)} `
    const invocation = identity.engine === 'codex' ? 'codex resume' : 'claude --resume'
    return { available: true, engine: identity.engine, nativeId: identity.nativeId!, directory: identity.directory!,
        machineId: identity.machineId!, machineName: text(identity.machineName), codexHome, shell,
        command: shell === 'posix' ? `cd ${quote(identity.directory!)} && ${prefix}${invocation} ${quote(identity.nativeId!)}`
            : `& { $ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${powershellQuote(identity.directory!)}; ${codexHome === null ? '' : `$env:CODEX_HOME = ${powershellQuote(codexHome)}; `}${invocation} ${powershellQuote(identity.nativeId!)} }` }
}

/** A clipboard port keeps this operation incapable of source execution. */
export async function copySourceResumeCommand(result: SourceResumeCommand, writeText: (text: string) => Promise<void>): Promise<boolean> {
    if (!result.available) return false
    await writeText(result.command)
    return true
}
