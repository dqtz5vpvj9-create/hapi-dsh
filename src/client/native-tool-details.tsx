/** Native tool detail presentation through the official keyed Tool slot. */
import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { TOOL_DETAIL_CHUNK_BYTES, TOOL_DETAIL_MIME, toolDetailEnvelope, toolDetailPageSchema, toolDetailPath, type ToolDetail, type ToolDetailEnvelope } from '../shared/native-tool-detail.ts'

const bytes = (value: string): Uint8Array => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const parse = (text: string | undefined): unknown => { if (text === undefined) return; try { return JSON.parse(text) } catch { return } }

/** Keep authentication, exact revision and byte cursor attached to every chunk. */
export async function readToolDetailChunk(api: Pick<HhpiRemoteApi, 'resource'>, sessionId: string, detail: ToolDetail, offset: number, signal: AbortSignal) {
    const result = await api.resource({ sessionId, path: toolDetailPath(detail, offset) }, signal)
    signal.throwIfAborted()
    if (!result.ok) throw result.error
    if (result.value.mimeType !== TOOL_DETAIL_MIME) throw new Error('The source returned a different kind of tool detail.')
    const page = toolDetailPageSchema.parse(JSON.parse(new TextDecoder().decode(bytes(result.value.content))))
    const content = bytes(page.bytesBase64), next = offset + content.byteLength
    if (page.ref !== detail.ref || page.revision !== detail.revision || page.part !== detail.part || page.offset !== offset
        || page.total !== detail.bytes || content.byteLength > TOOL_DETAIL_CHUNK_BYTES || next > page.total
        || page.nextOffset !== (next < page.total ? next : null) || next === offset && next < page.total) {
        throw new Error('The source tool detail changed while it was being read.')
    }
    return { page, content }
}

/** One chunk on screen; complete content is fetched only by explicit download. */
export function ToolDetailPanel({ sessionId, value, api, zh = false }: {
    sessionId: string; value: ToolDetailEnvelope; api: Pick<HhpiRemoteApi, 'resource'>; zh?: boolean
}) {
    const detail = value._hhpiDetail, lifetime = useRef<AbortController | null>(null)
    const [current, setCurrent] = useState<{ offset: number; next: number | null; previous: number | null; text: string } | null>(null)
    const visited = useRef<number[]>([])
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [downloaded, setDownloaded] = useState(0)
    useEffect(() => {
        const controller = new AbortController(); lifetime.current = controller
        setCurrent(null); setBusy(false); setError(''); setDownloaded(0); visited.current = []
        return () => { controller.abort(); if (lifetime.current === controller) lifetime.current = null }
    }, [sessionId, detail.ref, detail.revision, detail.part])
    const label = detail.part === 'input' ? (zh ? '工具输入' : 'Tool input') : (zh ? '工具结果' : 'Tool result')
    const read = async (offset: number): Promise<void> => {
        if (busy || !lifetime.current) return
        const signal = lifetime.current.signal
        setBusy(true); setError('')
        try {
            const { page, content } = await readToolDetailChunk(api, sessionId, detail, offset, signal)
            signal.throwIfAborted()
            let position = visited.current.indexOf(offset)
            if (position === -1) { visited.current.push(offset); position = visited.current.length - 1 }
            setCurrent({ offset, next: page.nextOffset, previous: visited.current[position - 1] ?? null, text: new TextDecoder().decode(content) })
        } catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) }
        finally { if (!signal.aborted) setBusy(false) }
    }
    const download = async (): Promise<void> => {
        if (busy || !lifetime.current) return
        const signal = lifetime.current.signal
        setBusy(true); setError(''); setDownloaded(0)
        try {
            const chunks: Uint8Array<ArrayBuffer>[] = []
            let offset: number | null = 0
            while (offset !== null) {
                const next = await readToolDetailChunk(api, sessionId, detail, offset, signal)
                chunks.push(new Uint8Array(next.content)); setDownloaded(next.page.offset + next.content.byteLength)
                offset = next.page.nextOffset
            }
            signal.throwIfAborted()
            const address = URL.createObjectURL(new Blob(chunks, { type: 'application/json' }))
            const link = document.createElement('a'); link.href = address; link.download = `tool-${detail.part}.json`
            link.click(); setTimeout(() => { URL.revokeObjectURL(address) }, 0)
        } catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) }
        finally { if (!signal.aborted) setBusy(false) }
    }
    return <section data-hhpi-tool-detail={detail.part} style={{ minWidth: 0, maxWidth: '100%', marginBlock: 8 }}>
        <p>{label} · {detail.bytes.toLocaleString()} {zh ? '字节；下方为预览，完整内容可分段阅读或下载。' : 'bytes. Preview below; read the complete content in sections or download it.'}</p>
        <pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{current?.text ?? value.preview}</pre>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" disabled={busy || current?.previous === null} onClick={() => { void read(current ? current.previous ?? 0 : 0) }}>{current ? (zh ? '上一段' : 'Previous section') : (zh ? '查看完整内容的第一段' : 'Read first section')}</button>
            {current && <button type="button" disabled={busy || current.next === null} onClick={() => { if (current.next !== null) void read(current.next) }}>{zh ? '下一段' : 'Next section'}</button>}
            <button type="button" disabled={busy} onClick={() => { void download() }}>{zh ? '下载完整内容' : 'Download complete content'}</button>
            {current && <span>{current.offset.toLocaleString()} / {detail.bytes.toLocaleString()}</span>}
            {busy && <span role="status">{zh ? '正在读取' : 'Reading'}{downloaded ? ` ${downloaded.toLocaleString()} / ${detail.bytes.toLocaleString()}` : '…'}</span>}
        </div>
        {error && <p role="alert">{error}</p>}
    </section>
}

type Props = ToolCallViewProps & PropsLocale<'conversation'>
const titles: Record<string, [string, string]> = { commandExecution: ['Run command', '运行命令'], fileChange: ['File changes', '文件修改'],
    webSearch: ['Web search', '搜索网页'], mcpToolCall: ['Tool call', '调用工具'], dynamicToolCall: ['Tool call', '调用工具'],
    collabAgentToolCall: ['Agent collaboration', '协作任务'], subAgentActivity: ['Agent activity', '子任务进展'],
    functionCallOutput: ['Tool output', '工具输出'], imageGeneration: ['Generate image', '生成图片'], sleep: ['Wait', '等待'] }
const keys = ['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
    'subAgentActivity', 'functionCallOutput', 'imageGeneration', 'sleep'].map(name => `codex.${name}`).concat('hhpi-native-tool-detail')

/** Ordinary native rows keep their existing official component and actions. */
export function installNativeToolDetails(ctx: Context): () => void {
    return ctx.slots.inject('tool.call.toolview', () => {
        let originals: Array<StoredEntry | undefined> = [], updating = false
        let stops: Array<() => void> = []
        const ownComponents = new Set<unknown>()
        const update = (): void => {
            if (updating) return
            const entries = keys.map(key => ctx.slots.entries('tool.call.toolview').filter(entry => entry.options.key === key
                && !ownComponents.has(entry.component)).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0])
            if (entries.length === originals.length && entries.every((entry, index) => entry === originals[index])) return
            updating = true
            try {
                for (const stop of stops) stop()
                stops = []; originals = entries
                keys.forEach((key, index) => {
                    const Original = entries[index]?.component as ComponentType<Props> | undefined
                    if (!Original && key !== 'hhpi-native-tool-detail') return
                    const NativeDetails = (props: Props) => {
                        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
                        const raw = 'kind' in props.block ? props.block.call?.argsRaw : props.block.phase === 'start' ? props.block.argsRaw : undefined
                        const parsedInput = parse(raw)
                        const sourceTool = typeof parsedInput === 'object' && parsedInput !== null && '_hhpiSourceTool' in parsedInput
                            && typeof parsedInput._hhpiSourceTool === 'string' ? parsedInput._hhpiSourceTool : key
                        const input = toolDetailEnvelope(parsedInput)
                        const content = 'kind' in props.block ? props.block.content : []
                        const output = content.length === 1 && content[0]?.type === 'text' ? toolDetailEnvelope(parse(content[0].text)) : undefined
                        if (!input && !output && Original) return createElement(Original, props)
                        const zh = language.startsWith('zh')
                        return <details data-hhpi-native-tool-detail-row="" style={{ minWidth: 0, maxWidth: '100%' }}>
                            <summary>{titles[sourceTool.replace('codex.', '')]?.[zh ? 1 : 0] ?? (zh ? '工具详情' : 'Tool details')}{'kind' in props.block && props.block.isError ? (zh ? ' · 失败' : ' · Failed') : ''}</summary>
                            {input && <ToolDetailPanel key={`${props.sessionId}:${input._hhpiDetail.ref}:${input._hhpiDetail.revision}`} sessionId={props.sessionId} value={input} api={ctx.remote.hhpi} zh={zh}/>}
                            {output && <ToolDetailPanel key={`${props.sessionId}:${output._hhpiDetail.ref}:${output._hhpiDetail.revision}`} sessionId={props.sessionId} value={output} api={ctx.remote.hhpi} zh={zh}/>}
                            {!input && raw && <details><summary>{zh ? '输入' : 'Input'}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{raw}</pre></details>}
                            {!output && content.length > 0 && <details><summary>{zh ? '结果' : 'Result'}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content.map(block => block.type === 'text' ? block.text : '').join('\n')}</pre></details>}
                        </details>
                    }
                    ownComponents.add(NativeDetails)
                    stops.push(ctx.slots.register({ name: 'tool.call.toolview', key, registrant: 'hhpi-native-tool-detail',
                        locale: 'conversation', priority: 500 }, NativeDetails))
                })
            } finally { updating = false }
        }
        const unsubscribe = ctx.slots.subscribe('tool.call.toolview', update)
        update()
        return () => { unsubscribe(); for (const stop of stops) stop() }
    })
}
