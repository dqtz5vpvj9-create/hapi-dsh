/** Original HAPI preference keys, shared through the workspace's explicit capability. */
import { DEFAULT_TOUCHBAR_KEYS } from './defaultKeys.ts'
import { DEFAULT_TOOLBAR_SETTINGS, type ToolbarSettings } from './havenLayout.ts'
import type { TouchBarKey } from './types.ts'
import type { WorkspacePreferenceKey, WorkspaceUiPreferences } from '../ui-preferences.ts'

export const TERMINAL_KEYS: WorkspacePreferenceKey = 'hapi-terminal-touchbar-keys'
export const TERMINAL_SETTINGS: WorkspacePreferenceKey = 'hapi-terminal-toolbar-settings'
const rows = new Set([0, 1, 2]), styles = new Set(['plain', 'accent', 'danger', 'custom'])
const modifiers = new Set(['ctrl', 'alt', 'shift', 'meta']), actions = new Set(['copy', 'paste', 'keyboard', 'snippets'])

/** Validate saved/imported preferences before allowing them to supply input bytes. */
export function terminalKeys(value: unknown): TouchBarKey[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('A terminal layout supports at most 256 keys')
  const seen = new Set<string>()
  return value.map((raw): TouchBarKey => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid terminal key')
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id || item.id.length > 160 || seen.has(item.id)) throw new Error('Every terminal key needs a unique ID')
    seen.add(item.id)
    if (typeof item.label !== 'string' || !item.label || item.label.length > 80 || typeof item.send !== 'string' || item.send.length > 16_384) throw new Error('Invalid terminal key label or sequence')
    const result: TouchBarKey = { id: item.id, label: item.label, send: item.send }
    if (item.row !== undefined) { if (typeof item.row !== 'number' || !rows.has(item.row)) throw new Error('Invalid terminal key row'); result.row = item.row as 0 | 1 | 2 }
    for (const field of ['col', 'size'] as const) if (item[field] !== undefined) {
      if (!Number.isSafeInteger(item[field]) || (item[field] as number) < 1 || (item[field] as number) > 256) throw new Error('Invalid terminal key position')
      result[field] = item[field] as number
    }
    if (item.style !== undefined) { if (!styles.has(String(item.style))) throw new Error('Invalid terminal key style'); result.style = item.style as NonNullable<TouchBarKey['style']> }
    if (item.modifier !== undefined) { if (!modifiers.has(String(item.modifier))) throw new Error('Invalid terminal modifier'); result.modifier = item.modifier as NonNullable<TouchBarKey['modifier']> }
    if (item.action !== undefined) { if (!actions.has(String(item.action))) throw new Error('Invalid terminal key action'); result.action = item.action as NonNullable<TouchBarKey['action']> }
    for (const field of ['bg', 'color'] as const) if (item[field] !== undefined) {
      if (typeof item[field] !== 'string' || item[field].length > 100 || /[;{}]|url\s*\(/i.test(item[field])) throw new Error('Invalid terminal key color')
      result[field] = item[field]
    }
    return result
  })
}
export function terminalSettings(value: unknown): ToolbarSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid terminal toolbar settings')
  const item = value as Record<string, unknown>
  if (!['aligned', 'inline'].includes(String(item.navMode)) || typeof item.uniformGrid !== 'boolean'
    || !Number.isInteger(item.minKeyWidth) || (item.minKeyWidth as number) < 0 || (item.minKeyWidth as number) > 64) throw new Error('Invalid terminal toolbar settings')
  return { navMode: item.navMode as ToolbarSettings['navMode'], uniformGrid: item.uniformGrid, minKeyWidth: item.minKeyWidth as number }
}

export interface TerminalPreferencesState { keys: TouchBarKey[]; settings: ToolbarSettings; error: string | null }
export class TerminalPreferences {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private rawKeys: string | null | undefined
  private rawSettings: string | null | undefined
  private state: TerminalPreferencesState = { keys: [...DEFAULT_TOUCHBAR_KEYS], settings: { ...DEFAULT_TOOLBAR_SETTINGS }, error: null }
  constructor(private readonly storage: WorkspaceUiPreferences) {
    this.reload(); this.unsubscribe = storage.subscribe(this.reload)
  }
  getSnapshot = (): TerminalPreferencesState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  updateKeys(keys: TouchBarKey[]): boolean { return this.save(TERMINAL_KEYS, terminalKeys, keys) }
  updateSettings(settings: ToolbarSettings): boolean { return this.save(TERMINAL_SETTINGS, terminalSettings, settings) }
  private save<T>(key: WorkspacePreferenceKey, validate: (value: unknown) => T, value: T): boolean {
    try {
      const text = JSON.stringify(validate(value))
      if (text.length > 65_536) throw new Error('Terminal preferences exceed the browser storage limit')
      this.storage.setItem(key, text); this.reload()
      if (this.state.error) { this.state = { ...this.state, error: null }; this.publish() }
      return true
    } catch (error) { this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) }; this.publish(); return false }
  }
  private reload = (): void => {
    try {
      const rawKeys = this.storage.getItem(TERMINAL_KEYS), rawSettings = this.storage.getItem(TERMINAL_SETTINGS)
      if (rawKeys === this.rawKeys && rawSettings === this.rawSettings) return
      this.rawKeys = rawKeys; this.rawSettings = rawSettings
      this.state = { keys: rawKeys ? terminalKeys(JSON.parse(rawKeys)) : [...DEFAULT_TOUCHBAR_KEYS],
        settings: rawSettings ? terminalSettings(JSON.parse(rawSettings)) : { ...DEFAULT_TOOLBAR_SETTINGS }, error: null }
    } catch (error) {
      // Do not send bytes from malformed imported preferences or overwrite them.
      this.state = { keys: [...DEFAULT_TOUCHBAR_KEYS], settings: { ...DEFAULT_TOOLBAR_SETTINGS }, error: error instanceof Error ? error.message : String(error) }
    }
    this.publish()
  }
  private publish(): void { for (const listener of this.listeners) listener() }
  dispose(): void { this.unsubscribe(); this.listeners.clear() }
}
