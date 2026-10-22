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
function powerShell(value: string): boolean { return /^(?:pwsh|powershell)(?:\.exe)?$/i.test(value.split(/[/\\]/).at(-1) ?? '') }
function commandText(value: unknown): string | null {
    if (typeof value === 'string') {
        const match = /^(?:&\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(value)
        if (match && powerShell(match[1] ?? match[2] ?? match[3]!)) {
            const body = match[4]!.trim()
            return body || value
        }
        return value || null
    }
    if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) return null
    if (value.length === 3 && /(?:^|[/\\])(?:ba|z|da|k)?sh$/.test(value[0]!) && /^-[a-z]*c[a-z]*$/i.test(value[1]!)) return value[2] || null
    if (powerShell(value[0] ?? '')) {
        let index = 1
        while (/^-(?:NoLogo|NoProfile|NonInteractive)$/i.test(value[index] ?? '')) index++
        if (/^-(?:Command|c)$/i.test(value[index] ?? '') && index === value.length - 2) return value[index + 1] || null
    }
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

export const SOURCE_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
    bash: SOURCE_COMMAND_TOOLS, edit: ['CodexPatch', 'apply_patch', 'Edit', 'MultiEdit'],
    write: ['Write'], read: ['Read', 'read_file'], grep: ['Grep', 'ripgrep'], glob: ['Glob'],
}
/** Only the official view input changes; inspect still points to the original call. */
export function sourceToolBlocks(block: ToolCallBlock, target: string): ToolCallBlock[] {
    if (target === 'bash') return [sourceShellBlock(block)]
    const done = 'kind' in block
    const raw = done ? block.call?.argsRaw ?? '' : block.phase === 'start' ? block.argsRaw : ''
    const parsed = parse(raw), input = object(parsed) ?? {}
    let inputs: Record<string, unknown>[] = [input]
    if (target === 'edit' && block.name === 'MultiEdit' && Array.isArray(input.edits)) {
        inputs = input.edits.map(edit => ({ file_path: input.file_path, ...object(edit) }))
    }
    if (target === 'edit' && (block.name === 'CodexPatch' || block.name === 'apply_patch')) {
        const changes = object(input.changes)
        if (changes) inputs = Object.entries(changes).map(([path, change]) => ({ ...object(change), file_path: path }))
        else {
            const patch = typeof parsed === 'string' ? parsed : typeof input.patch === 'string' ? input.patch : typeof input.input === 'string' ? input.input : ''
            const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!)
            if (paths.length) inputs = paths.map(file_path => ({ file_path }))
        }
    }
    return (inputs.length ? inputs : [input]).map(value => {
        const payload = { ...value, ...(typeof value.file_path !== 'string' && typeof value.path === 'string' && ['edit','write','read'].includes(target) ? { file_path: value.path } : {}) }
        const argsRaw = JSON.stringify(payload), args = PartialArguments.fromText(argsRaw)
        if (!done) return block.phase === 'start' ? { ...block, name: target, args, argsRaw } : { ...block, name: target, args }
        return { ...block, name: target, args, call: { name: target, argsRaw } }
    })
}
