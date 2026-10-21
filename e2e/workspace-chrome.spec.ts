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
    return page.locator('.hapi-pane').filter({ has: page.locator('.hapi-pane-header > .hapi-pane-title').filter({ hasText: title }) })
}
async function menu(page: Page, pane: Locator, mobile = false): Promise<Locator> {
    const result = mobile ? page.locator('.hapi-mobile-pane-bar > .hapi-pane-menu') : pane.locator('.hapi-pane-header > .hapi-pane-menu')
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
                await expect(pane.locator('.hapi-pane-body .hapi-host-tools')).toHaveCount(0)
                await expect(pane.getByRole('button', { name: words.settings })).not.toBeVisible()
                expect(await pane.locator('[data-slot="conversation.session.header"]').innerText()).not.toMatch(/hapi-(?:native|observed|codex-native)/)
                const titleFont = await typography(pane.locator('.hapi-pane-title'))
                expect(titleFont.size).toBeGreaterThanOrEqual(13)
                expect(titleFont.family).not.toMatch(/monospace|(?:^|,)\s*"?serif"?(?:,|$)/i)
                const frame = await pane.locator('.hapi-host-frame').boundingBox(), box = await pane.boundingBox()
                expect(frame!.height).toBeGreaterThan(box!.height - 45)
                expect((await pane.locator('[data-conversation-content]').boundingBox())!.height).toBeGreaterThan(500)
                const flow = pane.locator('[data-chat-flow]:not([data-step-process-content])')
                expect((await flow.boundingBox())!.height).toBeGreaterThan(100)
                expect((await flow.boundingBox())!.width).toBeGreaterThan(300)
            }
            await expect(observed.locator('[data-hapi-header-field="model"]')).toContainText('DeepSeek-Flash')
            await expect(observed.locator('[data-hapi-header-field="model"]')).not.toContainText('["')
            expect((await typography(page.locator('.hapi-session-title').filter({ hasText: sourceTitle }))).size).toBeGreaterThanOrEqual(14)
            expect((await typography(native.locator('.hapi-native-status'))).size).toBeGreaterThanOrEqual(13)
            await offerInstall(page)
            await expect(page.locator('.hapi-notification-stack article')).toHaveCount(0)
            await page.screenshot({ path: info.outputPath('workspace-readable-2048.png'), fullPage: true })

            const actions = await menu(page, native)
            await expect(actions.getByRole('button', { name: words.settings })).toBeVisible()
            await expect(actions.getByRole('button', { name: words.views })).toBeVisible()
            await expect(actions.getByRole('button', { name: 'Plugin views in a new pane', exact: true })).toBeVisible()
            await actions.getByRole('button', { name: words.settings }).click()
            const settings = page.getByRole('dialog', { name: words.settingsDialog })
            await expect(settings).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(settings).toHaveCount(0)
            await expect(actions).not.toHaveAttribute('open', '')

            await (await menu(page, native)).getByRole('group', { name: 'Host tools', exact: true }).getByRole('button', { name: words.plugins }).click()
            await expect(native.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })).not.toBeVisible()
            await (await menu(page, native)).getByRole('group', { name: 'Host tools', exact: true }).getByRole('button', { name: words.conversation }).click()
            await expect(native.getByText(nativeAnswer, { exact: true })).toBeVisible()

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
            await expect(native.locator('.hapi-pane-header')).not.toBeVisible()
            await expect(native.locator('[data-slot="conversation.session.header"]')).toBeVisible()
            await expect(native.locator('.hapi-pane-body .hapi-host-tools')).toHaveCount(0)
            await offerInstall(page)
            await expect(page.locator('.hapi-notification-stack article')).toHaveCount(0)
            const mobileActions = await menu(page, native, true)
            await expect(mobileActions.getByRole('button', { name: words.settings })).toBeVisible()
            await mobileActions.getByRole('button', { name: words.settings }).click()
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
            await expect(activeTools.locator('.hapi-host-tools')).toHaveCount(1)
            await expect(activeTools.getByRole('button', { name: words.settings })).toBeVisible()
            await page.screenshot({ path: info.outputPath('workspace-mobile-menu-420.png'), fullPage: true })
            await page.keyboard.press('Escape')
            await expect(activeTools).not.toHaveAttribute('open', '')
            await page.locator('.hapi-pane-tabs').getByRole('tab').filter({ hasText: sourceTitle }).click()
            await expect(native.getByText(nativeAnswer, { exact: true })).toBeVisible()
            expect((await native.locator('[data-conversation-content]').boundingBox())!.height).toBeGreaterThan(400)
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420)
            const composer = native.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
            await composer.fill('Mobile workspace draft saved through the official editor')
            const park = native.getByRole('button', { name: 'Park draft', exact: true })
            await expect(park).toBeEnabled()
            const parkBox = (await park.boundingBox())!
            expect(parkBox.height).toBeLessThan(40)
            expect(parkBox.x + parkBox.width).toBeLessThanOrEqual(420)
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
