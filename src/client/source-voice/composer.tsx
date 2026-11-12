import type {} from '@deepseek-ai/dsh-api-session-controller/client'
/** On-device dictation inserts through the existing official editor actions, never through submit. */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionInput, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceUiScope } from '../workspace-ui.ts'
import { useWorkspacePane } from '../surface/pane-context.tsx'
import { assertVoiceBinding } from './context.ts'
import { supportsDictation, useSourceDictation } from './dictation.ts'
import { VoicePreferencesPanel, useVoicePreferences, words } from './settings.tsx'
import { useComposerIdentity, type ComposerIdentity } from '../composer-identity.ts'
import { accountComposerDraftKey, readComposerRecoveries, writeComposerRecoveries, subscribeComposerRecoveries, notifyComposerRecoveries, type RecoveredComposerDraft } from '../composer-autosave.ts'
import { randomId } from '../random-id.ts'

type ComposerProps = PropsRuntime<'conversation.input.left'>
type VoiceUi = Pick<WorkspaceUiScope, 'voice' | 'preferences' | 'application'>
interface CapturedDictation { span: TokenSpan; binding: SessionBinding; actions: ComposerProps['inputActions']; identity: ComposerIdentity; key: string; id: string; input: Pick<SessionInput, 'state'> }
type DictationCopy = RecoveredComposerDraft & { retention: NonNullable<RecoveredComposerDraft['retention']> }
const isDictationCopy = (copy: RecoveredComposerDraft): copy is DictationCopy => copy.retention?.kind === 'dictation'
function Dialog({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
    const ref = useRef<HTMLDialogElement>(null), id = useId()
    useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close() }, [])
    return <dialog ref={ref} className="hapi-voice-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); close() }}>
        <header><h2 id={id}>{title}</h2><button type="button" onClick={close} aria-label={title.startsWith('本机') ? '关闭听写' : 'Close dictation'}>×</button></header>{children}
    </dialog>
}
export function VoiceComposer({ ctx, ui, language, binding, composer, initialOpen = false, signal }: {
    ctx: Context; ui: VoiceUi; language: string; binding: SessionBinding; composer: ComposerProps; initialOpen?: boolean; signal?: AbortSignal
}) {
    const tr = words(language), navigation = useWorkspacePane(ctx)
    const ownerId = `${navigation?.paneId ?? binding.viewId ?? 'main'}:${binding.sessionId}:dictation`
    const owner = useSyncExternalStore(ui.voice.subscribe, ui.voice.getSnapshot)
    const preferences = useVoicePreferences(ui.preferences)
    const identity = useComposerIdentity(ctx, binding.sessionId, ui.application)
    const lifecycleSignal = useMemo(() => identity && signal ? AbortSignal.any([identity.signal, signal]) : identity?.signal ?? signal, [identity, signal])
    const key = identity && !identity.signal.aborted ? accountComposerDraftKey(identity.scope, navigation?.hostId ?? 'local', binding.sessionId) : null
    const [open, setOpen] = useState(initialOpen), [retained, setRetained] = useState<{ key: string; copies: DictationCopy[] }>(), [notice, setNotice] = useState('')
    const pending = retained?.key === key ? retained.copies : []
    const insertion = useRef<CapturedDictation | null>(null), latest = useRef(composer); latest.current = composer
    const preservationFailed = useRef(false)
    const forget = (copyKey: string, ids: readonly string[]) => {
        const all = readComposerRecoveries(localStorage, copyKey), next = all.filter(copy => !copy.retention || !ids.includes(copy.retention.id))
        if (next.length !== all.length) writeComposerRecoveries(localStorage, copyKey, next)
        setRetained(value => value?.key === copyKey ? { key: copyKey, copies: value.copies.filter(copy => !ids.includes(copy.retention.id)) } : value)
    }
    const keep = (text: string, captured: CapturedDictation, detached: boolean, insertedDraft?: string) => {
        const copy: DictationCopy = { text, references: [], retention: { kind: 'dictation', id: captured.id, ...(insertedDraft === undefined ? {} : { insertedDraft }) } }
        try {
            const all = readComposerRecoveries(localStorage, captured.key)
            writeComposerRecoveries(localStorage, captured.key, [...all.filter(value => value.retention?.id !== captured.id), copy])
            preservationFailed.current = false
        } catch {
            preservationFailed.current = true
            if (!detached) setNotice(tr('Your transcript is still visible, but could not be saved. Keep this pane open.', '转录仍保留在当前面板，但尚未保存，请先保留此窗格。'))
        }
        if (!detached && captured.key === key) setRetained(value => ({ key: captured.key,
            copies: [...(value?.key === captured.key ? value.copies.filter(value => value.retention.id !== captured.id) : []), copy] }))
    }
    useLayoutEffect(() => {
        if (!key) return
        const refresh = () => {
            try {
                const all = readComposerRecoveries(localStorage, key)
                // A detached view may have lost its store writer just before
                // insertion. Keep its backup until the new editor proves that
                // exact inserted document was restored by its native owner.
                let draft: string | undefined
                try { draft = ctx.conversation.input.for(binding.ctx).state.getSnapshot().draft } catch { /* Retain every copy while its input is unavailable. */ }
                const settled = all.filter(copy => isDictationCopy(copy) && copy.retention.insertedDraft !== undefined && copy.retention.insertedDraft === draft)
                const copies = all.filter(copy => !settled.includes(copy))
                if (settled.length) writeComposerRecoveries(localStorage, key, copies)
                const next = copies.filter(isDictationCopy)
                setRetained(value => value?.key === key && JSON.stringify(value.copies) === JSON.stringify(next) ? value : { key, copies: next })
            } catch { setNotice(tr('The saved transcript could not be read. Its original copy has been kept.', '无法读取已保存转录，原副本仍保留。')) }
        }
        refresh()
        return subscribeComposerRecoveries(key, refresh)
    }, [key, binding, ctx])
    const dictation = useSourceDictation((text, interrupted, lifecycle, detached) => {
        if (!text) return
        const captured = insertion.current
        if (!captured) return
        // Ordinary lifecycle interruption keeps words in the same input when
        // its captured selection is still valid. No focus or send is requested.
        if (!interrupted || lifecycle) {
            try {
                if (captured.binding !== binding || !captured.identity.current()) throw new Error('The original dictation input changed')
                assertVoiceBinding(ctx, captured.binding)
                if (captured.actions.insertText(text, captured.span)) {
                    captured.actions.persistDraft()
                    if (detached) keep(text, captured, true, captured.input.state.getSnapshot().draft)
                    else { forget(captured.key, [captured.id]); preservationFailed.current = false }
                    if (!detached) setNotice(tr('Transcript inserted. Review the draft before sending.', '转录已插入，请检查草稿后再发送。'))
                    return
                }
            } catch { /* Retain only under the captured original account/Host/source. */ }
        }
        keep(text, captured, detached)
        if (!detached && !preservationFailed.current) setNotice(tr('Dictation stopped. Your transcript is kept below for review.', '听写已停止，已识别文字保留在下方供检查。'))
    }, () => ui.voice.release(ownerId), lifecycleSignal)
    const current = useRef(dictation); current.current = dictation
    const active = ['connecting', 'listening', 'processing'].includes(dictation.status)
    const supported = supportsDictation(), busyElsewhere = owner !== null && !ui.voice.owns(ownerId)
    useEffect(() => {
        const interrupt = () => current.current.interrupt()
        window.addEventListener('pagehide', interrupt)
        const hidden = () => { if (!navigation?.state.getSnapshot().visible) interrupt() }
        const unsubscribe = navigation?.state.subscribe(hidden)
        const unbind = binding.session.subscribe(() => { if (binding.session.getSnapshot().removed) interrupt() })
        return () => { window.removeEventListener('pagehide', interrupt); unsubscribe?.(); unbind(); interrupt() }
    }, [binding, navigation])
    const visibleIds = JSON.stringify(pending.map(copy => copy.retention.id))
    useEffect(() => { if (key) { notifyComposerRecoveries(key); return () => notifyComposerRecoveries(key) } }, [open, key, visibleIds])
    useEffect(() => navigation?.registerCloseGuard(() => {
        current.current.interrupt()
        return !preservationFailed.current
    }), [navigation])
    const begin = async () => {
        if (pending.length) return
        setNotice('')
        try {
            assertVoiceBinding(ctx, binding)
            if (!identity?.current() || !key || !supported || signal?.aborted || !ui.voice.claim(ownerId, () => current.current.interrupt())) return
            const actions = latest.current.inputActions
            insertion.current = { span: actions.captureInsertion(), binding, actions, identity, key, id: randomId(), input: ctx.conversation.input.for(binding.ctx) }
            await dictation.start(preferences)
        } catch {
            ui.voice.release(ownerId)
            setNotice(tr('Local dictation could not start. Check microphone permission and the browser’s language pack.', '无法启动本机听写，请检查麦克风权限和浏览器语言包。'))
        }
    }
    const insertPending = () => {
        try {
            if (!key || !identity?.current()) return
            assertVoiceBinding(ctx, binding)
            if (!latest.current.inputActions.insertText(pending.map(copy => copy.text).join('\n\n'), latest.current.inputActions.captureInsertion())) return
            latest.current.inputActions.persistDraft(); forget(key, pending.map(copy => copy.retention.id))
            setNotice(tr('Transcript inserted. Review the draft before sending.', '转录已插入，请检查草稿后再发送。'))
        } catch { /* Keep the transcript for explicit insertion when the binding is editable. */ }
    }
    const discard = () => {
        dictation.cancel()
        try { if (key && identity?.current()) forget(key, pending.map(copy => copy.retention.id)) }
        catch { setNotice(tr('The saved transcript could not be removed. Its original copy has been kept.', '无法移除已保存转录，原副本仍保留。')) }
    }
    const status = ({ idle: tr('Ready to dictate', '准备听写'), connecting: tr('Checking local speech recognition…', '正在检查本机语音识别…'),
        listening: tr('Listening', '正在听写'), processing: tr('Finishing dictation…', '正在完成听写…'),
        error: tr('Local dictation stopped. Check microphone permission and the installed language pack.', '本机听写已停止，请检查麦克风权限和已安装的语言包。') })[dictation.status]
    return <div className="hapi-voice-seat"><button type="button" className={active ? 'hapi-voice-trigger hapi-voice-live' : 'hapi-voice-trigger'}
        aria-haspopup="dialog" aria-label={tr('Local dictation', '本机听写')} title={tr('Local dictation', '本机听写')}
        onMouseDown={event => event.preventDefault()} onClick={() => setOpen(true)}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5V18M6.5 18h7" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
        {active ? <span>{tr('Listening', '正在听写')}</span> : pending.length ? <span>{tr('Transcript ready', '转录待插入')}</span> : null}</button>
        {open && <Dialog title={tr('Local dictation', '本机听写')} close={() => { dictation.interrupt(); setOpen(false) }}><div className="hapi-voice-body">
            <VoicePreferencesPanel store={ui.preferences} language={language} disabled={active}/>
            {supported && <p role="status">{status}</p>}
            {busyElsewhere && <p role="status">{tr('Another pane is using the microphone.', '另一个窗格正在使用麦克风。')}</p>}
            <div className="hapi-voice-row">{active ? <>
                <button type="button" disabled={dictation.status !== 'listening'} onClick={() => { void dictation.stop() }}>{tr('Stop and insert', '停止并插入')}</button>
                <button type="button" onClick={discard}>{tr('Cancel dictation', '取消听写')}</button>
            </> : <button type="button" disabled={!!pending.length || !supported || busyElsewhere || signal?.aborted} onClick={() => { void begin() }}>{tr('Start dictation', '开始听写')}</button>}</div>
            {dictation.partial && <pre className="hapi-voice-transcript">{dictation.partial}</pre>}
            {notice && <p role="status">{notice}</p>}
            {pending.length > 0 && <section data-hapi-dictation-recoveries={JSON.stringify([key, pending.map(copy => copy.retention.id)])} aria-label={tr('Uninserted transcript', '待插入转录')}><pre className="hapi-voice-transcript">{pending.map(copy => copy.text).join('\n\n')}</pre>
                <button type="button" onClick={insertPending}>{tr('Insert into this draft', '插入当前草稿')}</button>
                <button type="button" onClick={discard}>{tr('Cancel dictation', '取消听写')}</button></section>}
            <p><small>{tr('Dictation stays on this device and only inserts into the draft. Existing text and attachments are preserved; nothing is sent automatically.',
                '听写在本机完成，只插入草稿；保留已有文字和附件，不会自动发送。')}</small></p>
        </div></Dialog>}
    </div>
}
