import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Pi/HAPI progress is an explicit source wire fixture. Its official DSH
 * Session, Conversation chat target, tool card, grouping and SSE are real. */
import { test, expect, type Page } from '@playwright/test'
import type { HapiMessage } from '../src/codex/contracts.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import type { NativeFixture } from './hapi-fixture.ts'

function sourceRow(fixture: NativeFixture, data: Record<string, unknown>): HapiMessage {
    const seq = fixture.rows.length + 1
    return { id: `${fixture.session.id}-progress-row-${seq}`, localId: null, seq, createdAt: Date.now(),
        content: { role: 'agent', content: { type: data.type === 'ready' ? 'event' : 'codex', data } } }
}
function append(environment: OfficialEnvironment, fixture: NativeFixture, data: Record<string, unknown>) {
    const row = sourceRow(fixture, data); fixture.rows.push(row)
    environment.hapi.emit({ type: 'message-received', sessionId: fixture.session.id, message: row })
}
function progress(text: string) {
    return { type: 'tool-call', callId: 'pi-progress-call', name: 'bash', input: { command: 'fixture-long-running-command' },
        progress: { content: [{ type: 'text', text }], details: { original: 'Pi partialResult' } } }
}
async function open(page: Page, environment: OfficialEnvironment, name: string) {
    await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    await acknowledgePreviewNotice(page, environment)
    await page.locator('.hapi-session-open').filter({ hasText: name }).click()
    const pane = page.getByRole('region', { name: `Pane: ${name}`, exact: true }); await expect(pane).toBeVisible(); return pane
}

test.describe('source partial tool output through an additive official Conversation node', () => {
    let environment: OfficialEnvironment, running: NativeFixture, interrupted: NativeFixture
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment()
        running = environment.hapi.addObserved('pi', 'tool-progress')
        interrupted = environment.hapi.addObserved('pi', 'tool-interrupted', 'machine-beta')
        for (const fixture of [running, interrupted]) {
            fixture.rows.splice(1)
            fixture.rows.push(sourceRow(fixture, { type: 'tool-call', callId: 'pi-progress-call', name: 'bash', input: { command: 'fixture-long-running-command' } }))
            fixture.session.thinking = true; fixture.session.thinkingAt = Date.now()
            environment.hapi.emit({ type: 'session-updated', sessionId: fixture.session.id })
        }
    })
    test.afterAll(async () => { await environment?.close() })

    test('live updates reuse the same source call and disappear only when a real final tool result arrives', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            const pane = await open(page, environment, 'Source pi tool-progress')
            const catalog = async () => (await environment.rpc<{ sessions: Array<{ id: string; hapiSessionId: string }> }>('hapi/catalog'))
                .sessions.find(row => row.hapiSessionId === running.session.id)!
            const before = await catalog()
            await expect(pane.locator('[data-hapi-tool-progress]')).toHaveCount(0)
            append(environment, running, progress('First original partial chunk'))
            const partial = pane.locator('[data-hapi-tool-progress="pi-progress-call"]')
            await expect(partial).toBeVisible(); await expect(partial).toContainText('First original partial chunk')
            append(environment, running, progress('Second original partial chunk'))
            await expect(partial).toHaveCount(1); await expect(partial).toContainText('Second original partial chunk')
            await expect(partial).not.toContainText('First original partial chunk')
            append(environment, running, progress('Second original partial chunk'))
            expect((await catalog()).id).toBe(before.id)
            expect(running.session.metadata?.piSessionId).toBe('pi-thread-tool-progress')
            await page.reload(); await expect(partial).toBeVisible(); await expect(partial).toContainText('Second original partial chunk')
            expect((await catalog()).id).toBe(before.id)
            append(environment, running, { type: 'tool-call-result', callId: 'pi-progress-call', output: { content: [{ type: 'text', text: 'Actual source final tool output' }] } })
            await expect(partial).toHaveCount(0)
            append(environment, running, { type: 'message', id: 'pi-final', message: 'Original Pi final answer after the actual tool result.' })
            append(environment, running, { type: 'ready' })
            running.session.thinking = false; running.session.thinkingAt = Date.now(); environment.hapi.emit({ type: 'session-updated', sessionId: running.session.id })
            await expect(pane.getByText('Original Pi final answer after the actual tool result.', { exact: true })).toBeVisible()
            append(environment, running, progress('Late partial cannot reopen a finished invocation'))
            await expect(partial).toHaveCount(0)
            expect((await catalog()).id).toBe(before.id)
            expect(environment.hapi.sent).toHaveLength(0)
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('source-tool-progress-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })

    test('a source turn ending without a final result keeps the last partial explicitly incomplete', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            const pane = await open(page, environment, 'Source pi tool-interrupted')
            append(environment, interrupted, progress('Last partial before source interruption'))
            const partial = pane.locator('[data-hapi-tool-progress="pi-progress-call"]')
            await expect(partial).toBeVisible()
            append(environment, interrupted, { type: 'ready' })
            interrupted.session.thinking = false; interrupted.session.thinkingAt = Date.now(); environment.hapi.emit({ type: 'session-updated', sessionId: interrupted.session.id })
            // Completed-process disclosure can legitimately collapse; expand
            // the original owner rather than overriding its grouping policy.
            await expect(partial).toHaveAttribute('data-hapi-tool-progress-phase', 'turn-ended')
            const process = pane.getByRole('button', { name: /^Completed(?: process| in)/ })
            await expect(process).toBeVisible()
            if (!await partial.isVisible()) await process.click()
            await expect(partial).toBeVisible()
            await expect(partial).toContainText('without a final tool result')
            await expect(partial).toContainText('Last partial before source interruption')
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('source-incomplete-tool-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })
})
