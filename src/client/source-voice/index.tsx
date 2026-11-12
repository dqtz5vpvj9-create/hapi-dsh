import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
/** The official package-local chunk loader only loads the browser-local dictation composer. */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../workspace-ui.ts'
import { VoicePreferencesPanel, words } from './settings.tsx'
import { hasBrowserLocalSpeechSupport } from './browser-local.ts'
import { useWorkspacePane } from '../surface/pane-context.tsx'
import { loadVoiceComposer } from '../client-chunks.ts'
import type { VoiceComposer as VoiceComposerComponent } from './composer.tsx'
import { useComposerIdentity } from '../composer-identity.ts'
import { accountComposerDraftKey, notifyComposerRecoveries, readComposerRecoveries, subscribeComposerRecoveries } from '../composer-autosave.ts'
type ComposerProps = PropsRuntime<'conversation.input.left'>
function VoiceComposer(props: Parameters<typeof VoiceComposerComponent>[0]) {
    const [Loaded, setLoaded] = useState<typeof VoiceComposerComponent | null>(null)
    const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
    const pane = useWorkspacePane(props.ctx), identity = useComposerIdentity(props.ctx, props.binding.sessionId, props.ui.application)
    const key = identity && !identity.signal.aborted ? accountComposerDraftKey(identity.scope, pane?.hostId ?? 'local', props.binding.sessionId) : null
    const [retained, setRetained] = useState<{ key: string; pending: boolean }>()
    useLayoutEffect(() => {
        if (!key) return
        const refresh = () => {
            try { setRetained({ key, pending: readComposerRecoveries(localStorage, key).some(copy => copy.retention?.kind === 'dictation') }) }
            catch { setRetained(undefined) }
        }
        refresh(); return subscribeComposerRecoveries(key, refresh)
    }, [key])
    // This always-mounted entry owns retained dictation even before its lazy
    // panel is loaded or while closed. A failed loader leaves generic recovery
    // available until retry succeeds; words must never become unreachable.
    const entryKey = !failed ? key : null
    useEffect(() => { if (key) { notifyComposerRecoveries(key); return () => notifyComposerRecoveries(key) } }, [key, entryKey])
    if (Loaded) return <div className="hapi-voice-seat" data-hapi-dictation-entry={entryKey ?? undefined}><Loaded {...props} initialOpen/></div>
    const tr = words(props.language), label = tr('Local dictation', '本机听写')
    return <div className="hapi-voice-seat" data-hapi-dictation-entry={entryKey ?? undefined}><button type="button" className="hapi-voice-trigger" aria-haspopup="dialog"
        aria-label={label} title={failed ? tr('Local dictation could not load.', '无法加载本机听写。') : label} aria-busy={busy} disabled={busy}
        onMouseDown={event => event.preventDefault()} onClick={() => {
            setBusy(true); setFailed(false)
            void loadVoiceComposer().then(module => setLoaded(() => module.VoiceComposer)).catch(() => setFailed(true)).finally(() => setBusy(false))
        }}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5V18M6.5 18h7" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
        {retained?.key === key && retained.pending ? <span>{tr('Transcript ready', '转录待插入')}</span> : null}
    </button></div>
}
export function installSourceVoice(ctx: Context, language: string): () => void {
    const scope = ctx.inject(['hapiWorkspaceUi', 'sessions'], owner => {
        const shared = owner.hapiWorkspaceUi
        const Composer = (props: ComposerProps) => {
            const ui = useWorkspacePane(owner) ?? shared
            const account = useSyncExternalStore(ui.application.subscribe, ui.application.getSnapshot)
            const binding = props.sessionBinding ?? owner.sessions.binding(props.sessionId)
            if (!binding || !hasBrowserLocalSpeechSupport()) return null
            return <VoiceComposer key={`${binding.sessionId}:${binding.viewId ?? ''}`} ctx={owner} ui={ui} language={language}
                binding={binding} composer={props} {...(account ? { signal: account.signal } : {})}/>
        }
        const Settings = () => <section className="hapi-voice-settings" aria-label={words(language)('Local dictation settings', '本机听写设置')}>
            <h2>{words(language)('Local dictation', '本机听写')}</h2><VoicePreferencesPanel store={shared.preferences} language={language}/></section>
        const disposers = [
            owner.slots.inject('conversation.input.left', () => owner.slots.register({ name: 'conversation.input.left', id: 'hapi-dsh/voice', order: 85 }, Composer)),
            owner.slots.inject('settings.section', () => owner.slots.register({ name: 'settings.section', id: 'hapi-voice', order: 36,
                label: () => words(language)('Local dictation', '本机听写') }, Settings)),
        ]
        const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
        return () => { for (const dispose of disposers.reverse()) dispose(); style.remove() }
    })
    return () => { void scope.dispose() }
}
const styles = `
.hapi-voice-seat{display:inline-flex;align-items:center}.hapi-voice-trigger{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:inherit;padding:5px;border-radius:6px;cursor:pointer;font:inherit}.hapi-voice-live{color:var(--text-link,#537dce)}
.hapi-voice-dialog{color:var(--text-primary,inherit);background:var(--bg-primary,Canvas);border:1px solid var(--border-secondary,#8886);border-radius:12px;width:min(520px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:0;box-sizing:border-box}.hapi-voice-dialog::backdrop{background:#0006}.hapi-voice-dialog>header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border-secondary,#8885)}.hapi-voice-dialog h2,.hapi-voice-settings h2{font-size:18px;margin:0}.hapi-voice-dialog>header button{border:0;background:transparent;font-size:24px;color:inherit}.hapi-voice-body{padding:14px 16px;font-size:14px;line-height:1.5;overflow:auto}.hapi-voice-preferences label{display:grid;gap:5px;margin:10px 0}.hapi-voice-preferences select{width:100%;box-sizing:border-box;font:inherit;color:inherit;background:var(--bg-input,transparent);border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:8px}.hapi-voice-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.hapi-voice-body button{font:inherit;color:inherit;background:var(--bg-secondary,transparent);border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:6px 10px}.hapi-voice-body button:disabled{opacity:.5}.hapi-voice-transcript{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--border-secondary,#8885);padding:10px;border-radius:7px}.hapi-voice-body small{opacity:.75}
`
