import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

export const SOURCE_COMMAND_TOOLS = ['CodexBash', 'Bash', 'shell_command', 'run_shell_command', 'exec_command', 'local_shell'] as const

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function parse(raw: string): unknown {
    try { return JSON.parse(raw) } catch { return raw }
}
function commandText(value: unknown): string | null {
    if (typeof value === 'string') return value || null
    if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) return null
    // Codex also records argv. Show the shell body for the standard shell -c form.
    if (value.length === 3 && /(?:^|[/\\])(?:bash|zsh|sh)$/.test(value[0]!) && /^-[a-z]*c$/.test(value[1]!)) return value[2] || null
    return value.map(part => /^[\w./:=+-]+$/.test(part) ? part : JSON.stringify(part)).join(' ') || null
}

/** Only semantic command fields become the summary, never transport/thread IDs. */
export function sourceCommandModel(block: ToolCallBlock) {
    const done = 'kind' in block
    const raw = done ? block.call?.argsRaw ?? '' : block.phase === 'start' ? block.argsRaw : ''
    const input = object(parse(raw))
    const command = commandText(input?.command) ?? commandText(input?.cmd)
        ?? block.args.text('command') ?? block.args.text('cmd') ?? null
    const description = typeof input?.description === 'string' ? input.description : block.args.text('description') ?? null
    const resultRaw = done ? block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : ''
    const result = object(parse(resultRaw))
    const exitCode = typeof result?.exit_code === 'number' ? result.exit_code : typeof result?.exitCode === 'number' ? result.exitCode : null
    const stdout = result?.stdout ?? result?.aggregated_output ?? result?.output
    const stderr = result?.stderr
    const output = typeof stdout === 'string' || typeof stderr === 'string'
        ? [typeof stdout === 'string' ? stdout : '', typeof stderr === 'string' ? stderr : ''].filter(Boolean).join('\n')
        : resultRaw
    const status = !done ? block.phase === 'preparing' ? 'preparing' : 'running'
        : block.error?.code === 'interrupted' ? 'stopped'
        : block.isError || (exitCode !== null && exitCode !== 0) ? 'error' : 'done'
    return { command, description, raw, resultRaw, output, exitCode, status }
}
