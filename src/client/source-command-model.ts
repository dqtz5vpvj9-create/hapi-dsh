import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'

export const SOURCE_COMMAND_TOOLS = ['CodexBash', 'Bash', 'shell_command', 'run_shell_command', 'exec_command', 'local_shell'] as const
export const SOURCE_COMPACT_TOOLS = ['CodexPatch', 'apply_patch'] as const
export interface CommandActionLabels { read: string; search: string; listFiles: string }
const defaultActionLabels: CommandActionLabels = { read: 'Read', search: 'Search', listFiles: 'List files' }

/** Presentation adapter for the official Bash row; the stored call is untouched. */
export function sourceShellBlock(block: ToolCallBlock, labels = defaultActionLabels): ToolCallBlock {
    const model = sourceCommandModel(block, labels), done = 'kind' in block
    if (!model.command) return { ...block, name: 'bash' }
    const input = object(parse(model.raw))
    const workdir = input?.workdir ?? input?.cwd
    const payload = { command: model.command,
        ...(!done || model.exitCode !== null ? { description: model.description || commandPreview(model.command) } : {}),
        ...(typeof workdir === 'string' ? { workdir } : {}) }
    const argsRaw = JSON.stringify(payload)
    // An unknown process exit must retain the official persistent-shell path
    // (no description in call.argsRaw). Its header can still use the semantic
    // description through the public argument view instead of opaque JSON.
    const args = PartialArguments.fromText(done && model.exitCode === null
        ? JSON.stringify({ ...payload, description: model.description || commandPreview(model.command) }) : argsRaw)
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
/** Decode one quoted shell word for display only; never evaluate shell syntax. */
function quotedShellWord(value: string): string | null {
    if (value[0] !== "'" && value[0] !== '"') return null
    let quote = '', output = ''
    for (let i = 0; i < value.length; i++) {
        const char = value[i]!
        if (quote === "'") { if (char === "'") quote = ''; else output += char; continue }
        if (char === '\\') {
            const next = value[++i]
            if (next === undefined) return null
            if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) output += '\\'
            if (next !== '\n') output += next
        } else if (quote === '"') {
            if (char === '"') quote = ''
            else if (char === '$' || char === '`') return null
            else output += char
        } else if (char === "'" || char === '"') quote = char
        else if (/\s|[;&|<>$`()]/.test(char)) return null
        else output += char
    }
    return quote ? null : output
}
function commandPreview(command: string): string {
    const line = command.split('\n')[0]!.trim()
    return line.length > 120 ? `${line.slice(0, 117)}…` : line
}
function commandText(value: unknown): string | null {
    if (typeof value === 'string') {
        const shell = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(-[a-z]*c[a-z]*)\s+([\s\S]+)$/i.exec(value)
        if (shell && /(?:^|\/)\b(?:ba|z|da|k)?sh$/.test(shell[1] ?? shell[2] ?? shell[3]!)) {
            const body = quotedShellWord(shell[5]!.trim())
            if (body) return body
        }
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

/** Use source-provided action semantics; do not guess intent from shell syntax. */
function actionDescription(input: Record<string, unknown> | undefined, labels: CommandActionLabels): string | null {
    const actions = input?.command_actions ?? input?.commandActions
    if (!Array.isArray(actions) || !actions.length) return null
    const descriptions: string[] = []
    for (const value of actions) {
        const action = object(value)
        if (!action || !['read', 'search', 'listFiles'].includes(String(action.type))) return null
        const type = action.type as keyof CommandActionLabels
        const subject = type === 'read' ? action.name ?? action.path : type === 'search' ? action.query : action.path
        const description = [labels[type], typeof subject === 'string' ? subject : ''].filter(Boolean).join(' ')
        if (!descriptions.includes(description)) descriptions.push(description)
    }
    return commandPreview(descriptions.join(' · '))
}

/** Only semantic command fields become the summary, never transport/thread IDs. */
export function sourceCommandModel(block: ToolCallBlock, labels = defaultActionLabels) {
    const done = 'kind' in block
    const raw = done ? block.call?.argsRaw ?? '' : block.phase === 'start' ? block.argsRaw : ''
    const input = object(parse(raw))
    const command = commandText(input?.command) ?? commandText(input?.cmd)
        ?? commandText(block.args.text('command')) ?? commandText(block.args.text('cmd')) ?? null
    const description = (typeof input?.description === 'string' ? input.description : block.args.text('description'))
        || actionDescription(input, labels)
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
export function sourceToolBlocks(block: ToolCallBlock, target: string, labels = defaultActionLabels): ToolCallBlock[] {
    if (target === 'bash') return [sourceShellBlock(block, labels)]
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
