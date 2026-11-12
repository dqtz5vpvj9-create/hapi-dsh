import { useMemo, useSyncExternalStore } from 'react'
import type { WorkspaceUiPreferences } from '../ui-preferences.ts'
import { hasBrowserLocalSpeechSupport } from './browser-local.ts'
import { LANGUAGES, getLanguageDisplayName } from './languages.ts'
import { preferenceSnapshot, readVoicePreferences } from './preferences.ts'
export const words = (language: string) => (en: string, zh: string) => language.startsWith('zh') ? zh : en
export function useVoicePreferences(store: WorkspaceUiPreferences) {
    const snapshot = useSyncExternalStore(store.subscribe, () => preferenceSnapshot(store))
    return useMemo(() => readVoicePreferences(store), [store, snapshot])
}
export function VoicePreferencesPanel({ store, language, disabled = false }: { store: WorkspaceUiPreferences; language: string; disabled?: boolean }) {
    const preferences = useVoicePreferences(store), tr = words(language), supported = hasBrowserLocalSpeechSupport()
    return <div className="hapi-voice-preferences">
        <p>{supported ? tr('Dictation uses this browser’s installed on-device speech recognition.', '听写使用此浏览器已安装的本机语音识别。')
            : tr('On-device dictation is unavailable in this browser.', '此浏览器不支持安全的本机听写。')}</p>
        <label>{tr('Recognition language', '识别语言')}<select value={preferences.language ?? ''} disabled={disabled || !supported}
            onChange={event => { try {
                if (event.currentTarget.value) store.setItem('hapi-voice-lang', event.currentTarget.value)
                else store.removeItem('hapi-voice-lang')
            } catch { /* The shared preference store retains its in-memory value. */ } }}>
            {LANGUAGES.map(row => <option key={row.code ?? 'browser'} value={row.code ?? ''}>{row.code ? getLanguageDisplayName(row) : tr('Browser language', '浏览器语言')}</option>)}
            {preferences.language && !LANGUAGES.some(row => row.code === preferences.language) && <option value={preferences.language}>{preferences.language}</option>}
        </select></label>
    </div>
}
