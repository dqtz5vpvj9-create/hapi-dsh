/** HAPI source wire rows are explicit fixtures. Official DSH Session,
 * Conversation, projections and the HAPI parser/History reader are the real
 * pinned implementations. */
import { test, expect, type Page } from '@playwright/test'
import type { HapiMessage } from '../src/codex/contracts.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import type { HistoryPaging, NativeFixture } from './hapi-fixture.ts'

let cursor = 0
function nextRow(fixture: NativeFixture, overrides: Partial<HapiMessage> & { content: unknown }): HapiMessage {
    cursor++
    const seq = fixture.rows.length + 1
    return { id: `${fixture.session.id}-native-history-row-${cursor}`, localId: null, seq,
        createdAt: Date.now() + cursor, ...overrides }
}
function agentCodex(data: Record<string, unknown>, overrides: Partial<HapiMessage> = {}): Partial<HapiMessage> & { content: unknown } {
    return { content: { role: 'agent', content: { type: 'codex', data } }, ...overrides }
}
function userText(localId: string, text: string): Partial<HapiMessage> & { content: unknown } {
    return { localId, invokedAt: Date.now(), content: { role: 'user', content: { type: 'text', text },
        meta: { nativeExecution: { threadId: 'observed-fixture', turnId: 'turn-1', itemId: localId } } } }
}
function append(environment: OfficialEnvironment, fixture: NativeFixture, overrides: Partial<HapiMessage> & { content: unknown }): HapiMessage {
    const row = nextRow(fixture, overrides)
    fixture.rows.push(row)
    environment.hapi.emit({ type: 'message-received', sessionId: fixture.session.id, message: row })
    return row
}
async function open(page: Page, environment: OfficialEnvironment, name: string) {
    await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
    await notice.waitFor({ state: 'visible', timeout: 2000 }).catch(() => undefined)
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.locator('.hapi-session-open').filter({ hasText: name }).click()
    const pane = page.getByRole('region', { name: `Pane: ${name}`, exact: true }); await expect(pane).toBeVisible(); return pane
}

/** 300 real source turns: a large history that needs several bounded pages. */
function bulkHistory(): HapiMessage[] {
    const base = 1_700_000_000_000
    const rows: HapiMessage[] = []
    for (let index = 0; index < 300; index++) {
        const at = base + index * 1_000
        rows.push({ id: `bulk-user-${index}`, localId: `bulk-input-${index}`, seq: rows.length + 1, createdAt: at, invokedAt: at,
            content: { role: 'user', content: { type: 'text', text: `Bulk question ${index}` } } })
        rows.push({ id: `bulk-answer-${index}`, localId: `bulk-answer-${index}`, seq: rows.length + 1, createdAt: at + 1, invokedAt: at + 1,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: `bulk-answer-${index}`,
                message: `Bulk answer ${index}`, streamSnapshot: true,
                nativeExecution: { threadId: 'observed-fixture', turnId: `bulk-turn-${index}`, itemId: `bulk-answer-${index}` } } } } })
    }
    rows.push({ id: 'bulk-ready', localId: null, seq: rows.length + 1, createdAt: base + 400_000,
        content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } })
    return rows
}

test.describe('native source history rendering', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => { environment = await startOfficialEnvironment(false) })
    test.afterAll(async () => { await environment?.close() })

    test('lifecycle protocol rows never become transcript text or raw JSON while the real answer renders', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            const fixture = environment.hapi.addObserved('pi', 'protocol-rows')
            append(environment, fixture, userText('fixture-input-1', 'Real observed question'))
            append(environment, fixture, agentCodex({ type: 'message', id: 'pi-answer-protocol',
                message: 'Real observed answer despite protocol rows.', streamSnapshot: true,
                nativeExecution: { threadId: 'observed-fixture', turnId: 'turn-1', itemId: 'answer' } }))
            append(environment, fixture, agentCodex({ type: 'native-turn',
                nativeExecution: { threadId: 'observed-fixture', turnId: 'turn-1', turn: { status: 'completed', started: true, ended: true } } }))
            append(environment, fixture, agentCodex({ type: 'thread_goal_updated', threadId: 'observed-fixture',
                goal: { objective: 'protocol objective', status: 'active', tokensUsed: 12 } }))
            append(environment, fixture, agentCodex({ type: 'thread_goal_cleared', thread_id: 'observed-fixture' }))
            append(environment, fixture, agentCodex({ type: 'agent-run-update', agentId: 'child-thread',
                cardId: 'codex-agent:child-thread', status: 'completed' }))
            append(environment, fixture, agentCodex({ type: 'context_compacted', thread_id: 'observed-fixture' }))
            append(environment, fixture, agentCodex({ type: 'future-protocol-event', payload: { protocolDetail: 'must-not-render' } }))

            const pane = await open(page, environment, 'Source pi protocol-rows')
            await expect(pane.getByText('Real observed answer despite protocol rows.', { exact: true })).toBeVisible()
            const transcript = pane.locator('[data-conversation-scroll]')
            await expect(transcript).not.toContainText('native-turn')
            await expect(transcript).not.toContainText('thread_goal')
            await expect(transcript).not.toContainText('future-protocol-event')
            await expect(transcript).not.toContainText('protocolDetail')
            // R8b: routine native-messages row removed; the transcript still never
            // renders protocol rows or raw JSON.
            await expect(pane.locator('.hapi-native-notices, .hapi-native-routine')).toHaveCount(0)
            await expect(transcript).not.toContainText('{')
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('source-protocol-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })

    test('a final message row settles the streamed answer once instead of streaming again', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            const fixture = environment.hapi.addObserved('pi', 'protocol-final')
            const stable = 'codex:observed-fixture:turn-1:answer:agent_message'
            append(environment, fixture, userText('fixture-input-final', 'Question for the final row'))
            append(environment, fixture, agentCodex({ type: 'message', id: stable, message: 'Partial answer',
                streamSnapshot: true, nativeExecution: { threadId: 'observed-fixture', turnId: 'turn-1', itemId: 'answer' } }))
            append(environment, fixture, agentCodex({ type: 'message', id: stable, message: 'Completed answer settles once.',
                streamSnapshot: true, nativeExecution: { threadId: 'observed-fixture', turnId: 'turn-1', itemId: 'answer' } },
                { localId: stable }))
            append(environment, fixture, agentCodex({ type: 'native-turn',
                nativeExecution: { threadId: 'observed-fixture', turnId: 'turn-1', turn: { status: 'completed', started: true, ended: true } } }))

            const pane = await open(page, environment, 'Source pi protocol-final')
            await expect(pane.getByText('Completed answer settles once.', { exact: true })).toHaveCount(1)
            await page.waitForTimeout(1_000)
            await expect(pane.getByText('Completed answer settles once.', { exact: true })).toHaveCount(1)
            await expect(pane.getByText('Partial answer', { exact: true })).toHaveCount(0)
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('source-final-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })

    test('a large history keeps one epoch-stable pass while the source appends', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            const rows = bulkHistory()
            let pages = 0
            const paging: HistoryPaging = { epoch: 1, pageSize: 200, onPage(index, hook) {
                pages = index + 1
                if (index === 0) return
                // Normal appends (monotonic positions) do not bump the HAPI message
                // epoch; the reader must finish one pass over the same snapshot.
                rows.push({ id: `bulk-live-${index}`, localId: null, seq: rows.length + 1,
                    createdAt: Date.now() + index, invokedAt: Date.now() + index,
                    content: { role: 'agent', content: { type: 'codex', data: { type: 'message',
                        id: `bulk-live-${index}`, message: `Bulk live answer ${index}`, streamSnapshot: true,
                        nativeExecution: { threadId: 'observed-fixture', turnId: 'bulk-live', itemId: `bulk-live-${index}` } } } } })
            } }
            environment.hapi.addObserved('pi', 'history-append', 'machine-alpha', { rows, paging })
            const pane = await open(page, environment, 'Source pi history-append')
            await expect(pane.getByText(/Bulk answer 299/).first()).toBeVisible({ timeout: 15_000 })
            await expect(pane.locator('[data-conversation-scroll]')).not.toContainText('Native history changed repeatedly')
            await expect(pane.locator('[data-conversation-scroll]')).not.toContainText('history unavailable')
            await expect(pane.locator('[data-conversation-scroll]')).not.toContainText('Failed to load history')
            expect(pages).toBeGreaterThan(1)
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('source-history-append-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })

    test('a structural rewind mid-pass invalidates it and renders the replacement history', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            const rows = bulkHistory()
            let pages = 0
            let rewound = false
            const paging: HistoryPaging = { epoch: 1, pageSize: 200, onPage(index, hook) {
                pages = index + 1
                if (index !== 2 || rewound) return
                // A rewind removes the newest rows and bumps the epoch: rows read
                // before this point are no longer an authoritative snapshot.
                rewound = true
                rows.splice(Math.max(0, rows.length - 50) - 1, 50)
                hook.epoch++
            } }
            environment.hapi.addObserved('pi', 'history-rewind', 'machine-alpha', { rows, paging })
            const pane = await open(page, environment, 'Source pi history-rewind')
            await expect(pane.locator('[data-conversation-scroll]')).not.toContainText('Native history changed repeatedly', { timeout: 15_000 })
            await expect(pane.locator('[data-conversation-scroll]')).not.toContainText('history unavailable')
            // The official first window contains recent turns. Verify the
            // rewind tail first, then use its public paging control to inspect
            // the beginning; initial absence of turn zero is not data loss.
            await expect(pane.getByText('Bulk answer 274', { exact: true })).toBeVisible()
            await expect(pane.getByText('Bulk answer 299', { exact: true })).toHaveCount(0)
            const firstAnswer = pane.getByText('Bulk answer 0', { exact: true })
            const renderedRows = pane.locator('[data-chat-flow]:not([data-step-process-content]) [data-chat-anchor-key]')
            for (let pageIndex = 0; pageIndex < 20 && await firstAnswer.count() === 0; pageIndex++) {
                const loadEarlier = pane.getByRole('button', { name: 'Load earlier', exact: true })
                await expect(loadEarlier).toBeEnabled()
                const before = await renderedRows.count()
                // The official paging anchor can reassert the scroll position
                // during pointer hit testing. Use the public button's keyboard
                // activation for this history-data check; do not force a click.
                await loadEarlier.focus()
                await expect(loadEarlier).toBeFocused()
                await page.keyboard.press('Enter')
                await expect.poll(() => renderedRows.count()).toBeGreaterThan(before)
            }
            await pane.locator('[data-conversation-scroll]').evaluate(element => { element.scrollTop = 0 })
            await expect(firstAnswer).toBeVisible()
            expect(rewound).toBe(true)
            expect(pages).toBeGreaterThan(2)
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('source-history-rewind-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })
})
