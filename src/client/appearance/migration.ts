import type { WorkspaceUiPreferences } from '../ui-preferences.ts'

/** Retire the old role tint without replacing any other appearance preference. */
export function migrateMessageAppearance(preferences: WorkspaceUiPreferences): void {
    if (preferences.getItem('hapi-user-message-bg') !== null) preferences.removeItem('hapi-user-message-bg')
    const raw = preferences.getItem('hapi-theme-colors')
    if (!raw) return
    let colors: unknown
    try { colors = JSON.parse(raw) } catch { return }
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return
    let changed = false
    for (const scheme of ['light', 'dark', 'oled']) {
        const value: unknown = Reflect.get(colors, scheme)
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'userBubble')) {
            Reflect.deleteProperty(value, 'userBubble'); changed = true
        }
    }
    if (changed) preferences.setItem('hapi-theme-colors', JSON.stringify(colors))
}
