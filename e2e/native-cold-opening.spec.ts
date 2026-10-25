/** Real pinned Conversation/Host; source delays and messages are synthetic. */
import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { installColdOpeningProbe, readColdOpeningProbe, coldOpeningIssues, exerciseOpeningHistory,
    exerciseOpeningUnvisitedTarget, exerciseOpeningReturnLatest, waitForColdOpeningObservation } from './cold-opening-probe.ts'
import { nativeIndexedHistory } from './source-conversation-fixture.ts'
import { conversationReady, visualReview } from './visual-review.ts'

test.use({ screenshot: 'off' })
test.setTimeout(240_000)

function gate(): { promise: Promise<void>; release(): void } {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
}

/** The action requirements are enabled explicitly; this spec is product acceptance. */
const acceptanceOptions = (viewport: number) => ({
    requiresHistory: true, requiresNavigation: 'auto' as const, fullCapabilities: true,
    observeAfterReadyMs: 30_000, failureDeadlineMs: 60_000, checkpointsMs: [6_000, 20_000],
    stableMs: 750, captureTitles: true, bodySampleMs: 100,
    requireEditorInput: true, requireLiveUpdate: true,
    requireHistoryAction: true, requireNavigationAction: true,
    navigationAction: viewport > 900 ? 'unvisited-target' as const : 'return-latest' as const,
})

function observedHistory(): import('../src/codex/contracts.ts').HapiMessage[] {
    const rows: import('../src/codex/contracts.ts').HapiMessage[] = []
    const start = Date.now() - 10 * 60_000
    for (let turn = 0; turn < 8; turn++) {
        const at = start + turn * 60_000
        rows.push({ id: `observed-user-${turn}`, localId: `observed-user-${turn}`, seq: turn * 3 + 1,
            createdAt: at, invokedAt: at, content: { role: 'user', content: { type: 'text', text: `Earlier observed input ${turn + 1}.` } } })
        rows.push({ id: `observed-answer-${turn}`, localId: null, seq: turn * 3 + 2, createdAt: at + 1,
            content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: `observed-answer-${turn}`,
                message: { model: 'sonnet', content: [{ type: 'text', text: `Earlier observed answer ${turn + 1}.` }] } } } } })
        rows.push({ id: `observed-ready-${turn}`, localId: null, seq: turn * 3 + 3, createdAt: at + 2,
            content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } })
    }
    return rows
}

function appendLiveRows(hapi: OfficialEnvironment['hapi'], native: boolean, fixture: ReturnType<OfficialEnvironment['hapi']['add']>, thread: string, key: string, text: string): void {
    const seq = (fixture.rows.at(-1)?.seq ?? 0) + 1, at = Date.now(), turnId = `live-${key}`
    const execution = { threadId: thread, turnId }
    const input = { id: `${key}-live-input`, localId: `${key}-live-input`, seq, createdAt: at, invokedAt: at,
        content: { role: 'user' as const, content: { type: 'text' as const, text: `Live source question ${key}` },
            ...(native ? { meta: { nativeExecution: { ...execution, itemId: 'live-input' } } } : {}) } }
    const answer = { id: `${key}-live-answer`, localId: native ? `${key}-live-answer` : null, seq: seq + 1, createdAt: at + 1,
        content: { role: 'agent' as const, content: native
            ? { type: 'codex' as const, data: { type: 'message', id: `${key}-live-answer`, message: text, streamSnapshot: true,
                nativeExecution: { ...execution, itemId: 'live-answer' } } }
            : { type: 'output' as const, data: { type: 'assistant', uuid: `${key}-live-answer`,
                message: { model: 'sonnet', content: [{ type: 'text', text }] } } } } }
    const terminal = { id: `${key}-live-terminal`, localId: null, seq: seq + 2, createdAt: at + 2,
        content: { role: 'agent' as const, content: native
            ? { type: 'codex' as const, data: { type: 'native-turn', nativeExecution: {
                ...execution, turn: { status: 'completed', started: true, ended: true } } } }
            : { type: 'event' as const, data: { type: 'ready' } } } }
    for (const row of [input, answer, terminal]) {
        fixture.rows.push(row)
        fixture.session.updatedAt = row.createdAt
        hapi.emit({ type: 'message-received', sessionId: fixture.session.id, message: row })
    }
}

test.describe('native and observed document opening preserve freshness, identity and full interactivity', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => { environment = await startOfficialEnvironment() })
    test.afterAll(async () => { await environment?.close() })
    for (const engine of ['codex', 'claude'] as const) for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
        test(`${engine}: ${viewport.width}px opening is complete before the archive and survives it`, async ({ page }, info) => {
            await page.setViewportSize(viewport)
            const errors: string[] = []
            page.on('pageerror', error => errors.push(error.message))
            const metadataGate = gate(), historyGate = gate(), archiveGate = gate()
            const native = engine === 'codex'
            const key = `complete-${engine}-${viewport.width}`
            const fixture = native ? environment.hapi.add(key, 'Synthetic complete source', 'machine-alpha')
                : environment.hapi.addObserved('claude', key)
            const title = fixture.session.metadata!.name!
            const originalThread = native ? fixture.session.metadata!.codexSessionId! : fixture.session.metadata!.claudeSessionId!
            const staleText = native ? 'Synthetic final answer 8.' : 'Original claude answer in the official DSH Conversation.'
            const latestText = `Latest source tail ${key}; all prior history has been reconciled.`
            const liveText = `Live source update ${key} reached the original window.`
            const navigationText = native ? 'Synthetic original input 8.' : 'Original claude input'
            const navigationTurn = native ? 8 : 9
            const draftText = `Unsent draft during generation handoff ${key}`
            if (native) fixture.rows = nativeIndexedHistory(originalThread, 8, 3)
            else {
                // Keep the original two rows as the pre-open tail, with enough
                // bounded older history for real paging and the rail.
                const original = fixture.rows.map(row => structuredClone(row))
                const older = observedHistory()
                const tail = older.length + 1
                original.forEach((row, index) => {
                    row.seq = tail + index
                    row.createdAt = Date.now() - 20_000 + index
                    if (row.invokedAt != null) row.invokedAt = row.createdAt
                })
                fixture.rows = [...older, ...original]
            }
            let metadataReads = 0, historyReads = 0, archiveReads = 0, archiveReleased = false
            let sampling = false
            let sourceReleasedAt: number | undefined
            try {
                environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
                await page.goto(environment.launchUrl)
                await acknowledgePreviewNotice(page, environment)
                if (viewport.width < 768) {
                    const picker = page.locator('.hapi-mobile-session-layer')
                    if (!await picker.isVisible()) await page.locator('.hapi-statusbar > .hapi-mobile-back').click()
                    await expect(picker).toBeVisible()
                    await picker.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: title }).click()
                    await expect(picker).toHaveCount(0)
                } else await page.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: title }).click()
                const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
                await expect(pane.getByText(staleText, { exact: true })).toBeVisible()
                const paneId = await pane.getAttribute('data-pane-id')
                expect(paneId).toBeTruthy()
                const viewId = await pane.locator('[data-hapi-session-view]').first().getAttribute('data-hapi-session-view')
                expect(viewId).toBeTruthy()
                await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
                await page.goto('about:blank')

                // The Host already has an old materialized transcript. Original
                // Hub metadata/history now lag independently. Do not pre-project
                // the new source rows into the display Session.
                fixture.readSession = async () => { metadataReads++; await metadataGate.promise; return fixture.session }
                fixture.readHistory = async url => {
                    historyReads++
                    const before = Number(url.searchParams.get('beforeSeq')), limit = Number(url.searchParams.get('limit') ?? 200)
                    const older = url.searchParams.has('beforeSeq')
                    if (older && limit > 1) { archiveReads++; await archiveGate.promise }
                    else await historyGate.promise
                    const pool = older ? fixture.rows.filter(row => (row.seq ?? 0) < before) : fixture.rows
                    const selected = pool.slice(-(older ? limit : 3))
                    const oldest = selected[0], newest = fixture.rows.at(-1)
                    return { messages: structuredClone(selected), page: { direction: older ? 'before' : 'latest', limit,
                        epoch: 1, reset: false, nextBeforeSeq: oldest?.seq ?? null, nextBeforeAt: oldest?.invokedAt ?? oldest?.createdAt ?? null,
                        nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: newest?.seq ?? null,
                        snapshotHeadAt: newest?.createdAt ?? null, hasMore: pool.length > selected.length } }
                }
                const at = Date.now(), seq = (fixture.rows.at(-1)?.seq ?? 0) + 1
                const nativeExecution = { threadId: originalThread, turnId: `cold-tail-${key}` }
                fixture.rows.push(
                    { id: `${key}-latest-input`, localId: `${key}-latest-input`, seq, createdAt: at, invokedAt: at,
                        content: { role: 'user', content: { type: 'text', text: `New source question ${key}` },
                            ...(native ? { meta: { nativeExecution: { ...nativeExecution, itemId: 'input' } } } : {}) } },
                    { id: `${key}-latest-answer`, localId: native ? `${key}-latest-answer` : null, seq: seq + 1, createdAt: at + 1,
                        content: { role: 'agent', content: native ? { type: 'codex', data: { type: 'message', id: `${key}-latest-answer`,
                            message: latestText, streamSnapshot: true, nativeExecution: { ...nativeExecution, itemId: 'answer' } } }
                            : { type: 'output', data: { type: 'assistant', uuid: `${key}-latest-answer`,
                                message: { model: 'sonnet', content: [{ type: 'text', text: latestText }] } } } } },
                    { id: `${key}-latest-terminal`, localId: null, seq: seq + 2, createdAt: at + 2,
                        content: { role: 'agent', content: native ? { type: 'codex', data: { type: 'native-turn', nativeExecution: {
                            ...nativeExecution, turn: { status: 'completed', started: true, ended: true },
                        } } } : { type: 'event', data: { type: 'ready' } } } },
                )
                fixture.session.updatedAt = at + 2
                fixture.session.metadataVersion++
                // Reusing an attached Agent via page.reload() bypasses create's
                // persisted opening-cache fast path. Restart the synthetic Host,
                // keeping the original profile and native source identity.
                await environment.restartHost()
                await installColdOpeningProbe(page, { paneSelector: `[data-pane-id="${paneId}"]`, expectedTitle: title,
                    expectedText: latestText, staleText, expectedViewId: viewId!,
                    expectedNavigationText: viewport.width > 900 ? navigationText : latestText,
                    ...acceptanceOptions(viewport.width) })
                await page.goto(environment.launchUrl, { waitUntil: 'domcontentloaded' })
                sampling = true
                await page.waitForTimeout(500)
                metadataGate.release()
                await expect.poll(() => metadataReads).toBeGreaterThan(0)
                await expect.poll(() => historyReads).toBeGreaterThan(0)
                // Hold history past first shell/title paint. Sampling runs from
                // before navigation, including this stale interval.
                await page.waitForTimeout(750)
                const pending = await readColdOpeningProbe(page)
                expect(pending.first.latest).toBeNull()
                expect(pending.current?.ready).toBe(false)
                sourceReleasedAt = await page.evaluate(() => performance.now())
                historyGate.release()
                await page.waitForFunction(() => window.__hapiColdOpening.current?.ready
                    && window.__hapiColdOpening.current.stableForMs >= 750, undefined, { timeout: 90_000 })
                await expect.poll(() => archiveReads).toBeGreaterThan(0)
                expect(archiveReleased, 'latest body and usable editor must not wait for the archive').toBe(false)
                const beforeArchive = await readColdOpeningProbe(page)
                expect(beforeArchive.current?.latestVisible).toBe(true)
                expect(beforeArchive.current?.editorUsable).toBe(true)
                expect(beforeArchive.current?.historyHasMore).toBe(true)
                expect(beforeArchive.current?.historyScrollable).toBe(true)
                expect(beforeArchive.current?.navigationRequired).toBe(viewport.width > 900)
                expect(beforeArchive.current?.navigationMode).toBe(viewport.width > 900 ? 'rail' : 'mobile')
                const composer = pane.locator('[data-composer-input][contenteditable="true"]:visible').first()
                await composer.click()
                await page.keyboard.type(draftText, { delay: 5 })
                await page.waitForTimeout(700)
                await expect(composer).toHaveText(draftText)
                const draftEvidence = await page.evaluate(() => window.__hapiColdOpening.input)
                expect(draftEvidence.everRetained, 'trusted typing must be retained before the archive is released').toBe(true)
                const image = await visualReview(environment.launchUrl, `${native ? 'native' : 'observed'}-cold-latest-before-archive`,
                    `${viewport.width}x${viewport.height}`, conversationReady(title,
                        `if (!pane.textContent.includes(${JSON.stringify(latestText)})) return false;`))
                if (image) await info.attach('latest-body-while-archive-blocked', { path: image, contentType: 'image/png' })
                expect(archiveReleased).toBe(false)
                archiveReleased = true
                archiveGate.release()
                // A real live source message, appended after first success, must
                // reach the original window without replacing its editor or view.
                appendLiveRows(environment.hapi, native, fixture, originalThread, key, liveText)
                await expect(pane.getByText(liveText, { exact: true })).toBeVisible({ timeout: 20_000 })
                const historyAction = await exerciseOpeningHistory(page, pane, viewport.width < 900 ? 'touch' : 'wheel')
                expect(historyAction.failure, JSON.stringify(historyAction)).toBeNull()
                expect(historyAction.committed, JSON.stringify(historyAction)).toBe(true)
                expect(historyAction.requested, JSON.stringify(historyAction)).toBe(true)
                expect(historyAction.committed, JSON.stringify(historyAction)).toBe(true)
                expect(historyAction.commitAfterRequest, JSON.stringify(historyAction)).toBe(true)
                expect(historyAction.anchorRetained, JSON.stringify(historyAction)).toBe(true)
                expect(Math.abs(historyAction.anchorDriftPx ?? 0), JSON.stringify(historyAction)).toBeLessThanOrEqual(2)
                if (viewport.width > 900) {
                    const navigation = await exerciseOpeningUnvisitedTarget(page, pane, navigationText, navigationTurn)
                    expect(navigation.attempted, JSON.stringify(navigation)).toBe(true)
                    expect(navigation.failure, JSON.stringify(navigation)).toBeNull()
                    expect(navigation.committed, JSON.stringify(navigation)).toBe(true)
                    expect(navigation.targetVisible, JSON.stringify(navigation)).toBe(true)
                } else {
                    // The official TurnNavigator is hidden at <=900 px. The
                    // mobile action is explicitly return-latest, not a fake
                    // older-target jump; touch history above proves old content.
                    const navigation = await exerciseOpeningReturnLatest(page, pane, latestText)
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
                if (result.first.full !== null && result.stoppedAt! - result.first.full >= 20_000)
                    expect(result.observation.checkpoints.map(row => row.name)).toContain('t+20000')
                expect(result.input.everRetained).toBe(true)
                expect(result.liveUpdateAt, 'live source update must be observed').not.toBeNull()
                expect(result.first.latest).not.toBeNull()
                expect(result.first.latest! - sourceReleasedAt!).toBeLessThan(3000)
                expect(result.current?.editorUsable).toBe(true)
                const editorIds = result.states.filter(row => (row.editorRevision ?? 0) > 0).map(row => row.editorRevision)
                const portIds = result.states.filter(row => (row.portRevision ?? 0) > 0).map(row => row.portRevision)
                expect(new Set(editorIds).size, 'one stable editor instance for the whole opening').toBe(1)
                expect(new Set(portIds).size, 'one stable scroll root for the whole opening').toBe(1)
                expect(coldOpeningIssues(result), JSON.stringify({ titles: result.titles, states: result.states,
                    history: result.history, navigation: result.navigation, input: result.input })).toEqual([])
                const usableDrafts = await pane.locator('[data-composer-input]').evaluateAll(editors => editors.filter(editor => {
                    if (!editor.matches('[contenteditable="true"]') || editor.closest('[inert], [aria-disabled="true"]')
                        || !editor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
                    const rect = editor.getBoundingClientRect()
                    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight
                        || rect.right <= 0 || rect.left >= innerWidth) return false
                    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)),
                        Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)))
                    return Boolean(hit && (hit === editor || editor.contains(hit)))
                }).map(editor => editor.textContent))
                expect(usableDrafts, 'one usable successor composer must retain the unsent draft').toEqual([draftText])
                expect(native ? fixture.session.metadata!.codexSessionId : fixture.session.metadata!.claudeSessionId).toBe(originalThread)
                expect(environment.hapi.sent.filter(row => row.sessionId === fixture.session.id)).toEqual([])
                expect(environment.hapi.aborted).not.toContain(fixture.session.id)
                expect(errors).toEqual([])
            } finally {
                try {
                    if (sampling && !page.isClosed()) {
                        const timeline = JSON.stringify({ engine, viewport, sourceReleasedAt, metadataReads, historyReads, archiveReads, archiveReleased, errors,
                            trace: await readColdOpeningProbe(page, true) }, null, 2)
                        const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
                        await mkdir(directory, { recursive: true })
                        const path = join(directory, `${native ? 'native' : 'observed'}-cold-opening-${viewport.width}-${Date.now()}-timeline.json`)
                        await writeFile(path, timeline)
                        await info.attach('navigation-through-stable-latest-body', { path, contentType: 'application/json' })
                    }
                } finally {
                    metadataGate.release(); historyGate.release(); archiveGate.release()
                    delete fixture.readSession; delete fixture.readHistory
                }
                await info.attach('official-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
            }
        })
    }
})

/**
 * Synthetic sampler controls. These use data: URLs and are explicitly not
 * product acceptance; the real official Host cases above are the product test.
 */
test.describe('synthetic sampler mechanics, not product acceptance', () => {
    test('rejects title and freshness regressions even when the final DOM recovers', async ({ page }) => {
        await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail',
            staleText: 'Old native body', stableMs: 25, captureTitles: true, fullCapabilities: false,
            requiresHistory: false, requiresNavigation: false, observeAfterReadyMs: 0, checkpointsMs: [],
            requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false })
        await page.goto(`data:text/html,${encodeURIComponent(`<main class="hapi-pane hapi-pane-focused" aria-label="Pane: Known native title">
            <section data-conversation-scroll style="height:180px;overflow:auto"><div data-chat-flow>
            <article data-chat-node-key="one">Fresh native tail</article></div></section>
            <div data-composer-input contenteditable="true" style="height:40px">Draft</div></main>`)}`)
        await page.waitForFunction(() => window.__hapiColdOpening.current?.ready)
        // Both title writes occur in one task: a final assertion and even a pure
        // rAF sampler would miss this transition without MutationObserver records.
        await page.evaluate(() => {
            const pane = document.querySelector('.hapi-pane')!
            pane.setAttribute('aria-label', 'Pane: Untitled')
            pane.setAttribute('aria-label', 'Pane: Known native title')
            document.querySelector('[data-chat-node-key]')!.textContent = 'Old native body'
        })
        await page.waitForFunction(() => window.__hapiColdOpening.current?.staleVisible)
        await page.evaluate(() => { document.querySelector('[data-chat-node-key]')!.textContent = 'Fresh native tail' })
        await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
        const trace = await readColdOpeningProbe(page, true)
        expect(trace.current?.ready).toBe(true)
        expect(trace.titles.map(row => row.value)).toContain('Untitled')
        const failures = coldOpeningIssues(trace)
        expect(failures.some(row => row.startsWith('Title regressed to placeholder'))).toBe(true)
        expect(failures.some(row => row.startsWith('Latest source body disappeared'))).toBe(true)
        expect(failures.some(row => row.startsWith('Stale body appeared ready'))).toBe(true)
    })

    test('accepts a Chinese pane label and still records a transient unnamed title', async ({ page }) => {
        await installColdOpeningProbe(page, { expectedTitle: '已有会话标题', expectedText: '最新消息正文', stableMs: 25,
            captureTitles: true, fullCapabilities: false, requiresHistory: false, requiresNavigation: false,
            observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false, requireLiveUpdate: false,
            requireHistoryAction: false, requireNavigationAction: false })
        await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(`<main class="hapi-pane hapi-pane-focused" aria-label="窗格: 已有会话标题">
            <section data-conversation-scroll style="height:180px;overflow:auto"><div data-chat-flow>
            <article data-chat-node-key="one">最新消息正文</article></div></section>
            <div data-composer-input contenteditable="true" style="height:40px">草稿</div></main>`)}`)
        await page.waitForFunction(() => window.__hapiColdOpening.current?.ready)
        await page.evaluate(() => {
            const pane = document.querySelector('.hapi-pane')!
            pane.setAttribute('aria-label', '窗格: 未命名会话')
            pane.setAttribute('aria-label', '窗格: 已有会话标题')
        })
        await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
        const trace = await readColdOpeningProbe(page, true)
        expect(trace.first.title).not.toBeNull()
        expect(trace.titles.map(row => row.value)).toContain('未命名会话')
        expect(coldOpeningIssues(trace).some(row => row.startsWith('Title regressed to placeholder'))).toBe(true)
    })

    test('does not accept a latest marker below the viewport or an Untitled pane', async ({ page }) => {
        await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail',
            stableMs: 25, fullCapabilities: false, requiresHistory: false, requiresNavigation: false,
            observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false, requireLiveUpdate: false,
            requireHistoryAction: false, requireNavigationAction: false })
        await page.goto(`data:text/html,${encodeURIComponent(`<main class="hapi-pane hapi-pane-focused" aria-label="Pane: Untitled">
            <section data-conversation-scroll style="height:180px;overflow:auto"><div data-chat-flow>
            <article data-chat-node-key="one"><p>Old visible native text</p><div style="height:800px"></div>Fresh native tail</article>
            </div></section><div data-composer-input contenteditable="true" style="height:40px">Draft</div></main>`)}`)
        await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
        const trace = await readColdOpeningProbe(page, true)
        expect(trace.current?.latestAttached).toBe(true)
        expect(trace.current?.latestVisible).toBe(false)
        expect(trace.first.title).toBeNull()
        expect(trace.first.ready).toBeNull()
        expect(coldOpeningIssues(trace)).not.toEqual([])
    })

    test('rejects a visible successor editor and scroll root even with copied text and draft', async ({ page }) => {
        await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail',
            stableMs: 25, fullCapabilities: false, requiresHistory: false, requiresNavigation: false,
            observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false, requireLiveUpdate: false,
            requireHistoryAction: false, requireNavigationAction: false })
        await page.goto(`data:text/html,${encodeURIComponent(`<main class="hapi-pane hapi-pane-focused" aria-label="Pane: Known native title">
            <div data-hapi-session-view="original"><section data-conversation-scroll style="height:180px;overflow:auto">
            <div data-chat-flow><article data-chat-node-key="one">Fresh native tail</article></div></section>
            <div data-composer-input contenteditable="true" style="height:40px">Draft</div></div></main>`)}`)
        await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
        await page.evaluate(() => {
            const original = document.querySelector<HTMLElement>('[data-hapi-session-view]')!
            const replacement = original.cloneNode(true) as HTMLElement
            replacement.dataset.hapiSessionView = 'replacement'
            original.hidden = true
            original.after(replacement)
        })
        await page.waitForTimeout(150)
        const replaced = await readColdOpeningProbe(page, true)
        // The inherited test used to accept this. A successor view with the
        // same text and copied draft is a visible generation handoff, not the
        // same usable conversation.
        expect(replaced.current?.latestVisible).toBe(true)
        expect(replaced.current?.editorUsable).toBe(true)
        const failures = coldOpeningIssues(replaced)
        expect(failures.some(row => row.startsWith('Editor identity changed'))).toBe(true)
        expect(failures.some(row => row.startsWith('Scroll root identity changed'))).toBe(true)
        expect(failures.some(row => row.startsWith('Visible session view'))).toBe(true)
    })

    test('rejects an inert/transparent predecessor and does not let a later complete paint erase it', async ({ page }) => {
        await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail',
            staleText: 'Old native body', stableMs: 25, fullCapabilities: true, expectedViewId: 'replacement', requiresHistory: false,
            requiresNavigation: false, observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
            requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false })
        await page.goto(`data:text/html,${encodeURIComponent(`<main class="hapi-pane hapi-pane-focused" aria-label="Pane: Known native title" style="position:relative">
            <section id="preparing" inert style="position:absolute;inset:0;opacity:0"><div data-hapi-session-view="replacement">
            <section data-conversation-scroll style="height:180px;overflow:auto"><div data-chat-flow>
            <article data-chat-node-key="new">Fresh native tail</article></div></section>
            <div data-composer-input contenteditable="true" style="height:40px">Draft</div></div></section>
            <section id="previous" inert><div data-hapi-session-view="original">
            <section data-conversation-scroll style="height:180px;overflow:auto"><div data-chat-flow>
            <article data-chat-node-key="old">Old native body</article></div></section>
            <div data-composer-input contenteditable="true" style="height:40px">Draft</div></div></section></main>`)}`)
        await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
        const preparing = await readColdOpeningProbe(page)
        expect(preparing.current?.staleVisible).toBe(true)
        expect(preparing.current?.latestVisible).toBe(false)
        expect(preparing.current?.editorUsable).toBe(false)
        expect(preparing.first.partial).not.toBeNull()
        await page.evaluate(() => {
            document.querySelector('#previous')!.remove()
            const replacement = document.querySelector<HTMLElement>('#preparing')!
            replacement.style.position = 'relative'
            replacement.style.opacity = '1'
            replacement.inert = false
        })
        await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
        const ready = await readColdOpeningProbe(page, true)
        expect(ready.current?.latestVisible).toBe(true)
        expect(ready.current?.editorUsable).toBe(true)
        const failures = coldOpeningIssues(ready)
        expect(failures.some(row => row.startsWith('Partial conversation exposed'))).toBe(true)
        expect(failures.some(row => row.startsWith('Editor became unusable'))).toBe(true)
    })

    test('refreshes marker ranges when the same visible view is reparented', async ({ page }) => {
        await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail',
            stableMs: 25, fullCapabilities: false, requiresHistory: false, requiresNavigation: false,
            observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false, requireLiveUpdate: false,
            requireHistoryAction: false, requireNavigationAction: false })
        await page.goto(`data:text/html,${encodeURIComponent(`<main class="hapi-pane hapi-pane-focused" aria-label="Pane: Known native title">
            <div id="mount"><div data-hapi-session-view="original">
            <section data-conversation-scroll style="height:180px;overflow:auto"><div data-chat-flow>
            <article data-chat-node-key="one">Fresh native tail</article></div></section>
            <div data-composer-input contenteditable="true" style="height:40px">Draft</div>
            </div></div><div id="other"></div></main>`)}`)
        await page.waitForFunction(() => window.__hapiColdOpening.current?.ready)
        await page.evaluate(async () => {
            const view = document.querySelector('[data-hapi-session-view]')!
            document.querySelector('#other')!.append(view)
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
            document.querySelector('#mount')!.append(view)
        })
        await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 100)
        expect(coldOpeningIssues(await readColdOpeningProbe(page, true))).toEqual([])
    })
})
