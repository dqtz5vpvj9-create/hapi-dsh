import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'

export const SOURCE_COMMAND_TOOLS = ['CodexBash', 'Bash', 'shell_command', 'run_shell_command', 'exec_command', 'local_shell'] as const
export const SOURCE_COMPACT_TOOLS = ['CodexPatch', 'apply_patch'] as const

/** Presentation adapter for the official Bash row; the stored call is untouched. */
export function sourceShellBlock(block: ToolCallBlock): ToolCallBlock {
    const model = sourceCommandModel(block), done = 'kind' in block
    if (!model.command) return { ...block, name: 'bash' }
    const input = object(parse(model.raw))
    const workdir = input?.workdir ?? input?.cwd
    const payload = { command: model.command,
        ...(!done || model.exitCode !== null ? { description: model.description || model.command.split('\n')[0] } : {}),
        ...(typeof workdir === 'string' ? { workdir } : {}) }
    const argsRaw = JSON.stringify(payload), args = PartialArguments.fromText(argsRaw)
    if (!done) return block.phase === 'start' ? { ...block, name: 'bash', args, argsRaw } : { ...block, name: 'bash', args }
    // Missing exit data uses the official persistent/generic path, never its
    // default-success parser. Only real exit codes receive a shell marker.
    const output = model.exitCode === null ? model.output : `${model.output}\n[exit code: ${model.exitCode}]`
    return { ...block, name: 'bash', args, call: { name: 'bash', argsRaw },
        content: block.content.some(part => part.type !== 'text') ? block.content : [{ type: 'text', text: output }],
        isError: model.exitCode === null || block.error ? block.isError : false }
}

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

/** Prefer useful paths/queries over opaque source IDs, with the full payload on expansion. */
export function sourceToolSummary(block: ToolCallBlock): string | null {
    const done = 'kind' in block
    const raw = done ? block.call?.argsRaw ?? '' : block.phase === 'start' ? block.argsRaw : ''
    const input = object(parse(raw))
    for (const key of ['description', 'file_path', 'path', 'pattern', 'query', 'url']) {
        const value = input?.[key] ?? block.args.text(key)
        if (typeof value === 'string' && value.trim()) return value
    }
    const changes = object(input?.changes)
    if (changes) return Object.keys(changes).join(', ') || null
    const patch = typeof input?.patch === 'string' ? input.patch : typeof input?.input === 'string' ? input.input : raw.startsWith('*** Begin Patch') ? raw : ''
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1])
    return paths.length ? paths.join(', ') : null
}
