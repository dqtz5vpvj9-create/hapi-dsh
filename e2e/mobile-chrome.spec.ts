/** Official Host and Conversation, with synthetic source sessions and no sends.
 * Exercise the visible navigation controls; screenshots are independent webshot
 * replays of each saved state, not substitutes for identity/draft assertions. */
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { WorkspaceDocument } from '../src/client-api.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { visualReview } from './visual-review.ts'

test.use({ screenshot: 'off', trace: { mode: 'retain-on-failure', snapshots: false } })

const pane = (page: Page, name: 'alpha' | 'beta') => page.locator(`.hapi-pane[aria-label="Pane: Native Codex ${name}"]`)
const back = (page: Page) => page.locator('.hapi-statusbar > .hapi-mobile-back')
const picker = (page: Page) => page.locator('.hapi-mobile-session-layer')
const draft = (region: Locator) => region.locator('[data-composer-input]')

async function pickerIdle(page: Page): Promise<void> {
    await expect(picker(page)).toBeVisible()
    await expect(picker(page).locator('input:focus, textarea:focus, [contenteditable="true"]:focus')).toHaveCount(0)
    await expect(picker(page).getByRole('button', { name: 'Search conversations', exact: true })).toBeVisible()
    const returnButton = picker(page).locator('.hapi-picker-back')
    await expect(returnButton).toHaveAccessibleName('Back to workspace')
    await expect(returnButton.locator('svg')).toBeVisible()
    const box = (await returnButton.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    const header = await picker(page).locator('.hapi-session-sidebar > header').evaluate(element => ({
        width: innerWidth,
        buttons: [...element.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect()
            return { x: rect.x, right: rect.right }
        }),
    }))
    for (const button of header.buttons) {
        expect(button.x).toBeGreaterThanOrEqual(0)
        expect(button.right).toBeLessThanOrEqual(header.width)
    }
}

async function ready(page: Page, name: 'alpha' | 'beta'): Promise<void> {
    const region = pane(page, name)
    await expect(region).toHaveAttribute('aria-hidden', 'false')
    await expect(region.getByText(`Native history ${name} in the official DSH Conversation.`, { exact: true })).toBeVisible()
    await expect(draft(region)).toBeVisible()
}

async function openSourceStatus(menu: Locator, status: Locator, touch = true): Promise<void> {
    const click = async (locator: Locator) => touch ? locator.tap() : locator.click()
    if (await menu.getAttribute('open') === null) await click(menu.locator(':scope > summary'))
    await expect(status.locator(':scope > summary')).toHaveAccessibleName('Source status and receipts')
    await expect(status.locator(':scope > summary svg')).toHaveCount(0)
    if (await status.getAttribute('open') === null) await click(status.locator(':scope > summary'))
}

async function choose(page: Page, name: 'alpha' | 'beta'): Promise<void> {
    await pickerIdle(page)
    await picker(page).locator('.hapi-session-open').filter({ hasText: `Native Codex ${name}` }).tap()
    await expect(picker(page)).toHaveCount(0)
    await ready(page, name)
}

async function compact(page: Page, name: 'alpha' | 'beta', count: number, width: number): Promise<void> {
    const region = pane(page, name), footer = page.locator('.hapi-statusbar')
    await expect(region.locator('.hapi-pane-header')).toBeHidden()
    await expect(region.locator('.hapi-pane-header [data-hapi-pane-status]')).toBeHidden()
    await expect(back(page)).toBeVisible()
    await expect(back(page)).toHaveAccessibleName('Back to conversations')
    await expect(back(page).locator('svg')).toBeVisible()
    await expect(footer.locator(':scope > :first-child')).toHaveClass(/hapi-mobile-back/)
    if (count === 1) await expect(page.locator('.hapi-mobile-pane-bar')).toHaveCount(0)
    else {
        const tabs = page.locator('.hapi-pane-tabs').getByRole('tab')
        await expect(tabs).toHaveCount(count)
        await expect(tabs.nth(0)).toHaveText('P1')
        await expect(tabs.nth(1)).toHaveText('P2')
    }
    const geometry = await page.evaluate(() => {
        const region = document.querySelector<HTMLElement>('.hapi-pane[aria-hidden="false"]')!
        const body = region.querySelector<HTMLElement>('.hapi-pane-body')!
        const composer = region.querySelector<HTMLElement>('[data-composer-card]')!
        const footer = document.querySelector<HTMLElement>('.hapi-statusbar')!
        const box = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect()
            return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width }
        }
        return { width: document.documentElement.scrollWidth, viewport: innerWidth,
            region: box(region), body: box(body), composer: box(composer), footer: box(footer) }
    })
    expect(geometry.viewport).toBe(width)
    expect(geometry.width).toBeLessThanOrEqual(width)
    expect(Math.abs(geometry.body.y - geometry.region.y), 'hidden header must not reserve a top strip').toBeLessThanOrEqual(1)
    for (const element of [geometry.region, geometry.composer, geometry.footer]) {
        expect(element.x).toBeGreaterThanOrEqual(0)
        expect(element.right).toBeLessThanOrEqual(width + 1)
    }
    expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.footer.y + 1)
}

function screenshotReady(name: 'alpha' | 'beta', showPicker = false, showStatus = false): string {
    return `(() => {
        const notice = document.querySelector('[role="dialog"]');
        if (notice) [...notice.querySelectorAll('button')].find(b => /^(Continue|继续)$/.test(b.textContent.trim()))?.click();
        const layer = document.querySelector('.hapi-mobile-session-layer');
        if (layer) {
            if (${showPicker}) return !![...layer.querySelectorAll('.hapi-session-open')].find(b => b.textContent.includes('Native Codex alpha'));
            layer.querySelector('.hapi-picker-back')?.click();
            return false;
        }
        if (${showPicker}) { document.querySelector('.hapi-mobile-back')?.click(); return false; }
        const pane = document.querySelector('.hapi-pane[aria-label="Pane: Native Codex ${name}"][aria-hidden="false"]');
        if (!pane) {
            const tab = [...document.querySelectorAll('.hapi-pane-tabs [role="tab"]')].find(b => b.title === 'Native Codex ${name}');
            if (tab) tab.click();
            // A cold catalog may not have supplied titles yet. Wait for it;
            // selecting a list row here would replace the current pane.
            return false;
        }
        if (${showStatus}) {
            const menu = document.querySelector('.hapi-statusbar > .hapi-pane-actions');
            if (!menu?.open) { menu?.querySelector(':scope > summary')?.click(); return false; }
            const slot = document.querySelector('[data-hapi-pane-mobile-status="' + pane.dataset.paneId + '"]');
            const status = slot?.querySelector('.hapi-pane-source-status');
            if (!status) return false;
            if (!status.open) { status.querySelector('summary')?.click(); return false; }
        }
        return !!pane.querySelector('[data-composer-input]') && pane.textContent.includes('Native history ${name} in the official DSH Conversation.');
    })()`
}

async function capture(environment: OfficialEnvironment, info: TestInfo, name: string, width: number, readyJs: string): Promise<void> {
    const before = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
    const path = await visualReview(environment.launchUrl, name, `${width}x844`, readyJs)
    if (path) await info.attach(name, { path, contentType: 'image/png' })
    const after = await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')
    expect(after.state?.windows, 'a visual replay must not change the saved panes or sessions').toEqual(before.state?.windows)
}

for (const width of [360, 390]) {
    test.describe(`${width}px mobile workspace chrome`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true })
        test('returns to conversations without losing the draft and keeps pane switching only for splits', async ({ page, browser }, info) => {
            test.setTimeout(150_000)
            const environment = await startOfficialEnvironment()
            const alphaFixture = environment.hapi.sessions.get('native-alpha')!
            const alphaAnswer = alphaFixture.rows.find(row => row.localId?.includes(':answer-alpha:message'))!
            const answer = alphaAnswer.content as { content: { data: { message: string } } }
            answer.content.data.message += '\n\n' + Array.from({ length: 48 }, (_, index) =>
                `Reading position ${index + 1}. This synthetic paragraph makes the conversation longer than the phone viewport. Returning from the conversation list must preserve the paragraph being read.`).join('\n\n')
            const errors: string[] = []
            const readingChecks: Array<{ before: number; after: number }> = []
            page.on('pageerror', error => errors.push(error.message))
            try {
                await page.goto(environment.launchUrl)
                await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
                await acknowledgePreviewNotice(page, environment)
                await back(page).tap()
                await choose(page, 'alpha')
                await compact(page, 'alpha', 1, width)
                const alpha = pane(page, 'alpha')
                const identity = { paneId: await alpha.getAttribute('data-pane-id'), sessionId: await alpha.getAttribute('data-session-id') }
                await draft(alpha).fill(`Alpha mobile draft at ${width}px`)
                await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
                await capture(environment, info, `mobile-chrome-single-${width}`, width, screenshotReady('alpha'))

                const readingPort = alpha.locator('[data-conversation-scroll]')
                const readingTop = await readingPort.evaluate(async element => {
                    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2)
                    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
                    return element.scrollTop
                })
                expect(readingTop, 'the long-history fixture must actually start away from the tail').toBeGreaterThan(100)
                await back(page).tap()
                await pickerIdle(page)
                await picker(page).getByRole('button', { name: 'Search conversations', exact: true }).tap()
                await expect(picker(page).locator('.hapi-search input')).toBeFocused()
                await page.keyboard.press('Escape')
                await pickerIdle(page)
                await expect(picker(page).locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' })).toBeVisible()
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
                await capture(environment, info, `mobile-chrome-list-${width}`, width, screenshotReady('alpha', true))
                await choose(page, 'alpha')
                await expect(alpha).toHaveAttribute('data-pane-id', identity.paneId!)
                await expect(alpha).toHaveAttribute('data-session-id', identity.sessionId!)
                await expect(draft(alpha)).toHaveText(`Alpha mobile draft at ${width}px`)
                await expect.poll(async () => Math.abs(await readingPort.evaluate(element => element.scrollTop) - readingTop), {
                    message: 'reselecting the current conversation must keep the reading position',
                }).toBeLessThanOrEqual(1)
                readingChecks.push({ before: readingTop, after: await readingPort.evaluate(element => element.scrollTop) })
                await compact(page, 'alpha', 1, width)

                const actions = page.locator('.hapi-statusbar > .hapi-pane-actions')
                await actions.locator(':scope > summary').tap()
                await expect(actions).toHaveAttribute('open', '')
                await actions.getByRole('button', { name: 'Split left / right', exact: true }).tap()
                await choose(page, 'beta')
                await draft(pane(page, 'beta')).fill(`Beta mobile draft at ${width}px`)
                await compact(page, 'beta', 2, width)
                const tabs = page.locator('.hapi-pane-tabs').getByRole('tab')
                await tabs.nth(0).tap()
                await ready(page, 'alpha')
                await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
                await expect(draft(alpha)).toHaveText(`Alpha mobile draft at ${width}px`)
                await expect(alpha).toHaveAttribute('data-pane-id', identity.paneId!)
                await expect(alpha).toHaveAttribute('data-session-id', identity.sessionId!)
                await compact(page, 'alpha', 2, width)
                await tabs.nth(1).tap()
                await ready(page, 'beta')
                await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
                await expect(draft(pane(page, 'beta'))).toHaveText(`Beta mobile draft at ${width}px`)
                await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
                if (width === 390) {
                    // An explicit disconnected-source fixture exercises the
                    // moved status/recovery portal without sending a message.
                    const fixture = environment.hapi.sessions.get('native-beta')!
                    fixture.session.metadata!.codexNativeConnection = 'history'
                    fixture.session.metadataVersion++
                    environment.hapi.emit({ type: 'session-updated', sessionId: fixture.session.id })
                    const betaId = await pane(page, 'beta').getAttribute('data-pane-id')
                    const status = actions.locator(`[data-hapi-pane-mobile-status="${betaId}"] .hapi-pane-source-status`)
                    if (await actions.getAttribute('open') !== null) await actions.locator(':scope > summary').tap()
                    await expect(status).toBeHidden()
                    await openSourceStatus(actions, status)
                    await expect(status.getByRole('button', { name: 'Resume native session', exact: true })).toBeVisible()
                    await expect(status.locator('[data-hapi-composer-admission="resume"]')).toBeVisible()
                    await tabs.nth(0).tap()
                    await ready(page, 'alpha')
                    await expect(page.locator('.hapi-statusbar .hapi-pane-source-status:visible')).toHaveCount(0)
                    await tabs.nth(1).tap()
                    await ready(page, 'beta')
                    await openSourceStatus(actions, status)
                    await expect(status.getByRole('button', { name: 'Resume native session', exact: true })).toBeVisible()
                    await actions.locator(':scope > summary').tap()
                    await page.setViewportSize({ width: 1440, height: 844 })
                    const desktopMenu = pane(page, 'beta').locator('.hapi-pane-header .hapi-pane-menu')
                    const desktopStatus = desktopMenu.locator('.hapi-pane-source-status')
                    await expect(desktopStatus).toBeHidden()
                    await expect(page.locator('.hapi-pane-source-status')).toHaveCount(1)
                    await expect(pane(page, 'beta').locator('.hapi-pane-header')).toBeVisible()
                    await openSourceStatus(desktopMenu, desktopStatus, false)
                    await expect(desktopStatus.getByRole('button', { name: 'Resume native session', exact: true })).toBeVisible()
                    await desktopMenu.locator(':scope > summary').click()
                    await page.setViewportSize({ width, height: 844 })
                    await expect(status).toBeHidden()
                    await expect(page.locator('.hapi-pane-source-status')).toHaveCount(1)
                    await expect(pane(page, 'beta').locator('.hapi-pane-header')).toBeHidden()
                    await openSourceStatus(actions, status)
                    await expect(status.getByRole('button', { name: 'Resume native session', exact: true })).toBeVisible()
                    await actions.locator(':scope > summary').tap()
                    await expect(page.locator('.hapi-pane-source-status:visible')).toHaveCount(0)
                    await compact(page, 'beta', 2, width)
                }
                await capture(environment, info, `mobile-chrome-split-${width}`, width, screenshotReady('beta', false, width === 390))

                if (width === 390) {
                    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 844 }, isMobile: false, hasTouch: false })
                    try {
                        const desktop = await desktopContext.newPage()
                        await desktop.goto(environment.launchUrl)
                        await acknowledgePreviewNotice(desktop, environment, { initialView: 'existing-session' })
                        for (const name of ['alpha', 'beta'] as const) {
                            await ready(desktop, name)
                            await expect(pane(desktop, name).locator('.hapi-pane-header')).toBeVisible()
                            await expect(pane(desktop, name).locator('.hapi-pane-heading')).toContainText(`Native Codex ${name}`)
                        }
                        await expect(back(desktop)).toHaveCount(0)
                        await expect(desktop.locator('.hapi-mobile-pane-bar')).toHaveCount(0)
                        expect(await desktop.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440)
                        await capture(environment, info, 'mobile-chrome-desktop-guard', 1440, screenshotReady('alpha'))
                    } finally { await desktopContext.close() }
                }
                expect(environment.hapi.sent).toHaveLength(0)
                expect(errors).toEqual([])
            } finally {
                await info.attach('browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
                const readingPath = info.outputPath('reading-position.json')
                await writeFile(readingPath, JSON.stringify({ width, readingChecks }))
                await info.attach('reading-position', { path: readingPath, contentType: 'application/json' })
                await environment.close()
            }
        })
    })
}
