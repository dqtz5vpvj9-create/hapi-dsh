import type { WorkspaceUiPreferences } from '../ui-preferences.ts'

/** The original HAPI key and default; every graph uses the workspace owner. */
export const COMPOSER_ENTER_KEY = 'hapi-composer-enter-behavior'
export type ComposerEnterPreference = 'send' | 'newline'

export function readComposerEnterPreference(preferences: WorkspaceUiPreferences): ComposerEnterPreference {
  return preferences.getItem(COMPOSER_ENTER_KEY) === 'newline' ? 'newline' : 'send'
}

/** A failed persistent write remains visible through the shared owner's memory value. */
export function writeComposerEnterPreference(preferences: WorkspaceUiPreferences, value: ComposerEnterPreference): boolean {
  try {
    if (value === 'send') preferences.removeItem(COMPOSER_ENTER_KEY)
    else preferences.setItem(COMPOSER_ENTER_KEY, value)
    return true
  } catch { return false }
}
