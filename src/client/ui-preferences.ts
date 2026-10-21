/** The small, explicit set of original HAPI UI preferences shared by every pane graph. */
export type WorkspacePreferenceKey = 'hapi-terminal-touchbar-keys' | 'hapi-terminal-toolbar-settings'
    | 'hapi-voice-mode' | 'hapi-transcription-provider' | 'hapi-transcription-mode'
    | 'hapi-voice-lang' | 'hapi-voice-personality' | 'hapi-voice-context-notice' | 'hapi-voice-proactive'
    | 'hapi-voice-id' | 'hapi-voice-elevenlabs' | 'hapi-voice-gemini' | 'hapi-voice-qwen' | 'hapi-voice-backend'
    | 'hapi-appearance' | 'hapi-color-theme' | 'hapi-theme-colors' | 'hapi-font-scale' | 'hapi-terminal-font-size'
    | 'hapi-user-message-bg' | 'hapi-tool-group-bg' | 'hapi-session-header-metadata' | 'hapi-composer-toolbar-layout'
    | 'hapi-reasoning-collapsed' | 'hapi-codex-exploration-collapsed' | 'hapi-terminal-tool-display-mode'
    | 'hapi-open-external-links-in-new-tab' | 'hapi-dsh-appearance-enabled' | 'hapi.sessionExportFormat'
export interface WorkspaceUiPreferences {
    getItem(key: WorkspacePreferenceKey): string | null
    setItem(key: WorkspacePreferenceKey, value: string): void
    removeItem(key: WorkspacePreferenceKey): void
    subscribe(listener: () => void): () => void
}
const keys = new Set<WorkspacePreferenceKey>(['hapi-terminal-touchbar-keys', 'hapi-terminal-toolbar-settings',
    'hapi-voice-mode', 'hapi-transcription-provider', 'hapi-transcription-mode', 'hapi-voice-lang', 'hapi-voice-personality',
    'hapi-voice-context-notice', 'hapi-voice-proactive', 'hapi-voice-id', 'hapi-voice-elevenlabs', 'hapi-voice-gemini',
    'hapi-voice-qwen', 'hapi-voice-backend',
    'hapi-appearance', 'hapi-color-theme', 'hapi-theme-colors', 'hapi-font-scale', 'hapi-terminal-font-size',
    'hapi-user-message-bg', 'hapi-tool-group-bg', 'hapi-session-header-metadata', 'hapi-composer-toolbar-layout',
    'hapi-reasoning-collapsed', 'hapi-codex-exploration-collapsed', 'hapi-terminal-tool-display-mode',
    'hapi-open-external-links-in-new-tab', 'hapi-dsh-appearance-enabled', 'hapi.sessionExportFormat'])

export function createWorkspaceUiPreferences(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    events?: Pick<Window, 'addEventListener' | 'removeEventListener'>): WorkspaceUiPreferences & { dispose(): void } {
    const listeners = new Set<() => void>(), memory = new Map<WorkspacePreferenceKey, string | null>()
    const check = (key: WorkspacePreferenceKey): void => { if (!keys.has(key)) throw new Error('This key is not a shared workspace UI preference') }
    const publish = (): void => { for (const listener of [...listeners]) listener() }
    const changed = (event: StorageEvent): void => {
        if (event.key === null) { memory.clear(); publish() }
        else if (keys.has(event.key as WorkspacePreferenceKey)) { memory.delete(event.key as WorkspacePreferenceKey); publish() }
    }
    events?.addEventListener('storage', changed)
    return {
        getItem(key) { check(key); if (memory.has(key)) return memory.get(key) ?? null; try { return storage?.getItem(key) ?? null } catch { return null } },
        setItem(key, value) { check(key); if (typeof value !== 'string' || value.length > 65_536) throw new Error('Invalid workspace UI preference');
            memory.set(key, value)
            try { if (!storage) throw new Error('Browser preference storage is unavailable'); storage.setItem(key, value); memory.delete(key) }
            finally { publish() } },
        removeItem(key) { check(key); memory.set(key, null)
            try { if (!storage) throw new Error('Browser preference storage is unavailable'); storage.removeItem(key); memory.delete(key) }
            finally { publish() } },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
        dispose() { events?.removeEventListener('storage', changed); listeners.clear(); memory.clear() },
    }
}
