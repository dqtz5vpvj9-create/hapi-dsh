/**
 * Real pinned DSH AppFrame/slots/session bindings and browser rendering. HAPI
 * source histories, deliveries and approvals are explicit wire fixtures.
 * The shared path is opt-in; plugin-view panes retain the compatibility graph.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { startOneGraphProfile } from './one-graph-profile.ts'

test.setTimeout(360_000)
const composerName = 'Message or run a task, / commands, @ files or sessions'
const keys = ['one-alpha', 'one-beta', 'one-gamma', 'one-delta'] as const
const history = (key: string) => `Native history ${key} in the official DSH Conversation.`
const pane = (page: Page, key: string) => page.getByRole('region', { name: `Pane: Native Codex ${key}`, exact: true })
const composer = (view: Locator) => view.getByRole('textbox', { name: composerName, exact: true })

async function admitShared(page: Page, environment: OfficialEnvironment): Promise<void> {
    // Admission establishes the real cookie; a second navigation preserves the
    // feature flag even when the launch-token redirect strips query parameters.
    await page.goto(environment.launchUrl)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    await acknowledgePreviewNotice(page, environment)
    await page.goto(`${environment.origin}/`)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
}

async function open(page: Page, key: string, split = false): Promise<Locator> {
    if (split) await page.locator('.hapi-workspace-toolbar').getByRole('button', { name: 'Split left / right', exact: true }).click()
    await page.locator('.hapi-session-open').filter({ hasText: `Native Codex ${key}` }).click()
    const view = pane(page, key)
    await expect(view.locator('[data-hapi-session-view]')).toHaveCount(1)
    await expect(view.getByText(history(key), { exact: true })).toBeVisible()
    return view
}

async function close(page: Page, view: Locator): Promise<void> {
    await view.click({ position: { x: 4, y: 4 } })
    const menu = page.locator('.hapi-statusbar .hapi-pane-actions')
    await menu.locator(':scope > summary').click()
    await menu.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect(view).toHaveCount(0)
}

async function heap(page: Page, label: string) {
    const cdp = await page.context().newCDPSession(page)
    try {
        await cdp.send('HeapProfiler.collectGarbage')
        const memory = await cdp.send('Runtime.getHeapUsage') as { usedSize: number }
        const dom = await cdp.send('Memory.getDOMCounters') as { nodes: number; jsEventListeners: number }
        return { label, usedMB: +(memory.usedSize / 1048576).toFixed(2), nodes: dom.nodes, listeners: dom.jsEventListeners }
    } finally { await cdp.detach() }
}

/** Browser timestamps distinguish the surface appearing from text being ready. */
async function timedSwitch(page: Page, paneId: string, key: string) {
    return page.evaluate(({ paneId, key, text }) => new Promise<{ elementMs: number; contentMs: number }>((resolve, reject) => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('.hapi-session-open')].find(item => item.textContent?.includes(`Native Codex ${key}`))
        if (!button) { reject(new Error(`Missing fixture session ${key}`)); return }
        let elementMs: number | undefined
        const started = performance.now()
        const timer = window.setTimeout(() => { observer.disconnect(); reject(new Error('Shared session switch timed out')) }, 10_000)
        const inspect = () => {
            const pane = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(item => item.dataset.paneId === paneId)
            const candidate = pane?.querySelector<HTMLElement>('[data-hapi-session-view]')
            const surface = pane?.getAttribute('aria-label') === `Pane: Native Codex ${key}`
                && candidate?.dataset.hapiSessionView === pane.dataset.sessionId ? candidate : null
            if (surface && elementMs === undefined) elementMs = performance.now() - started
            if (surface?.textContent?.includes(text)) {
                observer.disconnect(); clearTimeout(timer)
                resolve({ elementMs: elementMs ?? performance.now() - started, contentMs: performance.now() - started })
            }
        }
        const observer = new MutationObserver(inspect)
        observer.observe(document.body, { subtree: true, childList: true, characterData: true })
        button.click(); inspect()
    }), { paneId, key, text: history(key) })
}

test.describe('one official graph per Host for chat panes', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment(true)
        for (const key of keys) {
            const fixture = environment.hapi.add(key, 'Synthetic laptop', 'machine-alpha')
            if (key === 'one-alpha' || key === 'one-beta') {
                const data = (fixture.rows[1]!.content as { content: { data: { message: string } } }).content.data
                data.message += '\n\n' + Array.from({ length: 45 }, (_, i) => `${key} scroll paragraph ${i + 1}. Independent transcript content.`).join('\n\n')
            }
            environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
        }
        environment.hapi.workbench.updateFile('native-one-alpha', '/workspace/one-alpha/alpha scoped.ts', 'Synthetic alpha file\n')
        environment.hapi.workbench.updateFile('native-one-beta', '/workspace/one-beta/beta scoped.ts', 'Synthetic beta file\n')
    })
    test.afterAll(async () => { await environment?.close() })

    test('local panes share resources while drafts, scrolling, approvals and closure retain their source', async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        const requests: string[] = []
        page.on('request', request => {
            const path = new URL(request.url()).pathname
            if (path.startsWith('/plugins/') || path === '/hapi-dsh/bootstrap') requests.push(path)
        })
        const measurements: Awaited<ReturnType<typeof heap>>[] = []
        try {
            await admitShared(page, environment)
            for (const key of keys) await expect(page.locator('.hapi-session-open').filter({ hasText: `Native Codex ${key}` })).toBeVisible()
            const baselineRequests = requests.length
            measurements.push(await heap(page, '0 panes'))
            const alpha = await open(page, 'one-alpha')
            await composer(alpha).fill('Independent alpha draft')
            measurements.push(await heap(page, '1 pane'))
            const beta = await open(page, 'one-beta', true)
            await composer(beta).fill('Independent beta draft')
            measurements.push(await heap(page, '2 panes'))
            await expect(composer(alpha)).toHaveText('Independent alpha draft')
            await expect(composer(beta)).toHaveText('Independent beta draft')
            await expect(alpha).not.toContainText('one-beta scroll paragraph')
            await expect(beta).not.toContainText('one-alpha scroll paragraph')
            await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
            await expect(page.locator('iframe')).toHaveCount(0)

            await composer(alpha).fill('@alpha')
            const candidate = alpha.getByRole('option').filter({ hasText: 'alpha scoped.ts' })
            await expect(candidate).toBeVisible()
            await expect(alpha.getByRole('option').filter({ hasText: 'beta scoped.ts' })).toHaveCount(0)
            await candidate.click()
            await expect(composer(alpha).locator('[contenteditable="false"]')).toHaveCount(1)
            await expect(composer(beta)).toHaveText('Independent beta draft')
            await composer(alpha).fill('Independent alpha draft')

            const alphaScroll = alpha.locator('[data-conversation-scroll]'), betaScroll = beta.locator('[data-conversation-scroll]')
            const betaTop = await betaScroll.evaluate(element => element.scrollTop)
            await alphaScroll.evaluate(element => { element.scrollTop = Math.max(1, (element.scrollHeight - element.clientHeight) / 2); element.dispatchEvent(new Event('scroll')) })
            const alphaTop = await alphaScroll.evaluate(element => element.scrollTop)
            expect(alphaTop).toBeGreaterThan(0)
            await composer(alpha).focus()
            await expect(alpha).toHaveClass(/hapi-pane-focused/)
            await composer(beta).focus()
            await expect(beta).toHaveClass(/hapi-pane-focused/)
            expect(await betaScroll.evaluate(element => element.scrollTop)).toBeCloseTo(betaTop, 0)
            expect(await alphaScroll.evaluate(element => element.scrollTop)).toBeCloseTo(alphaTop, 0)

            // Opening and dismissing a pane-owned dialog must retain both drafts.
            await beta.getByRole('button', { name: 'Voice and dictation', exact: true }).click()
            const dialog = page.getByRole('dialog', { name: 'Voice and dictation', exact: true })
            await expect(dialog).toBeVisible()
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
            await expect(composer(alpha)).toHaveText('Independent alpha draft')
            await expect(composer(beta)).toHaveText('Independent beta draft')

            environment.hapi.requestApproval('native-one-alpha', 'shared-alpha-approval')
            const approval = alpha.locator('[data-native-request="shared-alpha-approval"]')
            await expect(approval).toBeVisible()
            await expect(beta.locator('[data-native-request]')).toHaveCount(0)
            await approval.getByRole('button', { name: 'Approve', exact: true }).click()
            await expect.poll(() => environment.hapi.approvals.at(-1)).toMatchObject({ sessionId: 'native-one-alpha', requestId: 'shared-alpha-approval' })
            environment.hapi.settleApproval('native-one-alpha', 'shared-alpha-approval')
            await expect(approval).toHaveCount(0)

            await open(page, 'one-gamma', true)
            await open(page, 'one-delta', true)
            measurements.push(await heap(page, '4 panes'))
            expect(requests.length - baselineRequests, 'chat panes must not bootstrap or fetch additional local graph rows').toBe(0)
            await expect(page.locator('[data-hapi-session-view]')).toHaveCount(4)

            // Close one warm view, then bind its cached session and the delta
            // session alternately into the same remaining pane.
            await close(page, pane(page, 'one-gamma'))
            const delta = pane(page, 'one-delta')
            await delta.click({ position: { x: 4, y: 4 } })
            const paneId = await delta.getAttribute('data-pane-id')
            expect(paneId).toBeTruthy()
            const timings = []
            const stopProfile = await startOneGraphProfile(page)
            try {
                for (let i = 0; i < 10; i++) timings.push(await timedSwitch(page, paneId!, i % 2 ? 'one-delta' : 'one-gamma'))
            } finally { await stopProfile(info) }
            const sorted = timings.map(row => row.contentMs).sort((left, right) => left - right)
            const warmP95Ms = sorted[Math.ceil(sorted.length * .95) - 1]!
            await info.attach('one-graph-measurements', { body: JSON.stringify({ measurements, timings, warmP95Ms,
                warmGoalMet: warmP95Ms < 150, localPanePluginRequests: requests.length - baselineRequests }, null, 2), contentType: 'application/json' })

            // The close action releases this view; execution ownership remains on HAPI.
            const aborted = environment.hapi.aborted.length
            await close(page, delta)
            expect(environment.hapi.aborted).toHaveLength(aborted)
            await expect(composer(alpha)).toHaveText('Independent alpha draft')
            await expect(composer(beta)).toHaveText('Independent beta draft')
            expect(errors).toEqual([])
        } finally {
            await info.attach('shared-browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
            await info.attach('shared-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        }
    })

    test('remote chat panes bind the existing Host graph without another bootstrap or bundle round trip', async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        const requests: string[] = []
        page.on('request', request => {
            const url = new URL(request.url())
            if (url.pathname.startsWith('/hapi-dsh/machine/runner-one/') && (url.pathname.includes('/plugins/') || url.pathname.endsWith('/hapi-dsh/bootstrap'))) requests.push(url.pathname)
        })
        try {
            await admitShared(page, environment)
            const remote = page.locator('.hapi-session-open').filter({ hasText: 'DSH remote conversation' })
            await expect(remote).toBeVisible({ timeout: 90_000 })
            await remote.click()
            const first = page.getByRole('region', { name: 'Pane: DSH remote conversation', exact: true }).first()
            await expect(first.locator('[data-hapi-session-view]')).toHaveCount(1)
            await expect(first.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible()
            const baselineRequests = requests.length
            const created = await environment.remoteRpc!<{ sessionId: string }>('session/create', { cwd: environment.directory })
            await environment.remoteRpc!('session/selectModel', { sessionId: created.sessionId, provider: 'fixture', model: 'fixture-model' })
            await environment.remoteRpc!('session/rename', { sessionId: created.sessionId, title: 'Second remote shared conversation' })
            await environment.remoteRpc!('session/prompt', { sessionId: created.sessionId, requestId: 'one-graph-remote-fixture', mode: 'queue', content: [{ type: 'text', text: 'Second remote fixture prompt' }] })
            await page.locator('.hapi-workspace-toolbar').getByRole('button', { name: 'Split left / right', exact: true }).click()
            await page.locator('.hapi-session-open').filter({ hasText: 'Second remote shared conversation' }).click()
            const second = page.getByRole('region', { name: 'Pane: Second remote shared conversation', exact: true })
            await expect(second.locator('[data-hapi-session-view]')).toHaveCount(1)
            await expect(second.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible()
            expect(requests.length - baselineRequests, 'second remote chat pane reuses the catalog graph').toBe(0)
            await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
            await info.attach('one-graph-remote-requests', { body: JSON.stringify({ firstHostRequests: baselineRequests, additionalPaneRequests: requests.length - baselineRequests }), contentType: 'application/json' })
            expect(errors).toEqual([])
        } finally {
            await info.attach('remote-shared-browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
            await info.attach('remote-shared-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        }
    })
})
