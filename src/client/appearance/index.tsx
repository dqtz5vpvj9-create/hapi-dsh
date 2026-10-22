import { useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '../workspace-ui.ts'
import { AppearanceState, bindAppearanceTheme } from './state.ts'
import { COLOR_THEME_OPTIONS, type ColorScheme } from './palettes.ts'
import { COLOR_KEYS, DEFAULT_HEADER, FONT_SCALES, TERMINAL_FONT_SIZES, type ColorKey, type HeaderField } from './preferences.ts'
import { keyColors } from './tokens.ts'
import { HEADER_LABELS, sourceHeader } from './header.tsx'

const labels: Record<ColorKey, [string, string]> = {
    background: ['Background', '背景'], surface: ['Surface', '表面'], text: ['Text', '文字'], hint: ['Secondary text', '次要文字'],
    accent: ['Accent', '强调色'], border: ['Border', '边框'],
}
const paletteNames: Record<string, string> = { glass: 'Codex glass', 'default': 'HAPI', 'codex': 'Codex', 'notion': 'Notion', 'one': 'One', 'proof': 'Proof',
    'raycast': 'Raycast', 'rose-pine': 'Rosé Pine', 'solarized': 'Solarized', 'vercel': 'Vercel', 'vs-code-plus': 'VS Code Plus',
    'xcode': 'Xcode', 'linear': 'Linear', 'lobster': 'Lobster', 'material': 'Material', 'matrix': 'Matrix', 'monokai': 'Monokai', 'night-owl': 'Night Owl', 'nord': 'Nord' }

export function installSourceAppearance(ctx: Context): () => void {
    const scope = ctx.inject(['hapiWorkspaceUi', 'theme', 'slots', 'locale'], owner => {
        const state = new AppearanceState(owner.hapiWorkspaceUi.preferences)
        const untheme = bindAppearanceTheme(state, owner.theme, listener => owner.on('theme/change', listener))
        const language = () => owner.locale.getSnapshot().active
        const Section = () => {
            const value = useSyncExternalStore(state.subscribe, state.getSnapshot)
            const locale = useSyncExternalStore(listener => owner.locale.subscribe(listener), language), chinese = locale.startsWith('zh')
            const tr = (en: string, zh: string): string => chinese ? zh : en
            const [scheme, setScheme] = useState<ColorScheme>(() => value.mode === 'oled' ? 'oled' : owner.theme.getTheme().active.colorScheme)
            const colors = keyColors(value, scheme)
            const setColor = (key: ColorKey, color: string | null): void => {
                const updated = { ...value.colors, [scheme]: { ...value.colors[scheme] } }
                if (color) updated[scheme]![key] = color
                else delete updated[scheme]![key]
                state.write('hapi-theme-colors', JSON.stringify(updated))
            }
            return <section className="hapi-appearance-settings" aria-label={tr('HAPI appearance', 'HAPI 外观')}>
                <h2>{tr('HAPI appearance', 'HAPI 外观')}</h2>
                <p>{tr('Original HAPI colors and preferences are shared across this workspace. DSH and other plugins keep their own views and controls.', '原 HAPI 的配色与偏好在整个工作区共享。DSH 与其他插件保留各自的视图和控件。')}</p>
                <label className="hapi-appearance-toggle"><input type="checkbox" checked={value.enabled} onChange={event => state.write('hapi-dsh-appearance-enabled', String(event.currentTarget.checked))}/>{tr('Use HAPI appearance', '使用 HAPI 外观')}</label>
                {value.saveError && <p role="alert">{tr('The change works in this page but could not be saved for reload: ', '修改在本页生效，但无法保存以供刷新恢复：')}{value.saveError}</p>}
                <fieldset disabled={!value.enabled}>
                    <legend>{tr('Colors and typography', '配色与字体')}</legend>
                    <div className="hapi-appearance-grid">
                        <label>{tr('Appearance', '显示模式')}<select value={value.mode} onChange={event => state.write('hapi-appearance', event.currentTarget.value)}>
                            <option value="system">{tr('System', '跟随系统')}</option><option value="light">{tr('Light', '浅色')}</option>
                            <option value="dark">{tr('Dark', '深色')}</option><option value="oled">OLED</option>
                        </select></label>
                        <label>{tr('Color palette', '色板')}<select value={value.palette} onChange={event => state.write('hapi-color-theme', event.currentTarget.value)}>
                            {COLOR_THEME_OPTIONS.map(option => <option value={option.value} key={option.value}>{paletteNames[option.value]}</option>)}
                        </select></label>
                        <label>{tr('Font scale', '字体缩放')}<select value={value.fontScale} onChange={event => state.write('hapi-font-scale', event.currentTarget.value === '1' ? null : event.currentTarget.value)}>
                            {FONT_SCALES.map(scale => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}
                        </select></label>
                        <label>{tr('Terminal font size', '终端字号')}<select value={value.terminalFont ?? ''} onChange={event => state.write('hapi-terminal-font-size', event.currentTarget.value || null)}>
                            <option value="">{tr('Follow DSH', '跟随 DSH')}</option>{TERMINAL_FONT_SIZES.map(size => <option key={size} value={size}>{size} px</option>)}
                        </select></label>
                    </div>
                    <p>{tr('Font scale multiplies DSH text and code sizes. Terminal size is independent and uses the official terminal theme hook.', '字体缩放作用于 DSH 的文字与代码字号；终端字号独立，通过官方终端的主题接口生效。')}</p>
                    <h3>{tr('Custom colors', '自定义颜色')}</h3>
                    <label>{tr('Customize this scheme', '编辑此模式的颜色')}<select value={scheme} onChange={event => setScheme(event.currentTarget.value as ColorScheme)}>
                        <option value="light">{tr('Light', '浅色')}</option><option value="dark">{tr('Dark', '深色')}</option><option value="oled">OLED</option>
                    </select></label>
                    <div className="hapi-appearance-colors">{COLOR_KEYS.map(key => <div key={key}>
                        <label><input type="color" aria-label={`${tr('Custom', '自定义')} ${labels[key][chinese ? 1 : 0]}`} value={colors[key]} onChange={event => setColor(key, event.currentTarget.value)}/>{labels[key][chinese ? 1 : 0]}</label>
                        <button type="button" disabled={!value.colors[scheme]?.[key]} aria-label={`${tr('Reset', '重置')} ${labels[key][chinese ? 1 : 0]}`} onClick={() => setColor(key, null)}>{tr('Reset', '重置')}</button>
                    </div>)}</div>
                    <button type="button" onClick={() => { const colors = { ...value.colors }; delete colors[scheme]; state.write('hapi-theme-colors', JSON.stringify(colors)) }}>{tr('Reset colors for this scheme', '重置此模式的自定义颜色')}</button>
                </fieldset>
                <fieldset><legend>{tr('Source session header', '源会话页头')}</legend>
                    <p>{tr('Choose which original source facts appear beside the official header. Fields the source has not reported stay absent.', '选择官方页头旁显示的源会话信息。源端未报告的字段保持为空。')}</p>
                    <div className="hapi-appearance-header-options">{(Object.keys(DEFAULT_HEADER) as HeaderField[]).map(key => <label key={key}><input type="checkbox" checked={value.header[key]} onChange={event => state.write('hapi-session-header-metadata', JSON.stringify({ ...value.header, [key]: event.currentTarget.checked }))}/>{HEADER_LABELS[key][chinese ? 1 : 0]}</label>)}</div>
                    <button type="button" onClick={() => state.write('hapi-session-header-metadata', null)}>{tr('Reset header fields', '重置页头字段')}</button>
                </fieldset>
            </section>
        }
        const style = document.createElement('style'); style.dataset.hapiAppearance = ''; style.textContent = styles; document.head.append(style)
        const section = owner.slots.inject('settings.section', () => owner.slots.register({ name: 'settings.section', id: 'hapi-appearance', order: 32,
            label: () => language().startsWith('zh') ? 'HAPI 外观' : 'HAPI appearance' }, Section))
        const header = owner.slots.inject('conversation.session.header.utilities', () => owner.slots.register({
            name: 'conversation.session.header.utilities', id: 'hapi.source-header-metadata', order: -50,
        }, sourceHeader(owner, state)))
        return () => { header(); section(); style.remove(); untheme(); state.dispose() }
    })
    return () => { void scope.dispose() }
}

const styles = `
/* Pinned official Chat factory markup. Keep message roles neutral in every theme. */
.hapi-pane .Sixlwa_bubble {background:var(--hapi-user-message-surface,var(--dsw-specific-bubble));border:0;border-radius:10px;box-shadow:none;background-image:none;padding:10px 14px;max-width:88%;font-size:max(15px,var(--dsh-content-font-size,15px));line-height:1.6}
.hapi-pane .Sixlwa_bubble::before,.hapi-pane .Sixlwa_bubble::after {content:none}
.hapi-pane [data-chat-flow-kind="user-message"] {margin-top:22px}
.hapi-workspace-toolbar,.hapi-session-sidebar {background:var(--hapi-chrome-solid-surface,var(--hapi-panel));}
@supports (backdrop-filter:blur(1px)) {
 .hapi-workspace-toolbar,.hapi-session-sidebar {background:var(--hapi-chrome-translucent-surface,var(--hapi-panel));backdrop-filter:var(--hapi-chrome-backdrop,none)}
}
@media (prefers-reduced-transparency:reduce),(forced-colors:active) {
 .hapi-workspace-toolbar,.hapi-session-sidebar {background:var(--hapi-chrome-solid-surface,var(--hapi-panel));backdrop-filter:none}
}
@media(max-width:640px) {.hapi-pane .Sixlwa_bubble {max-width:96%}}
.hapi-appearance-settings{max-width:760px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}
.hapi-appearance-settings h2{font:var(--dsw-font-l-20);margin:0 0 10px}.hapi-appearance-settings h3{font:var(--dsw-font-s-strong-14);margin:20px 0 10px}
.hapi-appearance-settings p{color:var(--dsw-alias-label-secondary)}.hapi-appearance-settings fieldset{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:16px;margin:20px 0;min-width:0}.hapi-appearance-settings legend{padding:0 6px}
.hapi-appearance-settings fieldset:disabled{opacity:.55}.hapi-appearance-settings label{display:flex;align-items:center;gap:10px;justify-content:space-between;min-width:0}.hapi-appearance-toggle{justify-content:flex-start!important}
.hapi-appearance-settings select,.hapi-appearance-settings button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;max-width:100%}
.hapi-appearance-settings select:focus-visible,.hapi-appearance-settings button:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px}
.hapi-appearance-settings button:disabled{opacity:.45}.hapi-appearance-grid{display:grid;gap:14px;grid-template-columns:repeat(2,minmax(0,1fr))}.hapi-appearance-grid>label{align-items:stretch;flex-direction:column}
.hapi-appearance-colors{display:grid;gap:12px;margin:16px 0;grid-template-columns:repeat(2,minmax(0,1fr))}.hapi-appearance-colors>div{display:flex;gap:8px;align-items:center;justify-content:space-between}.hapi-appearance-colors label{justify-content:flex-start}
.hapi-appearance-settings input[type=color]{width:36px;height:30px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent}
.hapi-appearance-header-options{display:flex;flex-wrap:wrap;gap:12px 20px;margin:16px 0}.hapi-appearance-header-options label{justify-content:flex-start}
.hapi-source-header-metadata{display:flex;gap:3px 10px;flex-wrap:wrap;min-width:0;max-width:min(42cqw,560px);font:400 12px/1.45 var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-secondary)}
.hapi-source-header-metadata>span{white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}.hapi-source-header-metadata>[data-hapi-header-field=agent]{flex-shrink:0}.hapi-source-header-label{opacity:.75}
/* The official header publishes an anonymous inline-size container for slot
   occupants. Apply source metadata priorities to each pane, not the page. */
@container(max-width:700px){.hapi-source-header-metadata{flex-wrap:nowrap}.hapi-source-header-label{display:none}.hapi-source-header-metadata>span:not([data-hapi-header-field=agent]):not([data-hapi-mobile-secondary]){display:none}}
@media(max-width:640px){.hapi-appearance-colors,.hapi-appearance-grid{grid-template-columns:1fr}.hapi-source-header-metadata{max-width:32vw}.hapi-source-header-label{display:none}.hapi-source-header-metadata>span:not([data-hapi-header-field=agent]):not([data-hapi-mobile-secondary]){display:none}}
`
