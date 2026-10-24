/** Real Host and independent desktop/mobile storage. Source conversations are
 * fixtures; no messages are sent. Server revisions expose accidental writes. */
import { test, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { WorkspaceDocument, WorkspaceWriteResult } from '../src/client-api.ts'
import type { WorkspaceState } from '../src/client/model.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { visualReview, conversationReady } from './visual-review.ts'

test.use({ screenshot: 'off', trace: { mode: 'retain-on-failure', snapshots: false } })

const tabs = (page: Page) => page.locator('.hapi-window-tabs').getByRole('tab')
const editor = (page: Page, name: 'alpha' | 'beta') => page.locator(`[data-pane-id="sync-pane-${name}"] [data-composer-input]`)
const conflict = (page: Page) => page.locator('.hapi-notice').filter({ has: page.getByRole('button', { name: 'Keep this layout', exact: true }) })

async function expectNoConflict(page: Page): Promise<void> {
    await expect(conflict(page)).toHaveCount(0)
    // A structural conflict can now live in the pane menu. Inspect existence,
    // not visibility: a closed menu must not turn an unresolved conflict green.
    await expect(page.locator('.hapi-layout-sync-help')).toHaveCount(0)
}

async function restored(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.bringToFront()
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
    await expect(tabs(page)).toHaveCount(2)
    const active = page.locator('.hapi-window-active')
    await expect(active.locator('[data-composer-input]')).toBeVisible()
    await expect(active.getByText(/^Native history (alpha|beta) in the official DSH Conversation\.$/)).toBeVisible()
    await expect(page.locator('.hapi-persistence-saving')).toHaveCount(0)
}

async function open(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.goto(environment.launchUrl)
    await restored(page, environment)
}

async function rename(page: Page, index: number, name: string, trigger: 'keyboard' | 'touch' | 'context' = 'context'): Promise<void> {
    const tab = tabs(page).nth(index)
    const menu = page.getByRole('menu', { name: 'Window actions', exact: true })
    if (trigger === 'keyboard') await tab.press('Shift+F10')
    else if (trigger === 'touch') {
        await tab.scrollIntoViewIfNeeded()
        const box = (await tab.boundingBox())!
        const cdp = await page.context().newCDPSession(page)
        try {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] })
            await expect(menu).toBeVisible()
        } finally {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await cdp.detach()
        }
    } else await tab.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Rename window', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename window', exact: true })
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
}

async function seed(environment: OfficialEnvironment, browser: Browser): Promise<WorkspaceDocument> {
    // Materialize the two real display identities before seeding, so this test
    // measures geometry synchronization rather than display-generation binding.
    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await page.goto(environment.launchUrl)
        await acknowledgePreviewNotice(page, environment)
        for (const name of ['alpha', 'beta']) {
            await page.locator('.hapi-session-open').filter({ hasText: `Native Codex ${name}` }).click()
            await expect(page.getByText(`Native history ${name} in the official DSH Conversation.`, { exact: true })).toBeVisible()
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
        }
    } finally { await context.close() }
    const catalog = await environment.rpc<{ hubId: string; sessions: Array<{ id: string; hapiSessionId: string }> }>('hapi/catalog')
    const windows: WorkspaceState['windows'] = (['alpha', 'beta'] as const).map(name => {
        const display = catalog.sessions.find(row => row.hapiSessionId === `native-${name}`)
        expect(display, `fixture must materialize ${name} before measuring no-op restore`).toBeDefined()
        return { id: `sync-window-${name}`, name: `Shared ${name}`, autoName: false,
            root: { type: 'pane', id: `sync-pane-${name}`, resource: { kind: 'chat', sessionId: display!.id,
                sourceSessionId: `native-${name}`, sourceHubId: catalog.hubId } } }
    })
    const state: WorkspaceState = { schemaVersion: 1, revision: 0, windows, activeWindowId: 'sync-window-alpha',
        focused: { 'sync-window-alpha': 'sync-pane-alpha', 'sync-window-beta': 'sync-pane-beta' }, zoomed: {} }
    const before = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
    const result = await environment.rpc<WorkspaceWriteResult>('hapi/workspacePut', {
        expectedRevision: before.revision, operationId: `sync-seed-${crypto.randomUUID()}`, state,
    })
    expect(result.status).toBe('applied')
    return { revision: result.revision, state: result.state }
}

async function capture(environment: OfficialEnvironment, name: string, info: TestInfo): Promise<void> {
    // These are independent visual replays after all measured contexts close.
    // The revision report is attached first and is the no-echo evidence.
    for (const viewport of ['1440x900', '390x844']) {
        const path = await visualReview(environment.launchUrl, name, viewport, conversationReady('Native Codex alpha'))
        if (path) await info.attach(`visual-${viewport}`, { path, contentType: 'image/png' })
    }
}

async function report(info: TestInfo, observations: unknown): Promise<void> {
    const path = info.outputPath('workspace-sync-revisions.json')
    await writeFile(path, JSON.stringify(observations, null, 2))
    await info.attach('workspace-sync-revisions', { path, contentType: 'application/json' })
}

test('shared layout restore and clean mobile refresh do not echo writes or prompt for conflicts', async ({ browser }, info) => {
    test.setTimeout(180_000)
    const environment = await startOfficialEnvironment()
    const contexts: BrowserContext[] = []
    const observations: Array<{ step: string; document: WorkspaceDocument }> = []
    let failure: unknown
    try {
        const baseline = await seed(environment, browser)
        observations.push({ step: 'seed', document: baseline })
        const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); contexts.push(desktopContext)
        const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(mobileContext)
        const desktop = await desktopContext.newPage(), mobile = await mobileContext.newPage()
        await open(desktop, environment)
        observations.push({ step: 'desktop restore', document: await environment.rpc('hapi/workspaceGet') })
        await open(mobile, environment)
        observations.push({ step: 'mobile restore', document: await environment.rpc('hapi/workspaceGet') })
        for (const row of observations.slice(1)) expect(row.document.revision, `${row.step} must only read the saved layout`).toBe(baseline.revision)
        await expectNoConflict(desktop); await expectNoConflict(mobile)

        await tabs(mobile).nth(1).click()
        await editor(mobile, 'beta').fill('Mobile draft survives clean server refresh')
        await rename(desktop, 0, 'Desktop renamed alpha', 'keyboard')
        await expect.poll(async () => (await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')).state?.windows[0]?.name).toBe('Desktop renamed alpha')
        const edited = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
        observations.push({ step: 'desktop rename', document: edited })
        expect(edited.revision).toBe(baseline.revision + 1)

        for (let iteration = 0; iteration < 2; iteration++) {
            await mobile.reload(); await restored(mobile, environment)
            await expect(tabs(mobile).first()).toContainText('Desktop renamed alpha')
            await expect(tabs(mobile).nth(1)).toHaveAttribute('aria-selected', 'true')
            await expect(editor(mobile, 'beta')).toHaveText('Mobile draft survives clean server refresh')
            await expectNoConflict(mobile)
            const document = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
            observations.push({ step: `mobile reload ${iteration + 1}`, document })
            expect(document.revision).toBe(edited.revision)
        }
        const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(fresh)
        const page = await fresh.newPage(); await open(page, environment)
        await expect(tabs(page).first()).toContainText('Desktop renamed alpha')
        await expectNoConflict(page)
        const document = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
        observations.push({ step: 'fresh mobile context', document }); expect(document.revision).toBe(edited.revision)
        expect(environment.hapi.sent).toHaveLength(0)
    } catch (error) { failure = error; throw error }
    finally {
        await report(info, observations)
        for (const context of contexts) await context.close()
        try { await capture(environment, 'workspace-sync-clean', info) }
        catch (error) { if (!failure) throw error; await info.attach('visual-cleanup-error', { body: String(error), contentType: 'text/plain' }) }
        finally { await environment.close() }
    }
})

test('failed mobile save rebases independent desktop edits across reload without a choose-layout prompt', async ({ browser }, info) => {
    test.setTimeout(180_000)
    const environment = await startOfficialEnvironment()
    const contexts: BrowserContext[] = []
    const observations: Array<{ step: string; document: WorkspaceDocument }> = []
    let failure: unknown, blockedWrites = 0
    try {
        const baseline = await seed(environment, browser)
        observations.push({ step: 'seed', document: baseline })
        const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); contexts.push(desktopContext)
        const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(mobileContext)
        const desktop = await desktopContext.newPage(), mobile = await mobileContext.newPage()
        await open(desktop, environment); await open(mobile, environment)
        expect((await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')).revision).toBe(baseline.revision)
        await tabs(mobile).nth(1).click()
        await editor(mobile, 'beta').fill('Mobile draft survives a failed layout save')
        // Reject only this browser's actual mutation before it reaches the Host.
        // This is a failed-save fixture, not a claim of full WebSocket outage.
        await mobile.route('**/api/hapi/workspacePut', async route => {
            blockedWrites++
            await route.abort('internetdisconnected')
        })
        await rename(mobile, 1, 'Mobile renamed beta', 'touch')
        await expect.poll(() => blockedWrites, { message: 'the failure fixture must intercept a real workspace save' }).toBeGreaterThan(0)
        await expect(mobile.locator('.hapi-persistence-failed')).toBeVisible()
        expect((await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')).revision).toBe(baseline.revision)
        await rename(desktop, 0, 'Desktop renamed alpha')
        await expect.poll(async () => (await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')).state?.windows[0]?.name).toBe('Desktop renamed alpha')
        const desktopSaved = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
        observations.push({ step: 'desktop edit while mobile save failed', document: desktopSaved })
        expect(desktopSaved.state?.windows[1]?.name).toBe('Shared beta')
        await mobile.unrouteAll({ behavior: 'wait' })
        await mobile.reload(); await restored(mobile, environment)
        await expect(tabs(mobile).first()).toContainText('Desktop renamed alpha')
        await expect(tabs(mobile).nth(1)).toContainText('Mobile renamed beta')
        await expect(tabs(mobile).nth(1)).toHaveAttribute('aria-selected', 'true')
        await expect(editor(mobile, 'beta')).toHaveText('Mobile draft survives a failed layout save')
        await expectNoConflict(mobile)
        await expect.poll(async () => (await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')).state?.windows.map(window => window.name)).toEqual(['Desktop renamed alpha', 'Mobile renamed beta'])
        const merged = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
        observations.push({ step: 'mobile reload rebases both edits', document: merged })
        expect(merged.revision).toBe(desktopSaved.revision + 1)
        for (const page of [mobile, desktop, mobile]) {
            await page.reload(); await restored(page, environment)
            await expect(tabs(page).first()).toContainText('Desktop renamed alpha')
            await expect(tabs(page).nth(1)).toContainText('Mobile renamed beta')
            await expectNoConflict(page)
            expect((await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')).revision).toBe(merged.revision)
        }
        await expect(tabs(mobile).nth(1)).toHaveAttribute('aria-selected', 'true')
        await expect(editor(mobile, 'beta')).toHaveText('Mobile draft survives a failed layout save')
        const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(fresh)
        const page = await fresh.newPage(); await open(page, environment)
        await expect(tabs(page).first()).toContainText('Desktop renamed alpha')
        await expect(tabs(page).nth(1)).toContainText('Mobile renamed beta')
        await expectNoConflict(page)
        const document = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
        observations.push({ step: 'repeated reloads and fresh context', document })
        expect(document.revision).toBe(merged.revision)
        expect(environment.hapi.sent).toHaveLength(0)
    } catch (error) { failure = error; throw error }
    finally {
        await report(info, { blockedWrites, observations })
        for (const context of contexts) await context.close()
        try { await capture(environment, 'workspace-sync-rebase', info) }
        catch (error) { if (!failure) throw error; await info.attach('visual-cleanup-error', { body: String(error), contentType: 'text/plain' }) }
        finally { await environment.close() }
    }
})
