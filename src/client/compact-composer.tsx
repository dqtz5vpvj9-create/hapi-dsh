/** Presentation controls over the retained native input; no second draft or submit owner. */
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ComposerAttachmentsOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SourceInputProps } from './composer-picker/slots.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'

/** Progress comes from the native upload owner; byte completion still awaits its receipt. */
export function ComposerUploadStatus({ props, zh }: { props: Pick<ComposerAttachmentsOwnerProps, 'attachments' | 'uploads'>; zh: boolean }) {
    const { attachments, uploads } = props
    if (!attachments.length) return null
    const states = attachments.flatMap(attachment => {
        const upload = uploads[attachment.id]
        return attachment.kind === 'image' && upload === undefined ? [] : [{ attachment, upload }]
    })
    const failed = states.filter(({ upload }) => upload?.status === 'error')
    const pending = states.filter(({ upload }) => upload?.status !== 'ready' && upload?.status !== 'error')
    const tr = (en: string, chinese: string) => zh ? chinese : en
    let text: string
    if (failed.length) text = tr('Upload failed. Retry or remove the attachment.', '上传失败，请重试或移除。')
    else if (pending.length) {
        const transferring = pending.flatMap(({ upload }) => upload?.status === 'uploading' ? [upload] : [])
        const total = transferring.reduce((sum, upload) => sum + (upload.total ?? 0), 0)
        const loaded = transferring.reduce((sum, upload) => sum + upload.loaded, 0)
        const measured = transferring.length === pending.length && transferring.every(upload => upload.total !== undefined)
        text = measured && loaded >= total
            ? tr('Finishing upload…', '正在完成上传…')
            : measured && total > 0
                ? tr(`Uploading · ${Math.floor(loaded / total * 100)}%`, `正在上传 · ${Math.floor(loaded / total * 100)}%`)
                : tr('Preparing attachments…', '正在准备附件…')
    } else return null
    return <div role="status" className="hapi-composer-upload-status" data-hapi-upload-state={failed.length ? 'error' : 'uploading'}>{text}</div>
}

export function CompactComposerTools({ ctx, props, zh, overflow }: { ctx: Context; props: SourceInputProps; zh: boolean; overflow?: HTMLElement | null }) {
    const anchor = useRef<HTMLButtonElement>(null)
    const expandTrigger = useRef<HTMLButtonElement>(null)
    const insertion = useRef<ReturnType<SourceInputProps['inputActions']['captureInsertion']>>()
    const [expanded, setExpanded] = useState(false)
    const [expandInMore, setExpandInMore] = useState(false)
    useLayoutEffect(() => { insertion.current = undefined }, [props.sessionId, props.sessionBinding, props.inputActions])
    const locked = props.useInput(input => input.phase !== 'plain' && input.phase !== 'claimed')
    useLayoutEffect(() => {
        const card = anchor.current?.closest<HTMLElement>('[data-composer-card]')
        if (!card) return
        card.toggleAttribute('data-hapi-composer-expanded', expanded)
        return () => { card.removeAttribute('data-hapi-composer-expanded') }
    }, [expanded, props.sessionId])
    useLayoutEffect(() => {
        const card = anchor.current?.closest<HTMLElement>('[data-composer-card]')
        if (!card || !expandTrigger.current) return
        // The popup is portaled outside the Pane. Mirror the actual CSS seat,
        // rather than choosing a second viewport breakpoint for its action.
        const update = () => { if (expandTrigger.current) setExpandInMore(getComputedStyle(expandTrigger.current).display === 'none') }
        update()
        const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
        observer?.observe(card)
        return () => { observer?.disconnect() }
    }, [props.sessionId])
    const focus = () => { const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId); if (binding) ctx.conversation.input.for(binding.ctx).focus() }
    const expandLabel = zh ? expanded ? '收起输入框' : '展开输入框' : expanded ? 'Collapse editor' : 'Expand editor'
    const toggleExpanded = () => { setExpanded(value => !value); focus() }
    return <>
        <button ref={anchor} type="button" className="hapi-picker-utility" data-hhpi-composer-controls={isSourceSessionId(props.sessionId) ? '' : undefined}
            aria-label={zh ? '引用文件' : 'Reference a file'} disabled={locked}
            onPointerDown={event => { insertion.current = props.inputActions.captureInsertion(); event.preventDefault() }}
            onClick={() => { props.inputActions.insertText('@', insertion.current ?? props.inputActions.captureInsertion()); insertion.current = undefined; focus() }}>@</button>
        <button ref={expandTrigger} type="button" className="hapi-picker-utility hapi-composer-expand-trigger" aria-label={expandLabel} aria-pressed={expanded}
            onMouseDown={event => event.preventDefault()} onClick={toggleExpanded}>
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><path d={expanded ? 'M2 7h5V2m11 11h-5v5M7 7 2 2m11 11 5 5' : 'M2 7V2h5m6 16h5v-5M2 2l5 5m6 6 5 5'}/></svg>
        </button>
        {overflow && createPortal(<button type="button" className="hapi-composer-expand-more" data-compact={expandInMore ? '' : undefined} aria-pressed={expanded}
            onMouseDown={event => event.preventDefault()} onClick={toggleExpanded}>{expandLabel}</button>, overflow)}
    </>
}

export function ComposerSteerAction({ ctx, props, zh, close }: { ctx: Context; props: SourceInputProps; zh: boolean; close(): void }) {
    const input = props.useInput(value => value)
    const running = props.useSession(value => value.running)
    const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId)
    if (!isSourceSessionId(props.sessionId)) return null
    const metadata = (binding?.session as RemoteSourceSession | undefined)?.metadata.getSnapshot()
    if (!metadata?.capabilities.steer || !running) return null
    return <button type="button" className="hapi-composer-steer-action"
        disabled={sourceIsOffline(metadata) || input.phase !== 'plain' || (!input.draft.trim() && !input.attachmentIds.length) || !metadata.activeTurnId}
        onClick={() => { if (binding) { ctx.conversation.input.for(binding.ctx).submit('steer', 'click'); close() } }}>
        {zh ? '立即插话发送' : 'Send as an interruption'}
    </button>
}
