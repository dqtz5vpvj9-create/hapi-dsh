import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { remoteValue } from '../../client-api.ts';
import type { VoiceCredentialUpdate, VoiceCredentials, SourceVoiceApi } from '../../voice-types.ts';
import type { WorkspacePreferenceKey, WorkspaceUiPreferences } from '../ui-preferences.ts';
import { DEFAULT_VOICE_PERSONALITY, VOICE_PERSONALITY_PRESETS, RESPONSE_LENGTH_OPTIONS, getVoicePersonalityPreset,
    VOICE_IDENTITY_MAX_LENGTH, VOICE_CHARACTER_MAX_LENGTH, resolveComposedVoiceSystemPrompt, getVoicePlatformFixturesPreview, resolveElevenLabsVoiceSettings,
    type VoicePersonalityPreferences, type VoicePersonalityPresetId } from '../../voice/protocol/voicePersonality.ts';
import { GEMINI_LIVE_VOICE_OPTIONS, QWEN_REALTIME_VOICE_OPTIONS, VOICE_BACKEND_LABELS, VOICE_PICKER_STORAGE_KEYS } from '../../voice/protocol/voicePickerCatalog.ts';
import { LANGUAGES, getLanguageDisplayName } from './languages.ts';
import { preferenceSnapshot, readVoicePreferences, voiceProviders } from './preferences.ts';
import { voiceError } from './assistant.ts';
import type { VoiceCatalog } from './catalog.ts';

export const words = (language: string) => (en: string, zh: string) => language.startsWith('zh') ? zh : en;
export function useVoicePreferences(store: WorkspaceUiPreferences, catalog: VoiceCatalog) {
    const readiness = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
    const snapshot = useSyncExternalStore(store.subscribe, () => preferenceSnapshot(store));
    const preferences = useMemo(() => readVoicePreferences(store, readiness.value), [store, snapshot, readiness.value]);
    return { ...readiness, preferences };
}
export interface VoicePreferencesProps { api: SourceVoiceApi; store: WorkspaceUiPreferences; catalog: VoiceCatalog; language: string; disabled?: boolean }

/** Original HAPI keys and personality model, rendered as an additive DSH settings page. */
export function VoicePreferencesPanel({ api, store, catalog, language, disabled = false }: VoicePreferencesProps) {
    const state = useVoicePreferences(store, catalog), { preferences } = state, tr = words(language);
    const [error, setError] = useState<string | null>(null), [voices, setVoices] = useState<Array<{ id: string; name: string; previewUrl: string | null }>>([]);
    const [voiceErrorText, setVoiceError] = useState<string | null>(null), [loadingVoices, setLoadingVoices] = useState(false), [voiceRefresh, setVoiceRefresh] = useState(0);
    const write = (key: WorkspacePreferenceKey, value: string | null) => { try { value === null ? store.removeItem(key) : store.setItem(key, value); setError(null); } catch (failure) { setError(voiceError(failure)); } };
    const personality = (patch: Partial<VoicePersonalityPreferences>) => write('hapi-voice-personality', JSON.stringify({ ...preferences.personality, ...patch }));
    const provider = voiceProviders(state.value).find(row => row.id === preferences.provider);
    const tts = resolveElevenLabsVoiceSettings(preferences.personality);
    useEffect(() => { void catalog.refresh(); }, [catalog]);
    useEffect(() => {
        if (preferences.backend !== 'elevenlabs') return;
        const abort = new AbortController(); setLoadingVoices(true); setVoiceError(null);
        void api.sourceVoiceVoices({}, abort.signal).then(remoteValue).then(result => { if (!abort.signal.aborted) setVoices(result.voices); }, failure => {
            if (!abort.signal.aborted) setVoiceError(voiceError(failure));
        }).finally(() => { if (!abort.signal.aborted) setLoadingVoices(false); });
        return () => abort.abort();
    }, [api, preferences.backend, voiceRefresh]);
    const choices = preferences.backend === 'gemini-live' ? GEMINI_LIVE_VOICE_OPTIONS.map(row => ({ ...row, name: row.label }))
        : preferences.backend === 'qwen-realtime' ? QWEN_REALTIME_VOICE_OPTIONS.map(row => ({ ...row, name: row.label })) : voices;
    const selectedPreview = voices.find(row => row.id === preferences.voice)?.previewUrl;
    const safePreview = selectedPreview && /^https:\/\//i.test(selectedPreview) ? selectedPreview : undefined;
    const prompt = resolveComposedVoiceSystemPrompt(preferences.personality, {
        ...(preferences.backend ? { backend: preferences.backend } : {}), ...(preferences.language ? { language: preferences.language } : {}),
    });
    return <div className="hapi-voice-preferences">
        {state.loading && !state.value && <p role="status">{tr('Reading voice configuration…', '正在读取语音配置…')}</p>}
        {state.error && <p role="alert" className="hapi-voice-error">{state.error}</p>}{error && <p role="alert" className="hapi-voice-error">{error}</p>}
        {store.getItem('hapi-voice-context-notice') && <p role="status"><small>{tr('Last voice session', '上次语音会话')}: {store.getItem('hapi-voice-context-notice')?.slice(0, 8192)}</small></p>}
        <fieldset disabled={disabled}>
            <div className="hapi-voice-grid">
                <label>{tr('Microphone action', '麦克风操作')}<select value={preferences.mode} onChange={event => write('hapi-voice-mode', event.currentTarget.value)}>
                    <option value="dictation">{tr('Dictate into the draft', '听写到输入框')}</option><option value="assistant">{tr('Talk to a voice assistant', '与语音助手通话')}</option>
                </select></label>
                <label>{tr('Language', '语言')}<select value={preferences.language ?? ''} onChange={event => write('hapi-voice-lang', event.currentTarget.value || null)}>
                    {LANGUAGES.map(row => <option key={row.code ?? 'auto'} value={row.code ?? ''}>{row.code ? getLanguageDisplayName(row) : tr('Auto-detect', '自动检测')}</option>)}
                    {preferences.language && !LANGUAGES.some(row => row.code === preferences.language) && <option value={preferences.language}>{preferences.language}</option>}
                </select></label>
            </div>
            <h3>{tr('Dictation', '听写')}</h3>
            <div className="hapi-voice-grid"><label>{tr('Transcription provider', '转录服务商')}<select value={preferences.provider ?? ''} onChange={event => write('hapi-transcription-provider', event.currentTarget.value)}>
                {!preferences.provider && <option value="">{tr('Configure a provider below', '请先配置服务商')}</option>}
                {voiceProviders(state.value).map(row => <option key={row.id} value={row.id}>{row.id === 'browser-local' ? tr('Browser on-device', '浏览器本地识别') : row.label}</option>)}
            </select></label><label>{tr('Transcription mode', '转录模式')}<select value={preferences.transcriptionMode} disabled={!provider} onChange={event => write('hapi-transcription-mode', event.currentTarget.value)}>
                {(provider?.modes ?? [preferences.transcriptionMode]).map(mode => <option key={mode} value={mode}>{mode === 'standard' ? tr('Record, then transcribe', '录音后转录') : tr('Live transcription', '实时转录')}</option>)}
            </select></label></div>
            {preferences.provider === 'browser-local' && <p><small>{tr('Recognition is explicitly on-device. Browser language packs may need installing; this option never falls back to a browser cloud recognizer.', '此选项明确使用设备内识别，浏览器可能需要安装语言包；不会回退到浏览器云端识别。')}</small></p>}
            <h3>{tr('Voice assistant', '语音助手')}</h3>
            <div className="hapi-voice-grid"><label>{tr('Conversation backend', '语音会话后端')}<select value={preferences.backend ?? ''} onChange={event => write('hapi-voice-backend', event.currentTarget.value)}>
                {!preferences.backend && <option value="">{tr('Configure a backend below', '请先配置语音后端')}</option>}
                {(state.value?.backends ?? []).map(backend => <option key={backend} value={backend}>{VOICE_BACKEND_LABELS[backend]}</option>)}
            </select></label><label>{tr('Voice', '音色')}<select disabled={!preferences.backend || loadingVoices} value={preferences.voice ?? ''} onChange={event => { if (preferences.backend) write(VOICE_PICKER_STORAGE_KEYS[preferences.backend], event.currentTarget.value || null); }}>
                <option value="">{tr('Provider default', '服务商默认')}</option>{choices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                {preferences.voice && !choices.some(voice => voice.id === preferences.voice) && <option value={preferences.voice}>{preferences.voice}</option>}
            </select></label></div>
            {voiceErrorText && <p role="alert" className="hapi-voice-error">{voiceErrorText}</p>}
            {preferences.backend === 'elevenlabs' && <div className="hapi-voice-row"><button type="button" disabled={loadingVoices} onClick={() => setVoiceRefresh(value => value + 1)}>{tr('Refresh voice catalog', '刷新音色列表')}</button>
                {safePreview && <audio key={safePreview} controls preload="none" src={safePreview} aria-label={tr('Voice preview', '音色试听')}/>}</div>}
            <label className="hapi-voice-check"><input type="checkbox" checked={preferences.proactive} onChange={event => write('hapi-voice-proactive', String(event.currentTarget.checked))}/>
                {tr('Speak a summary when the coding agent becomes idle', '编程代理空闲时主动朗读摘要')}</label>
            <details><summary>{tr('Personality and delivery', '性格与表达方式')}</summary>
                <div className="hapi-voice-grid"><label>{tr('Preset', '预设')}<select value={preferences.personality.preset} onChange={event => {
                    const preset = event.currentTarget.value as VoicePersonalityPresetId; personality({ preset, elevenLabs: { ...getVoicePersonalityPreset(preset).elevenLabs } });
                }}>{VOICE_PERSONALITY_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{tr(preset.id, ({ balanced: '均衡', warm: '温暖', calm: '平静', direct: '直接', custom: '自定义' })[preset.id])}</option>)}</select></label>
                <label>{tr('Response length', '回复长度')}<select value={preferences.personality.responseLength} onChange={event => personality({ responseLength: event.currentTarget.value as VoicePersonalityPreferences['responseLength'] })}>
                    {RESPONSE_LENGTH_OPTIONS.map(length => <option key={length} value={length}>{tr(length, ({ brief: '简短', balanced: '均衡', detailed: '详细' })[length])}</option>)}</select></label></div>
                <label>{tr('Assistant identity', '助手身份')}<textarea rows={3} maxLength={VOICE_IDENTITY_MAX_LENGTH} value={preferences.personality.identity} placeholder={tr('Use the original HAPI identity', '使用原 HAPI 身份设定')}
                    onChange={event => personality({ identity: event.currentTarget.value, systemPrompt: '' })}/></label>
                <label>{tr('Character and speaking style', '性格与说话方式')}<textarea rows={4} maxLength={VOICE_CHARACTER_MAX_LENGTH} value={preferences.personality.character} placeholder={tr('Use the original character and selected preset', '使用原设定与已选预设')}
                    onChange={event => personality({ character: event.currentTarget.value, systemPrompt: '' })}/></label>
                {preferences.personality.systemPrompt && <details><summary>{tr('Retained legacy prompt', '已保留的旧版提示词')}</summary><textarea rows={6} maxLength={48000} value={preferences.personality.systemPrompt} onChange={event => personality({ systemPrompt: event.currentTarget.value })}/></details>}
                {preferences.backend === 'elevenlabs' && <div className="hapi-voice-grid">{(['stability', 'similarity_boost', 'style', 'speed'] as const).map(key => <label key={key}>{({ stability: tr('Stability', '稳定度'), similarity_boost: tr('Similarity', '音色相似度'), style: tr('Style intensity', '风格强度'), speed: tr('Speed', '语速') })[key]} · {tts[key].toFixed(2)}
                    <input type="range" min={key === 'speed' ? 0.7 : 0} max={key === 'speed' ? 1.2 : 1} step={0.01} value={tts[key]} onChange={event => personality({ preset: 'custom', elevenLabs: { ...tts, [key]: Number(event.currentTarget.value) } })}/>
                </label>)}<label className="hapi-voice-check"><input type="checkbox" checked={tts.use_speaker_boost} onChange={event => personality({ preset: 'custom', elevenLabs: { ...tts, use_speaker_boost: event.currentTarget.checked } })}/>{tr('Speaker boost', '增强说话人音色')}</label></div>}
                {preferences.backend === 'gemini-live' && <label className="hapi-voice-check"><input type="checkbox" checked={preferences.personality.gemini.affective_dialog} onChange={event => personality({ gemini: { affective_dialog: event.currentTarget.checked } })}/>{tr('Affective dialogue', '感情对话')}</label>}
                <div className="hapi-voice-row"><button type="button" onClick={() => write('hapi-voice-personality', JSON.stringify(DEFAULT_VOICE_PERSONALITY))}>{tr('Restore original personality', '恢复原性格设定')}</button></div>
                <details><summary>{tr('Effective prompt and protocol rules', '生效提示词与协议规则')} · {prompt.wireBytes.toLocaleString()} B</summary><pre>{prompt.prompt}</pre>
                    {prompt.truncated && <p>{tr('The prompt was shortened to the provider transport budget.', '提示词已按服务商传输预算截断。')}</p>}<pre>{getVoicePlatformFixturesPreview()}</pre></details>
            </details>
        </fieldset>
        <div className="hapi-voice-row"><button type="button" disabled={state.loading} onClick={() => { void catalog.refresh(); }}>{tr('Refresh available providers', '刷新可用服务商')}</button></div>
    </div>;
}

type SecretKey = 'openai' | 'elevenlabs' | 'deepgram' | 'groq' | 'geminiLive' | 'qwenRealtime';
const credentials = [ ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs'], ['deepgram', 'Deepgram'], ['groq', 'Groq'], ['geminiLive', 'Gemini Live'], ['qwenRealtime', 'Qwen Realtime'] ] as const;
function statusOf(state: VoiceCredentials, key: SecretKey) { return key === 'geminiLive' || key === 'qwenRealtime' ? state.voiceBackends[key] : state[key]; }

/** Secret drafts live only in mounted React state. All writes go to the original namespace owner. */
export function VoiceCredentialsPanel({ api, catalog, language }: Pick<VoicePreferencesProps, 'api' | 'catalog' | 'language'>) {
    const tr = words(language), mounted = useRef(true), generation = useRef(0);
    const [state, setState] = useState<VoiceCredentials | null>(null), [error, setError] = useState<string | null>(null), [note, setNote] = useState('');
    const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false);
    const [drafts, setDrafts] = useState<Partial<Record<SecretKey, string>>>({});
    const [compatible, setCompatible] = useState({ baseUrl: '', model: '', apiKey: '' });
    const refresh = useCallback(async () => {
        const revision = ++generation.current; setLoading(true); setError(null);
        try {
            const value = remoteValue(await api.sourceVoiceCredentials({}));
            if (mounted.current && revision === generation.current) { setState(value); setCompatible(current => ({ ...current, baseUrl: value.openaiCompatible.baseUrl ?? '', model: value.openaiCompatible.model ?? '' })); setUncertain(false); }
        } catch (failure) { if (mounted.current && revision === generation.current) setError(voiceError(failure)); }
        finally { if (mounted.current && revision === generation.current) setLoading(false); }
    }, [api]);
    useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; }; }, [refresh]);
    const save = async (update: VoiceCredentialUpdate, clear: () => void) => {
        if (saving || uncertain) return;
        setSaving(true); setError(null); setNote('');
        try { const value = remoteValue(await api.sourceVoiceUpdateCredentials({ update }));
            if (mounted.current) { setState(value); clear(); setNote(tr('The original Hub confirmed the update.', '原 Hub 已确认更新。')); } await catalog.refresh();
        } catch (failure) { if (mounted.current) { setError(voiceError(failure)); setUncertain(true); } }
        finally { if (mounted.current) setSaving(false); }
    };
    return <section className="hapi-voice-credentials"><h3>{tr('Provider credentials in the original HAPI Hub', '原 HAPI Hub 的服务商凭据')}</h3>
        <p><small>{tr('Only masked status is read back. Environment-controlled values keep the original Hub’s edit restrictions; keys are never saved in browser preferences.', '这里只读取掩码状态。环境变量控制的配置保留原 Hub 的编辑限制；密钥不保存到浏览器偏好中。')}</small></p>
        {error && <p role="alert" className="hapi-voice-error">{error}</p>}{note && <p role="status">{note}</p>}
        {uncertain && <p role="status">{tr('The update was not confirmed. It has not been retried. Refresh the original status before deciding on a new update.', '本次更新未获确认，未自动重试。请先刷新原始状态，再决定是否提交新的更新。')}</p>}
        {state && <fieldset disabled={saving || uncertain || loading}>
            {credentials.map(([key, label]) => { const status = statusOf(state, key); return <form key={key} className="hapi-voice-secret" onSubmit={event => { event.preventDefault(); if (drafts[key]?.trim()) void save({ [key]: drafts[key]!.trim() }, () => setDrafts(current => ({ ...current, [key]: '' }))); }}>
                <label>{label}<small>{status.configured ? `${tr('Configured', '已配置')} · ${status.hint ?? ''}` : tr('Not configured', '未配置')} · {status.source === 'env' ? tr('Environment', '环境变量') : status.source === 'settings' ? tr('Hub settings', 'Hub 设置') : tr('No key', '无密钥')}</small>
                    <input type="password" autoComplete="new-password" value={drafts[key] ?? ''} maxLength={16384} disabled={!status.editable} placeholder={tr('New API key', '新 API 密钥')}
                        aria-label={`${label} API key`} onChange={event => setDrafts(current => ({ ...current, [key]: event.target.value }))}/></label>
                <div className="hapi-voice-row"><button type="submit" disabled={!status.editable || !drafts[key]?.trim()}>{tr('Save', '保存')}</button>
                    <button type="button" disabled={!status.editable || status.source !== 'settings'} onClick={() => { if (window.confirm(tr(`Clear the saved ${label} key in the original Hub?`, `清除原 Hub 中保存的 ${label} 密钥？`))) void save({ [key]: null }, () => setDrafts(current => ({ ...current, [key]: '' }))); }}>{tr('Clear saved key', '清除已存密钥')}</button></div>
            </form>; })}
            <form onSubmit={event => { event.preventDefault(); const previous = state.openaiCompatible, update: NonNullable<VoiceCredentialUpdate['openaiCompatible']> = {};
                if (previous.baseUrlEditable && compatible.baseUrl !== (previous.baseUrl ?? '')) update.baseUrl = compatible.baseUrl.trim() || null;
                if (previous.modelEditable && compatible.model !== (previous.model ?? '')) update.model = compatible.model.trim() || null;
                if (previous.apiKey.editable && compatible.apiKey.trim()) update.apiKey = compatible.apiKey.trim();
                if (Object.keys(update).length) void save({ openaiCompatible: update }, () => setCompatible(current => ({ ...current, apiKey: '' })));
            }}><h4>{tr('OpenAI-compatible transcription', 'OpenAI 兼容转录')}</h4>
                <div className="hapi-voice-grid"><label>{tr('Base URL', '基础地址')}<input type="url" maxLength={8192} value={compatible.baseUrl} disabled={!state.openaiCompatible.baseUrlEditable} onChange={event => setCompatible(current => ({ ...current, baseUrl: event.target.value }))}/></label>
                    <label>{tr('Model', '模型')}<input value={compatible.model} maxLength={1024} disabled={!state.openaiCompatible.modelEditable} onChange={event => setCompatible(current => ({ ...current, model: event.target.value }))}/></label></div>
                <label>API key <small>{state.openaiCompatible.apiKey.hint ?? tr('No saved key', '无已存密钥')}</small><input type="password" autoComplete="new-password" maxLength={16384} value={compatible.apiKey} disabled={!state.openaiCompatible.apiKey.editable} onChange={event => setCompatible(current => ({ ...current, apiKey: event.target.value }))}/></label>
                <div className="hapi-voice-row"><button type="submit">{tr('Save compatible provider', '保存兼容服务商')}</button><button type="button" disabled={!state.openaiCompatible.apiKey.editable || state.openaiCompatible.apiKey.source !== 'settings'} onClick={() => {
                    if (window.confirm(tr('Clear the saved compatible-provider key?', '清除已保存的兼容服务商密钥？'))) void save({ openaiCompatible: { apiKey: null } }, () => setCompatible(current => ({ ...current, apiKey: '' })));
                }}>{tr('Clear saved key', '清除已存密钥')}</button></div>
            </form>
        </fieldset>}
        <button type="button" disabled={loading || saving} onClick={() => { void refresh(); }}>{loading ? tr('Reading…', '读取中…') : tr('Refresh credential status', '刷新凭据状态')}</button>
    </section>;
}
