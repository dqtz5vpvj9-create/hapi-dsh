/** Official graph and browser; the 13 source sessions are explicit wire fixtures. */
import { test, expect } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'

test('shared Host restores 13 pane identities, binds visible windows lazily and preserves drafts and geometry', async ({ page }, info) => {
    test.setTimeout(240_000)
    let environment: OfficialEnvironment | undefined
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
        environment = await startOfficialEnvironment(false)
        const names = ['alpha', 'beta', ...Array.from({ length: 11 }, (_, index) => `shared-restore-${index + 3}`)]
        for (const name of names.slice(2)) {
            environment.hapi.add(name, 'Synthetic restore machine', 'machine-alpha')
            environment.hapi.emit({ type: 'session-added', sessionId: `native-${name}` })
        }
        await page.goto(environment.launchUrl)
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
        await acknowledgePreviewNotice(page, environment)
        let catalog: { hubId: string; sessions: Array<{ id: string; hapiSessionId: string }> }
        await expect.poll(async () => {
            catalog = await environment!.rpc('hapi/catalog')
            return names.every(name => catalog.sessions.some(row => row.hapiSessionId === `native-${name}`))
        }).toBe(true)
        const windows = [names.slice(0, 4), names.slice(4, 9), names.slice(9)].map((rows, index) => ({
            id: `shared-window-${index}`, name: `Shared window ${index + 1}`, autoName: false,
            root: { type: 'split', id: `shared-split-${index}`, axis: 'horizontal', weights: rows.map(() => 1), children: rows.map(name => ({
                type: 'pane', id: `shared-pane-${name}`, resource: { kind: 'chat',
                    sessionId: catalog!.sessions.find(row => row.hapiSessionId === `native-${name}`)!.id,
                    sourceSessionId: `native-${name}`, sourceHubId: catalog!.hubId },
            })) },
        }))
        const state = { schemaVersion: 1, revision: 0, windows, activeWindowId: windows[0]!.id,
            focused: Object.fromEntries(windows.map(window => [window.id, window.root.children[0]!.id])), zoomed: {} }
        await page.evaluate(value => { localStorage.setItem(`hapi-dsh:workspace:v1:${location.origin}${location.pathname}`, JSON.stringify(value)) }, state)
        let requests = 0
        page.on('request', request => {
            const path = new URL(request.url()).pathname
            if (path === '/hapi-dsh/bootstrap' || path.startsWith('/plugins/')) requests++
        })
        const started = Date.now()
        await page.goto(`${environment.origin}/?hapiGraph=shared`)
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
        const workspaceVisibleMs = Date.now() - started
        await expect(page.locator('.hapi-pane')).toHaveCount(13)
        for (const name of names.slice(0, 4)) await expect(page.getByText(`Native history ${name} in the official DSH Conversation.`, { exact: true })).toBeVisible()
        await expect(page.locator('[data-hapi-session-view]')).toHaveCount(4)
        const activeTranscriptMs = Date.now() - started
        const startupRequests = requests
        const first = page.locator('[data-pane-id="shared-pane-alpha"]')
        const composer = first.getByRole('textbox', { name: /Message or run a task/ })
        await composer.fill('Shared restore draft keeps its original pane')
        const divider = page.getByRole('separator', { name: 'Resize split', exact: true }).first()
        const ratio = await divider.getAttribute('aria-valuenow')
        await divider.press('ArrowRight')
        await expect(divider).not.toHaveAttribute('aria-valuenow', ratio!)
        const resized = await divider.getAttribute('aria-valuenow')
        const selectWindow = async (index: number) => page.getByRole('tablist', { name: 'Window', exact: true }).getByRole('tab').nth(index).click()
        await selectWindow(1)
        for (const name of names.slice(4, 9)) await expect(page.getByText(`Native history ${name} in the official DSH Conversation.`, { exact: true })).toBeVisible()
        await expect(page.locator('[data-hapi-session-view]')).toHaveCount(9)
        await selectWindow(2)
        for (const name of names.slice(9)) await expect(page.getByText(`Native history ${name} in the official DSH Conversation.`, { exact: true })).toBeVisible()
        await expect(page.locator('[data-hapi-session-view]')).toHaveCount(13)
        await selectWindow(0)
        await expect(composer).toHaveText('Shared restore draft keeps its original pane')
        await expect(page.getByRole('separator', { name: 'Resize split', exact: true }).first()).toHaveAttribute('aria-valuenow', resized!)
        expect(requests - startupRequests).toBe(0)
        await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
        await page.reload()
        await expect(page.locator('.hapi-pane')).toHaveCount(13)
        await expect(page.locator('[data-hapi-session-view]')).toHaveCount(4)
        await expect(composer).toHaveText('Shared restore draft keeps its original pane')
        await expect(page.getByRole('separator', { name: 'Resize split', exact: true }).first()).toHaveAttribute('aria-valuenow', resized!)
        expect(environment.hapi.aborted).toEqual([])
        expect(errors).toEqual([])
        await info.attach('shared-restore-measurements', { body: JSON.stringify({ workspaceVisibleMs, activeTranscriptMs, startupRequests,
            initialViews: 4, deferredViews: 9, additionalGraphRequestsOnWindowActivation: 0 }), contentType: 'application/json' })
    } finally {
        await info.attach('shared-restore-browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
        if (environment) await info.attach('shared-restore-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        await environment?.close()
    }
})
