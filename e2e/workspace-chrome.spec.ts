/** Real official DSH components and browser layout. HAPI histories and the
 * beforeinstallprompt event are explicit, synthetic protocol fixtures. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { nativeIndexedHistory, useBoundedSourceHistory } from './source-conversation-fixture.ts'

const sourceTitle = '原生代码审查 · Codex'
const observedTitle = '跨机器依赖检查 · DSH'
const nativeAnswer = 'Synthetic final answer 180.'
const words = {
    split: /^(Split left \/ right|左右分屏)$/,
    settings: /^(Host settings|Host 设置)$/,
    settingsDialog: /^(Settings|设置)$/,
    conversation: /^(Conversation|聊天)$/,
    plugins: /^(Plugins|插件)$/,
    views: /^(Plugin views|插件视图)$/,
}

async function admit(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.goto(environment.launchUrl)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    await acknowledgePreviewNotice(page, environment)
}
function sourcePane(page: Page, title: string): Locator {
    // v2 has no workspace title bar; the pane region name carries the session title.
    return page.locator(`.hapi-pane[aria-label="Pane: ${title}"]`)
}
async function menu(page: Page, pane: Locator, mobile = false): Promise<Locator> {
    if (!mobile) await pane.click({ position: { x: 4, y: 4 } })
    const result = mobile ? page.locator('.hapi-mobile-pane-bar > .hapi-pane-menu') : page.locator('.hapi-statusbar .hapi-pane-actions')
    await result.locator(':scope > summary').click()
    await expect(result).toHaveAttribute('open', '')
    return result
}
async function typography(locator: Locator) {
    return locator.evaluate(element => {
        const style = getComputedStyle(element)
        return { family: style.fontFamily, size: parseFloat(style.fontSize), height: element.getBoundingClientRect().height }
    })
}
async function offerInstall(page: Page): Promise<void> {
    await page.evaluate(() => {
        const facts = { prompts: 0 }
        Object.assign(window, { __hapiChromeInstall: facts })
        const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
            prompt: async () => { facts.prompts++ }, userChoice: Promise.resolve({ outcome: 'dismissed' }),
        })
        window.dispatchEvent(event)
    })
}

test.describe('readable workspace chrome keeps every official pane action', () => {
    test.use({ viewport: { width: 2048, height: 1088 }, locale: 'en-US' })
    let environment: OfficialEnvironment
    test.beforeEach(async () => {
        environment = await startOfficialEnvironment()
        const native = environment.hapi.add('chrome', '开发机', 'machine-alpha')
        native.session.metadata!.name = sourceTitle
        native.rows = nativeIndexedHistory(native.session.metadata!.codexSessionId!)
        useBoundedSourceHistory(native)
        environment.hapi.emit({ type: 'session-added', sessionId: native.session.id })
        const observed = environment.hapi.addObserved('dsh', 'chrome', 'machine-beta')
        observed.session.metadata!.name = observedTitle
        observed.session.model = JSON.stringify(['deepseek-official', 'deepseek-flash'])
        environment.hapi.emit({ type: 'session-updated', sessionId: observed.session.id })
    })
    test.afterEach(async () => { await environment?.close() })

    test('2048 desktop has readable type, full official headers, compact menus and an explicit installation entry', async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        try {
            await admit(page, environment)
            await page.locator('.hapi-session-open').filter({ hasText: sourceTitle }).click()
            const native = sourcePane(page, sourceTitle)
            await expect(native.getByText(nativeAnswer, { exact: true })).toBeVisible()
            await page.locator('.hapi-workspace-toolbar').getByRole('button', { name: words.split }).click()
            await page.locator('.hapi-session-open').filter({ hasText: observedTitle }).click()
            const observed = sourcePane(page, observedTitle)
            await expect(observed.getByText('Original dsh answer in the official DSH Conversation.', { exact: true })).toBeVisible()
            for (const pane of [native, observed]) {
                await expect(pane.locator('[data-slot="conversation.session.header"]')).toBeVisible()
                // R8b: no routine metadata bars/rows above the composer.
                await expect(pane.locator('.hapi-native-routine, .hapi-native-usage, .hapi-native-goal, .hapi-native-notices, .hapi-native-status')).toHaveCount(0)
                // v2: no workspace title bar; pane identity comes from the bottom window list.
                await expect(pane.locator('.hapi-pane-header')).toHaveCount(0)
                await expect(pane.locator('.hapi-pane-body .hapi-host-tools')).toHaveCount(0)
                // Host settings / plugin views stay in the official session header utilities.
                await expect(pane.getByRole('button', { name: words.settings })).toBeVisible()
                await expect(pane.getByRole('button', { name: words.views })).toBeVisible()
                expect(await pane.locator('[data-slot="conversation.session.header"]').innerText()).not.toMatch(/hapi-(?:native|observed|codex-native)/)
                const titleFont = await typography(page.locator('.hapi-window-tabs [aria-selected="true"] .hapi-window-label'))
                expect(titleFont.size).toBeGreaterThanOrEqual(12)
                expect(titleFont.family).not.toMatch(/monospace|(?:^|,)\s*"?serif"?(?:,|$)/i)
                const frame = await pane.locator('.hapi-host-frame').boundingBox(), box = await pane.boundingBox()
                expect(frame!.height).toBeGreaterThan(box!.height - 16)
                expect((await pane.locator('[data-conversation-content]').boundingBox())!.height).toBeGreaterThan(500)
                const flow = pane.locator('[data-chat-flow]:not([data-step-process-content])')
                expect((await flow.boundingBox())!.height).toBeGreaterThan(100)
                expect((await flow.boundingBox())!.width).toBeGreaterThan(300)
            }
            await expect(observed.locator('[data-hapi-header-field="model"]')).toContainText('DeepSeek-Flash')
            await expect(observed.locator('[data-hapi-header-field="model"]')).not.toContainText('["')
            // v2 uses the official --dsw-font-xs-13 chrome scale for titles.
            const windowTitleType = await typography(page.locator('.hapi-window-tabs [aria-selected="true"] .hapi-window-label'))
            expect(windowTitleType.size).toBeGreaterThanOrEqual(13)
            const sessionTitle = page.locator('.hapi-session-title').filter({ hasText: sourceTitle })
            const sessionTitleType = await typography(sessionTitle)
            expect(sessionTitleType.size).toBeGreaterThanOrEqual(13)
            expect(sessionTitleType.family).not.toMatch(/monospace|(?:^|,)\s*"?serif"?(?:,|$)/i)
            // Native status is a compact 11px caption in the current type scale;
            // the readable-title floor is asserted above on the window/session titles.
            await offerInstall(page)
            await expect(page.locator('.hapi-notification-stack article')).toHaveCount(0)
            await page.screenshot({ path: info.outputPath('workspace-readable-2048.png'), fullPage: true })

            // The bottom bar's Pane actions menu owns pane geometry only.
            const actions = await menu(page, native)
            await expect(actions.getByRole('button', { name: words.split })).toBeVisible()
            await expect(actions.getByRole('button', { name: 'Plugin views in a new pane', exact: true })).toBeVisible()
            await expect(actions.getByRole('button', { name: 'Close pane', exact: true })).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(actions).not.toHaveAttribute('open', '')

            await native.getByRole('button', { name: words.settings }).click()
            const settings = page.getByRole('dialog', { name: words.settingsDialog })
            await expect(settings).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(settings).toHaveCount(0)

            // Installation remains a deliberate action in the original Settings.
            await page.getByRole('button', { name: 'Account menu', exact: true }).click()
            await page.getByRole('menuitem', { name: 'Settings', exact: false }).click()
            await settings.getByRole('button', { name: 'Notifications and installation', exact: true }).click()
            await expect(settings.getByRole('button', { name: 'Install workspace', exact: true })).toBeVisible()
            expect(await page.evaluate(() => (window as unknown as { __hapiChromeInstall: { prompts: number } }).__hapiChromeInstall.prompts)).toBe(0)
            await settings.getByRole('button', { name: 'Install workspace', exact: true }).click()
            expect(await page.evaluate(() => (window as unknown as { __hapiChromeInstall: { prompts: number } }).__hapiChromeInstall.prompts)).toBe(1)
            await page.keyboard.press('Escape')
            await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
            await expect(page.locator('iframe')).toHaveCount(0)

            // Official plugin pages stay reachable from the pane utility cluster.
            // Selecting one replaces the conversation surface in that pane; this is
            // the last pane assertion so no return-to-conversation step is needed.
            const hostTools = native.getByRole('combobox', { name: 'Host tools', exact: true })
            await expect(hostTools.locator('option', { hasText: 'Plugins' })).toHaveCount(1)
            await expect(hostTools.locator('option', { hasText: words.conversation })).toHaveCount(1)
            await hostTools.selectOption({ label: 'Plugins' })
            await expect(native.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })).not.toBeVisible()
            await expect(native.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
            expect(errors).toEqual([])
        } finally {
            await info.attach('browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
            await info.attach('host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        }
    })

    test.describe('touchscreen', () => {
    test.use({ viewport: { width: 420, height: 900 }, hasTouch: true, isMobile: true })
    test('420px keeps the official conversation readable and moves focused pane tools to its mobile menu', async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        try {
            await admit(page, environment)
            await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
            await page.locator('.hapi-session-picker .hapi-session-open').filter({ hasText: sourceTitle }).click()
            const native = sourcePane(page, sourceTitle)
            await expect(native.getByText(nativeAnswer, { exact: true })).toBeVisible()
            await expect(native.locator('.hapi-pane-header')).toHaveCount(0)
            await expect(native.locator('[data-slot="conversation.session.header"]')).toBeVisible()
            await expect(native.locator('.hapi-pane-body .hapi-host-tools')).toHaveCount(0)
            await offerInstall(page)
            await expect(page.locator('.hapi-notification-stack article')).toHaveCount(0)
            const mobileActions = await menu(page, native, true)
            await expect(mobileActions.getByRole('button', { name: words.split })).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(mobileActions).not.toHaveAttribute('open', '')
            await native.getByRole('button', { name: /Open the Settings panel for this Host/ }).click()
            const settings = page.getByRole('dialog', { name: words.settingsDialog })
            await expect(settings).toBeVisible()
            await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0)

            await (await menu(page, native, true)).getByRole('button', { name: words.split }).click()
            await page.locator('.hapi-session-picker .hapi-session-open').filter({ hasText: observedTitle }).click()
            const observed = sourcePane(page, observedTitle)
            await expect(observed.getByText('Original dsh answer in the official DSH Conversation.', { exact: true })).toBeVisible()
            await expect(native).toHaveAttribute('aria-hidden', 'true')
            const engineLabel = observed.locator('[data-hapi-header-field="agent"]')
            await expect(engineLabel).toBeVisible()
            expect(await engineLabel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
            const activeTools = await menu(page, observed, true)
            await expect(activeTools.getByRole('button', { name: words.split })).toBeVisible()
            await page.screenshot({ path: info.outputPath('workspace-mobile-menu-420.png'), fullPage: true })
            await page.keyboard.press('Escape')
            await expect(activeTools).not.toHaveAttribute('open', '')
            await page.locator('.hapi-pane-tabs').getByRole('tab').filter({ hasText: sourceTitle }).click()
            await expect(native.getByText(nativeAnswer, { exact: true })).toBeVisible()
            expect((await native.locator('[data-conversation-content]').boundingBox())!.height).toBeGreaterThan(400)
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420)
            const composer = native.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
            await composer.fill('Mobile workspace draft saved through the official editor')
            await native.locator('[data-hapi-composer-overflow] > summary').click()
            const park = native.getByRole('button', { name: 'Park draft', exact: true })
            await expect(park).toBeEnabled()
            const parkBox = (await park.boundingBox())!
            // R8 puts this action in the overflow menu, whose coarse-pointer
            // buttons deliberately retain the existing 44px touch target.
            expect(parkBox.height).toBeGreaterThanOrEqual(44)
            expect(parkBox.x).toBeGreaterThanOrEqual(0)
            expect(parkBox.x + parkBox.width).toBeLessThanOrEqual(420)
            const overflowBox = (await native.locator('.hapi-composer-overflow-panel').boundingBox())!
            expect(overflowBox.x).toBeGreaterThanOrEqual(0)
            expect(overflowBox.x + overflowBox.width).toBeLessThanOrEqual(420)
            // A clipped absolute menu can have a visible bounding box while
            // transcript rows receive its pointer events. Verify the real target.
            await expect.poll(() => park.evaluate(element => {
                const box = element.getBoundingClientRect()
                return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
                    && element.contains(document.elementFromPoint(box.x + 4, box.y + 4))
                    && element.contains(document.elementFromPoint(box.right - 4, box.bottom - 4))
            })).toBe(true)
            await park.click()
            const parked = native.getByRole('region', { name: 'Parked composer draft', exact: true })
            await expect(parked).toContainText('Saved to scratchlist. The parked draft was cleared.')
            await expect(composer).toHaveText('')
            expect(environment.hapi.extras.notes.get('native-chrome')?.size).toBe(1)
            await parked.getByRole('button', { name: 'Close draft details', exact: true }).click()
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420)
            await page.screenshot({ path: info.outputPath('workspace-readable-mobile-420.png'), fullPage: true })
            expect(environment.hapi.sent).toHaveLength(0)
            expect(errors).toEqual([])
        } finally {
            await info.attach('browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
            await info.attach('host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        }
    })
    })
})
