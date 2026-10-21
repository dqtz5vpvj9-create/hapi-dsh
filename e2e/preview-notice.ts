import { expect, type Page } from '@playwright/test'
import type { OfficialEnvironment } from './official-runtime.ts'

// The pinned official notice is acknowledged durably on the Host. Its first
// settings read is asynchronous; workspace visibility does not prove it ran.
const acknowledged = new WeakMap<OfficialEnvironment, Promise<void>>()
const restoredPageHandlers = new WeakSet<Page>()

/**
 * A fresh blank view must show the notice before controls are exercised.
 * The pinned SettingsRoot intentionally defers onboarding when a restored
 * main session is nonblank. In that case handle a notice only if later UI
 * navigation actually makes it eligible; never invent an acknowledgement.
 */
export async function acknowledgePreviewNotice(page: Page, environment: OfficialEnvironment, options: {
    initialView?: 'blank' | 'existing-session'
} = {}): Promise<void> {
    const notice = page.getByRole('dialog', { name: /^(Preview Notice|预览版说明)$/ })
    const confirmVisible = async (): Promise<void> => {
        await notice.getByRole('button', { name: /^(Continue|继续)$/ }).click()
        await expect(notice).toBeHidden()
    }
    if (options.initialView === 'existing-session') {
        if (!restoredPageHandlers.has(page)) {
            await page.addLocatorHandler(notice, async () => {
                const confirmation = confirmVisible()
                acknowledged.set(environment, confirmation)
                try { await confirmation }
                catch (error) {
                    if (acknowledged.get(environment) === confirmation) acknowledged.delete(environment)
                    throw error
                }
            })
            restoredPageHandlers.add(page)
        }
        // This assertion invokes the handler if the notice is already visible.
        // It does not mark the Host acknowledged when no notice was rendered.
        await expect(notice).toBeHidden()
        return
    }
    let confirmation = acknowledged.get(environment)
    if (!confirmation) {
        confirmation = (async () => {
            await expect(notice).toBeVisible({ timeout: 30_000 })
            await confirmVisible()
        })()
        acknowledged.set(environment, confirmation)
    }
    try { await confirmation }
    catch (error) {
        if (acknowledged.get(environment) === confirmation) acknowledged.delete(environment)
        throw error
    }
    // Reloads and later pages on the same Host must not wait for a notice whose
    // real acknowledgement has already completed.
    await expect(notice).toBeHidden()
}
