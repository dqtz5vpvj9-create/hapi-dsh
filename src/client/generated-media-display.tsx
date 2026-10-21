import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FileTypeIcon, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { sourceGeneratedMediaRecordOf, type SourceGeneratedMediaRecord } from '../hapi-agent/generated-media-record.ts'
import { generatedMediaResourceAddress } from '../workspace/artifacts.ts'
import { sourcePathAddress } from './source-path-actions.tsx'
import type {} from './pane-navigation.ts'
import type {} from '../hapi-agent/projection-types.ts'
import type {} from '../codex/projection-types.ts'

export const SOURCE_MEDIA_DATA = 'hapi-generated-media'
type SourceMediaTurn = readonly SourceGeneratedMediaRecord[]
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ConversationTurnDataMap { 'hapi-generated-media': SourceMediaTurn }
}
function add(state: SourceMediaTurn, record: SourceGeneratedMediaRecord | null): SourceMediaTurn {
    if (!record) return state
    const previous = state.find(value => value.messageId === record.messageId)
    if (previous && JSON.stringify(previous) === JSON.stringify(record)) return state
    return [...state.filter(value => value.messageId !== record.messageId), record].sort((a, b) => a.surfaceSeq - b.surfaceSeq)
}

/** Add source-specific data only; every official renderer retains its target. */
export const sourceGeneratedMediaDefinition: ConversationNodeDefinition<SourceMediaTurn> = {
    kind: SOURCE_MEDIA_DATA,
    match(event) { const record = sourceGeneratedMediaRecordOf(event); return record ? { id: String(record.turn), role: 'start' } : null },
    start(_context, match) { return add([], sourceGeneratedMediaRecordOf(match.event)) },
    update(context, match) { return add(context.state, sourceGeneratedMediaRecordOf(match.event)) },
    buildLocationData(context, scope, previous) {
        if (scope !== 'turn') return null
        const value = context.state ?? context.matches.reduce((state, match) => add(state, sourceGeneratedMediaRecordOf(match.event)), [] as SourceMediaTurn)
        if (!value.length) return null
        if (previous?.kind === 'turn' && previous.key === SOURCE_MEDIA_DATA && previous.value === value) return previous
        return { kind: 'turn', turn: value[0]!.turn, key: SOURCE_MEDIA_DATA, value }
    },
}

/** The public source-file link opens the existing official document pane.
 * Audio/video without an installed body remain exact downloadable files. */
export function installGeneratedMediaDisplay(ctx: Context): () => void {
    const Tail = (props: PropsRuntime<'conversation.chat.turnTail'> & TurnTailOwnerProps) => {
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved')
        const source = sourcePathAddress(native ?? observed)
        const stream = props.turn.data.source(SOURCE_MEDIA_DATA), records = useSyncExternalStore(stream.subscribe, stream.getSnapshot)
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active), zh = language.startsWith('zh')
        if (!source || !records?.length) return null
        return <div className="hapi-generated-media-links" data-hapi-generated-media={props.turn.turn}>
            {records.flatMap(record => record.files.map(file => {
                const address = generatedMediaResourceAddress({ source, document: { kind: 'generated-media', imageId: file.imageId, fileName: file.fileName, mimeType: file.mimeType } })
                const open = (): void => {
                    const pane = ctx.get('hapiWorkspacePane')
                    if (pane) pane.openResource(address)
                    else ctx.sidebarRight.openResourceIn(props.sessionId, address)
                }
                return <button type="button" key={`${record.messageId}:${file.blockIndex}`} data-hapi-generated-media-file={file.imageId}
                    title={file.fileName} aria-label={`${zh ? '打开源媒体' : 'Open original media'} ${file.fileName}`} onClick={open}>
                    <FileTypeIcon path={file.fileName}/><span><strong>{file.fileName}</strong><small>{fileSizeText(file.attachment.bytes)} · {zh ? '源媒体' : 'Original media'}</small></span>
                </button>
            }))}
        </div>
    }
    const stopDefinition = ctx.uiConversation.events.register(sourceGeneratedMediaDefinition)
    const stopSlot = ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'hapi.generated-media', order: 25 }, Tail))
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => { stopSlot(); stopDefinition(); style.remove() }
}

const styles = `
.hapi-generated-media-links{display:flex;flex-wrap:wrap;gap:8px;padding-top:8px;max-width:100%}.hapi-generated-media-links>button{display:flex;align-items:center;gap:8px;max-width:100%;min-width:0;text-align:left;padding:8px 12px;border:1px solid var(--border-secondary,#8884);border-radius:8px;background:var(--bg-secondary,transparent);color:inherit;cursor:pointer}.hapi-generated-media-links>button:hover{background:var(--bg-hover,#8882)}.hapi-generated-media-links svg{width:24px;height:24px;flex-shrink:0}.hapi-generated-media-links>button>span{min-width:0;display:flex;flex-direction:column;gap:2px}.hapi-generated-media-links strong{font-size:13px;font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.hapi-generated-media-links small{font-size:11px;color:var(--text-secondary,#888)}
`
