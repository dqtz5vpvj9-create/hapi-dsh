/** Retain only the user's recognition language; remote provider settings are not read or changed. */
import type { WorkspaceUiPreferences } from '../ui-preferences.ts'
export interface VoicePreferences { language: string | undefined }
export function readVoicePreferences(store: WorkspaceUiPreferences): VoicePreferences {
    const saved = store.getItem('hapi-voice-lang')
    try { return { language: saved ? Intl.getCanonicalLocales(saved)[0] : undefined } }
    catch { return { language: undefined } }
}
export function preferenceSnapshot(store: WorkspaceUiPreferences): string { return store.getItem('hapi-voice-lang') ?? '' }
