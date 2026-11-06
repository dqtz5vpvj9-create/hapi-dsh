/** Presentation controls over the retained native input; no second draft or submit owner. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SourceInputProps } from './composer-picker/slots.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'

export function CompactComposerTools({ ctx, props, zh }: { ctx: Context; props: SourceInputProps; zh: boolean }) {
    const anchor = useRef<HTMLButtonElement>(null)
    const insertion = useRef<ReturnType<SourceInputProps['inputActions']['captureInsertion']>>()
    const [expanded, setExpanded] = useState(false)
    const locked = props.useInput(input => input.phase === 'submitting' || input.phase === 'adjudicating')
    useLayoutEffect(() => {
        const card = anchor.current?.closest<HTMLElement>('[data-composer-card]')
        if (!card) return
        card.toggleAttribute('data-hapi-composer-expanded', expanded)
        return () => { card.removeAttribute('data-hapi-composer-expanded') }
    }, [expanded, props.sessionId])
    const focus = () => { const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId); if (binding) ctx.conversation.input.for(binding.ctx).focus() }
    return <>
        <button ref={anchor} type="button" className="hapi-picker-utility" aria-label={zh ? '引用文件' : 'Reference a file'} disabled={locked}
            onPointerDown={event => { insertion.current = props.inputActions.captureInsertion(); event.preventDefault() }}
            onClick={() => { props.inputActions.insertText('@', insertion.current ?? props.inputActions.captureInsertion()); insertion.current = undefined; focus() }}>@</button>
        <button type="button" className="hapi-picker-utility" aria-label={zh ? expanded ? '收起输入框' : '展开输入框' : expanded ? 'Collapse editor' : 'Expand editor'} aria-pressed={expanded}
            onMouseDown={event => event.preventDefault()} onClick={() => { setExpanded(!expanded); focus() }}>
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><path d={expanded ? 'M2 7h5V2m11 11h-5v5M7 7 2 2m11 11 5 5' : 'M2 7V2h5m6 16h5v-5M2 2l5 5m6 6 5 5'}/></svg>
        </button>
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
        disabled={sourceIsOffline(metadata) || input.phase !== 'plain' || !input.draft.trim() || !metadata.activeTurnId}
        onClick={() => { if (binding) { ctx.conversation.input.for(binding.ctx).submit('steer', 'click'); close() } }}>
        {zh ? '立即插话发送' : 'Send as an interruption'}
    </button>
}
