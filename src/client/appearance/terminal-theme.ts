/** Adapt the public TerminalBodyInjected theme hook; never the terminal engine. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { WorkspaceUiPreferences } from '../ui-preferences.ts'
import { readAppearance } from './preferences.ts'

export function terminalTheme(official: HostObservable<ThemeSnapshot>, preferences: WorkspaceUiPreferences): HostObservable<ThemeSnapshot> {
    let original: ThemeSnapshot | undefined, font: number | null | undefined, cached: ThemeSnapshot | undefined
    const getSnapshot = (): ThemeSnapshot => {
        const current = official.getSnapshot(), appearance = readAppearance(preferences)
        const next = appearance.enabled ? appearance.terminalFont : null
        if (current === original && next === font && cached) return cached
        original = current; font = next
        cached = next === null || next === current.fontSizes.terminal ? current
            : { ...current, fontSizes: { ...current.fontSizes, terminal: next } }
        return cached
    }
    return { getSnapshot, subscribe(listener) {
        const first = official.subscribe(listener), second = preferences.subscribe(listener)
        return () => { first(); second() }
    } }
}
