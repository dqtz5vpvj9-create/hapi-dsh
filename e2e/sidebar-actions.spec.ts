/** Unchanged official DSH UI plus explicit HAPI wire fixtures. Lifecycle tests
 * deliberately cancel confirmation; no physical Runner or user's data is changed. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

async function admit(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.goto(environment.launchUrl)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
}
const row = (page: Page, title: string) => page.locator('.hapi-session-row').filter({ has: page.locator('.hapi-session-open').filter({ hasText: title }) })
const menu = (page: Page, title: string) => page.getByRole('menu', { name: `${title} · Conversation actions`, exact: true })
async function context(page: Page, target: Locator, title: string) {
    await target.locator('.hapi-session-open').click({ button: 'right' })
    const actions = menu(page, title); await expect(actions).toBeVisible(); return actions
}

test.describe('original sidebar actions on unified source sessions', () => {
    let environment: OfficialEnvironment
    test.beforeEach(async () => { environment = await startOfficialEnvironment() })
    test.afterEach(async () => { await environment?.close() })

    test('context and keyboard menus keep exact IDs, both pins, source title/export and below-pane navigation', async ({ page, context: browserContext }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        await browserContext.grantPermissions(['clipboard-read', 'clipboard-write'])
        await admit(page, environment)
        const alpha = row(page, 'Native Codex alpha'), beta = row(page, 'Native Codex beta')
        await alpha.locator('.hapi-session-open').click()
        const alphaPane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })
        const composer = alphaPane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
        await composer.fill('Keep the original draft during sidebar actions')
        let actions = await context(page, alpha, 'Native Codex alpha')
        await actions.getByRole('menuitem', { name: 'Copy HAPI session ID', exact: true }).click()
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('native-alpha')
        await expect(actions).toHaveCount(0)
        actions = await context(page, alpha, 'Native Codex alpha')
        await actions.getByRole('menuitem', { name: 'Copy original session ID', exact: true }).click()
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('codex-thread-alpha')
        const displayId = await alpha.getAttribute('data-session-row'); expect(displayId).toMatch(/^hapi-codex-/)
        actions = await context(page, alpha, 'Native Codex alpha')
        await actions.getByRole('menuitem', { name: 'Copy serving DSH session ID', exact: true }).click()
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(displayId)

        actions = await context(page, alpha, 'Native Codex alpha')
        await actions.getByRole('menuitem', { name: 'Pin to project', exact: true }).click()
        await expect.poll(() => environment.hapi.require('native-alpha').session.pinned).toBe(true)
        actions = await context(page, alpha, 'Native Codex alpha')
        await expect(actions.getByRole('menuitem', { name: 'Unpin from project', exact: true })).toBeVisible()
        await actions.getByRole('menuitem', { name: 'Pin globally', exact: true }).click()
        await expect.poll(() => environment.hapi.require('native-alpha').session.globalPinned).toBe(true)
        expect(environment.hapi.require('native-alpha').session.pinned).toBe(false)

        await beta.locator('.hapi-session-open').focus(); await page.keyboard.press('Shift+F10')
        const betaActions = menu(page, 'Native Codex beta')
        await expect(betaActions.getByRole('menuitem', { name: 'Open in current pane', exact: true })).toBeFocused()
        await betaActions.getByRole('menuitem', { name: 'Open below this pane', exact: true }).click()
        const betaPane = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true })
        await expect(betaPane).toBeVisible(); await expect(alphaPane).toBeVisible()
        const alphaBounds = await alphaPane.boundingBox(), betaBounds = await betaPane.boundingBox()
        expect(alphaBounds).toBeTruthy(); expect(betaBounds).toBeTruthy()
        expect(betaBounds!.y).toBeGreaterThan(alphaBounds!.y + alphaBounds!.height - 5)
        await expect(composer).toHaveText('Keep the original draft during sidebar actions')

        actions = await context(page, alpha, 'Native Codex alpha')
        await actions.getByRole('menuitem', { name: 'Rename', exact: true }).click()
        const rename = page.getByRole('dialog', { name: 'Rename', exact: true })
        await rename.getByRole('button', { name: 'Suggest a title', exact: true }).click()
        await expect(rename.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('A suggested source title')
        expect(environment.hapi.require('native-alpha').session.metadata!.name).toBe('Native Codex alpha')
        await rename.getByRole('button', { name: 'Dismiss', exact: true }).click()

        actions = await context(page, alpha, 'Native Codex alpha')
        await actions.getByRole('menuitem', { name: 'Export conversation', exact: true }).click()
        const exporting = page.getByRole('dialog', { name: 'Export conversation', exact: true })
        await expect(exporting.getByRole('combobox', { name: 'Export format', exact: true })).toHaveValue('json')
        const downloading = page.waitForEvent('download')
        await exporting.getByRole('button', { name: 'Download conversation', exact: true }).click()
        const download = await downloading, path = await download.path(); expect(path).toBeTruthy()
        const exported = JSON.parse(await readFile(path!, 'utf8'))
        expect(exported.session.id).toBe('native-alpha')
        expect(exported.messages).toHaveLength(environment.hapi.require('native-alpha').rows.length)
        await expect(exporting).toHaveCount(0)
        expect(await page.evaluate(() => localStorage.getItem('hapi.sessionExportFormat'))).toBe('json')
        await expect(composer).toHaveText('Keep the original draft during sidebar actions')
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
        await page.screenshot({ path: info.outputPath('source-sidebar-actions.png'), fullPage: true })
    })

    test('live restart and inactive delete shortcuts open real confirmations without submitting on menu activation', async ({ page }) => {
        const inactive = environment.hapi.add('inactive', 'Laptop', 'machine-alpha')
        inactive.session.active = false
        inactive.session.metadata!.codexNativeConnection = 'history'
        inactive.session.metadata!.lifecycleState = 'archived'
        environment.hapi.emit({ type: 'session-added', sessionId: inactive.session.id })
        const operations: string[] = []
        page.on('request', request => { if (request.url().includes('/api/hapi/nativeSourceOperation')) operations.push(request.postData() ?? '') })
        await admit(page, environment)
        let actions = await context(page, row(page, 'Native Codex alpha'), 'Native Codex alpha')
        await expect(actions.getByRole('menuitem', { name: 'Delete conversation', exact: true })).toHaveCount(0)
        await actions.getByRole('menuitem', { name: 'Restart conversation', exact: true }).click()
        const tools = page.getByRole('dialog', { name: 'Session tools', exact: true })
        const confirmation = tools.getByRole('group', { name: 'Confirm session operation', exact: true })
        await expect(confirmation).toContainText('Restart this agent process?')
        await expect(confirmation.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled()
        expect(operations).toEqual([])
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
        await tools.getByRole('button', { name: 'Dismiss', exact: true }).click()
        actions = await context(page, row(page, 'Native Codex inactive'), 'Native Codex inactive')
        await expect(actions.getByRole('menuitem', { name: 'Restart conversation', exact: true })).toHaveCount(0)
        await expect(actions.getByRole('menuitem', { name: 'Restore conversation', exact: true })).toBeVisible()
        await actions.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
        await expect(confirmation).toContainText('Permanently delete this session')
        await expect(confirmation.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled()
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
        await tools.getByRole('button', { name: 'Dismiss', exact: true }).click()
        expect(operations).toEqual([]); expect(environment.hapi.sessions.has('native-inactive')).toBe(true)
    })
})

test.describe('original mobile row long press', () => {
    test.use({ hasTouch: true, viewport: { width: 420, height: 900 } })
    test('a real touch long press opens its menu and the compatibility click does not navigate the underlying row', async ({ page }, info) => {
        const environment = await startOfficialEnvironment(), errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        try {
            await admit(page, environment)
            await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
            const alpha = row(page, 'Native Codex alpha'), button = alpha.locator('.hapi-session-open')
            const bounds = await button.boundingBox(); expect(bounds).toBeTruthy()
            const cdp = await page.context().newCDPSession(page)
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds!.x + 30, y: bounds!.y + 22, id: 1 }] })
            const actions = menu(page, 'Native Codex alpha'); await expect(actions).toBeVisible()
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await expect(page.locator('.hapi-session-picker')).toBeVisible()
            await expect(page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })).toHaveCount(0)
            const rect = await actions.boundingBox(); expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(420)
            expect(rect!.y).toBeGreaterThanOrEqual(0); expect(rect!.y + rect!.height).toBeLessThanOrEqual(900)
            await page.screenshot({ path: info.outputPath('mobile-source-menu.png'), fullPage: true })
            await actions.getByRole('menuitem', { name: 'Open in current pane', exact: true }).click()
            await expect(page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })).toBeVisible()
            await expect(page.locator('.hapi-session-picker')).toHaveCount(0)
            await cdp.detach()
            expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
        } finally { await environment.close() }
    })
})
