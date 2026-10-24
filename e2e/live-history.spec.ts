/** Real pinned DSH graph and transport; all source rows/events are synthetic. */
import { test, expect } from '@playwright/test'
import type { HapiMessage, HapiMessagesPage } from '../src/codex/contracts.ts'
import type { NativeFixture } from './hapi-fixture.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { conversationReady, visualReview } from './visual-review.ts'

test.setTimeout(180_000)
test.use({ screenshot: 'off' })

function complete(rows: readonly HapiMessage[]): HapiMessagesPage {
    return { messages: [...rows], page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
        nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null,
        snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } }
}

function liveRows(fixture: NativeFixture, key: string, at: number): HapiMessage[] {
    const prefix = `${fixture.session.id}-${key}`
    const threadId = fixture.session.metadata?.codexSessionId
    const turnId = `live-${key}`
    const execution = (itemId: string) => ({ threadId, turnId, itemId })
    return [
        { id: `${prefix}-input`, localId: `${prefix}-input`, seq: at, createdAt: at, invokedAt: at,
            content: { role: 'user', content: { type: 'text', text: `Question ${key}` },
                ...(threadId ? { meta: { nativeExecution: execution(`${prefix}-input`) } } : {}) } },
        { id: `${prefix}-answer`, localId: `${prefix}-answer`, seq: at + 1, createdAt: at + 1, invokedAt: at + 1,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: `${prefix}-answer`,
                message: `Answer ${key} survives source reconciliation.`, streamSnapshot: true,
                ...(threadId ? { nativeExecution: execution(`${prefix}-answer`) } : {}) } } } },
        { id: `${prefix}-ready`, localId: null, seq: at + 2, createdAt: at + 2,
            content: { role: 'agent', content: threadId
                ? { type: 'codex', data: { type: 'native-turn', nativeExecution: {
                    threadId, turnId, turn: { status: 'completed', started: true, ended: true },
                } } }
                : { type: 'event', data: { type: 'ready' } } } },
    ]
}

test.describe('source live/history continuity', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => { environment = await startOfficialEnvironment(false) })
    test.afterAll(async () => { await environment?.close() })

    for (const engine of ['codex', 'pi'] as const) {
        test(`${engine}: attach, blocked history refresh and reload retain the live suffix exactly once`, async ({ page }, info) => {
            const errors: string[] = []
            page.on('pageerror', error => errors.push(error.message))
            let release: (() => void) | undefined
            try {
                await page.goto(environment.launchUrl)
                await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
                await acknowledgePreviewNotice(page, environment)
                await page.goto(`${environment.origin}/?hapiGraph=shared`)
                await expect(page.locator('[data-hapi-workspace]')).toBeVisible()

                const key = `live-continuity-${engine}`
                const fixture: NativeFixture = engine === 'codex'
                    ? environment.hapi.add(key, 'Synthetic laptop', 'machine-alpha')
                    : environment.hapi.addObserved('pi', key)
                const title = engine === 'codex' ? `Native Codex ${key}` : `Source pi ${key}`
                const seed = complete(fixture.rows)
                const initialGate = new Promise<void>(resolve => { release = resolve })
                let initialReading = false
                fixture.readHistory = async () => { initialReading = true; await initialGate; return seed }
                environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
                // Discovery is on demand: the catalog must not eagerly load
                // every source's history just because the sidebar lists it.
                await page.locator('.hapi-session-open').filter({ hasText: title }).click()
                await expect.poll(() => initialReading).toBe(true)

                // SSE leads REST indexing. Its suffix must survive initial publication.
                const initialLive = liveRows(fixture, 'during-attach', Date.now() + 10)
                for (const message of initialLive) environment.hapi.emit({ type: 'message-received', sessionId: fixture.session.id, message })
                release!(); release = undefined
                const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
                await expect(pane.getByText('Answer during-attach survives source reconciliation.', { exact: true })).toHaveCount(1)
                fixture.rows.push(...initialLive)

                const composer = pane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
                await composer.fill('Draft stays while a source history request is slow')
                const stale = complete(fixture.rows)
                const refreshGate = new Promise<void>(resolve => { release = resolve })
                let refreshing = false, served = false
                fixture.readHistory = async () => { refreshing = true; await refreshGate; served = true; return stale }
                environment.hapi.emit({ type: 'message-updated', sessionId: fixture.session.id })
                await expect.poll(() => refreshing).toBe(true)
                const refreshLive = liveRows(fixture, 'during-refresh', Date.now() + 20)
                for (const message of refreshLive) environment.hapi.emit({ type: 'message-received', sessionId: fixture.session.id, message })

                // This assertion runs BEFORE the read gate opens. A refresh on
                // the live event queue would stall until this assertion times out.
                await expect(pane.getByText('Answer during-refresh survives source reconciliation.', { exact: true })).toHaveCount(1)
                expect(served).toBe(false)
                await expect(composer).toHaveText('Draft stays while a source history request is slow')
                release!(); release = undefined
                await expect.poll(() => served).toBe(true)
                fixture.rows.push(...refreshLive)
                fixture.readHistory = () => complete(fixture.rows)
                environment.hapi.emit({ type: 'message-updated', sessionId: fixture.session.id })
                await expect(pane.getByText('Answer during-attach survives source reconciliation.', { exact: true })).toHaveCount(1)
                await expect(pane.getByText('Answer during-refresh survives source reconciliation.', { exact: true })).toHaveCount(1)
                await expect(composer).toHaveText('Draft stays while a source history request is slow')

                await page.reload()
                const restored = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
                await expect(restored.getByText('Answer during-attach survives source reconciliation.', { exact: true })).toHaveCount(1)
                await expect(restored.getByText('Answer during-refresh survives source reconciliation.', { exact: true })).toHaveCount(1)
                expect(environment.hapi.sent.filter(item => item.sessionId === fixture.session.id)).toEqual([])
                expect(environment.hapi.aborted).not.toContain(fixture.session.id)
                expect(errors).toEqual([])
                for (const viewport of ['1440x900', '390x844']) {
                    const image = await visualReview(environment.launchUrl, `live-history-${engine}`, viewport,
                        conversationReady(title, `if (!pane.textContent.includes('Answer during-refresh survives source reconciliation.')) return false;`))
                    if (image) await info.attach(`visual-${viewport}`, { path: image, contentType: 'image/png' })
                }
            } finally {
                release?.()
                await info.attach('live-history-browser-errors', { body: errors.join('\n'), contentType: 'text/plain' })
                await info.attach('live-history-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
            }
        })
    }
})
