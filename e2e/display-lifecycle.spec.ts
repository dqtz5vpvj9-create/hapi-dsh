/** Real pinned Host/Client; one synthetic source with a bounded large history. */
import { test, expect } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { conversationReady, visualReview } from './visual-review.ts'
import type { HapiMessage } from '../src/codex/contracts.ts'

test.use({ screenshot: 'off' })
test.setTimeout(180_000)

test('closing the last browser reference retires the Host display and reopening restores the source', async ({ page }, info) => {
    const environment: OfficialEnvironment = await startOfficialEnvironment()
    const errors: string[] = []
    let acquiredLease: { hubId: string; leaseId: string } | undefined
    page.on('pageerror', error => errors.push(error.message))
    // Capture the browser's real lease id so this test can perform the same
    // last-lease release as Host TTL expiry without waiting five wall minutes.
    page.on('request', request => {
        if (!request.url().includes('/api/hapi/sourceDisplayLease')) return
        try {
            const body = request.postDataJSON() as { payload?: { args?: { request?: { action?: string; hubId?: string; leaseId?: string; sourceSessionId?: string } } } }
            const lease = body.payload?.args?.request
            if (lease?.action === 'acquire' && lease.hubId && lease.leaseId && lease.sourceSessionId === 'source-display-lifecycle') {
                acquiredLease = { hubId: lease.hubId, leaseId: lease.leaseId }
            }
        } catch { /* non-JSON fixture request */ }
    })
    try {
        const key = 'display-lifecycle'
        const fixture = environment.hapi.addObserved('claude', key)
        const title = fixture.session.metadata!.name!
        const base = fixture.session.createdAt
        const rows: HapiMessage[] = []
        const total = 1_600
        for (let index = 0; index < total; index++) {
            rows.push({ id: `lifecycle-${index}`, localId: null, seq: index, createdAt: base + index,
                content: index % 2 === 0
                    ? { role: 'user', content: { type: 'text', text: `Lifecycle question ${index}` } }
                    : { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: `lifecycle-answer-${index}`,
                        message: { model: 'sonnet', content: [{ type: 'text', text: `Lifecycle answer ${index}` }] } } } } })
        }
        fixture.rows = rows
        fixture.session.seq = rows.length + 1; fixture.session.updatedAt = base + rows.length
        environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
        // The bounded warm cache keeps five recent generations. Five filler
        // sources evict the target through the same public reference lifetime
        // instead of pretending a closed pane alone is the last reader.
        const fillers = Array.from({ length: 5 }, (_, index) => {
            const filler = environment.hapi.addObserved('claude', `lifecycle-filler-${index}`)
            return { source: filler, title: filler.session.metadata!.name! }
        })

        await page.goto(environment.launchUrl)
        await acknowledgePreviewNotice(page, environment)
        const open = () => page.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: title }).click()
        await open()
        const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
        await expect(pane.locator('[data-composer-input]')).toBeVisible()
        await expect(pane.getByText(`Lifecycle answer ${total - 1}`, { exact: true })).toBeVisible()
        const displayId = await pane.getAttribute('data-session-id')
        expect(displayId).toBeTruthy()

        const catalogState = async (): Promise<{ binding: string; attached: boolean; pending: number | null }> => {
            const value = await environment.rpc<{ sessions: Array<{ hapiSessionId: string; sourceRowState?: { pendingRequestsCount?: number | null } }>; sourceDiscovery: { sessions: Array<{ sourceSessionId: string; binding: string }> } }>('hapi/catalog')
            const display = value.sessions.find(row => row.hapiSessionId === fixture.session.id)
            return { binding: value.sourceDiscovery.sessions.find(row => row.sourceSessionId === fixture.session.id)?.binding ?? 'missing',
                attached: Boolean(display), pending: display?.sourceRowState?.pendingRequestsCount ?? null }
        }
        await expect.poll(async () => (await catalogState()).binding).toBe('attached')
        environment.hapi.requestApproval(fixture.session.id)
        await expect.poll(async () => (await catalogState()).pending).toBe(1)
        const draft = 'Draft survives Host display retirement'
        const composer = pane.locator('[data-composer-input][contenteditable="true"]')
        await composer.fill(draft)
        await expect(composer).toHaveText(draft)
        await page.waitForTimeout(500)

        // Close through the normal pane menu, not a synthetic API flag.
        await pane.click({ position: { x: 4, y: 4 } })
        const actions = page.locator('.hapi-statusbar .hapi-pane-actions')
        await actions.locator(':scope > summary').click()
        await actions.getByRole('button', { name: 'Close pane', exact: true }).click()
        await expect(page.getByRole('region', { name: `Pane: ${title}`, exact: true })).toHaveCount(0)
        for (const filler of fillers) {
            await page.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: filler.title }).click()
            const fillerPane = page.getByRole('region', { name: `Pane: ${filler.title}`, exact: true })
            await expect(fillerPane.locator('[data-composer-input]')).toBeVisible()
            await fillerPane.click({ position: { x: 4, y: 4 } })
            const fillerActions = page.locator('.hapi-statusbar .hapi-pane-actions')
            await fillerActions.locator(':scope > summary').click()
            await fillerActions.getByRole('button', { name: 'Close pane', exact: true }).click()
            await expect(page.getByRole('region', { name: `Pane: ${filler.title}`, exact: true })).toHaveCount(0)
        }

        // The warm cache evicts the target through its public reference
        // lifetime; the Host then applies its bounded grace before retiring.
        await expect.poll(async () => (await catalogState()).attached, { timeout: 25_000 }).toBe(false)
        const after = await catalogState()
        expect(after.binding).not.toBe('attached')
        expect(environment.hapi.aborted).not.toContain(fixture.session.id)
        expect(environment.hapi.sent.filter(row => row.sessionId === fixture.session.id)).toEqual([])

        // Reopen from the public sidebar; complete source content, title and
        // composer must return without a source mutation.
        await open()
        await expect(pane.locator('[data-composer-input]')).toBeVisible()
        await expect(pane.getByText(`Lifecycle answer ${total - 1}`, { exact: true })).toBeVisible()
        await expect(pane.getByText(`Lifecycle question ${total - 2}`, { exact: true })).toBeVisible()
        await expect(pane.locator('[data-composer-input][contenteditable="true"]')).toHaveText(draft)
        await expect.poll(async () => (await catalogState()).pending).toBe(1)
        const liveText = 'Lifecycle live answer after reopening'
        const at = Date.now(), seq = (fixture.rows.at(-1)?.seq ?? total) + 1
        const liveRow: HapiMessage = { id: 'lifecycle-live-after-reopen', localId: null, seq, createdAt: at,
            content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'lifecycle-live-after-reopen',
                message: { model: 'sonnet', content: [{ type: 'text', text: liveText }] } } } } }
        fixture.rows.push(liveRow)
        environment.hapi.emit({ type: 'message-received', sessionId: fixture.session.id, message: liveRow })
        await expect(pane.getByText(liveText, { exact: true })).toBeVisible()
        const reopenedId = await pane.getAttribute('data-session-id')
        expect(reopenedId).not.toBe(displayId)

        // A Host restart removes the in-memory display generation and every
        // lease. Foreground/network recovery must probe immediately, re-acquire
        // the lease, resolve the public source again and rebind the normal
        // Controller/SessionProvider without a source send or abort. Add a row
        // while the Host is down: seeing it proves real source re-read rather
        // than the old DOM generation.
        const restartText = 'Lifecycle answer after Host restart'
        const restartSeq = (fixture.rows.at(-1)?.seq ?? total) + 1
        const restartRow: HapiMessage = { id: 'lifecycle-after-host-restart', localId: null, seq: restartSeq, createdAt: Date.now(),
            content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'lifecycle-after-host-restart',
                message: { model: 'sonnet', content: [{ type: 'text', text: restartText }] } } } } }
        fixture.rows.push(restartRow)
        fixture.session.seq = restartSeq + 1; fixture.session.updatedAt = restartRow.createdAt
        await environment.restartHost()
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        await expect(pane.getByText(restartText, { exact: true })).toBeVisible({ timeout: 45_000 })
        await expect(pane.locator('[data-composer-input][contenteditable="true"]')).toHaveText(draft)
        await expect(pane.getByText(`Lifecycle answer ${total - 1}`, { exact: true })).toBeVisible()
        await expect(pane.getByText(liveText, { exact: true })).toBeVisible()
        await expect.poll(async () => (await catalogState()).pending, { timeout: 20_000 }).toBe(1)
        await expect.poll(async () => (await catalogState()).attached, { timeout: 20_000 }).toBe(true)
        expect(environment.hapi.aborted).not.toContain(fixture.session.id)
        expect(environment.hapi.sent.filter(row => row.sessionId === fixture.session.id)).toEqual([])

        // Exercise the same Host path as TTL expiry: release the browser's only
        // lease, wait for the 10s retirement grace, then resume the page. The
        // Host must create a new display generation and the client must re-read
        // a row added while its lease was gone.
        expect(acquiredLease).toBeTruthy()
        const expireText = 'Lifecycle answer after lease expiry recovery'
        const expireSeq = (fixture.rows.at(-1)?.seq ?? total) + 1
        const expireRow: HapiMessage = { id: 'lifecycle-after-lease-expiry', localId: null, seq: expireSeq, createdAt: Date.now(),
            content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'lifecycle-after-lease-expiry',
                message: { model: 'sonnet', content: [{ type: 'text', text: expireText }] } } } } }
        fixture.rows.push(expireRow)
        fixture.session.seq = expireSeq + 1; fixture.session.updatedAt = expireRow.createdAt
        await environment.rpc('hapi/sourceDisplayLease', {
            hubId: acquiredLease!.hubId, sourceSessionId: fixture.session.id,
            leaseId: acquiredLease!.leaseId, action: 'release',
        })
        await expect.poll(async () => (await catalogState()).attached, { timeout: 25_000 }).toBe(false)
        const beforeExpiry = await pane.getAttribute('data-session-id')
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        await expect(pane.getByText(expireText, { exact: true })).toBeVisible({ timeout: 45_000 })
        expect(await pane.getAttribute('data-session-id')).not.toBe(beforeExpiry)
        await expect(pane.locator('[data-composer-input][contenteditable="true"]')).toHaveText(draft)
        await expect.poll(async () => (await catalogState()).pending, { timeout: 20_000 }).toBe(1)
        expect(environment.hapi.aborted).not.toContain(fixture.session.id)
        expect(environment.hapi.sent.filter(row => row.sessionId === fixture.session.id)).toEqual([])
        const image = await visualReview(environment.launchUrl, 'display-lifecycle-reopened', '1440x900',
            conversationReady(title, `if (!pane.textContent.includes(${JSON.stringify(`Lifecycle answer ${total - 1}`)})) return false;`))
        if (image) await info.attach('reopened-source-after-display-release', { path: image, contentType: 'image/png' })
        expect(errors).toEqual([])
    } finally { await environment.close() }
})
