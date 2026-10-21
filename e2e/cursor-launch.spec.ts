/** Real DSH Web and official loader; source Cursor discovery/spawn are explicit wire fixtures. */
import { test, expect } from '@playwright/test'
import { startOfficialEnvironment } from './official-runtime.ts'

test('Cursor original base and variant picker preserves exact source identity, draft and selected machine', async ({ page }) => {
    const environment = await startOfficialEnvironment()
    try {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        environment.hapi.cursorCatalogs.set('machine-alpha', { availableModels: [{ modelId: 'fixture-family[reasoning=high,fast=false]' }],
            cliModelSkus: [{ modelId: 'fixture-family-high', name: 'High' }, { modelId: 'fixture-family-high-fast', name: 'High fast' }] })
        environment.hapi.cursorCatalogs.set('machine-beta', { availableModels: [{ modelId: 'fixture-other[fast=false]' }], cliModelSkus: [] })
        await page.goto(environment.launchUrl)
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
        const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
        if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
        const open = async () => {
            await page.locator('.hapi-workspace-tools > details > summary').click()
            await page.getByRole('button', { name: 'HAPI engines · New conversation', exact: true }).click()
        }
        await open()
        const form = page.getByRole('dialog', { name: 'HAPI engines · New conversation', exact: true })
        await form.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('machine-alpha')
        await form.getByRole('combobox', { name: 'Engine', exact: true }).selectOption('cursor')
        await form.getByLabel('Working directory', { exact: true }).fill('/workspace/cursor-project')
        const model = form.getByRole('combobox', { name: 'Model', exact: true })
        await expect(model).toBeEnabled()
        await model.selectOption('fixture-family')
        await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
        await expect(form.getByRole('combobox', { name: 'Model reasoning variant', exact: true })).toHaveValue('')
        await form.getByRole('button', { name: 'Cancel', exact: true }).click()
        await page.reload(); await expect(page.locator('[data-hapi-workspace]')).toBeVisible(); await open()
        await expect(model).toHaveValue('fixture-family')
        await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
        await form.getByRole('combobox', { name: 'Model reasoning variant', exact: true }).selectOption('fixture-family-high-fast')
        await form.getByLabel('Working directory', { exact: true }).fill('/workspace/cursor-other-folder')
        await expect(form.getByRole('combobox', { name: 'Model reasoning variant', exact: true })).toHaveValue('fixture-family-high-fast')
        await form.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('machine-beta')
        await expect(model).toBeEnabled(); await expect(model).toHaveValue('auto')
        await expect(model.locator('option[value="fixture-family"]')).toHaveCount(0)
        await model.selectOption('fixture-other[fast=false]')
        await form.getByRole('button', { name: 'Create', exact: true }).click()
        await expect(form).toHaveCount(0)
        expect(environment.hapi.spawnRequests).toHaveLength(1)
        expect(environment.hapi.spawnRequests[0]).toMatchObject({ machineId: 'machine-beta', body: { agent: 'cursor', model: 'fixture-other[fast=false]', directory: '/workspace/cursor-other-folder' } })
        expect(environment.hapi.spawnRequests[0]!.body.modelReasoningEffort).toBeUndefined()
        expect(environment.hapi.sent).toHaveLength(0)
        expect(environment.hapi.cursorModelRequests).toContain('machine-beta')
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
        expect(errors).toEqual([])
    } finally { await environment.close() }
})
