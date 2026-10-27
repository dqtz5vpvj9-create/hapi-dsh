/**
 * Real official Host, full-conversation acceptance for the observer.
 *
 * The long source is synthetic HAPI wire data. The Host, official Conversation,
 * pager, editor and official TurnNavigator are the pinned real implementation.
 * The target is resolved once to an exact display view, the Host is restarted,
 * then its browser HTTP cache is cleared before the measured navigation.
 * Saved workspace/origin storage is retained, as on a returning user's open.
 */
import { test, expect } from '@playwright/test'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
    // Exceed the six 200-row source seed pages. The older navigation target
    // must require an actual source window, not just a resident Host log page.
    const fixture = warm.environment.hapi.require('native-accept-history')
    fixture.rows = nativeIndexedHistory(fixture.session.metadata!.codexSessionId!, 180, 8)
})
test.afterAll(async () => { await warm?.close() })

const title = 'Native Codex accept-history'
const latestText = 'Synthetic final answer 180.'
const navigationText = 'Synthetic original input 20.'
const draftText = 'Unsent observer acceptance draft; never submit.'
const liveText = 'Live synthetic source update for the complete observer.'
let sourceHeadText = latestText

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
    sourceHeadText = text
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
        const openingText = sourceHeadText
        const liveMarker = `${liveText} ${viewport.width}px`
        const page = await warm.page({ width: viewport.width, height: viewport.height }, mobile)
        const errors: string[] = []
        const sourceWindows: Array<{ receivedAt: number; count: number; openingMarker: boolean; liveMarker: boolean }> = []
        let navigationTurn: number | undefined
        page.on('response', async response => {
            if (new URL(response.url()).pathname === '/api/hapi/sourceHistoryWindowPage' && response.ok()) {
                try {
                    const payload = await response.json() as { result?: { value?: { records?: unknown[] } } }
                    const rows = payload.result?.value?.records ?? []
                    const encoded = JSON.stringify(rows)
                    sourceWindows.push({ receivedAt: await page.evaluate(() => performance.now()), count: rows.length,
                        openingMarker: encoded.includes(openingText), liveMarker: encoded.includes(liveMarker) })
                } catch { /* Closing the page is recorded by the interaction assertion. */ }
            }
            if (new URL(response.url()).pathname !== '/api/hapi/sourceHistoryOutline' || !response.ok()) return
            try {
                const data = await response.json() as { result?: { value?: { entries?: Array<{ prompt: string; turn: number }> } } }
                const entry = data.result?.value?.entries?.find(row => row.prompt === navigationText)
                if (entry) navigationTurn = entry.turn
            } catch { /* A missing authoritative target fails the assertion below. */ }
        })
        let sampling = false
        let expectedViewId: string | undefined
        page.on('pageerror', error => errors.push(error.message))
        // The official feed catches renderer exceptions and emits a warning;
        // a pageerror listener alone misses this real broken-history path.
        page.on('console', message => {
            if (message.text().includes('event feed subscriber failed')) errors.push(message.text().slice(0, 1200))
        })
        try {
            // Resolve the exact display view once. This warm-up is setup only;
            // the measured opening below happens after a Host restart with the
            // observer installed before navigation.
            await warm.admit(page)
            await openListedSession(page, mobile)
            const warmPane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
            await expect(warmPane.getByText(openingText, { exact: true })).toBeVisible({ timeout: 45_000 })
            const paneId = await warmPane.getAttribute('data-pane-id')
            const viewId = await warmPane.locator('[data-hapi-session-view]').first().getAttribute('data-hapi-session-view')
            expect(paneId).toBeTruthy()
            expect(viewId).toBeTruthy()
            expectedViewId = viewId!
            await page.goto('about:blank')
            await warm.environment.restartHost()
            const cacheControl = await page.context().newCDPSession(page)
            await cacheControl.send('Network.clearBrowserCache')
            await cacheControl.detach()

            await installColdOpeningProbe(page, {
                paneSelector: `[data-pane-id="${paneId}"]`,
                expectedViewId: viewId!, expectedTitle: title, expectedText: openingText,
                expectedNavigationText: mobile ? liveMarker : navigationText,
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
            await expect(pane.getByText(openingText, { exact: true })).toBeVisible({ timeout: 45_000 })
            await page.waitForFunction(() => window.__hapiColdOpening.current?.ready
                && window.__hapiColdOpening.current.stableForMs >= 750, null, { timeout: 45_000 })
            const composer = pane.locator('[data-composer-input][contenteditable="true"]:visible').first()
            await composer.click()
            await page.keyboard.type(draftText, { delay: 5 })
            await page.waitForTimeout(700)
            await expect(composer).toHaveText(draftText)
            expect((await page.evaluate(() => window.__hapiColdOpening.input)).everRetained).toBe(true)

            appendLive(`${viewport.width}`, liveMarker)
            await expect(pane.getByText(liveMarker, { exact: true })).toBeVisible({ timeout: 1_500 })
            const history = await exerciseOpeningHistory(page, pane, mobile ? 'touch' : 'wheel')
            expect(history.failure, JSON.stringify(history)).toBeNull()
            expect(history.requested, JSON.stringify(history)).toBe(true)
            expect(history.committed, JSON.stringify(history)).toBe(true)
            expect(history.commitAfterRequest, JSON.stringify(history)).toBe(true)
            expect(history.anchorRetained, JSON.stringify(history)).toBe(true)
            expect(Math.abs(history.anchorDriftPx ?? 0), JSON.stringify(history)).toBeLessThanOrEqual(2)

            if (mobile) {
                const navigation = await exerciseOpeningReturnLatest(page, pane, liveMarker)
                expect(navigation.attempted, JSON.stringify(navigation)).toBe(true)
                expect(navigation.failure, JSON.stringify(navigation)).toBeNull()
                expect(navigation.committed, JSON.stringify(navigation)).toBe(true)
                expect(navigation.targetVisible, JSON.stringify(navigation)).toBe(true)
            } else {
                expect(navigationTurn, 'The exact source target must appear in the authoritative outline').toBeDefined()
                const navigation = await exerciseOpeningUnvisitedTarget(page, pane, navigationText, navigationTurn!)
                expect(navigation.attempted, JSON.stringify(navigation)).toBe(true)
                expect(navigation.failure, JSON.stringify(navigation)).toBeNull()
                expect(navigation.committed, JSON.stringify(navigation)).toBe(true)
                expect(navigation.targetVisible, JSON.stringify(navigation)).toBe(true)
            }
            // The newest source row is the live update above, not the older
            // opening marker. Returning from history must rejoin that head and
            // keep receiving later events through the same official editor.
            if (!mobile) {
                expect(await page.evaluate(text => window.__hapiColdOpening.setReturnLatestTarget(text), liveMarker)).toBe(true)
                await pane.locator('button[class*="toBottom"]').click()
                await expect(pane.getByText(liveMarker, { exact: true })).toBeVisible({ timeout: 1_500 })
            }
            for (let index = 1; index <= 5; index++) {
                const text = `Live update after returning to latest ${viewport.width}.${index}.`
                appendLive(`${viewport.width}-returned-${index}`, text)
                await expect(pane.getByText(text, { exact: true })).toBeVisible({ timeout: 1_500 })
            }
            await expect(composer).toHaveText(draftText)
            await waitForColdOpeningObservation(page, 70_000)
            const result = await readColdOpeningProbe(page, true)
            // Keep the full interaction trace even when opening is slow. The
            // 60 s observer deadline is diagnostic, never the performance SLA.
            expect.soft(result.first.full ?? Infinity,
                'The first complete conversation must be usable within 1500 ms of navigation').toBeLessThan(1_500)
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
                first: result.first,
                history: result.history, navigation: result.navigation, input: result.input,
                liveUpdateAt: result.liveUpdateAt, observation: result.observation,
                editorIds: [...new Set(result.states.map(row => row.editorRevision).filter(Boolean))].length,
                portIds: [...new Set(result.states.map(row => row.portRevision).filter(Boolean))].length,
            }, null, 2), contentType: 'application/json' })
        } finally {
            if (!page.isClosed()) {
                try {
                    const trace = sampling ? await readColdOpeningProbe(page, true) : null
                    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
                    await mkdir(directory, { recursive: true, mode: 0o700 })
                    await chmod(directory, 0o700)
                    const geometry = await page.locator('[data-conversation-scroll]').evaluateAll(nodes => nodes.map(node => {
                        const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
                        return { clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
                            scrollTop: node.scrollTop, width: rect.width, height: rect.height,
                            overflowY: style.overflowY, visible: node.checkVisibility(),
                            flowHeight: node.querySelector('[data-chat-flow]')?.getBoundingClientRect().height ?? null }
                    }))
                    const timings = await page.evaluate(() => ({ marks: performance.getEntriesByType('mark').map(e => ({ name: e.name, at: e.startTime })), resources: performance.getEntriesByType('resource').map(e => { const r = e as PerformanceResourceTiming; return { path: new URL(r.name).pathname, start: r.startTime, response: r.responseStart, end: r.responseEnd, bytes: r.transferSize } }) }))
                    const path = join(directory, `complete-observer-${viewport.width}-${Date.now()}-timeline.json`)
                    await writeFile(path, JSON.stringify({ viewport, errors, geometry, timings, sourceWindows, trace }, null, 2))
                    await info.attach(`complete-observer-${viewport.width}-timeline`, { path, contentType: 'application/json' })
                    // Fixed webshot opens a fresh browser on this same synthetic
                    // workspace. It is a visual companion, not the action trace.
                    if (expectedViewId || await page.locator('[data-hapi-session-view]').count() > 0) {
                        const shot = join(directory, `complete-observer-${viewport.width}-${Date.now()}.png`)
                        const readySelector = expectedViewId
                            ? `[data-hapi-session-view="${expectedViewId}"] [data-hapi-session-reveal="ready"] [data-composer-input]`
                            : `[aria-label="Pane: ${title}"] [data-hapi-session-reveal="ready"] [data-composer-input]`
                        try {
                            await promisify(execFile)('webshot', ['--url', warm.environment.launchUrl,
                                '--output', shot, '--viewport', `${viewport.width}x${viewport.height}`,
                                '--ready-js', `Boolean(document.querySelector(${JSON.stringify(readySelector)})) || [...document.querySelectorAll('[role="alert"]')].some(node => node.textContent?.includes('could not fill'))`,
                                '--timeout-ms', '20000', '--quiet'], { timeout: 25000 })
                            await info.attach(`complete-observer-${viewport.width}-fresh-context`, { path: shot, contentType: 'image/png' })
                        } catch {
                            await info.attach('visual-companion-failed', { body: 'webshot did not produce a ready image; no visual pass is claimed.', contentType: 'text/plain' })
                        }
                    }
                } catch { /* Preserve the primary test failure. */ }
            }
            await page.unrouteAll({ behavior: 'wait' }).catch(() => {})
            await page.close().catch(() => {})
        }
    })
}
