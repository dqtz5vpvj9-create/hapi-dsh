/** Original HAPI preference keys and migration; shared by the workspace's public UI scope. */
import type { WorkspaceUiPreferences } from '../ui-preferences.ts';
import { DEFAULT_VOICE_PERSONALITY, parseVoicePersonalityPreferences, type VoicePersonalityPreferences } from '../../voice/protocol/voicePersonality.ts';
import { resolveEffectiveVoiceBackend, type TranscriptionMode, type TranscriptionProvider, type VoiceMode } from '../../voice/protocol/voice.ts';
import { VOICE_PICKER_STORAGE_KEYS } from '../../voice/protocol/voicePickerCatalog.ts';
import { voiceLanguageSchema, type VoiceBackend, type VoiceCapabilities } from '../../voice-types.ts';
import { hasBrowserLocalSpeechSupport } from './browser-local.ts';

export interface VoicePreferences {
    mode: VoiceMode; provider: TranscriptionProvider | null; transcriptionMode: TranscriptionMode; backend: VoiceBackend | null;
    language: string | undefined; voice: string | undefined; proactive: boolean; personality: VoicePersonalityPreferences;
}
export function voiceProviders(capabilities: VoiceCapabilities | null) {
    const rows = capabilities?.providers.filter(row => row.id !== 'browser-local') ?? [];
    return hasBrowserLocalSpeechSupport() ? [...rows, { id: 'browser-local' as const, label: 'Browser on-device', modes: ['realtime' as const] }] : rows;
}
export function readVoicePreferences(store: WorkspaceUiPreferences, capabilities: VoiceCapabilities | null): VoicePreferences {
    const providers = voiceProviders(capabilities), savedProvider = store.getItem('hapi-transcription-provider');
    const provider = providers.find(row => row.id === savedProvider) ?? providers[0]; const mode = store.getItem('hapi-transcription-mode');
    const backend = resolveEffectiveVoiceBackend(capabilities?.backends ?? [], capabilities?.backend ?? null, store.getItem('hapi-voice-backend'));
    let personality = structuredClone(DEFAULT_VOICE_PERSONALITY);
    try { const saved = store.getItem('hapi-voice-personality'); if (saved) personality = parseVoicePersonalityPreferences(JSON.parse(saved)); } catch { /* Keep original default on invalid legacy data. */ }
    const language = voiceLanguageSchema.safeParse(store.getItem('hapi-voice-lang'));
    const voice = backend ? store.getItem(VOICE_PICKER_STORAGE_KEYS[backend]) ?? (backend === 'elevenlabs' ? store.getItem('hapi-voice-id') : null) : null;
    return { mode: store.getItem('hapi-voice-mode') === 'dictation' ? 'dictation' : 'assistant', provider: provider?.id ?? null,
        transcriptionMode: (mode === 'standard' || mode === 'realtime') && provider?.modes.includes(mode) ? mode : provider?.modes[0] ?? 'standard',
        backend, language: language.success ? language.data : undefined, voice: voice || undefined,
        proactive: store.getItem('hapi-voice-proactive') === 'true', personality };
}
export function preferenceSnapshot(store: WorkspaceUiPreferences): string {
    return JSON.stringify(['hapi-voice-mode', 'hapi-transcription-provider', 'hapi-transcription-mode', 'hapi-voice-lang', 'hapi-voice-personality', 'hapi-voice-context-notice', 'hapi-voice-proactive',
        'hapi-voice-id', 'hapi-voice-elevenlabs', 'hapi-voice-gemini', 'hapi-voice-qwen', 'hapi-voice-backend'].map(key => store.getItem(key as Parameters<WorkspaceUiPreferences['getItem']>[0])));
}
