/** Real unchanged DSH UI; the HAPI wire fixture is explicit and runs no model. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

async function admit(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.goto(environment.launchUrl)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
    // Each environment has a fresh official profile. Its async welcome plugin
    // can present this after the workspace shell has already become visible.
    await expect(notice).toBeVisible()
    await notice.getByRole('button', { name: 'Continue', exact: true }).click()
}
const composer = (pane: Locator) => pane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })

async function edgeDrop(source: Locator, target: Locator, edge: 'right' | 'top'): Promise<void> {
    const size = await target.boundingBox()
    expect(size).not.toBeNull()
    await source.dragTo(target, { targetPosition: edge === 'right'
        ? { x: size!.width - 10, y: size!.height / 2 } : { x: size!.width / 2, y: 10 } })
}

test.describe('original HAPI workspace and sidebar interactions', () => {
    let environment: OfficialEnvironment
    test.beforeEach(async () => { environment = await startOfficialEnvironment() })
    test.afterEach(async () => { await environment?.close() })

    test('real session and pane drags preserve official composers across geometry, windows, shortcuts and reload', async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await admit(page, environment)
        const sidebarAlpha = page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' })
        const sidebarBeta = page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' })
        await sidebarAlpha.click()
        const alpha = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })
        await composer(alpha).fill('Alpha draft before real pane moves')
        const alphaId = await alpha.getAttribute('data-pane-id')
        const alphaGraph = await alpha.locator('.hapi-remote-pane').elementHandle()
        await edgeDrop(sidebarBeta, alpha, 'right')
        const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true })
        await expect(beta.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toBeVisible()
        await expect(page.locator('.hapi-pane')).toHaveCount(2)
        const betaId = await beta.getAttribute('data-pane-id')
        const betaGraph = await beta.locator('.hapi-remote-pane').elementHandle()
        await composer(beta).fill('Beta draft keeps the same official editor')
        await edgeDrop(beta.locator('.hapi-pane-title'), alpha, 'top')
        const boxes = await Promise.all([alpha.boundingBox(), beta.boundingBox()])
        expect(boxes[1]!.y).toBeLessThan(boxes[0]!.y)
        expect(Math.abs(boxes[0]!.x - boxes[1]!.x)).toBeLessThan(2)
        await expect(composer(alpha)).toHaveText('Alpha draft before real pane moves')
        await expect(composer(beta)).toHaveText('Beta draft keeps the same official editor')
        expect(await alpha.locator('.hapi-remote-pane').evaluate((node, original) => node === original, alphaGraph)).toBe(true)

        await page.getByRole('button', { name: 'New window', exact: true }).click()
        const tabs = page.locator('.hapi-window-tabs').getByRole('tab')
        await expect(tabs).toHaveCount(2)
        await tabs.first().click()
        await beta.locator('.hapi-pane-title').dragTo(tabs.nth(1))
        await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
        await expect(composer(beta)).toHaveText('Beta draft keeps the same official editor')
        expect(await beta.locator('.hapi-remote-pane').evaluate((node, original) => node === original, betaGraph)).toBe(true)
        await expect(beta).toHaveAttribute('data-pane-id', betaId!)
        // The inactive window intentionally leaves the accessibility tree; its
        // retained graph must still exist under the unchanged pane identity.
        const hiddenAlpha = page.locator(`[data-pane-id="${alphaId}"]`)
        await expect(hiddenAlpha).toHaveCount(1)
        await expect(hiddenAlpha).toBeHidden()

        await composer(beta).focus()
        await page.keyboard.press('Control+b')
        await expect(page.locator('.hapi-prefix')).toHaveClass(/hapi-prefix-active/)
        await page.keyboard.press('q') // Unknown suffix belongs to the prefix, not the draft.
        await expect(composer(beta)).toHaveText('Beta draft keeps the same official editor')
        const started = Date.now()
        await page.keyboard.press('Control+b')
        await expect(page.locator('.hapi-prefix')).toHaveClass(/hapi-prefix-active/)
        await expect(page.locator('.hapi-prefix')).not.toHaveClass(/hapi-prefix-active/, { timeout: 2200 })
        expect(Date.now() - started).toBeLessThan(2200)
        await page.keyboard.press('End'); await page.keyboard.press('!')
        await expect(composer(beta)).toHaveText('Beta draft keeps the same official editor!')
        await page.keyboard.press('Control+b'); await page.keyboard.press('1')
        await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
        await expect(composer(alpha)).toHaveText('Alpha draft before real pane moves')

        await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
        await page.reload()
        await expect(alpha.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible()
        await tabs.nth(1).click()
        await expect(beta.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toBeVisible()
        await expect(composer(beta)).toHaveText('Beta draft keeps the same official editor!')
        expect(environment.hapi.sent).toHaveLength(0)
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
        await page.screenshot({ path: `${info.outputDir}/official-dragged-workspace.png`, fullPage: true })
        expect(errors).toEqual([])
    })

    test('original date groups and local ranges retain distinct recent/folder scroll positions', async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        const today = new Date(); today.setHours(12, 0, 0, 0)
        for (let index = 0; index < 72; index++) {
            const fixture = environment.hapi.add(`list-${String(index).padStart(3, '0')}`, index % 2 ? 'Linux workstation' : 'Laptop', index % 2 ? 'machine-beta' : 'machine-alpha')
            const date = new Date(today); date.setDate(date.getDate() - Math.floor(index / 24)); date.setMinutes(59 - index % 24)
            const at = date.getTime()
            fixture.session.createdAt = at; fixture.session.updatedAt = at + 3
            fixture.session.metadata!.name = `List row ${String(index).padStart(3, '0')}`
            fixture.session.metadata!.path = `/workspace/project-${index % 6}`
            for (const [offset, row] of fixture.rows.entries()) { row.createdAt = at + offset; if (row.invokedAt != null) row.invokedAt = at + offset }
            environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
        }
        await admit(page, environment)
        const sidebar = page.locator('.hapi-session-sidebar'), list = sidebar.locator('.hapi-session-list')
        await expect(sidebar.locator('[data-recent-total]')).toHaveAttribute('data-recent-total', '74')
        await expect(list.getByText('Today', { exact: true })).toBeVisible()
        const anchor = () => list.evaluate(element => {
            const viewport = element.getBoundingClientRect()
            const row = [...element.querySelectorAll<HTMLElement>('[data-session-view-anchor]')].find(node => {
                const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
            })!
            return { id: row.dataset.sessionViewAnchor!, top: row.getBoundingClientRect().top - viewport.top }
        })
        const aligned = async (saved: { id: string; top: number }) => expect.poll(async () => list.evaluate((element, value) => {
            const row = [...element.querySelectorAll<HTMLElement>('[data-session-view-anchor]')].find(node => node.dataset.sessionViewAnchor === value.id)
            return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - value.top) : 1_000_000
        }, saved)).toBeLessThan(2)
        await list.hover(); await page.mouse.wheel(0, 850)
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(500)
        await expect(list.getByText('Yesterday', { exact: true })).toHaveCount(1)
        const recent = await anchor()
        await sidebar.getByRole('button', { name: 'Folders', exact: true }).click()
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)
        await list.hover(); await page.mouse.wheel(0, 1250)
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(900)
        const folders = await anchor()
        await sidebar.getByRole('button', { name: 'Recent', exact: true }).click(); await aligned(recent)
        await sidebar.getByRole('button', { name: 'Folders', exact: true }).click(); await aligned(folders)
        await sidebar.getByRole('button', { name: 'Recent', exact: true }).click(); await aligned(recent)

        await sidebar.getByRole('button', { name: 'Search conversations', exact: true }).click()
        await sidebar.getByRole('button', { name: 'Date range', exact: true }).click()
        const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
        await sidebar.getByLabel('From date', { exact: true }).fill(day)
        await sidebar.getByLabel('Through date', { exact: true }).fill(day)
        await expect(sidebar.locator('[data-recent-total]')).toHaveAttribute('data-recent-total', '24')
        await sidebar.getByRole('button', { name: 'Clear date range', exact: true }).click()
        await expect(sidebar.getByRole('searchbox')).toBeFocused()
        await expect(sidebar.locator('[data-recent-total]')).toHaveAttribute('data-recent-total', '74')
        await page.screenshot({ path: `${info.outputDir}/original-sidebar-dates.png`, fullPage: true })
        expect(errors).toEqual([])
    })

    test('folder New session here preserves the source machine and cwd when choosing Codex or DSH', async ({ page }) => {
        await admit(page, environment)
        const sidebar = page.locator('.hapi-session-sidebar')
        await sidebar.getByRole('button', { name: 'Folders', exact: true }).click()
        const chooseHere = async (source: 'alpha' | 'beta', engine: 'Codex' | 'DSH') => {
            const folder = sidebar.locator('.hapi-folder').filter({ hasText: `Native Codex ${source}` })
            await folder.locator(':scope > header .hapi-menu > summary').click()
            await folder.getByRole('button', { name: 'New session here', exact: true }).click()
            const chooser = page.locator('.hapi-dialog').filter({ has: page.locator('.hapi-new-choice') })
            await chooser.getByRole('button', { name: new RegExp(`^${engine}`) }).click()
        }
        for (const source of ['alpha', 'beta'] as const) {
            await chooseHere(source, 'Codex')
            const dialog = page.getByRole('dialog', { name: 'New Codex session', exact: true })
            await expect(dialog.getByRole('combobox', { name: 'Machine', exact: true })).toHaveValue(`machine-${source}`)
            await expect(dialog.getByRole('combobox', { name: 'Working directory', exact: true })).toHaveValue(`/workspace/${source}`)
            await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
        }
        await chooseHere('beta', 'DSH')
        const sourceDialog = page.locator('.hapi-dialog').filter({ has: page.getByRole('combobox', { name: 'Engine', exact: true }) })
        await expect(sourceDialog.getByRole('combobox', { name: 'Machine', exact: true })).toHaveValue('machine-beta')
        await expect(sourceDialog.getByRole('combobox', { name: 'Engine', exact: true })).toHaveValue('dsh')
        await expect(sourceDialog.getByRole('combobox', { name: 'Working directory', exact: true })).toHaveValue('/workspace/beta')
        expect(environment.hapi.spawnRequests).toHaveLength(0)
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
    })

    test('original active groups and folder batches preserve pending and selected sessions with source preferences', async ({ page }) => {
        const now = Date.now()
        for (let index = 0; index < 12; index++) {
            const key = `batch-${String(index).padStart(2, '0')}`
            const fixture = environment.hapi.add(key, 'Laptop', 'machine-alpha')
            fixture.session.metadata!.name = `Batch ${String(index).padStart(2, '0')}`
            fixture.session.metadata!.path = '/workspace/batch'
            fixture.session.updatedAt = now - index * 1000
            fixture.session.active = index >= 8 && index <= 10
            if (!fixture.session.active) fixture.session.metadata!.codexNativeConnection = 'history'
            if (index === 8) fixture.session.pinned = true
            environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
        }
        environment.hapi.requestApproval('native-batch-10', 'batch-approval')
        const alpha = environment.hapi.require('native-alpha').session
        alpha.execution = { ...alpha.execution!, sequence: alpha.execution!.sequence + 1, status: 'active' }
        alpha.executionVersion!++
        environment.hapi.require('native-beta').session.metadata!.lifecycleState = 'idle'
        environment.hapi.emit({ type: 'session-updated', sessionId: 'native-alpha' })
        environment.hapi.emit({ type: 'session-updated', sessionId: 'native-beta' })
        await page.addInitScript(() => { localStorage.setItem('hapi-session-preview-limit', '4') })
        await admit(page, environment)
        const sidebar = page.locator('.hapi-session-sidebar')
        await sidebar.locator('.hapi-session-open').filter({ hasText: 'Batch 11' }).click()
        await expect(page.getByRole('region', { name: 'Pane: Batch 11', exact: true })).toBeVisible()
        await sidebar.getByRole('button', { name: 'Folders', exact: true }).click()
        const batch = sidebar.locator('.hapi-folder').filter({ has: page.locator('header > button[title="Laptop · /workspace/batch"]') })
        await expect(batch.locator('.hapi-session-open')).toHaveCount(4)
        await expect(batch.locator('.hapi-session-open').filter({ hasText: 'Batch 11' })).toBeVisible()
        await expect(batch.locator('.hapi-session-open').filter({ hasText: 'Batch 10' })).toBeVisible()
        await batch.getByRole('button', { name: /^Show more sessions/ }).click()
        await expect(batch.locator('.hapi-session-open')).toHaveCount(8)
        await batch.getByRole('button', { name: /^Show fewer sessions/ }).click()
        await expect(batch.locator('.hapi-session-open')).toHaveCount(4)
        await sidebar.locator('.hapi-sidebar-options > summary').click()
        await expect(sidebar.getByRole('spinbutton', { name: 'Sessions per folder preview', exact: true })).toHaveValue('4')
        await sidebar.getByRole('checkbox', { name: 'Group connected sessions above folders', exact: true }).check()
        const progress = sidebar.locator('[data-sidebar-section="in-progress"]'), active = sidebar.locator('[data-sidebar-section="active"]')
        await expect(progress.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' })).toBeVisible()
        await expect(progress.locator('.hapi-session-open').filter({ hasText: 'Batch 10' })).toBeVisible()
        await expect(active.getByRole('group', { name: 'Idle connections', exact: true }).locator('.hapi-session-open')).toContainText('Native Codex beta')
        await expect(active.getByRole('group', { name: 'Active', exact: true }).locator('.hapi-session-open')).toContainText('Batch 09')
        await expect(batch.locator('.hapi-session-open').filter({ hasText: 'Batch 08' })).toBeVisible()
        const alphaFolder = sidebar.locator('.hapi-folder').filter({ has: page.locator('header > button[title="Laptop · /workspace/alpha"]') })
        await expect(alphaFolder.locator('.hapi-session-open')).toHaveCount(0)
        await alphaFolder.locator('header .hapi-menu > summary').click()
        await expect(alphaFolder.getByRole('button', { name: 'New session here', exact: true })).toBeEnabled()
        await page.keyboard.press('Escape')
        await sidebar.getByRole('checkbox', { name: 'Active sessions only', exact: true }).check()
        await expect(batch.locator('.hapi-session-open').filter({ hasText: 'Batch 11' })).toBeVisible()
        await expect(sidebar.locator('.hapi-session-open').filter({ hasText: 'Batch 00' })).toHaveCount(0)
        expect(await page.evaluate(() => localStorage.getItem('hapi-pin-in-progress-sessions'))).toBe('true')
        expect(await page.evaluate(() => localStorage.getItem('hapi-show-active-sessions-only'))).toBe('true')
        await page.reload()
        await expect(page.getByRole('region', { name: 'Pane: Batch 11', exact: true })).toBeVisible()
        await expect(batch.locator('.hapi-session-open').filter({ hasText: 'Batch 11' })).toBeVisible()
        await expect(progress.locator('.hapi-session-open').filter({ hasText: 'Batch 10' })).toBeVisible()
        expect(environment.hapi.approvals).toHaveLength(0)
    })
    test('long recent lists retain selected and menu rows while restoring semantic positions across views and insertions', async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        const now = Date.now()
        const add = (key: string, title: string, at: number) => {
            const fixture = environment.hapi.add(key, 'Laptop', 'machine-alpha')
            fixture.session.metadata!.name = title
            fixture.session.metadata!.path = `/workspace/virtual-${Number(key.replace(/\D/g, '')) % 3}`
            fixture.session.updatedAt = at
            environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
        }
        for (let index = 0; index < 180; index++) add(`window-${index}`, `Window ${String(index).padStart(3, '0')}`, now - index * 1000)
        await admit(page, environment)
        const sidebar = page.locator('.hapi-session-sidebar'), list = sidebar.locator('.hapi-session-list')
        await expect(list.locator('[data-recent-total]')).toHaveAttribute('data-recent-total', '182')
        await expect.poll(() => list.locator('.hapi-session-open').count()).toBeLessThan(100)
        const selected = list.locator('.hapi-session-row').filter({ has: page.locator('.hapi-session-open').filter({ hasText: 'Window 000' }) })
        await selected.locator('.hapi-session-open').click()
        await expect(page.getByRole('region', { name: 'Pane: Window 000', exact: true })).toBeVisible()
        const selectedElement = await selected.elementHandle()
        await list.hover(); await page.mouse.wheel(0, 6200)
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(5500)
        await expect.poll(() => list.locator('.hapi-session-open').count()).toBeLessThan(100)
        await expect(selected).toHaveCount(1)
        expect(await selected.evaluate((node, original) => node === original, selectedElement)).toBe(true)
        const menuId = await list.evaluate(element => {
            const viewport = element.getBoundingClientRect()
            return [...element.querySelectorAll<HTMLElement>('[data-session-row]')].find(node => {
                const rect = node.getBoundingClientRect(); return rect.top >= viewport.top + 10 && rect.bottom < viewport.bottom - 180
            })!.dataset.sessionRow!
        })
        const menuRow = list.locator(`[data-session-row="${menuId}"]`), menu = menuRow.locator('details')
        await menu.locator('summary').click()
        const menuElement = await menuRow.elementHandle()
        await list.hover(); await page.mouse.wheel(0, 1700)
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(7000)
        await expect(menu).toHaveAttribute('open', '')
        expect(await menuRow.evaluate((node, original) => node === original, menuElement)).toBe(true)
        await page.keyboard.press('Escape')
        const capture = () => list.evaluate(element => {
            const viewport = element.getBoundingClientRect()
            const node = [...element.querySelectorAll<HTMLElement>('[data-session-view-anchor]')].find(row => {
                const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
            })!
            return { id: node.dataset.sessionViewAnchor!, top: node.getBoundingClientRect().top - viewport.top }
        })
        const aligned = async (saved: { id: string; top: number }) => expect.poll(() => list.evaluate((element, value) => {
            const row = [...element.querySelectorAll<HTMLElement>('[data-session-view-anchor]')].find(node => node.dataset.sessionViewAnchor === value.id)
            return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - value.top) : 1_000_000
        }, saved)).toBeLessThan(2)
        const saved = await capture()
        await sidebar.getByRole('button', { name: 'Folders', exact: true }).click()
        await expect(list.locator('[data-recent-total]')).toHaveCount(0)
        await sidebar.getByRole('button', { name: 'Recent', exact: true }).click()
        await aligned(saved)
        for (let index = 0; index < 20; index++) add(`inserted-${index}`, `Inserted ${index}`, now + 10_000 + index)
        await expect(list.locator('[data-recent-total]')).toHaveAttribute('data-recent-total', '202')
        await aligned(saved)
        await expect.poll(() => list.locator('.hapi-session-open').count()).toBeLessThan(100)
        // Native IDs are searchable too. A bare "179" can also occur inside
        // another session's honest generated display hash, so use its identity.
        await sidebar.getByRole('button', { name: 'Search conversations', exact: true }).click()
        await sidebar.getByRole('searchbox').fill('codex-thread-window-179')
        await expect(list.locator('[data-recent-total]')).toHaveAttribute('data-recent-total', '1')
        await expect(list.locator('.hapi-session-open')).toContainText('Window 179')
        await expect(list.locator('.hapi-session-open')).toBeVisible()
        await page.screenshot({ path: `${info.outputDir}/original-sidebar-window.png`, fullPage: true })
        expect(environment.hapi.sent).toHaveLength(0)
        expect(errors).toEqual([])
    })

})
