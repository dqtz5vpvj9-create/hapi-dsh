import { useLayoutEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { ComposerAutosaves, composerDraftKey, composerRecoveryKey, readComposerRecoveries, appendRecoveredDraft, type RecoveredComposerDraft } from './composer-autosave.ts'
import { useWorkspacePane } from './surface/pane-context.tsx'

/** Observe the official input directly; persistence must not depend on a view's writer. */
export function installComposerAutosave(ctx: Context): () => void {
    const autosaves = new ComposerAutosaves()
    const Seat = (props: PropsRuntime<'conversation.input.dock'>) => {
        const pane = useWorkspacePane(ctx)
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), source = native ?? observed
        const [recoveries, setRecoveries] = useState<RecoveredComposerDraft[]>([])
        const phase = props.useInput(value => value.phase)
        // Wait for native identity; never store a temporary display as another source.
        const key = !source && /^(?:hapi-codex-|hapi-observed-)/u.test(props.sessionId) ? null
            : composerDraftKey(pane?.hostId ?? 'local', props.sessionBinding?.viewId === undefined ? props.sessionId : JSON.stringify([props.sessionId, pane?.paneId ?? props.sessionBinding.viewId]), observed?.sidechain ? undefined : source ?? undefined)
        useLayoutEffect(() => {
            if (!key) return
            const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId)
            if (!binding) return
            const composer = ctx.conversation.input.for(binding.ctx)
            const report = (error: unknown) => composer.notify('error', ctx.locale.getSnapshot().active.startsWith('zh')
                ? `草稿自动保存或恢复失败，当前输入仍保留：${error instanceof Error ? error.message : String(error)}`
                : `Draft autosave or recovery failed; the current input was kept: ${error instanceof Error ? error.message : String(error)}`)
            try {
                const stop = autosaves.retain({ key, storage: window.localStorage, composer, actions: props.inputActions, report,
                    resolveCommand: async (token, signal) => ctx.get('inputTriggers')?.sessionOf(binding.ctx).resolveClaim(token, signal) })
                setRecoveries(readComposerRecoveries(window.localStorage, key))
                return stop
            } catch (error) { report(error) }
        }, [key, props.sessionId, props.sessionBinding, props.inputActions])
        if (!recoveries.length || !key) return null
        const zh = ctx.locale.getSnapshot().active.startsWith('zh')
        return <details className="hapi-draft-recovery"><summary>{zh ? '恢复另一份未发送草稿' : 'Recover another unsent draft'}</summary>
            {recoveries.map((draft, index) => <div key={index}><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{draft.text}</pre>
                <button type="button" disabled={phase === 'submitting' || phase === 'adjudicating'} onClick={() => {
                    const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId)
                    if (!binding) return
                    const composer = ctx.conversation.input.for(binding.ctx)
                    try {
                        appendRecoveredDraft(composer, props.inputActions, draft)
                        props.inputActions.persistDraft()
                        const next = recoveries.filter((_, item) => item !== index)
                        window.localStorage.setItem(composerRecoveryKey(key), JSON.stringify(next)); setRecoveries(next)
                        composer.focus()
                    } catch (error) { composer.notify('error', error instanceof Error ? error.message : String(error)) }
                }}>{zh ? '追加到当前输入框' : 'Append to current draft'}</button></div>)}
        </details>
    }
    return ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'hapi.composer-autosave', order: -95 }, Seat))
}
