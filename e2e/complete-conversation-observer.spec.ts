/**
 * Real official Host, full-conversation acceptance for the observer.
 *
 * The long source is synthetic HAPI wire data. The Host, official Conversation,
 * pager, editor and official TurnNavigator are the pinned real implementation.
 * The target is resolved once to an exact display view, the Host is restarted,
 * and the observer is installed before the cold navigation back to that view.
 */
import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WarmOfficialSession } from './warm-session.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { nativeIndexedHistory } from './source-conversation-fixture.ts'
import { installColdOpeningProbe, readColdOpeningProbe, coldOpeningIssues, exerciseOpeningHistory,
    exerciseOpeningUnvisitedTarget, exerciseOpeningReturnLatest, waitForColdOpeningObservation } from './cold-opening-probe.ts'

test.use({ screenshot: 'off', trace: { mode: 'retain-on-failure', snapshots: false } })
test.setTimeout(240_000)

let warm: WarmOfficialSession
test.beforeAll(async () => {
    warm = new WarmOfficialSession()
    await warm.start()
    // The shared warm fixture's 180x25 source is intentionally heavy for other
    // specs. This focused acceptance source stays above the 200-row tail so the
    // official pager has a real older page, without making the test a load test.
    const fixture = warm.environment.hapi.require('native-accept-history')
    fixture.rows = nativeIndexedHistory(fixture.session.metadata!.codexSessionId!, 30, 8)
})
test.afterAll(async () => { await warm?.close() })

const title = 'Native Codex accept-history'
const latestText = 'Synthetic final answer 30.'
const navigationText = 'Synthetic original input 20.'
const draftText = 'Unsent observer acceptance draft; never submit.'
const liveText = 'Live synthetic source update for the complete observer.'

function appendLive(key: string, text: string): void {
    const fixture = warm.environment.hapi.require('native-accept-history')
    const thread = fixture.session.metadata!.codexSessionId!
    const seq = (fixture.rows.at(-1)?.seq ?? 0) + 1, at = Date.now(), turnId = `observer-live-${key}`
    const execution = { threadId: thread, turnId }
    const rows = [
        { id: `${key}-live-input`, localId: `${key}-live-input`, seq, createdAt: at, invokedAt: at,
            content: { role: 'user', content: { type: 'text', text: `Live question ${key}` },
                meta: { nativeExecution: { ...execution, itemId: 'live-input' } } } },
        { id: `${key}-live-answer`, localId: `${key}-live-answer`, seq: seq + 1, createdAt: at + 1,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: `${key}-live-answer`, message: text,
                streamSnapshot: true, nativeExecution: { ...execution, itemId: 'live-answer' } } } } },
        { id: `${key}-live-terminal`, localId: null, seq: seq + 2, createdAt: at + 2,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'native-turn',
                nativeExecution: { ...execution, turn: { status: 'completed', started: true, ended: true } } } } } },
    ]
    for (const row of rows) {
        fixture.rows.push(row)
        fixture.session.updatedAt = row.createdAt
        warm.environment.hapi.emit({ type: 'message-received', sessionId: fixture.session.id, message: row })
    }
}

async function openListedSession(page: import('@playwright/test').Page, mobile: boolean): Promise<void> {
    if (mobile) {
        const picker = page.locator('.hapi-mobile-session-layer')
        if (!await picker.isVisible()) await page.locator('.hapi-statusbar > .hapi-mobile-back').click()
        await expect(picker).toBeVisible()
        await picker.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: title }).click()
        await expect(picker).toHaveCount(0)
    } else {
        await page.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: title }).click()
    }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const) {
    test(`real official Host complete opening ${viewport.width}px: exact view, body, draft, history, navigation, live update and 30 s observation`, async ({}, info) => {
        const mobile = viewport.width < 900
        const page = await warm.page({ width: viewport.width, height: viewport.height }, mobile)
        const errors: string[] = []
        let sampling = false
        page.on('pageerror', error => errors.push(error.message))
        try {
            // Resolve the exact display view once. This warm-up is setup only;
            // the measured opening below happens after a Host restart with the
            // observer installed before navigation.
            await warm.admit(page)
            await openListedSession(page, mobile)
            const warmPane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
            await expect(warmPane.getByText(latestText, { exact: true })).toBeVisible({ timeout: 45_000 })
            const paneId = await warmPane.getAttribute('data-pane-id')
            const viewId = await warmPane.locator('[data-hapi-session-view]').first().getAttribute('data-hapi-session-view')
            expect(paneId).toBeTruthy()
            expect(viewId).toBeTruthy()
            await page.goto('about:blank')
            await warm.environment.restartHost()

            await installColdOpeningProbe(page, {
                paneSelector: `[data-pane-id="${paneId}"]`,
                expectedViewId: viewId!, expectedTitle: title, expectedText: latestText,
                expectedNavigationText: mobile ? latestText : navigationText,
                navigationAction: mobile ? 'return-latest' : 'unvisited-target',
                stableMs: 750, captureTitles: false,
                requiresHistory: true, requiresNavigation: 'auto', fullCapabilities: true,
                observeAfterReadyMs: 30_000, failureDeadlineMs: 60_000, checkpointsMs: [6_000, 20_000],
                requireEditorInput: true, requireLiveUpdate: true,
                requireHistoryAction: true, requireNavigationAction: true,
            })
            await page.goto(warm.environment.launchUrl, { waitUntil: 'domcontentloaded' })
            sampling = true
            await acknowledgePreviewNotice(page, warm.environment, { initialView: 'existing-session' })
            const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
            await expect(pane.getByText(latestText, { exact: true })).toBeVisible({ timeout: 45_000 })
            await page.waitForFunction(() => window.__hapiColdOpening.current?.ready
                && window.__hapiColdOpening.current.stableForMs >= 750, null, { timeout: 45_000 })
            const composer = pane.locator('[data-composer-input][contenteditable="true"]:visible').first()
            await composer.click()
            await page.keyboard.type(draftText, { delay: 5 })
            await page.waitForTimeout(700)
            await expect(composer).toHaveText(draftText)
            expect((await page.evaluate(() => window.__hapiColdOpening.input)).everRetained).toBe(true)

            appendLive(`${viewport.width}`, liveText)
            await expect(pane.getByText(liveText, { exact: true })).toBeVisible({ timeout: 20_000 })
            const history = await exerciseOpeningHistory(page, pane, mobile ? 'touch' : 'wheel')
            expect(history.failure, JSON.stringify(history)).toBeNull()
            expect(history.requested, JSON.stringify(history)).toBe(true)
            expect(history.committed, JSON.stringify(history)).toBe(true)
            expect(history.commitAfterRequest, JSON.stringify(history)).toBe(true)
            expect(history.anchorRetained, JSON.stringify(history)).toBe(true)
            expect(Math.abs(history.anchorDriftPx ?? 0), JSON.stringify(history)).toBeLessThanOrEqual(2)

            if (mobile) {
                const navigation = await exerciseOpeningReturnLatest(page, pane, latestText)
                expect(navigation.attempted, JSON.stringify(navigation)).toBe(true)
                expect(navigation.failure, JSON.stringify(navigation)).toBeNull()
                expect(navigation.committed, JSON.stringify(navigation)).toBe(true)
                expect(navigation.targetVisible, JSON.stringify(navigation)).toBe(true)
            } else {
                const navigation = await exerciseOpeningUnvisitedTarget(page, pane, navigationText, 20)
                expect(navigation.attempted, JSON.stringify(navigation)).toBe(true)
                expect(navigation.failure, JSON.stringify(navigation)).toBeNull()
                expect(navigation.committed, JSON.stringify(navigation)).toBe(true)
                expect(navigation.targetVisible, JSON.stringify(navigation)).toBe(true)
            }
            await expect(composer).toHaveText(draftText)
            await waitForColdOpeningObservation(page, 70_000)
            const result = await readColdOpeningProbe(page, true)
            expect(result.observation.complete).toBe(true)
            expect(result.observation.deadlineMissed).toBe(false)
            expect(result.observation.checkpoints.map(row => row.name)).toContain('t+6000')
            expect(result.liveUpdateAt).not.toBeNull()
            expect(result.input.everRetained).toBe(true)
            expect(result.current?.editorUsable).toBe(true)
            const failures = coldOpeningIssues(result)
            expect(failures, JSON.stringify({ history: result.history, navigation: result.navigation,
                input: result.input, observation: result.observation, states: result.states })).toEqual([])
            expect(errors).toEqual([])
            expect(warm.environment.hapi.sent).toEqual([])
            await info.attach(`complete-observer-${viewport.width}`, { body: JSON.stringify({
                history: result.history, navigation: result.navigation, input: result.input,
                liveUpdateAt: result.liveUpdateAt, observation: result.observation,
                editorIds: [...new Set(result.states.map(row => row.editorRevision).filter(Boolean))].length,
                portIds: [...new Set(result.states.map(row => row.portRevision).filter(Boolean))].length,
            }, null, 2), contentType: 'application/json' })
        } finally {
            if (sampling && !page.isClosed()) {
                try {
                    const trace = await readColdOpeningProbe(page, true)
                    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
                    await mkdir(directory, { recursive: true })
                    const path = join(directory, `complete-observer-${viewport.width}-${Date.now()}-timeline.json`)
                    await writeFile(path, JSON.stringify({ viewport, errors, trace }, null, 2))
                    await info.attach(`complete-observer-${viewport.width}-timeline`, { path, contentType: 'application/json' })
                } catch { /* Preserve the primary test failure. */ }
            }
            await page.unrouteAll({ behavior: 'wait' }).catch(() => {})
            await page.close().catch(() => {})
        }
    })
}
