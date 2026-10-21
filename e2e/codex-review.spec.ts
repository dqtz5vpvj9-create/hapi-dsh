/** Review-shaped HAPI transcript fixtures. Official DSH Conversation,
 * Clipboard and source-aware file plugins run real production code. */
import { test, expect, type Page, type Locator } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

function review(path: string): string {
    return JSON.stringify({ findings: [{ title: 'Keep the original operation identity', body: 'A lost acknowledgement must not submit the same source task twice.',
        priority: 1, confidence_score: 0.96, code_location: { absolute_file_path: path, line_range: { start: 1, end: 2 } } }],
        overall_correctness: 'patch is incorrect', overall_explanation: 'The source operation needs an immutable request identity.', overall_confidence_score: 0.91 })
}
async function openWorkspace(page: Page, environment: OfficialEnvironment) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.origin })
    await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
}
async function source(page: Page, name: string): Promise<Locator> {
    await page.locator('.hapi-session-open').filter({ hasText: name }).click()
    const pane = page.getByRole('region', { name: `Pane: ${name}`, exact: true }); await expect(pane).toBeVisible(); return pane
}

test.describe('Codex review annotations without replacing the official assistant renderer', () => {
    let environment: OfficialEnvironment, nativeText: string, legacyText: string, piText: string
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment()
        const native = environment.hapi.add('review-native', 'Linux workstation', 'machine-beta')
        nativeText = review('/workspace/review-native/source.txt')
        ;(native.rows[1]!.content as { content: { data: { message: string } } }).content.data.message = nativeText
        environment.hapi.emit({ type: 'session-added', sessionId: native.session.id })
        const legacy = environment.hapi.addObserved('claude', 'review-legacy')
        legacy.session.metadata!.flavor = 'codex'; legacy.session.metadata!.name = 'Source Codex review legacy'
        delete legacy.session.metadata!.claudeSessionId; legacy.session.metadata!.codexSessionId = 'original-legacy-codex-thread'
        legacy.session.metadataVersion++
        legacyText = review('/workspace/review-legacy/source.txt')
        legacy.rows[1]!.content = { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'original-legacy-review', message: legacyText } } }
        environment.hapi.emit({ type: 'session-updated', sessionId: legacy.session.id })
        const pi = environment.hapi.addObserved('pi', 'review-stream')
        piText = review('/workspace/review-stream/source.txt')
        pi.rows[1]!.content = { role: 'agent', content: { type: 'codex', data: { type: 'message',
            id: 'pi-original-nonce-turn-1-message-1-text-0', streamSnapshot: true, message: piText } } }
        environment.hapi.emit({ type: 'session-updated', sessionId: pi.session.id })
        const ordinary = await environment.rpc<{ sessionId: string }>('session/create', { cwd: environment.directory })
        await environment.rpc('session/selectModel', { sessionId: ordinary.sessionId, provider: 'fixture', model: 'fixture-model' })
        await environment.rpc('session/rename', { sessionId: ordinary.sessionId, title: 'Ordinary DSH review comparison' })
        await environment.rpc('session/prompt', { sessionId: ordinary.sessionId, requestId: 'review-comparison-ordinary', mode: 'queue', content: [{ type: 'text', text: 'Ordinary DSH request' }] })
    })
    test.afterAll(async () => { await environment?.close() })

    test('source final findings retain raw Copy and open their file through the same original machine', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            await openWorkspace(page, environment)
            const native = await source(page, 'Native Codex review-native')
            const card = native.locator('[data-hapi-codex-review]')
            await expect(card).toBeVisible(); await expect(card).toContainText('1 findings')
            await expect(card).toContainText('P1'); await expect(card).toContainText('Confidence 96%'); await expect(card).toContainText('Confidence 91%')
            await expect(card).toContainText('Keep the original operation identity')
            await native.locator('[data-turn-tail]').getByRole('button', { name: 'Copy', exact: true }).click()
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(nativeText)
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible(); await page.reload(); await expect(card).toBeVisible()
            await card.getByRole('button', { name: 'Open source file /workspace/review-native/source.txt:1–2', exact: true }).click()
            await expect(page.getByText('Source file from machine-beta', { exact: true })).toBeVisible()
            expect(environment.hapi.workbench.fileRequests.some(value => value.sessionId === 'native-review-native'
                && value.machineId === 'machine-beta' && value.path === '/workspace/review-native/source.txt')).toBe(true)
            expect(environment.hapi.require('native-review-native').session.metadata?.codexSessionId).toBe('codex-thread-review-native')
            const legacy = await source(page, 'Source Codex review legacy')
            await expect(legacy.locator('[data-hapi-codex-review]')).toContainText('Keep the original operation identity')
            await legacy.locator('[data-turn-tail]').getByRole('button', { name: 'Copy', exact: true }).click()
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(legacyText)
            expect(environment.hapi.sent).toHaveLength(0)
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('review-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })

    test('Pi cumulative JSON and ordinary DSH answers keep their original official presentation', async ({ page }) => {
        await openWorkspace(page, environment)
        const pi = await source(page, 'Source pi review-stream')
        await expect(pi.locator('[data-hapi-codex-review]')).toHaveCount(0)
        await pi.locator('[data-turn-tail]').getByRole('button', { name: 'Copy', exact: true }).click()
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(piText)
        const ordinary = await source(page, 'Ordinary DSH review comparison')
        await expect(ordinary.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible()
        await expect(ordinary.locator('[data-hapi-codex-review]')).toHaveCount(0)
    })
})
