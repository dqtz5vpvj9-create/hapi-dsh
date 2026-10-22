/** Original HAPI display preference contracts (0f8ef697, AGPL-3.0-only).
 * Copyright HAPI contributors. Unknown keys never become CSS or plugin state. */
import type { WorkspacePreferenceKey, WorkspaceUiPreferences } from '../ui-preferences.ts'
import { COLOR_THEME_OPTIONS, type ColorScheme, type ColorThemePreset } from './palettes.ts'

export type AppearanceMode = 'system' | ColorScheme
export const FONT_SCALES = [0.8, 0.9, 1, 1.1, 1.2] as const
export const TERMINAL_FONT_SIZES = [9, 11, 13, 15, 17] as const
export const COLOR_KEYS = ['background', 'surface', 'text', 'hint', 'accent', 'border'] as const
export type ColorKey = typeof COLOR_KEYS[number]
export type ThemeColors = Partial<Record<ColorScheme, Partial<Record<ColorKey, string>>>>
export type BubbleColor = 'default' | 'preset:soft-blue' | 'preset:soft-green' | 'preset:soft-yellow' | `custom:#${string}`
export const DEFAULT_HEADER = Object.freeze({ showLabels: true, agent: true, model: true, reasoning: true,
    fastMode: true, machine: true, lastActive: true, createdAt: false, updatedAt: false, worktree: true })
export type HeaderPreferences = { -readonly [K in keyof typeof DEFAULT_HEADER]: boolean }
export type HeaderField = keyof HeaderPreferences
export const APPEARANCE_KEYS: readonly WorkspacePreferenceKey[] = ['hapi-appearance', 'hapi-color-theme', 'hapi-theme-colors',
    'hapi-font-scale', 'hapi-terminal-font-size', 'hapi-user-message-bg']

export function parseMode(raw: string | null): AppearanceMode {
    return raw === 'light' || raw === 'dark' || raw === 'oled' ? raw : 'system'
}
export function parseColorTheme(raw: string | null): ColorThemePreset {
    return COLOR_THEME_OPTIONS.some(option => option.value === raw) ? raw as ColorThemePreset : 'glass'
}
export function parseFontScale(raw: string | null): number {
    const value = Number(raw)
    return FONT_SCALES.some(candidate => candidate === value) ? value : 1
}
/** A missing value follows DSH's current font setting instead of inventing an override. */
export function terminalFontOverride(raw: string | null): number | null {
    if (raw === null) return null
    const value = Number(raw)
    return TERMINAL_FONT_SIZES.some(candidate => candidate === value) ? value : 13
}
export function normalizeColor(value: unknown): string | null {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null
}
export function parseColors(raw: string | null): ThemeColors {
    if (!raw) return {}
    try {
        const record: unknown = JSON.parse(raw), result: ThemeColors = {}
        if (!record || typeof record !== 'object' || Array.isArray(record)) return result
        for (const scheme of ['light', 'dark', 'oled'] as const) {
            const source: unknown = Reflect.get(record, scheme)
            if (!source || typeof source !== 'object' || Array.isArray(source)) continue
            for (const key of COLOR_KEYS) {
                const color = normalizeColor(Reflect.get(source, key))
                if (color) (result[scheme] ??= {})[key] = color
            }
        }
        return result
    } catch { return {} }
}
export function parseBubble(raw: string | null): BubbleColor {
    if (raw === 'preset:soft-blue' || raw === 'preset:soft-green' || raw === 'preset:soft-yellow') return raw
    const custom = raw?.startsWith('custom:') ? normalizeColor(raw.slice(7)) : null
    return custom ? `custom:${custom}` as BubbleColor : 'default'
}
export function parseHeader(raw: string | null): HeaderPreferences {
    const result: HeaderPreferences = { ...DEFAULT_HEADER }
    if (!raw) return result
    try {
        const record: unknown = JSON.parse(raw)
        if (record && typeof record === 'object' && !Array.isArray(record)) for (const key of Object.keys(result) as HeaderField[]) {
            const value: unknown = Reflect.get(record, key)
            if (typeof value === 'boolean') result[key] = value
        }
    } catch { /* Invalid original data does not erase defaults. */ }
    return result
}

export interface AppearancePreferences {
    enabled: boolean; mode: AppearanceMode; palette: ColorThemePreset; colors: ThemeColors;
    fontScale: number; terminalFont: number | null; bubble: BubbleColor; header: HeaderPreferences
}
export function readAppearance(preferences: WorkspaceUiPreferences): AppearancePreferences {
    const enabled = preferences.getItem('hapi-dsh-appearance-enabled')
    return {
        enabled: enabled !== 'false',
        mode: parseMode(preferences.getItem('hapi-appearance')), palette: parseColorTheme(preferences.getItem('hapi-color-theme')),
        colors: parseColors(preferences.getItem('hapi-theme-colors')), fontScale: parseFontScale(preferences.getItem('hapi-font-scale')),
        terminalFont: terminalFontOverride(preferences.getItem('hapi-terminal-font-size')), bubble: parseBubble(preferences.getItem('hapi-user-message-bg')),
        header: parseHeader(preferences.getItem('hapi-session-header-metadata')),
    }
}
