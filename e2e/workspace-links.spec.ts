import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Real original DSH Markdown anchors and workspace drafts; the linked page is
 * a Playwright route fixture, so the test never visits an external service. */
import { test, expect } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

test.describe('workspace external links', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment()
        for (const key of ['alpha', 'beta']) {
            const row = environment.hapi.require(`native-${key}`).rows.find(row => row.id.includes(`answer-${key}`))!
            const content = row.content as { content: { data: { message: string } } }
            content.content.data.message += ` [Workspace documentation](https://workspace-docs.example.test/${key}?query=original#section)`
            environment.hapi.emit({ type: 'message-updated', sessionId: `native-${key}` })
        }
    })
    test.afterAll(async () => { await environment?.close() })

    test('original new-tab preference and explicit same-tab departure preserve both official input drafts', async ({ page, context }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await context.route('https://workspace-docs.example.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Workspace link destination</title><h1>Fixture documentation</h1>' }))
        await page.addInitScript(() => {
            if (localStorage.getItem('link-fixture-seeded')) return
            localStorage.setItem('link-fixture-seeded', 'yes'); localStorage.setItem('hapi-open-external-links-in-new-tab', 'true')
        })
        try {
            await page.goto(environment.launchUrl)
            await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
            await acknowledgePreviewNotice(page, environment)
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click()
            const alpha = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })
            await expect(alpha.getByRole('link', { name: 'Workspace documentation', exact: true })).toBeVisible()
            const alphaInput = alpha.locator('[contenteditable="true"][role="textbox"]')
            await alphaInput.fill('Alpha unsent before navigation')
            await page.keyboard.press('Control+b'); await page.keyboard.press('%')
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click()
            const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true })
            await expect(beta.getByRole('link', { name: 'Workspace documentation', exact: true })).toBeVisible()
            const betaInput = beta.locator('[contenteditable="true"][role="textbox"]')
            await betaInput.fill('Beta unsent before navigation')
            const popupPromise = context.waitForEvent('page')
            await beta.getByRole('link', { name: 'Workspace documentation', exact: true }).click()
            const popup = await popupPromise
            await expect(popup).toHaveURL('https://workspace-docs.example.test/beta?query=original#section')
            await expect(popup.getByRole('heading', { name: 'Fixture documentation' })).toBeVisible()
            expect(await popup.evaluate(() => window.opener === null)).toBe(true)
            await popup.close()
            await expect(alphaInput).toHaveText('Alpha unsent before navigation')
            await expect(betaInput).toHaveText('Beta unsent before navigation')

            await alpha.getByRole('button', { name: 'Host settings', exact: true }).click()
            const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
            await settings.getByRole('button', { name: 'Workspace links', exact: true }).click()
            await settings.getByRole('combobox', { name: 'Open web links', exact: true }).selectOption('same-tab')
            await page.keyboard.press('Escape')
            await alphaInput.fill('Alpha final edit immediately before leaving')
            await alpha.getByRole('link', { name: 'Workspace documentation', exact: true }).click()
            await expect(page).toHaveURL('https://workspace-docs.example.test/alpha?query=original#section')
            await page.goto(environment.launchUrl)
            await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
            await expect(alphaInput).toHaveText('Alpha final edit immediately before leaving')
            await expect(betaInput).toHaveText('Beta unsent before navigation')
            expect(await page.evaluate(() => localStorage.getItem('hapi-open-external-links-in-new-tab'))).toBeNull()
            expect(environment.hapi.sent).toHaveLength(0)
            expect(errors).toEqual([])
            await page.screenshot({ path: info.outputPath('workspace-link-drafts-restored.png'), fullPage: true })
        } catch (error) { await info.attach('official-processes.txt', { body: environment.diagnostics(), contentType: 'text/plain' }); throw error }
    })
})
