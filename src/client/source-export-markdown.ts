/** Readable conversation export over the pinned public DSH event/content vocabulary. */
import type { AppSourceRoute } from '../workspace/app-service-types.ts'
import type { OriginalExportEvent } from './source-export-state.ts'
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const html = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
function code(value: string): string {
    const fence = '`'.repeat(Math.max(1, ...[...value.matchAll(/`+/gu)].map(match => match[0].length + 1)))
    return `${fence} ${value.replace(/[\r\n]/gu, ' ')} ${fence}`
}
function block(value: unknown, language = 'json'): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)))
    return `${fence}${language}\n${text}\n${fence}`
}
function details(title: string, body: string): string { return `<details>\n<summary>${html(title)}</summary>\n\n${body}\n\n</details>` }
function prose(text: string): string {
    return text.replace(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/gu, (_match, plan: string) => `### Proposed plan\n\n${plan.trim()}`)
}
function attachment(part: Record<string, unknown>, seq: number): string {
    const ref = record(part.attachment) ? part.attachment : undefined
    const name = ref && typeof ref.name === 'string' ? ref.name : part.type === 'image' ? 'Image' : 'File attachment'
    const facts = ref ? [typeof ref.mediaType === 'string' ? ref.mediaType : undefined,
        typeof ref.bytes === 'number' ? `${ref.bytes} bytes` : undefined,
        typeof ref.width === 'number' && typeof ref.height === 'number' ? `${ref.width} × ${ref.height}` : undefined].filter(Boolean).join(' · ') : ''
    const reference = ref ? Object.fromEntries(['attachmentId', 'name', 'mediaType', 'bytes', 'width', 'height'].flatMap(key => key in ref ? [[key, ref[key]]] : [])) : { sourceEvent: seq }
    return `**${part.type === 'image' ? 'Image' : 'Attachment'}:** ${code(name)}${facts ? ` · ${facts}` : ''}\n\nSource reference: ${code(JSON.stringify(reference))}`
}
function content(value: unknown, seq: number, calls: Set<string>): string {
    if (!Array.isArray(value)) return ''
    return value.flatMap(part => {
        if (!record(part)) return []
        if (part.type === 'text' && typeof part.text === 'string') return [prose(part.text)]
        if (part.type === 'reasoning' && typeof part.text === 'string') return [details('Reasoning', part.text)]
        if (part.type === 'image' || part.type === 'file') return [attachment(part, seq)]
        if (part.type === 'tool-call') {
            if (typeof part.id === 'string') calls.add(part.id)
            return [details(`Tool request · ${String(part.name ?? 'tool')}`, block(typeof part.arguments === 'string' ? part.arguments : ''))]
        }
        return [`*Structured ${typeof part.type === 'string' ? html(part.type) : 'content'} block — source event ${seq}. Complete data is available in the JSON export.*`]
    }).join('\n\n')
}

export function exportConversationMarkdown(title: string, source: AppSourceRoute, events: readonly OriginalExportEvent[]): string {
    const sections = [`# ${title.replace(/[\r\n]/gu, ' ')}\n\nOriginal source: ${code(JSON.stringify(source))}\n\nImages and attachments retain their original source references. Their external bytes are not embedded in this Markdown file.`]
    const calls = new Set<string>(), callNames = new Map<string, string>(), other: string[] = []
    for (const event of events) {
        const data = record(event.data) ? event.data : {}, reference = `Source event ${event.seq}`
        if (event.type === 'user/message' || event.type === 'assistant/message') {
            const message = event.type === 'user/message' ? data : record(data.message) ? data.message : {}
            const body = content(message.content, event.seq, calls)
            if (!body) continue
            const role = event.type === 'user/message' ? 'User' : 'Assistant'
            sections.push(`## ${role}\n\n_${reference}${typeof message.id === 'string' ? ` · message ${code(message.id)}` : ''}_\n\n${body}`)
        } else if (event.type === 'tool/call') {
            const callId = typeof data.callId === 'string' ? data.callId : '', name = String(data.name ?? 'tool')
            if (callId) callNames.set(callId, name)
            if (!calls.has(callId)) sections.push(details(`Tool request · ${name}`, `${reference}\n\n${block(typeof data.arguments === 'string' ? data.arguments : '')}`))
        } else if (event.type === 'tool/result') {
            const message = record(data.message) ? data.message : {}, callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
            const body = content(message.content, event.seq, calls)
            const error = record(data.error) && typeof data.error.reason === 'string' ? `\n\n**Error:** ${data.error.reason}` : ''
            sections.push(details(`Tool result${callNames.has(callId) ? ` · ${callNames.get(callId)}` : ''}${message.isError ? ' · failed' : ''}`,
                `${reference}\n\n${body}${error}`))
        } else if (event.type === 'system/message' || event.type === 'developer/message') {
            const message = record(data.message) ? data.message : data, body = content(message.content, event.seq, calls)
            if (body) sections.push(details(event.type === 'system/message' ? 'System context' : 'Developer context', `${reference}\n\n${body}`))
        } else if (event.type === 'turn/end' && record(data.reason) && data.reason.kind !== 'completed') {
            sections.push(`> Turn ended: ${code(String(data.reason.kind))} (${reference}).`)
        } else if (!['turn/start', 'turn/end', 'step/start', 'step/end', 'request/header'].includes(event.type)) other.push(`${code(event.type)} — ${reference}`)
    }
    if (other.length) sections.push(details('Additional source records', `${other.map(value => `- ${value}`).join('\n')}\n\nThe JSON export preserves their complete original data.`))
    return `${sections.join('\n\n---\n\n')}\n`
}
