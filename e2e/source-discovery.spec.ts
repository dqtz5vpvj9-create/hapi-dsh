/** Real pinned DSH Host, browser and official Conversation. The 350 original
 * source summaries, exact-read failure and catalog transport outage are explicit
 * HAPI protocol fixtures; no real Runner or model execution is claimed. */
import { expect, test } from '@playwright/test'
import type { HapiCatalog, WorkspaceDocument } from '../src/client-api.ts'
import { panes } from '../src/client/model.ts'
import { startOfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'

test('the 350th unbound original source remains searchable and explicit retry opens only its real display binding', async ({ page }, info) => {
    const environment = await startOfficialEnvironment()
    const errors: string[] = []
    const resolutions: Array<{ hubId: unknown; sourceSessionId: unknown }> = []
    const hubId = 'e2e-native-hub', key = 'discovery-0350', sourceId = `native-${key}`
    const title = 'Original source at row 350', answer = `Native history ${key} in the official DSH Conversation.`
    let allowExplicitRetry = false, transportFailures = 0
    const catalogRoute = '**/api/hapi/catalog'
    page.on('pageerror', error => errors.push(error.message))
    try {
        await page.route('**/api/hapi/sourceSessionResolve', async route => {
            const wire = route.request().postDataJSON() as { payload?: { args?: { request?: { hubId?: unknown; sourceSessionId?: unknown } } } }
            const identity = { hubId: wire.payload?.args?.request?.hubId, sourceSessionId: wire.payload?.args?.request?.sourceSessionId }
            resolutions.push(identity)
            // Keep the original GET blocked even if an automatic read-only
            // attach retries. Only the explicit browser retry releases this
            // fixture fault, before passing the unchanged RPC to the real Host.
            if (allowExplicitRetry && identity.hubId === hubId && identity.sourceSessionId === sourceId) {
                allowExplicitRetry = false
                environment.hapi.sessionReadErrors.delete(sourceId)
            }
            await route.continue()
        })
        await expect.poll(async () => (await environment.rpc<HapiCatalog>('hapi/catalog')).sessions
            .map(row => row.hapiSessionId).sort()).toEqual(['native-alpha', 'native-beta'])

        // The initial official attachment pass is complete before this set is
        // added. add() publishes no source events: summaries 3..349 stay pending
        // and must still participate in the full catalog's search and filters.
        for (let index = 3; index <= 350; index++) {
            const fixture = environment.hapi.add(`discovery-${String(index).padStart(4, '0')}`, 'Original discovery machine', 'machine-beta')
            fixture.session.updatedAt -= index
            fixture.session.createdAt = fixture.session.updatedAt
            fixture.session.metadata!.name = index === 350 ? title : `Original discovery row ${index}`
        }
        const original = environment.hapi.require(sourceId).session
        const originalIdentity = structuredClone(original), sourceCount = environment.hapi.sessions.size
        environment.hapi.sessionReadErrors.set(sourceId, { status: 503, code: 'synthetic_source_unavailable' })
        environment.hapi.emit({ type: 'session-added', sessionId: sourceId })
        await expect.poll(async () => {
            const catalog = await environment.rpc<HapiCatalog>('hapi/catalog')
            return { count: catalog.sourceDiscovery?.sessions.length, phase: catalog.sourceDiscovery?.phase,
                last: catalog.sourceDiscovery?.sessions.at(-1)?.sourceSessionId,
                binding: catalog.sourceDiscovery?.sessions.find(row => row.sourceSessionId === sourceId)?.binding,
                attached: catalog.sessions.some(row => row.hapiSessionId === sourceId) }
        }).toEqual({ count: 350, phase: 'ready', last: sourceId, binding: 'failed', attached: false })
        const initial = await environment.rpc<HapiCatalog>('hapi/catalog')
        expect(initial.sourceDiscovery!.sessions.every(row => !Object.hasOwn(row, 'id') && !Object.hasOwn(row, 'displayId'))).toBe(true)
        expect(initial.sessions).toHaveLength(2)

        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(environment.launchUrl)
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
        await acknowledgePreviewNotice(page, environment)
        const sidebar = page.locator('.hapi-session-sidebar'), list = sidebar.locator('.hapi-session-list')
        const discovery = sidebar.locator('[data-hapi-source-discovery]')
        const target = discovery.locator(`[data-hapi-discovered-source="${sourceId}"]`)
        await expect(discovery).toHaveAttribute('data-hapi-source-discovery', 'ready')
        await expect(discovery.locator('[data-hapi-discovered-source]').first()).toBeVisible()
        const firstBatch = await discovery.locator('[data-hapi-discovered-source]').count()
        expect(firstBatch).toBeLessThan(200)
        await expect(target).toHaveCount(0)

        // Reaching the actual shared scroll viewport's end appends a preview
        // batch without pressing Show more or loading hundreds of display graphs.
        await discovery.locator('[data-hapi-source-discovery-more]').scrollIntoViewIfNeeded()
        await expect.poll(() => discovery.locator('[data-hapi-discovered-source]').count()).toBeGreaterThan(firstBatch)
        expect(await discovery.locator('[data-hapi-discovered-source]').count()).toBeLessThan(200)
        await expect(target).toHaveCount(0)
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)

        await sidebar.getByRole('button', { name: 'Search conversations', exact: true }).click()
        await sidebar.getByRole('searchbox').fill(sourceId)
        await expect(target).toBeVisible()
        await expect(discovery.locator('[data-hapi-discovered-source]')).toHaveCount(1)
        await expect(target).toHaveAttribute('data-hapi-source-hub', hubId)
        await expect(target).toHaveAttribute('data-session-view-anchor', `source:${JSON.stringify([hubId, sourceId])}`)
        await expect(target.locator('.hapi-discovery-open')).toContainText(title)
        await expect(target.locator('.hapi-discovery-open')).toContainText(`/workspace/${key}`)
        await expect(target.getByRole('status')).toHaveText('Session loading failed')
        await expect(target.getByRole('alert')).toBeVisible()
        await expect(target.getByRole('button', { name: 'Retry opening', exact: true })).toBeVisible()

        // A browser-to-Host catalog failure must retain the found source with
        // explicit stale status. Host-to-HAPI summary read failures have separate
        // pure-state coverage; this route fixture does not claim that boundary.
        await page.route(catalogRoute, async route => { transportFailures++; await route.abort('failed') })
        await discovery.getByRole('button', { name: 'Refresh source list', exact: true }).click()
        await expect(discovery).toHaveAttribute('data-hapi-source-discovery', 'stale')
        await expect(target).toBeVisible()
        expect(transportFailures).toBeGreaterThan(0)
        await page.unroute(catalogRoute)
        await discovery.getByRole('button', { name: 'Refresh source list', exact: true }).click()
        await expect(discovery).toHaveAttribute('data-hapi-source-discovery', 'ready')
        await expect(target).toBeVisible()

        const beforeOpen = resolutions.length
        await target.locator('.hapi-discovery-open').click()
        await expect.poll(() => resolutions.length).toBeGreaterThan(beforeOpen)
        await expect(target.getByRole('button', { name: 'Retry opening', exact: true })).toBeEnabled()
        await expect(target.getByRole('alert')).toBeVisible()
        expect((await environment.rpc<HapiCatalog>('hapi/catalog')).sessions.some(row => row.hapiSessionId === sourceId)).toBe(false)
        expect(environment.hapi.sessionReadErrors.has(sourceId)).toBe(true)

        const beforeRetry = resolutions.length
        allowExplicitRetry = true
        await target.getByRole('button', { name: 'Retry opening', exact: true }).click()
        const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
        await expect(pane.getByText(answer, { exact: true })).toBeVisible()
        await expect(pane.getByRole('textbox', { name: /Message or run a task/ })).toBeVisible()
        await expect(target).toHaveCount(0)
        await expect(sidebar.locator('.hapi-session-open').filter({ hasText: title })).toHaveCount(1)
        expect(resolutions.length).toBeGreaterThan(beforeRetry)
        expect(resolutions.every(identity => identity.hubId === hubId && identity.sourceSessionId === sourceId)).toBe(true)
        const catalog = await environment.rpc<HapiCatalog>('hapi/catalog')
        const bindings = catalog.sessions.filter(row => row.hapiSessionId === sourceId)
        expect(bindings).toHaveLength(1)
        expect(bindings[0]!.id).not.toBe(sourceId)
        expect(bindings[0]).toMatchObject({ machineId: 'machine-beta', engine: 'codex', active: true })
        await expect.poll(async () => (await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')).state?.windows
            .flatMap(window => panes(window.root)).filter(item => item.resource.kind === 'chat')
            .map(item => item.resource)).toContainEqual({ kind: 'chat', sessionId: bindings[0]!.id,
                sourceSessionId: sourceId, sourceHubId: hubId })
        expect(environment.hapi.sessionReads.filter(read => read.sessionId === sourceId)).toEqual(expect.arrayContaining([
            { sessionId: sourceId, status: 503 }, { sessionId: sourceId, status: 200 },
        ]))
        expect(original).toEqual(originalIdentity)
        expect(environment.hapi.sessions.size).toBe(sourceCount)
        expect(environment.hapi.sent).toEqual([])
        expect(environment.hapi.spawnRequests).toEqual([])
        expect(environment.hapi.forkRequests).toEqual([])
        expect(environment.hapi.history.reopens).toEqual([])
        expect(environment.hapi.history.imports).toEqual([])
        expect(environment.hapi.approvals).toEqual([])
        expect(environment.hapi.settingChanges).toEqual([])
        expect(environment.hapi.aborted).toEqual([])
        expect(environment.hapi.cancelled).toEqual([])
        expect(environment.hapi.planRequests).toEqual([])
        expect(environment.hapi.workbench.fileWrites).toEqual([])
        expect(environment.hapi.workbench.terminalCommands).toEqual([])
        await expect(page.locator('iframe')).toHaveCount(0)
        expect(errors).toEqual([])
    } finally {
        await info.attach('original-source-discovery', { body: JSON.stringify({ resolutions, transportFailures,
            reads: environment.hapi.sessionReads.filter(read => read.sessionId === sourceId), errors }, null, 2), contentType: 'application/json' })
        await info.attach('official-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        await environment.close()
    }
})
