/** Real official Host, browser, Conversation and document plugins. The original
 * Hub's omitted discovery row, persistent 404 and saved v2 layout are explicit
 * protocol fixtures. Recovery must read the original source, never reopen it. */
import { expect, test } from '@playwright/test'
import type { HapiCatalog, WorkspaceDocument } from '../src/client-api.ts'
import { panes } from '../src/client/model.ts'
import { startOfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'

test('a saved original chat and document recover after an explicit retry even when discovery omits their archived source', async ({ page }, info) => {
    const environment = await startOfficialEnvironment()
    const errors: string[] = []
    const resolutions: Array<{ hubId: unknown; sourceSessionId: unknown }> = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
        if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/hapi/sourceSessionResolve') return
        const wire = request.postDataJSON() as { payload?: { args?: { request?: { hubId?: unknown; sourceSessionId?: unknown } } } }
        resolutions.push({ hubId: wire.payload?.args?.request?.hubId, sourceSessionId: wire.payload?.args?.request?.sourceSessionId })
    })

    // add() deliberately does not publish a session-added event. Neither the
    // initial list nor later discovery can make this source appear for us.
    const key = 'catalog-omitted'
    const original = environment.hapi.add(key, 'Original archive machine', 'machine-beta')
    const source = original.session
    source.active = false
    source.metadata!.lifecycleState = 'archived'
    source.metadata!.codexNativeConnection = 'history'
    source.metadataVersion++
    environment.hapi.omittedFromSessionList.add(source.id)
    environment.hapi.sessionReadErrors.set(source.id, { status: 404, code: 'source_not_found' })
    const originalIdentity = structuredClone(source)
    const sourceCount = environment.hapi.sessions.size
    const hubId = 'e2e-native-hub'
    const documentPath = `${source.metadata!.path}/restored.md`
    const documentTitle = 'Restored original archive document'
    const answer = `Native history ${key} in the official DSH Conversation.`
    environment.hapi.workbench.updateFile(source.id, documentPath,
        `# ${documentTitle}\n\nThis file still belongs to the original archived session on machine-beta.\n`, 'text/markdown')
    environment.hapi.legacyWorkspaces = { schemaVersion: 2, revision: 23, workspaces: [{
        id: 'omitted-source-window', name: 'Original archived workspace', autoName: false,
        root: { type: 'split', id: 'omitted-source-split', axis: 'horizontal', weights: [3, 2], children: [
            { type: 'pane', id: 'omitted-source-chat', resource: { kind: 'chat', sessionId: source.id } },
            { type: 'pane', id: 'omitted-source-document', resource: { kind: 'document', sessionId: source.id,
                document: { kind: 'file', path: documentPath, machineId: 'machine-beta' } } },
        ] },
    }] }
    const expectedIdentity = { hubId, sourceSessionId: source.id }
    const chat = page.locator('[data-pane-id="omitted-source-chat"]')
    const document = page.locator('[data-pane-id="omitted-source-document"]')
    const notFound = 'The source Hub has not found this conversation. Its saved reference is preserved; you can retry after checking the source.'
    const savedWindow = async () => (await environment.rpc<WorkspaceDocument>('hapi/workspaceGet')).state?.windows
        .find(window => window.id === 'omitted-source-window')
    const assertGeometry = async (): Promise<void> => {
        await expect.poll(savedWindow).toMatchObject({
            id: 'omitted-source-window', name: 'Original archived workspace', autoName: false,
            root: { type: 'split', id: 'omitted-source-split', axis: 'horizontal', weights: [3, 2], children: [
                { type: 'pane', id: 'omitted-source-chat', resource: { kind: 'chat', sourceSessionId: source.id, sourceHubId: hubId } },
                { type: 'pane', id: 'omitted-source-document', resource: { kind: 'document', sourceSessionId: source.id, sourceHubId: hubId,
                    document: { kind: 'file', path: documentPath, machineId: 'machine-beta' } } },
            ] },
        })
    }
    try {
        expect((await environment.rpc<HapiCatalog>('hapi/catalog')).sessions.some(row => row.hapiSessionId === source.id)).toBe(false)
        await page.setViewportSize({ width: 2048, height: 1088 })
        await page.goto(environment.launchUrl)
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
        await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
        for (const pane of [chat, document]) {
            await expect(pane.getByRole('alert')).toContainText(notFound)
            await expect(pane.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
            await expect(pane.locator('.hapi-failure-details > summary')).toHaveText('Technical details')
            await expect(pane.locator('.hapi-failure-details')).not.toHaveAttribute('open', '')
            await expect(pane.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toHaveCount(0)
            await expect(pane.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toHaveCount(0)
        }
        expect(environment.hapi.sessionReads.filter(read => read.sessionId === source.id)).toContainEqual({ sessionId: source.id, status: 404 })
        expect(resolutions.length).toBeGreaterThan(0)
        expect(resolutions.every(request => JSON.stringify(request) === JSON.stringify(expectedIdentity))).toBe(true)
        expect((await environment.rpc<HapiCatalog>('hapi/catalog')).sessions.some(row => row.hapiSessionId === source.id)).toBe(false)
        await assertGeometry()
        await page.screenshot({ path: info.outputPath('original-source-not-found.png'), fullPage: true })

        // Only the exact read becomes available. Keep the original row omitted
        // and emit no source event: the visible Retry must drive its recovery.
        const beforeRetry = resolutions.length
        environment.hapi.sessionReadErrors.delete(source.id)
        await expect(chat.getByText(answer, { exact: true })).toHaveCount(0)
        await expect(document.getByRole('heading', { name: documentTitle, exact: true })).toHaveCount(0)
        await chat.getByRole('button', { name: 'Retry', exact: true }).click()
        await expect(chat.getByText(answer, { exact: true })).toBeVisible()
        await expect(chat.getByText('Codex is not connected. Your draft is preserved.', { exact: true })).toBeVisible()
        await expect(chat.getByRole('button', { name: 'Resume native session', exact: true })).toBeVisible()
        await expect(chat.locator('[data-slot="conversation.session.header"]')).toBeVisible()
        await expect(document.getByRole('heading', { name: documentTitle, exact: true })).toBeVisible()
        await expect(chat.getByRole('alert').filter({ hasText: notFound })).toHaveCount(0)
        await expect(document.getByRole('alert').filter({ hasText: notFound })).toHaveCount(0)
        expect(resolutions.length).toBeGreaterThan(beforeRetry)
        expect(resolutions.every(request => JSON.stringify(request) === JSON.stringify(expectedIdentity))).toBe(true)
        expect(environment.hapi.sessionReads.filter(read => read.sessionId === source.id)).toContainEqual({ sessionId: source.id, status: 200 })
        expect(environment.hapi.omittedFromSessionList.has(source.id)).toBe(true)

        const catalog = await environment.rpc<HapiCatalog>('hapi/catalog')
        expect(catalog.hubId).toBe(hubId)
        const bindings = catalog.sessions.filter(row => row.hapiSessionId === source.id)
        expect(bindings).toHaveLength(1)
        expect(bindings[0]).toMatchObject({ machineId: 'machine-beta', engine: 'codex', active: false, lifecycleState: 'archived' })
        await assertGeometry()
        await expect.poll(async () => {
            const window = await savedWindow()
            return window ? panes(window.root).map(pane => pane.resource.kind === 'empty' ? null : pane.resource.sessionId) : []
        }).toEqual([bindings[0]!.id, bindings[0]!.id])
        const originalReads = environment.hapi.workbench.fileRequests.filter(read => read.path === documentPath)
        expect(originalReads.some(read => read.route === 'file')).toBe(true)
        expect(originalReads.every(read => read.sessionId === source.id && read.machineId === 'machine-beta'
            && read.method === 'GET' && (read.route === 'file' || read.route === 'file-info'))).toBe(true)
        expect(source).toEqual(originalIdentity)
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
        await page.screenshot({ path: info.outputPath('original-source-recovered.png'), fullPage: true })
        expect(errors).toEqual([])
    } finally {
        await info.attach('original-source-recovery', { body: JSON.stringify({ resolutions,
            reads: environment.hapi.sessionReads.filter(read => read.sessionId === source.id),
            files: environment.hapi.workbench.fileRequests, errors }, null, 2), contentType: 'application/json' })
        await info.attach('official-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
        await environment.close()
    }
})
