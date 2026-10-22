import { useLayoutEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { ComposerAutosaves, composerDraftKey } from './composer-autosave.ts'
import { useWorkspacePane } from './surface/pane-context.tsx'

/** Observe the official input directly; persistence must not depend on a view's writer. */
export function installComposerAutosave(ctx: Context): () => void {
    const autosaves = new ComposerAutosaves()
    const Seat = (props: PropsRuntime<'conversation.input.dock'>) => {
        const pane = useWorkspacePane(ctx)
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), source = native ?? observed
        // Wait for native identity; never store a temporary display as another source.
        const key = !source && /^(?:hapi-codex-|hapi-observed-)/u.test(props.sessionId) ? null
            : composerDraftKey(pane?.hostId ?? 'local', props.sessionId, observed?.sidechain ? undefined : source ?? undefined)
        useLayoutEffect(() => {
            if (!key) return
            const binding = ctx.sessions.binding(props.sessionId)
            if (!binding) return
            const composer = ctx.conversation.input.for(binding.ctx)
            const report = (error: unknown) => composer.notify('error', ctx.locale.getSnapshot().active.startsWith('zh')
                ? `草稿自动保存或恢复失败，当前输入仍保留：${error instanceof Error ? error.message : String(error)}`
                : `Draft autosave or recovery failed; the current input was kept: ${error instanceof Error ? error.message : String(error)}`)
            try {
                return autosaves.retain({ key, storage: window.localStorage, composer, actions: props.inputActions, report,
                    resolveCommand: async (token, signal) => ctx.get('inputTriggers')?.sessionOf(binding.ctx).resolveClaim(token, signal) })
            } catch (error) { report(error) }
        }, [key, props.sessionId, props.inputActions])
        return null
    }
    return ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'hapi.composer-autosave', order: -95 }, Seat))
}
