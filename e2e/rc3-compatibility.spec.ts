/** Real rc.3 menus, navigation and drafts; all sessions and providers are local fixtures. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { conversationReady, visualReview } from './visual-review.ts'

const composerName = /^(Message or run a task|Describe what you want to build), \/ commands, @ files or sessions$/
const originalTitle = 'RC3 standard draft'
const creatorTitle = 'RC3 creator draft'
const sidebarPrompt = 'Create a DSH plugin with a left sidebar entry.'
const rightbarPrompt = 'Create a DSH plugin with a right sidebar entry.'
test.use({ screenshot: 'off' })

async function openSession(page: Page, title: string): Promise<Locator> {
    await page.locator('.hapi-session-open').filter({ hasText: title }).click()
    const pane = page.locator('.hapi-pane-focused').and(page.getByRole('region', { name: `Pane: ${title}`, exact: true }))
    await expect(pane.getByRole('textbox', { name: composerName, exact: true })).toBeVisible()
    const paneId = await pane.getAttribute('data-pane-id')
    return page.locator(`[data-pane-id="${paneId}"]`)
}
async function sidebarMore(page: Page): Promise<Locator> {
    await page.getByRole('navigation', { name: 'Global panels', exact: true }).getByRole('button', { name: 'More', exact: true }).click()
    const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Create your plugin', exact: true }) })
    await expect(menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true })).toBeVisible()
    return menu
}
async function openGuide(page: Page, pane: Locator): Promise<Locator> {
    const ids = await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))
    await pane.click({ position: { x: 4, y: 4 } })
    const menu = page.locator('.hapi-statusbar > .hapi-pane-actions')
    await menu.locator(':scope > summary').click()
    await menu.getByRole('button', { name: 'Plugin views in a new pane', exact: true }).click()
    await expect.poll(async () => (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).filter(id => !ids.includes(id)).length).toBe(1)
    const id = (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).find(id => !ids.includes(id))!
    const guide = page.locator(`[data-pane-id="${id}"]`)
    await expect(guide.getByRole('button', { name: 'More tools', exact: true })).toBeVisible()
    return guide
}
async function guideMore(page: Page, guide: Locator): Promise<Locator> {
    await guide.getByRole('button', { name: 'More tools', exact: true }).click()
    const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Create your plugin', exact: true }) })
    await expect(menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true })).toBeVisible()
    return menu
}

test('deferred official More menus open plugin pages and append Creator drafts without submitting', async ({ page }, info) => {
    test.setTimeout(240_000)
    let environment: OfficialEnvironment | undefined
    const errors: string[] = [], submissions: string[] = [], creations: string[] = []
    const restoredSessionIds = new Set<string>()
    const officialReferenceCancellations: Array<{ sessionId: string; text: string }> = []
    let restoring = false
    const stage = (name: string): void => { process.stdout.write(`[rc3 compatibility] ${name}\n`) }
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
        if (message.type() !== 'error') return
        const text = message.text()
        const released = /^Sidebar Session opening failed: Error: Session reference "([^"]+)" is released\n/.exec(text)
        // rc.3 SidebarSessionView logs even its normal reference-ready
        // cancellation as an error. Record only this exact upstream teardown
        // path for sessions restored by this test; all other errors still fail.
        if (restoring && released && restoredSessionIds.has(released[1]!)
            && text.includes('at ClientSessionReference.release (') && text.includes('at SidebarSessionView.dispose (')) {
            officialReferenceCancellations.push({ sessionId: released[1]!, text })
        } else errors.push(text)
    })
    page.on('request', request => {
        const path = new URL(request.url()).pathname
        if (path.endsWith('/api/session/prompt')) submissions.push('HTTP session/prompt')
        if (path.endsWith('/api/session/create')) creations.push(request.postData() ?? '')
    })
    page.on('websocket', socket => socket.on('framesent', frame => {
        try { if (JSON.parse(frame.payload.toString()).method === 'session/prompt') submissions.push('WebSocket session/prompt') }
        catch { /* Non-JSON transport frames cannot submit a prompt. */ }
    }))
    try {
        await page.addInitScript(() => {
            const observations: Array<Record<string, unknown>> = []
            Object.assign(window, { __rc3FocusObservations: observations })
            document.addEventListener('focusin', event => {
                if (!(event.target instanceof HTMLElement)) return
                observations.push({ time: performance.now(), paneId: event.target.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
                    tag: event.target.tagName, type: event.target.getAttribute('type'), role: event.target.getAttribute('role'),
                    editable: event.target.getAttribute('contenteditable'), class: event.target.className, stack: new Error('focusin').stack })
                if (observations.length > 200) observations.shift()
            })
        })
        environment = await startOfficialEnvironment()
        const { workspace } = await environment.rpc<{ workspace: { workspaceId: string } }>('workspace/create', { path: environment.directory })
        const original = await environment.rpc<{ sessionId: string }>('session/create', { workspaceId: workspace.workspaceId })
        await environment.rpc('session/rename', { sessionId: original.sessionId, title: originalTitle })
        await page.goto(environment.launchUrl)
        await acknowledgePreviewNotice(page, environment)
        await openSession(page, 'Native Codex alpha')
        await page.waitForFunction(() => performance.getEntriesByName('hapi:conversation-plugins-ready').length > 0)
        stage('deferred plugins ready; opening sidebar More')

        const sidebar = await sidebarMore(page)
        await expect(sidebar.getByRole('menuitem', { name: 'Create your plugin', exact: true })).toBeVisible()
        expect(await page.getByRole('navigation', { name: 'Global panels' }).locator(':scope > button [class*="panelTitle"]').evaluateAll(labels =>
            labels.every(label => label.scrollWidth <= label.clientWidth)), 'Sidebar plugin labels remain readable beside the compact More button').toBe(true)
        const sidebarShot = await visualReview(environment.launchUrl, 'rc3-sidebar-more', '1440x900', conversationReady('Native Codex alpha', `
            if (!performance.getEntriesByName('hapi:conversation-plugins-ready').length) return false;
            const more = document.querySelector('nav[aria-label="Global panels"] button[aria-label="More"]');
            if (!more || more.getAttribute('aria-expanded') !== 'true') { more?.click(); return false; }
            if (![...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.trim() === 'Create your plugin' && item.getBoundingClientRect().width)) return false;
        `))
        if (sidebarShot) await info.attach('rc3-sidebar-more', { path: sidebarShot, contentType: 'image/png' })
        await sidebar.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
        stage('sidebar Browse opened the official Plugins page')
        // webshot uses its own browser profile. Capture before creating the
        // Creator draft so that profile's default blank selection cannot change
        // the preset under the later functional scenario.
        const visualGuide = await openGuide(page, await openSession(page, 'Native Codex alpha'))
        await guideMore(page, visualGuide)
        await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
        const guideShot = await visualReview(environment.launchUrl, 'rc3-guide-more', '1440x900', conversationReady('Native Codex alpha', `
            if (!performance.getEntriesByName('hapi:conversation-plugins-ready').length) return false;
            const more = [...document.querySelectorAll('.hapi-pane button[aria-label="More tools"]')].find(button => button.getBoundingClientRect().width);
            if (!more || more.getAttribute('aria-expanded') !== 'true') { more?.click(); return false; }
            if (![...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.trim() === 'Create your plugin' && item.getBoundingClientRect().width)) return false;
        `))
        if (guideShot) await info.attach('rc3-guide-more', { path: guideShot, contentType: 'image/png' })
        await page.keyboard.press('Escape')
        await visualGuide.click({ position: { x: 4, y: 4 } })
        const visualActions = page.locator('.hapi-statusbar > .hapi-pane-actions')
        await visualActions.locator(':scope > summary').click()
        await visualActions.getByRole('button', { name: 'Close pane', exact: true }).click()
        await expect(visualGuide).toHaveCount(0)
        const originalPane = await openSession(page, originalTitle)
        await originalPane.getByRole('textbox', { name: composerName }).fill('Keep this separate Standard draft.')
        await (await sidebarMore(page)).getByRole('menuitem', { name: 'Create your plugin', exact: true }).click()
        await expect(page.locator('.hapi-pane-focused').getByRole('textbox', { name: composerName })).toContainText(sidebarPrompt)
        const creatorId = await page.locator('.hapi-pane-focused [data-hapi-session-view]').getAttribute('data-hapi-session-view')
        expect(creatorId).toBeTruthy()
        expect(creatorId).not.toBe(original.sessionId)
        await environment.rpc('session/rename', { sessionId: creatorId, title: creatorTitle })
        const draftPane = page.getByRole('region', { name: `Pane: ${creatorTitle}`, exact: true })
        const draft = draftPane.getByRole('textbox', { name: composerName, exact: true })
        await draft.fill('Keep this original Creator draft.')
        await (await sidebarMore(page)).getByRole('menuitem', { name: 'Create your plugin', exact: true }).click()
        await expect(draftPane.locator('[data-hapi-session-view]')).toHaveAttribute('data-hapi-session-view', creatorId!)
        await expect(draft).toContainText('Keep this original Creator draft.')
        await expect(draft).toContainText(sidebarPrompt)
        await openSession(page, 'Native Codex alpha')
        await openSession(page, creatorTitle)
        await expect(draft).toContainText('Keep this original Creator draft.')
        await expect(draft).toContainText(sidebarPrompt)
        await expect((await openSession(page, originalTitle)).getByRole('textbox', { name: composerName })).toHaveText('Keep this separate Standard draft.')
        expect(submissions).toEqual([])
        stage('sidebar Create preserved both presets and appended the retained Creator draft')

        const alpha = await openSession(page, 'Native Codex alpha')
        restoredSessionIds.add((await alpha.locator('[data-hapi-session-view]').getAttribute('data-hapi-session-view'))!)
        restoredSessionIds.add(creatorId!)
        const beforeGuide = creations.length
        const guide = await openGuide(page, alpha)
        expect(creations.length, 'Opening Guide must not create or reset another workspace blank').toBe(beforeGuide)
        const rightMenu = await guideMore(page, guide)
        stage('pane menu opened official Guide More')
        await expect(rightMenu.getByRole('menuitem', { name: 'Create your plugin', exact: true })).toBeVisible()
        await rightMenu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
        await expect(guide.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
        stage('Guide Browse opened the official Plugins page')

        const beforeNextGuide = creations.length
        const nextGuide = await openGuide(page, alpha)
        expect(creations.length, 'Opening another Guide must preserve existing presets').toBe(beforeNextGuide)
        await (await guideMore(page, nextGuide)).getByRole('menuitem', { name: 'Create your plugin', exact: true }).click()
        const focused = page.locator('.hapi-pane-focused')
        await expect(focused.locator('[data-hapi-session-view]')).toHaveAttribute('data-hapi-session-view', creatorId!)
        const returned = focused.getByRole('textbox', { name: composerName, exact: true })
        await expect(returned).toContainText('Keep this original Creator draft.')
        await expect(returned).toContainText(sidebarPrompt)
        await expect(returned).toContainText(rightbarPrompt)
        stage('Guide Create handed its appended draft back to the shared conversation')
        restoring = true
        await page.reload()
        await expect(page.locator('.hapi-pane-focused').getByRole('textbox', { name: composerName, exact: true })).toContainText(rightbarPrompt)
        // A restored background Plugins pane must not take focus when its
        // delayed official root mounts after the user opens a chat.
        const selectedAlpha = await openSession(page, 'Native Codex alpha')
        await selectedAlpha.getByRole('textbox', { name: composerName, exact: true }).click()
        await expect(guide.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
        await expect(page.locator('[data-hapi-pane-booting]')).toHaveCount(0)
        await expect(selectedAlpha).toHaveClass(/hapi-pane-focused/, { timeout: 3000 })
        expect(await page.evaluate(() => document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id'))).toBe(await selectedAlpha.getAttribute('data-pane-id'))
        const restoredPluginPaneId = await guide.getAttribute('data-pane-id')
        expect(await page.evaluate(id => {
            const observations = (window as typeof window & { __rc3FocusObservations?: Array<{ paneId: string; editable: string }> }).__rc3FocusObservations ?? []
            return observations.filter(item => item.paneId === id && item.editable === 'true')
        }, restoredPluginPaneId), 'Restoring Plugins must never mount and focus a transient conversation editor').toEqual([])
        const afterReloadDraft = (await openSession(page, creatorTitle)).getByRole('textbox', { name: composerName, exact: true })
        await expect(afterReloadDraft).toContainText('Keep this original Creator draft.')
        await expect(afterReloadDraft).toContainText(sidebarPrompt)
        await expect(afterReloadDraft).toContainText(rightbarPrompt)
        stage('reload preserved drafts and delayed Plugins restoration did not steal chat focus')
        expect(submissions).toEqual([])
        expect(environment.hapi.sent).toEqual([])
        expect(officialReferenceCancellations.length).toBeLessThanOrEqual(restoredSessionIds.size)
        expect(new Set(officialReferenceCancellations.map(item => item.sessionId)).size).toBe(officialReferenceCancellations.length)
        expect(errors).toEqual([])
    } finally {
        await info.attach('rc3-focus-observations', { body: JSON.stringify(await page.evaluate(() =>
            (window as typeof window & { __rc3FocusObservations?: unknown }).__rc3FocusObservations ?? []), null, 2), contentType: 'application/json' })
        await info.attach('rc3-official-reference-cancellations', { body: JSON.stringify(officialReferenceCancellations, null, 2), contentType: 'application/json' })
        await info.attach('rc3-browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
        await info.attach('rc3-prompt-attempts', { body: JSON.stringify(submissions), contentType: 'application/json' })
        if (environment) await info.attach('rc3-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        await environment?.close()
    }
})
