import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantActionOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { NativeControlLedger } from './native-control-state.ts'
import { NativeForkContent } from './native-controls.tsx'
import { Dialog } from './ui.tsx'
import { useSharedWorkspacePane } from './surface/pane-context.tsx'

export type NativeForkActionProps = PropsRuntime<'conversation.chat.assistant-actions'> & PropsLocale<'hapiWorkspace'>
    & AssistantActionOwnerProps & { controls: NativeControlLedger; open: (sessionId: string) => void }

/** One native action in the official message-action extension seat. */
export function NativeForkAction({ sessionId, messageId, useProjection, controls, open, t }: NativeForkActionProps) {
    const projection = useProjection('hapi')
    const pane = useSharedWorkspacePane()
    const [show, setShow] = useState(false)
    if (!projection) return null
    return <>
        <button type="button" className="hapi-native-fork-action" aria-label={t('fork')} title={t('fork')} onClick={() => setShow(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7c0 6-12 3-12 8"/></svg>
        </button>
        {show && <Dialog title={t('fork')} close={() => setShow(false)} t={t}>
            <NativeForkContent ledger={controls} sessionId={sessionId} boundary={{ displayMessageId: messageId }} t={t} open={id => {
                setShow(false)
                if (pane) pane.openSession(id, { beside: 'horizontal' })
                else open(id)
            }}/>
        </Dialog>}
    </>
}
