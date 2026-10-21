/** Bilingual copy for plugin-owned surfaces whose locale file belongs to the
 * workspace UI task. English is the source of truth; Chinese matches the app. */
import { en, type WorkspaceTranslate } from '../locales.ts'

export function translate(t: WorkspaceTranslate, english: string, chinese: string): string {
  return t('sourceStatus') === en.sourceStatus ? english : chinese
}
