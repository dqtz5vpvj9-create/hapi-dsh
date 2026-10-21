import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Long synthetic HAPI wire history through the unchanged official DSH Web. */
import { expect, test } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { nativeIndexedHistory, useBoundedSourceHistory } from './source-conversation-fixture.ts'

test('180 native source turns remain visible and pageable in the official Conversation', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    let environment: OfficialEnvironment | undefined
    try {
        environment = await startOfficialEnvironment()
        const source = environment.hapi.add('long-history', 'Synthetic Runner', 'machine-alpha')
        source.rows = nativeIndexedHistory(source.session.metadata!.codexSessionId!)
        const history = useBoundedSourceHistory(source)
        environment.hapi.emit({ type: 'session-added', sessionId: source.session.id })
        await page.goto(environment.launchUrl)
        await acknowledgePreviewNotice(page, environment)
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex long-history' }).click()
        const pane = page.getByRole('region', { name: 'Pane: Native Codex long-history', exact: true })
        const answer = pane.getByText('Synthetic final answer 180.', { exact: true })
        await expect(answer).toBeVisible({ timeout: 45_000 })
        await expect(pane.getByText('Synthetic original input 180.', { exact: true })).toBeVisible()
        const flow = pane.locator('[data-chat-flow]:not([data-step-process-content])')
        const geometry = await flow.evaluate(element => {
            const rect = element.getBoundingClientRect(), parent = element.parentElement!, viewport = parent.getBoundingClientRect()
            return { height: rect.height, width: rect.width, viewportHeight: viewport.height, scrollHeight: parent.scrollHeight, scrollTop: parent.scrollTop }
        })
        expect(geometry.height).toBeGreaterThan(100); expect(geometry.width).toBeGreaterThan(300); expect(geometry.viewportHeight).toBeGreaterThan(150)
        expect(history.requests.length).toBeGreaterThan(20)
        await info.attach('official-chat-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' })
        await page.screenshot({ path: info.outputPath('long-native-conversation.png'), fullPage: true })
        await page.reload(); await expect(answer).toBeVisible()
        expect(environment.hapi.sent).toHaveLength(0)
        expect(errors).toEqual([])
    } finally {
        if (errors.length) await info.attach('browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
        if (environment) { await info.attach('host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' }); await environment.close() }
    }
})

test('observed shared Codex keeps the official answer, consumes lifecycle facts and exposes real source error details', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    let environment: OfficialEnvironment | undefined
    try {
        environment = await startOfficialEnvironment()
        const source = environment.hapi.add('observed-history', 'Synthetic Runner', 'machine-alpha')
        source.session.metadata = { ...source.session.metadata!, name: 'Synthetic observed Codex', codexNativeSession: false }
        const threadId = source.session.metadata.codexSessionId!
        source.rows = nativeIndexedHistory(threadId, 2, 3)
        const first = source.rows[0]!, last = source.rows.at(-1)!, lifecycleId = `codex:${threadId}:lifecycle:synthetic-turn-1:turn/completed`
        source.rows.push({ id: 'synthetic-terminal-row', localId: lifecycleId, createdAt: last.createdAt + 1, seq: last.seq! + 1,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'native-turn', id: lifecycleId,
                nativeExecution: { threadId, turnId: 'synthetic-turn-1', turn: { status: 'completed', started: true, ended: true } } } } } })
        source.rows.push({ id: 'synthetic-source-error', localId: null, createdAt: last.createdAt + 2, seq: last.seq! + 2,
            content: { role: 'agent', content: { type: 'event', data: { type: 'error',
                message: 'Synthetic source request failed. Expand details.', details: 'Synthetic diagnostic: rejected model selection, code -32602.' } } } })
        expect(first.invokedAt).not.toBeNull()
        useBoundedSourceHistory(source)
        environment.hapi.emit({ type: 'session-added', sessionId: source.session.id })
        await page.goto(environment.launchUrl); await acknowledgePreviewNotice(page, environment)
        await page.locator('.hapi-session-open').filter({ hasText: 'Synthetic observed Codex' }).click()
        const pane = page.getByRole('region', { name: 'Pane: Synthetic observed Codex', exact: true })
        await expect(pane.getByText('Synthetic final answer 2.', { exact: true })).toBeVisible()
        await expect(pane.getByText('Synthetic original input 2.', { exact: true })).toBeVisible()
        const notices = pane.locator('.hapi-native-notices')
        await expect(notices.getByText('Synthetic source request failed. Expand details.', { exact: true })).toBeVisible()
        await expect(notices).not.toContainText('native-turn')
        await expect(notices).not.toContainText('nativeExecution')
        const details = notices.getByText('Synthetic diagnostic: rejected model selection, code -32602.', { exact: true })
        await expect(details).not.toBeVisible()
        await notices.getByText('Details / 详情', { exact: true }).click()
        await expect(details).toBeVisible()
        await expect(pane.getByText('hapi-observed', { exact: true })).toHaveCount(0)
        await page.reload(); await expect(pane.getByText('Synthetic final answer 2.', { exact: true })).toBeVisible()
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
        await page.screenshot({ path: info.outputPath('observed-codex-history.png'), fullPage: true })
    } finally {
        if (errors.length) await info.attach('browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
        if (environment) { await info.attach('host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' }); await environment.close() }
    }
})
