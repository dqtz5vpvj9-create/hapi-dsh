import type { ThemeRuntime, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { WorkspacePreferenceKey, WorkspaceUiPreferences } from '../ui-preferences.ts'
import { readAppearance, type AppearancePreferences } from './preferences.ts'
import { appearanceTokens } from './tokens.ts'
import { migrateMessageAppearance } from './migration.ts'

export type AppearanceSnapshot = AppearancePreferences & { saveError: string | null }
export class AppearanceState {
    private snapshot: AppearanceSnapshot
    private readonly listeners = new Set<() => void>()
    private readonly stop: () => void
    constructor(readonly preferences: WorkspaceUiPreferences) {
        let saveError: string | null = null
        try { migrateMessageAppearance(preferences) } catch (error) { saveError = error instanceof Error ? error.message : String(error) }
        this.snapshot = { ...readAppearance(preferences), saveError }
        this.stop = preferences.subscribe(() => {
            const next = { ...readAppearance(preferences), saveError: this.snapshot.saveError }
            if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
            this.snapshot = next; this.publish()
        })
    }
    getSnapshot = (): AppearanceSnapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(): void { for (const listener of [...this.listeners]) listener() }
    write(key: WorkspacePreferenceKey, value: string | null): void {
        let error: string | null = null
        try { value === null ? this.preferences.removeItem(key) : this.preferences.setItem(key, value) }
        catch (reason) { error = reason instanceof Error ? reason.message : String(reason) }
        if (error !== this.snapshot.saveError) { this.snapshot = { ...this.snapshot, saveError: error }; this.publish() }
    }
    dispose(): void { this.stop(); this.listeners.clear() }
}

/** Uses only public theme writes/events. A user choosing another official
 * theme remains authoritative; font events never overwrite the original keys. */
export function bindAppearanceTheme(state: AppearanceState, theme: Pick<ThemeRuntime, 'getTheme' | 'setTheme' | 'overrideTokens'>,
    subscribe: (listener: (snapshot: ThemeSnapshot) => void) => () => void): () => void {
    let layer: (() => void) | undefined, signature = '', desiredMode: string | undefined
    let lastPreference = theme.getTheme().preference as string, applying = false, disposed = false
    const update = (): void => {
        if (applying || disposed) return
        applying = true
        try {
            const preferences = state.getSnapshot(), desired = preferences.enabled ? preferences.mode === 'oled' ? 'dark' : preferences.mode : undefined
            if (desired !== desiredMode) {
                desiredMode = desired
                if (desired) theme.setTheme(desired)
            }
            const current = theme.getTheme(), tokens = appearanceTokens(preferences, current), next = JSON.stringify(tokens)
            lastPreference = current.preference
            if (next !== signature) {
                signature = next
                const previous = layer
                layer = Object.keys(tokens).length ? theme.overrideTokens('hapi-dsh.appearance', tokens) : undefined
                previous?.()
            }
        } finally { applying = false }
    }
    const untheme = subscribe(snapshot => {
        if (applying || disposed) return
        const changed = snapshot.preference !== lastPreference
        lastPreference = snapshot.preference
        if (changed && state.getSnapshot().enabled) {
            if (['light', 'dark', 'system'].includes(snapshot.preference)) state.write('hapi-appearance', snapshot.preference)
            else state.write('hapi-dsh-appearance-enabled', 'false')
        }
        update()
    })
    const unstate = state.subscribe(update)
    update()
    return () => { disposed = true; unstate(); untheme(); layer?.() }
}
