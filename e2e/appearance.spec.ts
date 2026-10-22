import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Real official DSH theme, Conversation and xterm; source facts/PTY use the
 * same explicit HAPI wire fixture as the other integration tests. */
import { test, expect } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { initialWorkspace } from '../src/client/model.ts'

test.describe('original HAPI appearance through official DSH plugin contracts', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => { environment = await startOfficialEnvironment() })
    test.afterAll(async () => { await environment?.close() })
    test.beforeEach(async () => {
        const document = await environment.rpc<{ revision: number }>('hapi/workspaceGet')
        let sequence = 0
        const result = await environment.rpc<{ status: string }>('hapi/workspacePut', {
            expectedRevision: document.revision, operationId: 'appearance-reset-' + crypto.randomUUID(),
            state: initialWorkspace(() => 'appearance-node-' + ++sequence),
        })
        expect(result.status).toBe('applied')
    })

    test('OLED and font preferences remain shared while real source terminal uses 9px', async ({ page }, info) => {
        const errors: string[] = []
        const upstreamReleasedReferences: string[] = []
        const openerMounts: unknown[] = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => {
            if (message.type() !== 'error') return
            const text = message.text(), first = text.split('\n')[0]!
            // Pinned ui-sidebar-right's known disposal/open race. Preserve it
            // as evidence; every pageerror and any other console error fails.
            if (first.startsWith('Sidebar Session opening failed: Error: Session reference "') && first.endsWith('" is released')) upstreamReleasedReferences.push(text)
            else errors.push(text)
        })
        await page.exposeFunction('recordAppearanceOpener', (value: unknown) => { openerMounts.push(value) })
        // Record transient mounts too: a Host-local opener in a source pane is
        // incorrect even if the next projection update immediately hides it.
        await page.addInitScript({ content: `new MutationObserver(rows => {
            for (const row of rows) for (const node of row.addedNodes) {
                if (!(node instanceof Element)) continue;
                for (const img of [...(node.matches('img') ? [node] : []), ...node.querySelectorAll('img')]) {
                    if (!img.getAttribute('src')?.includes('open-in-app/icon/')) continue;
                    const parents = []; let owner = img.parentElement;
                    while (owner && parents.length < 20) {
                        parents.push({ tag: owner.tagName, className: owner.className, pane: owner.getAttribute('data-pane-id'), instance: owner.getAttribute('data-hapi-pane-instance'), label: owner.getAttribute('aria-label') });
                        owner = owner.parentElement;
                    }
                    window.recordAppearanceOpener({ path: img.getAttribute('src'), parents });
                }
            }
        }).observe(document, { childList: true, subtree: true });` })
        await page.addInitScript(() => {
            // Original HAPI keys, seeded only once. Reload must preserve edits.
            if (localStorage.getItem('appearance-fixture-seeded')) return
            localStorage.setItem('appearance-fixture-seeded', 'yes')
            localStorage.setItem('hapi-appearance', 'oled')
            localStorage.setItem('hapi-color-theme', 'codex')
            localStorage.setItem('hapi-font-scale', '1.2')
            localStorage.setItem('hapi-terminal-font-size', '9')
            localStorage.setItem('hapi-theme-colors', JSON.stringify({ oled: { userBubble: '#123456' } }))
            localStorage.setItem('hapi-session-header-metadata', JSON.stringify({ createdAt: true, updatedAt: true, lastActive: false, model: false }))
        })
        try {
            await page.goto(environment.launchUrl)
            await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
            await acknowledgePreviewNotice(page, environment)
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click()
            const alpha = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })
            await expect(alpha.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible()
            const graph = alpha
            await expect.poll(() => graph.evaluate(element => getComputedStyle(element).getPropertyValue('--dsw-alias-bg-base').trim())).toBe('#000000')
            await expect.poll(() => graph.evaluate(element => getComputedStyle(element).getPropertyValue('--dsh-content-font-size').trim())).toBe('16.8px')
            const bubble = alpha.locator('[class*="_bubble"]').filter({ hasText: 'Question from Codex TUI — alpha' })
            await expect(bubble).not.toHaveCSS('background-color', 'rgb(18, 52, 86)')

            await page.locator('.hapi-workspace-toolbar').getByRole('button', { name: 'Split left / right', exact: true }).click()
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click()
            const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true })
            await expect(beta.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toBeVisible()
            await page.getByRole('button', { name: 'Account menu', exact: true }).click()
            await page.getByRole('menuitem', { name: 'Settings', exact: false }).click()
            const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
            await settings.getByRole('button', { name: 'HAPI appearance', exact: true }).click()
            const panel = settings.getByRole('region', { name: 'HAPI appearance', exact: true })
            await expect(panel.getByRole('combobox', { name: 'Terminal font size', exact: true })).toHaveValue('9')
            await expect(panel.getByRole('combobox', { name: 'Bubble color', exact: true })).toHaveCount(0)
            await expect(panel.getByLabel('Custom User message', { exact: true })).toHaveCount(0)
            await expect(panel.getByRole('group', { name: 'Source session header', exact: true })).toHaveCount(0)
            await panel.getByRole('combobox', { name: 'Color palette', exact: true }).selectOption('nord')
            await panel.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark')
            await page.keyboard.press('Escape')
            await expect(settings).toHaveCount(0)
            await expect.poll(() => beta.evaluate(element => getComputedStyle(element).getPropertyValue('--dsw-alias-bg-base').trim())).toBe('#2e3440')

            const ids = new Set(await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id'))))
            await alpha.click({ position: { x: 4, y: 4 } })
            const menu = page.locator('.hapi-statusbar .hapi-pane-actions')
            await menu.locator(':scope > summary').click(); await menu.getByRole('button', { name: 'Terminal', exact: true }).click()
            await expect.poll(async () => (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).filter(id => !ids.has(id)).length).toBe(1)
            const id = (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).find(id => !ids.has(id))!
            const terminal = page.locator(`[data-pane-id="${id}"]`)
            await expect(terminal.locator('[data-sidebar-terminal] .xterm')).toBeVisible()
            // xterm's DOM renderer measures regular/bold/italic/bold-italic in
            // four spans. Inspect all real engine measurement variants.
            const measureFontSizes = () => terminal.locator('.xterm-char-measure-element').evaluateAll(elements => [...new Set(elements.map(element => getComputedStyle(element).fontSize))])
            await expect.poll(measureFontSizes).toEqual(['9px'])
            await terminal.getByRole('textbox', { name: 'Terminal', exact: true }).pressSequentially('appearance-input\r')
            await expect.poll(() => environment.hapi.workbench.terminalInputs.filter(row => row.machineId === 'machine-alpha').map(row => row.data).join('')).toBe('appearance-input\r')
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
            await page.reload()
            await expect.poll(measureFontSizes).toEqual(['9px'])
            await expect(alpha.locator('[data-hapi-header-field="model"]')).toContainText('fixture-model')
            await expect(beta.locator('[data-hapi-header-field="machine"]')).toHaveCount(0)
            await expect.poll(() => alpha.locator('[data-hapi-pane-instance]').evaluate(element => getComputedStyle(element).getPropertyValue('--dsw-alias-bg-base').trim())).toBe('#2e3440')
            expect(environment.hapi.sent).toHaveLength(0)
            expect(openerMounts, 'Source panes never mount a serving-Host desktop opener').toEqual([])
            expect(errors).toEqual([])
            await page.screenshot({ path: info.outputPath('appearance-official-plugins.png'), fullPage: true })
        } finally {
            await info.attach('browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
            await info.attach('source-opener-mounts', { body: JSON.stringify(openerMounts, null, 2), contentType: 'application/json' })
        }
    })
})
