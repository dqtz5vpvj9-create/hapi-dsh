/** Synthetic source wire; the pinned DSH Host journal, Session and Conversation
 * are real. Full source backfill is deliberately held until every assertion:
 * previous-Turn context must come from the first generation, not replacement. */
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { HapiMessage } from '../src/codex/contracts.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { nativeIndexedHistory, useBoundedSourceHistory } from './source-conversation-fixture.ts'

const NAME = 'Native Codex initial-turn-context'
const COMPOSER = 'Message or run a task, / commands, @ files or sessions'
let environment: OfficialEnvironment
test.beforeAll(async () => { environment = await startOfficialEnvironment() })
test.afterAll(async () => { await environment?.close() })

async function expectPreviousTurn(pane: Locator): Promise<void> {
    await expect(pane.locator('[data-hapi-initial-history]')).toHaveAttribute('data-hapi-initial-history', 'ready', { timeout: 30_000 })
    for (const text of ['Synthetic original input 7.', 'Synthetic final answer 7.', 'Synthetic original input 8.', 'Synthetic final answer 8.']) {
        await expect(pane.getByText(text, { exact: true })).toHaveCount(1)
    }
    await expect(pane.locator('[data-chat-following-tail]')).toHaveCount(1)
}

async function openWorkspace(page: Page): Promise<void> {
    await page.goto(environment.launchUrl)
    await acknowledgePreviewNotice(page, environment)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
}

test('first source generation includes a previous long Turn across more than two retained pages while full history is blocked', async ({ page }, info) => {
    const source = environment.hapi.add('initial-turn-context', 'Synthetic Runner', 'machine-alpha')
    const threadId = source.session.metadata!.codexSessionId!
    // 10,408 source rows; two recent Turns require 2,602 rows (14 REST pages).
    // Each retained DSH page is at most 500 messages, so two pages cannot meet
    // the input-boundary target. The latest Turn stays active for the live probe.
    source.rows = nativeIndexedHistory(threadId, 8, 1300)
    // The shared fixture normally uses short Turns starting 60s apart. At
    // 1,300 items its 100ms item spacing would overlap subsequent Turns and
    // violate the wire's invokedAt/seq ordering: backward cursor paging would
    // skip the previous final answer. Keep this long-Turn fixture monotonic.
    const historyStartedAt = source.rows[0]!.createdAt
    source.rows.forEach((row, index) => {
        row.createdAt = historyStartedAt + index * 100
        row.invokedAt = row.createdAt
    })
    for (const row of source.rows.slice(-1301)) {
        const envelope = row.content as { meta: { nativeExecution: { turn: unknown } } }
        envelope.meta.nativeExecution.turn = { status: 'inProgress', started: true, ended: false }
    }
    source.session.thinking = true
    source.session.execution = { ...source.session.execution!, status: 'active', turnId: 'synthetic-turn-7',
        startedAt: source.rows.at(-1301)!.createdAt, completedAt: null }
    const paging = useBoundedSourceHistory(source), read = source.readHistory!
    let release!: () => void, released = false, latestReads = 0, blockedFullReads = 0
    let seedStartedAt = 0, seedPublishedAt = 0, seedRequests = 0
    const blocked = new Promise<void>(resolve => { release = resolve })
    source.readHistory = async url => {
        if (!url.searchParams.has('beforeSeq')) {
            latestReads++
            if (latestReads === 1) seedStartedAt = Date.now()
            else if (!released) {
                blockedFullReads++
                if (seedPublishedAt === 0) { seedPublishedAt = Date.now(); seedRequests = paging.requests.length }
                await blocked
            }
        }
        return read(url)
    }
    const errors: string[] = [], olderRequests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/session/page'
            && (request.postData() ?? '').includes('"beforeSeq"')) olderRequests.push(request.url())
    })
    // The small wire delay makes typing during automatic page loading an
    // explicit overlap. No private Session or scroll state is mutated.
    await page.route('**/api/session/page', async route => {
        if ((route.request().postData() ?? '').includes('"beforeSeq"')) await new Promise(resolve => setTimeout(resolve, 80))
        await route.continue()
    })
    environment.hapi.emit({ type: 'session-added', sessionId: source.session.id })
    try {
        await openWorkspace(page)
        const openingAt = Date.now()
        await page.locator('.hapi-session-open').filter({ hasText: NAME }).click()
        const pane = page.getByRole('region', { name: `Pane: ${NAME}`, exact: true })
        await expect(pane.getByText('Synthetic final answer 8.', { exact: true })).toBeVisible({ timeout: 60_000 })
        const firstBodyMs = Date.now() - openingAt
        const view = pane.locator('[data-hapi-session-view]'), input = pane.getByRole('textbox', { name: COMPOSER, exact: true })
        const initialIdentity = await view.getAttribute('data-hapi-session-view')
        await input.fill('Draft while previous-Turn context is loading')
        await expectPreviousTurn(pane)
        const previousContextMs = Date.now() - openingAt
        expect(olderRequests.length).toBeGreaterThan(2)
        expect(olderRequests.length).toBeLessThanOrEqual(20)
        const firstOpenPages = olderRequests.length
        expect(blockedFullReads).toBeGreaterThan(0)
        expect(released).toBe(false)
        expect(seedRequests, '14 bounded data pages and one epoch validation; not the full 53-page source').toBe(15)
        await expect(view).toHaveAttribute('data-hapi-session-view', initialIdentity!)
        await expect(input).toHaveText('Draft while previous-Turn context is loading')
        await expect(input).toBeFocused()

        const last = source.rows.at(-1)!, id = `codex:${threadId}:synthetic-turn-7:live-after-open:agent_message`
        const nativeExecution = { threadId, turnId: 'synthetic-turn-7', itemId: 'live-after-open', phase: 'commentary',
            turn: { status: 'inProgress', started: true, ended: false } }
        const live: HapiMessage = { id, localId: id, seq: last.seq! + 10_000, createdAt: last.createdAt + 100,
            invokedAt: (last.invokedAt ?? last.createdAt) + 100, content: { role: 'agent', meta: { nativeExecution },
                content: { type: 'codex', data: { type: 'message', id, message: 'Live output while full backfill stays blocked.',
                    streamSnapshot: true, nativeExecution } } } }
        source.rows.push(live); environment.hapi.emit({ type: 'message-received', sessionId: source.session.id, message: live })
        await expect(pane.getByText('Live output while full backfill stays blocked.', { exact: true })).toHaveCount(1)
        await expectPreviousTurn(pane)
        await expect(view).toHaveAttribute('data-hapi-session-view', initialIdentity!)
        await expect(input).toHaveText('Draft while previous-Turn context is loading')

        // A fresh client window uses the same Host generation and live journal.
        await page.reload()
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
        const restored = page.getByRole('region', { name: `Pane: ${NAME}`, exact: true })
        await expectPreviousTurn(restored)
        await expect(restored.getByText('Live output while full backfill stays blocked.', { exact: true })).toHaveCount(1)
        await expect(restored.locator('[data-hapi-session-view]')).toHaveAttribute('data-hapi-session-view', initialIdentity!)
        await expect(restored.getByRole('textbox', { name: COMPOSER, exact: true })).toHaveText('Draft while previous-Turn context is loading')
        expect(released).toBe(false)
        expect(environment.hapi.sent.filter(send => send.sessionId === source.session.id)).toEqual([])
        expect(environment.hapi.approvals.filter(answer => answer.sessionId === source.session.id)).toEqual([])
        expect(errors).toEqual([])
        await info.attach('initial-turn-context-measurement', { body: JSON.stringify({
            sourceRows: 10408, sourceDataPageSize: 200, sourceSeedRequests: seedRequests,
            sourceSeedAndPublishMs: seedPublishedAt - seedStartedAt, firstBodyMs, previousContextMs,
            firstOpenOfficialOlderPages: firstOpenPages, totalOfficialOlderPagesAfterReload: olderRequests.length,
            blockedFullReads, backgroundWasReleasedDuringAssertions: released,
        }, null, 2), contentType: 'application/json' })
        await page.screenshot({ path: `${info.outputDir}/initial-turn-context.png`, fullPage: true })
    } finally { released = true; release(); await page.unroute('**/api/session/page') }
})
