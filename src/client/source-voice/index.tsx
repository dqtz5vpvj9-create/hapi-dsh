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

function VoiceComposer({ ctx, api, transport, catalog, ui, language, binding, source, composer, readOnly }: {
    ctx: Context; api: HapiRemoteApi; transport: SourceVoiceTransport; catalog: VoiceCatalog; ui: WorkspaceUiScope; language: string;
    binding: SessionBinding; source: WorkbenchSource | null; composer: ComposerProps; readOnly: boolean;
}) {
    const tr = words(language), navigation = useWorkspacePane(ctx), identity = `${navigation?.paneId ?? 'main'}:${binding.sessionId}`;
    const dictationId = `${identity}:dictation`, assistantId = `${identity}:voice`;
    const ownerId = useSyncExternalStore(ui.voice.subscribe, ui.voice.getSnapshot);
    const { preferences } = useVoicePreferences(ui.preferences, catalog);
    const [open, setOpen] = useState(false), [settingsOpen, setSettingsOpen] = useState(false), [error, setError] = useState<string | null>(null);
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

function installVoiceSeats(ctx: Context, api: HapiRemoteApi, shared: WorkspaceUiScope): () => void {
    const transport = new SourceVoiceTransport(api), catalog = new VoiceCatalog(api), disposers: Array<() => void> = [];
    const language = () => ctx.locale.getSnapshot().active;
    const Composer = (props: ComposerProps) => {
        const lang = useSyncExternalStore(listener => ctx.locale.subscribe(listener), language);
        const ui = useWorkspacePane(ctx) ?? shared;
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), projection = native ?? observed;
        const source = useMemo(() => projection ? { sourceSessionId: projection.hapiSessionId, sourceHubId: projection.hubId,
            ...(projection.machineId ? { machineId: projection.machineId } : {}) } : null, [projection?.hapiSessionId, projection?.hubId, projection?.machineId]);
        const binding = ctx.sessions.binding(props.sessionId);
        if (!binding || observed?.sidechain) return null;
        return <VoiceComposer key={props.sessionId} ctx={ctx} api={api} transport={transport} catalog={catalog} ui={ui} language={lang}
            binding={binding} source={source} composer={props} readOnly={Boolean(projection?.readOnly)}/>;
    };
    const Settings = (_props: PropsRuntime<'settings.section'>) => {
        const lang = useSyncExternalStore(listener => ctx.locale.subscribe(listener), language);
        const ui = useWorkspacePane(ctx) ?? shared;
        return <section className="hapi-voice-settings" aria-label={words(lang)('Voice and dictation settings', '语音与听写设置')}><h2>{words(lang)('Voice and dictation', '语音与听写')}</h2>
            <VoicePreferencesPanel api={api} store={ui.preferences} catalog={catalog} language={lang}/><VoiceCredentialsPanel api={api} catalog={catalog} language={lang}/></section>;
    };
    disposers.push(ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'hapi-dsh/voice', order: 85 }, Composer)));
    disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'hapi-voice', order: 36, label: () => words(language())('Voice and dictation', '语音与听写') }, Settings)));
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
    return () => { for (const dispose of disposers.reverse()) dispose(); catalog.dispose(); style.remove(); };
}

export function installSourceVoice(ctx: Context, api: HapiRemoteApi): () => void {
    // A graph may not invent a temporary independent microphone coordinator
    // while the shared workspace capability is still starting.
    const scope = ctx.inject(['hapiWorkspaceUi', 'uiSession'], owner => installVoiceSeats(owner, api, owner.hapiWorkspaceUi));
    return () => { void scope.dispose(); };
}

const styles = `
.hapi-voice-seat{display:inline-flex;align-items:center}.hapi-voice-trigger{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:inherit;padding:5px;border-radius:6px;cursor:pointer;font:inherit;font-size:11px}.hapi-voice-live{color:var(--text-link,#537dce);background:color-mix(in srgb,currentColor 12%,transparent)}
.hapi-voice-dialog{color:var(--text-primary,inherit);background:var(--bg-primary,Canvas);border:1px solid var(--border-secondary,#8886);border-radius:14px;width:min(680px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;box-sizing:border-box;box-shadow:0 16px 70px #0005}.hapi-voice-dialog::backdrop{background:#0006}.hapi-voice-dialog>header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border-secondary,#8885);position:sticky;top:0;background:var(--bg-primary,Canvas);z-index:1}.hapi-voice-dialog h2,.hapi-voice-settings h2{font-size:18px;margin:0}.hapi-voice-dialog>header button{border:0;background:transparent;font-size:24px;padding:2px 8px;color:inherit;cursor:pointer}.hapi-voice-body{padding:16px 18px;font-size:14px;line-height:1.5}
.hapi-voice-settings{font-size:14px;line-height:1.5;color:inherit}.hapi-voice-settings h3{font-size:15px;margin:22px 0 10px}.hapi-voice-settings h4{font-size:14px;margin:14px 0 8px}.hapi-voice-body label,.hapi-voice-settings label{display:grid;gap:5px;margin:10px 0}.hapi-voice-body input:not([type=checkbox]):not([type=range]),.hapi-voice-body textarea,.hapi-voice-body select,.hapi-voice-settings input:not([type=checkbox]):not([type=range]),.hapi-voice-settings textarea,.hapi-voice-settings select{width:100%;min-width:0;box-sizing:border-box;font:inherit;color:inherit;background:var(--bg-input,transparent);border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:8px}.hapi-voice-body textarea,.hapi-voice-settings textarea{resize:vertical}.hapi-voice-body button,.hapi-voice-settings button{color:inherit;background:var(--bg-secondary,transparent);border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}.hapi-voice-body button:disabled,.hapi-voice-settings button:disabled{opacity:.5;cursor:default}.hapi-voice-body button[aria-pressed=true]{border-color:var(--text-link,#537dce);background:color-mix(in srgb,var(--text-link,#537dce) 12%,transparent)}
.hapi-voice-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}.hapi-voice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.hapi-voice-settings fieldset{border:0;margin:0;padding:0;min-width:0}.hapi-voice-settings .hapi-voice-check{display:flex;align-items:center;gap:8px}.hapi-voice-settings small,.hapi-voice-body small{opacity:.72}.hapi-voice-settings details,.hapi-voice-body details{margin:12px 0}.hapi-voice-settings summary,.hapi-voice-body summary{cursor:pointer}.hapi-voice-settings pre,.hapi-voice-body pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font-size:12px}.hapi-voice-secret{border-bottom:1px solid var(--border-secondary,#8884);padding:6px 0 10px}.hapi-voice-credentials{border-top:1px solid var(--border-secondary,#8885);margin-top:20px;padding-top:5px}.hapi-voice-settings audio{max-width:100%;height:34px}.hapi-voice-error{color:var(--text-error,#d45d62);overflow-wrap:anywhere}.hapi-voice-warning{border:1px solid var(--border-secondary,#8886);border-radius:8px;padding:10px}.hapi-voice-session{font-size:12px;opacity:.75;margin:0 0 12px;overflow-wrap:anywhere}.hapi-voice-caption{border-left:3px solid var(--text-link,#537dce);padding:8px 12px;white-space:pre-wrap}.hapi-voice-body article{margin:10px 0;padding:10px;border:1px solid var(--border-secondary,#8884);border-radius:7px;font-size:12px}.hapi-voice-body code{overflow-wrap:anywhere}.hapi-voice-transcript{border:1px solid var(--border-secondary,#8885);padding:10px;border-radius:7px}
@media(max-width:540px){.hapi-voice-grid{grid-template-columns:1fr}.hapi-voice-dialog{max-height:calc(100dvh - 12px);width:calc(100vw - 12px);border-radius:10px}.hapi-voice-body{padding:12px}.hapi-voice-body button,.hapi-voice-settings button{min-height:36px}.hapi-voice-settings input,.hapi-voice-settings select,.hapi-voice-settings textarea{font-size:16px!important}}
`;
