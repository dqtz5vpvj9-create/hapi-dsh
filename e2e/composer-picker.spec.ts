/** Pinned official Conversation and shared graph, synthetic HAPI wire settings. */
import { test, expect, type Locator } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'

/** The embedded surface must contain one effective pair of controls. Visible
 * boxes alone are insufficient: the old official cell used to cover ours. */
async function expectSourceCapsules(pane: Locator): Promise<void> {
    const model = pane.locator('[data-hapi-composer-picker="model"] button')
    const permission = pane.locator('[data-hapi-composer-picker="permission"] button')
    await expect(model).toHaveCount(1); await expect(permission).toHaveCount(1)
    const official = pane.locator('[data-composer-card] :is([data-slot="conversation.input.model"],[data-slot="conversation.input.permission"]) button')
    await expect(official).toHaveCount(2)
    for (const button of await official.all()) await expect(button).toBeHidden()
    // Preserve source-owned plan semantics too; a real NativePlanControls
    // proposal/receipt lives in the additive dock, outside this official cell.
    for (const plan of await pane.locator('[data-composer-card] [data-slot="conversation.input.plan"]').all()) await expect(plan).toBeHidden()
    await expect(pane.getByRole('button', { name: /^(Access mode, current:|Select model)/ })).toHaveCount(0)
    const attach = pane.getByRole('button', { name: 'Add files or run commands', exact: true })
    const send = pane.getByRole('button', { name: 'Send message', exact: true })
    for (const button of [model, permission, attach, send]) {
        await expect(button).toBeVisible()
        await expect(button).toBeEnabled()
        await expect.poll(() => button.evaluate(element => {
            const box = element.getBoundingClientRect()
            return [0.2, 0.5, 0.8].every(fraction => element.contains(document.elementFromPoint(box.left + box.width * fraction, box.top + box.height / 2)))
        })).toBe(true)
    }
    const modelBox = await model.boundingBox(), permissionBox = await permission.boundingBox()
    expect(modelBox).not.toBeNull(); expect(permissionBox).not.toBeNull()
    // Narrow source toolbars may wrap their two official groups onto separate
    // rows. Either axis must separate the capsules, with real hit-tests above.
    expect(permissionBox!.x + permissionBox!.width <= modelBox!.x || modelBox!.x + modelBox!.width <= permissionBox!.x ||
        permissionBox!.y + permissionBox!.height <= modelBox!.y || modelBox!.y + modelBox!.height <= permissionBox!.y).toBe(true)
}

test.describe('source composer capsules', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => { environment = await startOfficialEnvironment() })
    test.afterAll(async () => { await environment?.close() })

    test('model pages, effort stops, Fast and permissions write only the originating shared pane', async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        try {
            await page.goto(environment.launchUrl)
            await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
            await acknowledgePreviewNotice(page, environment)
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click()
            const alpha = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })
            const alphaInput = alpha.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
            await alphaInput.fill('Alpha draft stays here')
            await page.locator('.hapi-workspace-toolbar').getByRole('button', { name: 'Split left / right', exact: true }).click()
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click()
            const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true })
            const betaInput = beta.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
            await betaInput.fill('Beta draft stays here')

            await expectSourceCapsules(alpha)
            await expectSourceCapsules(beta)
            expect(environment.hapi.settingChanges).toHaveLength(0)
            await beta.locator('[data-hapi-composer-picker="model"] button').click()
            const popup = page.getByRole('dialog', { name: 'Model settings', exact: true })
            const slider = popup.getByRole('slider', { name: 'Reasoning effort', exact: true })
            await expect(slider).toHaveValue('2')
            await popup.getByRole('button', { name: 'Choose model', exact: true }).click()
            await expect(popup.getByRole('radio', { name: 'Fixture model', exact: true })).toHaveAttribute('aria-checked', 'true')
            await popup.getByRole('button', { name: 'Back to model settings', exact: true }).click()
            await expect(slider).toBeEnabled()
            await slider.focus(); await slider.press('End')
            await expect.poll(() => environment.hapi.settingChanges.filter(row => row.route === 'model-reasoning-effort')).toHaveLength(1)
            await expect(slider).toHaveValue('3')
            const fast = popup.getByRole('switch', { name: 'Fast mode', exact: true })
            await expect(fast).toBeEnabled(); await fast.click()
            await expect(fast).toHaveAttribute('aria-checked', 'true')
            await info.attach('composer-model-picker', { body: await popup.screenshot(), contentType: 'image/png' })
            await page.keyboard.press('Escape')
            await expect(popup).toHaveCount(0)
            await expectSourceCapsules(beta)
            await beta.locator('[data-hapi-composer-picker="permission"] button').click()
            const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true })
            await expect(permissions.getByRole('radio', { name: 'Request approval', exact: true })).toHaveAttribute('aria-checked', 'true')
            await permissions.getByRole('radio', { name: 'Full access', exact: true }).click()
            await expect(permissions.getByRole('radio', { name: 'Full access', exact: true })).toHaveAttribute('aria-checked', 'true')
            await info.attach('composer-permission-picker', { body: await permissions.screenshot(), contentType: 'image/png' })
            await alphaInput.focus()
            await expect(permissions).toHaveCount(0)
            await expect(alphaInput).toHaveText('Alpha draft stays here')
            await expect(betaInput).toHaveText('Beta draft stays here')
            expect(environment.hapi.settingChanges).toHaveLength(3)
            expect(environment.hapi.settingChanges.every(row => row.sessionId === 'native-beta')).toBe(true)
            expect(environment.hapi.settingChanges.map(row => [row.route, row.body])).toEqual([
                ['model-reasoning-effort', { modelReasoningEffort: 'high' }], ['service-tier', { serviceTier: 'fast' }], ['permission-mode', { mode: 'yolo' }],
            ])
            await betaInput.focus()
            await page.setViewportSize({ width: 420, height: 880 })
            await expectSourceCapsules(beta)
            await beta.locator('[data-hapi-composer-picker="model"] button').click()
            await expect(popup).toBeVisible()
            const bounds = await popup.boundingBox()
            expect(bounds).not.toBeNull()
            expect(bounds!.x).toBeGreaterThanOrEqual(0)
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(420)
            expect(await popup.evaluate(element => {
                const box = element.getBoundingClientRect()
                return [box.top + 15, box.top + box.height / 2, box.bottom - 15].every(y => element.contains(document.elementFromPoint(box.left + box.width / 2, y)))
            })).toBe(true)
            await info.attach('composer-picker-420px', { body: await page.screenshot(), contentType: 'image/png' })
            await popup.getByRole('button', { name: 'Close picker', exact: true }).click()
            expect(environment.hapi.settingChanges).toHaveLength(3)
            expect(environment.hapi.sent).toHaveLength(0)
            expect(errors).toEqual([])
        } finally {
            await info.attach('composer-picker-errors', { body: errors.join('\n'), contentType: 'text/plain' })
            await info.attach('composer-picker-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        }
    })
})
