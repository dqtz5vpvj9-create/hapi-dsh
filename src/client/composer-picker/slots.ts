import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

export type SourceInputProps = PropsRuntime<'conversation.input.right'>
export interface SourceComposerActionsProps {
    source: SourceInputProps
    onAttention(value: boolean): void
    onClose(): void
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'hapi.source.composer-actions': { kind: 'single'; scope: 'session'; owner: SourceComposerActionsProps }
    }
}
