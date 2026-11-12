import { useLayoutEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ComposerAutosaves, accountComposerDraftKey, readComposerRecoveries, writeComposerRecoveries, subscribeComposerRecoveries, dictationRecoveryHasEntry, appendRecoveredDraft, type RecoveredComposerDraft, type ComposerAuthenticatedIdentity } from './composer-autosave.ts'
import { useWorkspacePane } from './surface/pane-context.tsx'
import { useComposerIdentity } from './composer-identity.ts'

/** Observe the official input directly; persistence must not depend on a view's writer. */
export function installComposerAutosave(ctx: Context, authenticatedIdentity?: ComposerAuthenticatedIdentity): () => void {
    const autosaves = new ComposerAutosaves()
    const Seat = (props: PropsRuntime<'conversation.input.dock'>) => {
        const pane = useWorkspacePane(ctx)
        const identity = useComposerIdentity(ctx, props.sessionId, authenticatedIdentity)
        const [recovery, setRecovery] = useState<{ key: string; drafts: RecoveredComposerDraft[] }>()
        const phase = props.useInput(value => value.phase)
        const key = identity && !identity.signal.aborted ? accountComposerDraftKey(identity.scope, pane?.hostId ?? 'local', props.sessionId) : null
        const recoveries = recovery?.key === key ? recovery.drafts.filter(draft => !draft.retention || !dictationRecoveryHasEntry(key!, draft.retention.id)) : []
        useLayoutEffect(() => {
            const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId)
            if (!binding) return
            const composer = ctx.conversation.input.for(binding.ctx)
            const unavailable = (blocked = false) => ctx.get('hapiWorkspaceUi')?.updates.registerCheckpoint({
                kind: 'message', label: 'Draft account is unavailable',
                revision: () => { const state = composer.state.getSnapshot(); return JSON.stringify([state.draftRev, state.phase, state.attachmentIds, state.queue.length]) },
                current: () => {
                    const state = composer.state.getSnapshot()
                    return !blocked && !state.draft && !state.attachmentIds.length && !state.occurrences.length && !state.claim
                        && state.phase === 'plain' && !state.queue.length
                }, save(signal) { signal.throwIfAborted() },
            })
            if (!key) return unavailable()
            const report = (error: unknown) => composer.notify('error', ctx.locale.getSnapshot().active.startsWith('zh')
                ? `草稿自动保存或恢复失败，当前输入仍保留：${error instanceof Error ? error.message : String(error)}`
                : `Draft autosave or recovery failed; the current input was kept: ${error instanceof Error ? error.message : String(error)}`)
            try {
                const stop = autosaves.retain({ key, storage: window.localStorage, composer, actions: props.inputActions, report, signal: identity!.signal,
                    resolveCommand: async (token, signal) => ctx.get('inputTriggers')?.sessionOf(binding.ctx).resolveClaim(token, signal) })
                const checkpoint = ctx.get('hapiWorkspaceUi')?.updates.registerCheckpoint({ kind: 'message', label: 'Message drafts',
                    revision: () => autosaves.revision(), current: () => identity!.current() && ctx.sessions.ownsBinding?.(binding) !== false,
                    save(signal) { signal.throwIfAborted(); autosaves.checkpoint(); signal.throwIfAborted() } })
                setRecovery({ key, drafts: readComposerRecoveries(window.localStorage, key) })
                const unwatch = subscribeComposerRecoveries(key, () => {
                    try { setRecovery({ key, drafts: readComposerRecoveries(window.localStorage, key) }) } catch (error) { report(error) }
                })
                return () => { unwatch(); checkpoint?.(); stop() }
            } catch (error) { report(error); return unavailable(true) }
        }, [key, identity, props.sessionId, props.sessionBinding, props.inputActions])
        if (!recoveries.length || !key) return null
        const zh = ctx.locale.getSnapshot().active.startsWith('zh')
        return <details className="hapi-draft-recovery"><summary>{zh ? '恢复另一份未发送草稿' : 'Recover another unsent draft'}</summary>
            {recoveries.map((draft, index) => <div key={index}><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{draft.text}</pre>
                <button type="button" disabled={phase === 'submitting' || phase === 'adjudicating'} onClick={() => {
                    if (!identity?.current()) return
                    const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId)
                    if (!binding) return
                    const composer = ctx.conversation.input.for(binding.ctx)
                    try {
                        appendRecoveredDraft(composer, props.inputActions, draft)
                        props.inputActions.persistDraft()
                        const all = readComposerRecoveries(window.localStorage, key)
                        const original = all.findIndex(value => JSON.stringify(value) === JSON.stringify(draft))
                        const next = all.filter((_, item) => item !== original)
                        writeComposerRecoveries(window.localStorage, key, next); setRecovery({ key, drafts: next })
                        composer.focus()
                    } catch (error) { composer.notify('error', error instanceof Error ? error.message : String(error)) }
                }}>{zh ? '追加到当前输入框' : 'Append to current draft'}</button></div>)}
        </details>
    }
    return ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'hapi.composer-autosave', order: -95 }, Seat))
}
