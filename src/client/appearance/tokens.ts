/** Public DSH token mapping; the original Conversation and plugin views remain owners. */
import type { ThemeSnapshot, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { compositeOnBackground, getPalette, mix, type ColorScheme } from './palettes.ts'
import type { AppearancePreferences, BubbleColor, ColorKey } from './preferences.ts'

const BASE: Record<ColorScheme, Record<ColorKey, string>> = {
    light: { background: '#ffffff', surface: '#f2f4f6', text: '#111827', hint: '#6b7280', accent: '#111827', border: '#e2e8f0', userBubble: '#f2f4f6' },
    dark: { background: '#1c1c1e', surface: '#2b2f34', text: '#ffffff', hint: '#8e8e93', accent: '#ffffff', border: '#2a2a2c', userBubble: '#2b2f34' },
    oled: { background: '#000000', surface: '#0e0e10', text: '#f5f5f7', hint: '#8e8e93', accent: '#4ea1ff', border: '#1f1f22', userBubble: '#141414' },
}
const accents = { 'preset:soft-blue': '#7db7ff', 'preset:soft-green': '#8fd19e', 'preset:soft-yellow': '#f0d77a' }
export function bubbleColor(preference: BubbleColor, scheme: ColorScheme): string | null {
    if (preference === 'default') return null
    const custom = preference.startsWith('custom:')
    const accent = custom ? preference.slice(7) : accents[preference as keyof typeof accents]
    return mix(BASE[scheme].userBubble, accent, custom ? scheme === 'light' ? 0.34 : 0.22 : scheme === 'light' ? 0.3 : 0.2)
}
/** The source's OLED special case, named palettes, and seven per-scheme overrides. */
export function keyColors(preferences: AppearancePreferences, scheme: ColorScheme): Record<ColorKey, string> {
    const palette = preferences.palette === 'default' ? undefined : getPalette(preferences.palette, scheme)
    const values = palette ? { background: palette.background, surface: palette.secondary, text: palette.foreground,
        hint: palette.hint, accent: palette.accent, border: compositeOnBackground(palette.border, palette.background), userBubble: palette.surface } : { ...BASE[scheme] }
    return { ...values, ...preferences.colors[scheme] }
}

function colors(preferences: AppearancePreferences, scheme: ColorScheme): Record<string, string> {
    const color = keyColors(preferences, scheme), palette = preferences.palette === 'default' ? undefined : getPalette(preferences.palette, scheme)
    const surface = preferences.colors[scheme]?.surface, contrast = scheme === 'light' ? '#000000' : '#ffffff'
    const userBubble = bubbleColor(preferences.bubble, scheme) ?? color.userBubble
    const hover = surface ? mix(surface, contrast, 0.08) : palette?.surfaceHover ?? mix(color.surface, contrast, 0.08)
    return {
        '--dsw-alias-bg-base': color.background, '--dsw-alias-bg-layer-1': surface ?? palette?.dialog ?? color.surface,
        '--dsw-alias-bg-layer-2': color.surface, '--dsw-alias-bg-layer-3': hover,
        '--dsw-alias-bg-module-platform': color.surface, '--dsw-alias-bg-multi-select': hover,
        '--dsw-specific-sidebar-fill': color.background, '--dsw-specific-sidebar-nav-item-active': hover,
        '--dsw-specific-sidebar-nav-item-hover': color.surface, '--dsw-specific-input-major': surface ?? palette?.dialog ?? color.surface,
        '--dsw-alias-label-primary': color.text, '--dsw-alias-label-primary-dimmed': color.text,
        '--dsw-alias-label-secondary': color.hint, '--dsw-alias-label-tertiary': color.hint, '--dsw-alias-label-caption': color.hint,
        '--dsw-alias-border-l1': color.border, '--dsw-alias-border-l2': color.border,
        '--dsw-alias-border-l3': color.border, '--dsw-alias-border-l4': color.border,
        '--dsw-alias-link': color.accent, '--dsw-alias-interactive-bg-hover': hover,
        '--dsw-alias-interactive-bg-hover-solid': hover, '--dsw-alias-interactive-bg-active': hover,
        '--dsw-alias-button-elevated-fill': color.surface, '--dsw-alias-button-floating-fill': color.surface,
        '--dsw-alias-button-floating-hover': hover, '--dsw-specific-bubble': userBubble,
        '--dsw-specific-bubble-highlight': mix(userBubble, color.accent, 0.15),
        // Our layout follows the same palette without selecting undocumented
        // classes inside another plugin's body.
        '--hapi-bg': color.background, '--hapi-panel': color.surface, '--hapi-fg': color.text,
        '--hapi-muted': color.surface, '--hapi-secondary': color.hint, '--hapi-border': color.border,
        '--hapi-palette-accent': color.accent, '--hapi-hover': hover,
    }
}

export function appearanceTokens(preferences: AppearancePreferences, theme: Pick<ThemeSnapshot, 'fontSizes'>): ThemeTokenOverrides {
    if (!preferences.enabled) return {}
    const light = colors(preferences, 'light'), dark = colors(preferences, preferences.mode === 'oled' ? 'oled' : 'dark')
    const result: ThemeTokenOverrides = Object.fromEntries(Object.keys(light).map(key => [key, { light: light[key]!, dark: dark[key]! }]))
    if (preferences.fontScale !== 1) {
        const scale = preferences.fontScale, px = (value: number): string => `${Math.round(value * scale * 100) / 100}px`
        const invariant = (key: string, value: string): void => { result[key] = { light: value, dark: value } }
        invariant('--dsh-content-font-size', px(theme.fontSizes.text))
        invariant('--dsh-code-font-size', px(theme.fontSizes.code))
        invariant('--hapi-font-scale', String(scale))
        // The official token contract exposes both the shorthand and component
        // values. Scale both so menus/header/third-party token users agree.
        const fonts: Array<[string, number, number, number?]> = [
            ['xl-24', 24, 32, 600], ['l-20', 20, 28, 500], ['m-18', 16, 28, 500],
            ['base-16', 16, 24], ['base-strong-16', 16, 24, 500], ['s-14', 14, 22], ['s-strong-14', 14, 22, 500],
            ['xs-13', 13, 20], ['xs-strong-13', 13, 20, 500], ['xxs-12', 12, 18], ['xxs-strong-12', 12, 18, 500], ['xxxs-11', 11, 14],
        ]
        for (const [name, size, line, weight] of fonts) {
            const token = `--dsw-font-${name}`
            invariant(token, `${weight ? `${weight} ` : ''}${px(size)}/${px(line)} var(--dsw-font-family)`)
            invariant(`${token}-font-size`, px(size)); invariant(`${token}-line-height`, px(line))
        }
    }
    return result
}
