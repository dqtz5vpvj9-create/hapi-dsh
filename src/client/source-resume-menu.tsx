import { useState } from 'react'
import { buildSourceResumeCommand, copySourceResumeCommand, type SourceResumeIdentity } from './source-resume-command.ts'

/** Copies a command for the original machine; never invokes a terminal. */
export function SourceResumeMenu({ identity, chinese = false }: { identity: SourceResumeIdentity | null; chinese?: boolean }) {
    const result = buildSourceResumeCommand(identity), [error, setError] = useState<string | null>(null)
    const title = result.available ? `${chinese ? '在原机器运行' : 'Run on original machine'}: ${result.machineName ?? result.machineId}\n${result.directory}\n${result.command}`
        : chinese ? '源端尚未提供可验证的 CLI、原生 ID 或 POSIX 目录' : 'Verified CLI, native ID or POSIX directory is unavailable from the source'
    return <><button type="button" role="menuitem" disabled={!result.available} title={title} onClick={() => {
        void copySourceResumeCommand(result, value => navigator.clipboard.writeText(value)).catch(error => setError(String(error)))
    }}>{chinese ? '复制恢复命令' : 'Copy resume command'}</button>{error && <span role="alert">{error}</span>}</>
}
