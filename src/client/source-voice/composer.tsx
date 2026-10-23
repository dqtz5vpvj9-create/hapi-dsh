/** HAPI speech and voice assistants attached to the unchanged official composer and settings. */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '../../codex/projection-types.ts';
import type {} from '../../hapi-agent/projection-types.ts';
import type { HapiRemoteApi } from '../../client-api.ts';
import type { WorkbenchSource } from '../../workbench-types.ts';
import type { WorkspaceUiScope } from '../workspace-ui.ts';
import type {} from '../workspace-ui.ts';
import type {} from '../pane-navigation.ts';
import { SourceVoiceTransport } from './transport.ts';
import { VoiceCatalog } from './catalog.ts';
import { useSourceDictation, supportsDictation } from './dictation.ts';
import { useVoiceAssistant } from './use-assistant.ts';
import { assertVoiceBinding, voiceContextReader } from './context.ts';
import { voiceToolOwner } from './tools.ts';
import { VoiceCredentialsPanel, VoicePreferencesPanel, useVoicePreferences, words } from './settings.tsx';
import { voiceError } from './assistant.ts';
import { VOICE_BACKEND_LABELS } from '../../voice/protocol/voicePickerCatalog.ts';
import { useWorkspacePane } from '../surface/pane-context.tsx';

type ComposerProps = PropsRuntime<'conversation.input.left'>;
function Dialog({ title, close, minimize, children }: { title: string; close(): void; minimize(): void; children: ReactNode }) {
    const ref = useRef<HTMLDialogElement>(null), id = useId();
    useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
    return <dialog ref={ref} className="hapi-voice-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }}>
        <header><h2 id={id}>{title}</h2><span><button type="button" onClick={minimize} aria-label={title.startsWith('语音') ? '最小化语音并继续' : 'Minimize voice and continue'}>−</button>
            <button type="button" onClick={close} aria-label={title.startsWith('语音') ? '关闭语音' : 'Close voice'}>×</button></span></header>{children}
    </dialog>;
}

export function VoiceComposer({ ctx, api, transport, catalog, ui, language, binding, source, composer, readOnly, initialOpen = false }: {
    ctx: Context; api: HapiRemoteApi; transport: SourceVoiceTransport; catalog: VoiceCatalog; ui: WorkspaceUiScope; language: string;
    binding: SessionBinding; source: WorkbenchSource | null; composer: ComposerProps; readOnly: boolean; initialOpen?: boolean;
}) {
    useEffect(() => { if (initialOpen) void catalog.refresh(); }, [catalog, initialOpen]);
    const tr = words(language), navigation = useWorkspacePane(ctx), identity = `${navigation?.paneId ?? 'main'}:${binding.sessionId}`;
    const dictationId = `${identity}:dictation`, assistantId = `${identity}:voice`;
    const ownerId = useSyncExternalStore(ui.voice.subscribe, ui.voice.getSnapshot);
    const { preferences } = useVoicePreferences(ui.preferences, catalog);
    const [open, setOpen] = useState(initialOpen), [settingsOpen, setSettingsOpen] = useState(false), [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(''), [notice, setNotice] = useState('');
    const insertion = useRef<TokenSpan | null>(null), latest = useRef(composer); latest.current = composer;
    const reader = useMemo(() => voiceContextReader(ctx, api, binding, source), [ctx, api, binding, source]);
    const owner = useMemo(() => voiceToolOwner(ctx, api, binding, source !== null, reader), [ctx, api, binding, source, reader]);
    const final = (text: string) => {
        if (!text) { setNotice(tr('No transcript was returned.', '没有返回转录文本。')); return; }
        try {
            assertVoiceBinding(ctx, binding);
            if (insertion.current && latest.current.inputActions.insertText(text, insertion.current)) {
                latest.current.inputActions.persistDraft(); setPending(''); setNotice(tr('Transcript inserted into this draft. Review it before sending.', '转录已插入当前输入框，请检查后再发送。')); return;
            }
            setPending(text); setNotice(tr('The draft changed while listening. The transcript is retained below; insert it when ready.', '听写期间输入框已变化。转录保留在下方，可在准备好后插入。'));
        } catch (failure) { setPending(text); setError(voiceError(failure)); }
    };
    const dictation = useSourceDictation(transport, final, () => ui.voice.release(dictationId));
    const assistant = useVoiceAssistant(transport, owner, () => ui.voice.release(assistantId));
    const current = useRef({ dictation, assistant }); current.current = { dictation, assistant };
    const recording = ['connecting', 'listening', 'processing'].includes(dictation.status);
    const talking = ui.voice.owns(assistantId), ours = ui.voice.owns(dictationId) || talking;
    const active = recording || talking, busyElsewhere = ownerId !== null && !ours;
    const stop = async () => { current.current.dictation.cancel(); await current.current.assistant.stop(); };
    const showError = (failure: unknown) => setError(voiceError(failure));
    const close = () => { void stop().then(() => { setOpen(false); setSettingsOpen(false); }, showError); };
    useEffect(() => {
        if (assistant.state.status !== 'connected') return;
        try { assistant.state.notice ? ui.preferences.setItem('hapi-voice-context-notice', assistant.state.notice) : ui.preferences.removeItem('hapi-voice-context-notice'); }
        catch (failure) { setError(voiceError(failure)); }
    }, [assistant.state.status, assistant.state.notice, ui.preferences]);
    useEffect(() => {
        const exit = () => { current.current.dictation.cancel(); void current.current.assistant.stop().catch(() => {}); };
        window.addEventListener('pagehide', exit); return () => { window.removeEventListener('pagehide', exit); exit(); };
    }, []);
    useEffect(() => navigation?.registerCloseGuard(() => !pending || window.confirm(tr('Close this pane and discard the uninserted voice transcript?', '关闭此窗格并丢弃尚未插入的语音转录？'))), [navigation, pending, language]);
    const begin = async (retry = false) => {
        setError(null); setNotice('');
        try {
            assertVoiceBinding(ctx, binding);
            const dictate = retry || preferences.mode === 'dictation';
            if (dictate) {
                if (!retry && !supportsDictation(preferences)) throw new Error(tr('Configure a supported dictation provider in Voice settings.', '请在语音设置中配置此浏览器支持的转录服务。'));
                if (!ui.voice.claim(dictationId, () => current.current.dictation.cancel())) throw new Error(tr('Another pane owns the microphone. Stop its voice activity before starting here.', '其他窗格正在使用麦克风，请先停止那里的语音。'));
                insertion.current = latest.current.inputActions.captureInsertion();
                try { if (retry) await dictation.retry(); else await dictation.start(preferences); }
                catch (failure) { ui.voice.release(dictationId); throw failure; }
            } else {
                if (readOnly) throw new Error(tr('This source is read-only. Resume control in the original conversation before starting its voice assistant.', '此源会话当前只读，请先在原会话恢复控制，再启动语音助手。'));
                if (!preferences.backend) throw new Error(tr('Configure a voice assistant backend in Voice settings.', '请先在语音设置中配置语音助手后端。'));
                if (!ui.voice.claim(assistantId, () => current.current.assistant.stop())) throw new Error(tr('Another pane owns the microphone. Stop its voice activity before starting here.', '其他窗格正在使用麦克风，请先停止那里的语音。'));
                // Only the actual connection owner releases its claim after
                // cleanup. A stale React snapshot cannot prove that cleanup.
                await assistant.start(preferences);
            }
        } catch (failure) { showError(failure); }
    };
    const insertPending = () => { try {
        assertVoiceBinding(ctx, binding);
        if (!latest.current.inputActions.insertText(pending, latest.current.inputActions.captureInsertion())) throw new Error(tr('The draft changed again. Your transcript is retained.', '输入框再次变化，转录仍保留。'));
        latest.current.inputActions.persistDraft(); setPending(''); setNotice(tr('Transcript inserted. Review it before sending.', '转录已插入，请检查后再发送。'));
    } catch (failure) { showError(failure); } };
    const dictationLabel = ({ idle: tr('Ready to dictate', '准备听写'), connecting: tr('Connecting microphone…', '正在连接麦克风…'), listening: tr('Listening', '正在听写'), processing: tr('Transcribing…', '正在转录…'), error: tr('Transcription stopped', '转录已停止') })[dictation.status];
    const assistantLabel = ({ idle: tr('Ready to call', '准备通话'), connecting: tr('Connecting voice assistant…', '正在连接语音助手…'), connected: assistant.state.mode === 'speaking' ? tr('Assistant speaking', '助手正在说话') : tr('Listening', '正在聆听'), stopping: tr('Closing microphone and connection…', '正在关闭麦克风与连接…'), error: tr('Voice stopped', '语音已停止') })[assistant.state.status];
    return <div className="hapi-voice-seat"><button type="button" className={active ? 'hapi-voice-trigger hapi-voice-live' : 'hapi-voice-trigger'} aria-haspopup="dialog"
        aria-label={tr('Voice and dictation', '语音与听写')} title={active ? tr('Voice active', '语音正在使用') : tr('Voice and dictation', '语音与听写')}
        onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(true); void catalog.refresh(); }}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5V18M6.5 18h7" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
        {active ? <span>{tr('Live', '正在使用')}</span> : pending ? <span>{tr('Transcript ready', '转录待插入')}</span> : null}</button>
        {open && <Dialog title={tr('Voice and dictation', '语音与听写')} close={close} minimize={() => setOpen(false)}><div className="hapi-voice-body">
            <p className="hapi-voice-session">{tr('Bound to this conversation', '绑定到当前会话')} · <code>{binding.sessionId}</code></p>
            {error && <p role="alert" className="hapi-voice-error">{error}</p>}
            {busyElsewhere && <div className="hapi-voice-warning"><p>{tr('A different pane currently owns the microphone.', '另一个窗格正在使用麦克风。')}</p>
                <button type="button" onClick={() => { void ui.voice.stop().catch(showError); }}>{tr('Stop the other voice activity', '停止其他窗格的语音')}</button></div>}
            <div className="hapi-voice-row"><button type="button" disabled={active} aria-pressed={preferences.mode === 'dictation'} onClick={() => { try { ui.preferences.setItem('hapi-voice-mode', 'dictation'); } catch (failure) { showError(failure); } }}>{tr('Dictation', '听写')}</button>
                <button type="button" disabled={active} aria-pressed={preferences.mode === 'assistant'} onClick={() => { try { ui.preferences.setItem('hapi-voice-mode', 'assistant'); } catch (failure) { showError(failure); } }}>{tr('Voice assistant', '语音助手')}</button>
                <button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>{tr('Voice settings', '语音设置')}</button></div>
            {(preferences.mode === 'dictation' || recording) && !talking ? <section aria-label={tr('Dictation', '听写')}>
                <p role="status">{dictationLabel} · {preferences.provider ?? tr('No provider selected', '尚未选择服务商')} · {preferences.transcriptionMode}</p>
                {dictation.error && <p role="alert" className="hapi-voice-error">{dictation.error}</p>}
                <div className="hapi-voice-row">{recording ? <><button type="button" disabled={dictation.status !== 'listening'} onClick={() => { void dictation.stop().catch(showError); }}>{tr('Stop and transcribe', '停止并转录')}</button>
                    <button type="button" onClick={dictation.cancel}>{tr('Cancel recording', '取消录音')}</button></>
                    : <button type="button" disabled={busyElsewhere} onClick={() => { void begin(); }}>{tr('Start dictation', '开始听写')}</button>}
                    {dictation.retryAvailable && !recording && <button type="button" disabled={busyElsewhere} onClick={() => { void begin(true); }}>{tr('Retry the retained recording', '重新提交保留的录音')}</button>}</div>
                {dictation.partial && <div className="hapi-voice-transcript"><p>{tr('Live transcript', '实时转录')}</p><pre>{dictation.partial}</pre>{!recording && <button type="button" onClick={() => { setPending(dictation.partial); }}>{tr('Keep this partial transcript', '保留此部分转录')}</button>}</div>}
                <p><small>{tr('Speech is inserted into this draft without sending it. Existing text and attachment chips are preserved.', '语音只插入当前输入框，不自动发送；保留已有文字与附件。')}</small></p>
            </section> : <section aria-label={tr('Voice assistant', '语音助手')}>
                <p role="status">{assistantLabel} · {preferences.backend ? VOICE_BACKEND_LABELS[preferences.backend] : tr('No backend selected', '尚未选择后端')}</p>
                {assistant.state.error && <p role="alert" className="hapi-voice-error">{assistant.state.error}</p>}{assistant.state.notice && <p role="status">{assistant.state.notice}</p>}
                <div className="hapi-voice-row">{talking ? <><button type="button" disabled={assistant.state.status !== 'connected'} aria-pressed={assistant.state.muted} onClick={() => assistant.setMuted(!assistant.state.muted)}>{assistant.state.muted ? tr('Unmute microphone', '取消麦克风静音') : tr('Mute microphone', '麦克风静音')}</button>
                    <button type="button" onClick={() => { void assistant.stop().catch(showError); }}>{tr('End voice call', '结束语音通话')}</button></>
                    : <button type="button" disabled={busyElsewhere || readOnly} onClick={() => { void begin(); }}>{tr('Start voice call', '开始语音通话')}</button>}</div>
                {readOnly && <p>{tr('Resume the original source conversation to send requests through voice.', '请恢复原源会话后再通过语音发送请求。')}</p>}
                <p><small>{tr('The selected voice provider receives bounded conversation context and microphone audio. Spoken coding requests use this conversation’s normal queue; approval responses apply only to the one pending request advertised to this voice connection.', '所选语音服务商会收到有边界的会话上下文与麦克风音频。口述任务进入当前会话的正常队列；审批仅作用于已告知本次语音连接的那一条待处理请求。')}</small></p>
                {assistant.state.caption && <p className="hapi-voice-caption" aria-live="polite">{assistant.state.caption}</p>}
                {assistant.state.receipts.length > 0 && <details><summary>{tr('Voice tool receipts', '语音工具回执')} ({assistant.state.receipts.length})</summary>{assistant.state.receipts.map(receipt => <article key={receipt.id}>
                    <strong>{receipt.name} · {receipt.status}</strong><p>{receipt.result || tr('Waiting for source admission…', '等待源确认接收…')}</p>{receipt.requestId && <code>{receipt.requestId}</code>}</article>)}</details>}
            </section>}
            {notice && <p role="status">{notice}</p>}{pending && <section><label>{tr('Retained transcript', '已保留的转录')}<textarea rows={5} value={pending} onChange={event => setPending(event.target.value)}/></label>
                <div className="hapi-voice-row"><button type="button" onClick={insertPending}>{tr('Insert into current draft', '插入当前输入框')}</button><button type="button" onClick={() => { void navigator.clipboard.writeText(pending).catch(showError); }}>{tr('Copy transcript', '复制转录')}</button><button type="button" onClick={() => setPending('')}>{tr('Discard transcript', '丢弃转录')}</button></div></section>}
            {settingsOpen && <section className="hapi-voice-settings"><VoicePreferencesPanel api={api} store={ui.preferences} catalog={catalog} language={language} disabled={active}/><VoiceCredentialsPanel api={api} catalog={catalog} language={language}/></section>}
        </div></Dialog>}
    </div>;
}

