/** Real pinned Conversation/Host; source delays and messages are synthetic. */
import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { installColdOpeningProbe, readColdOpeningProbe, coldOpeningIssues } from './cold-opening-probe.ts'
import { conversationReady, visualReview } from './visual-review.ts'

test.use({ screenshot: 'off' })
test.setTimeout(180_000)

function gate(): { promise: Promise<void>; release(): void } {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
}
test.describe('native document opening preserves freshness and title throughout startup', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => { environment = await startOfficialEnvironment() })
    test.afterAll(async () => { await environment?.close() })
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
        test(`delayed source metadata and history cannot make stale ${viewport.width}px content look ready`, async ({ page }, info) => {
            await page.setViewportSize(viewport)
            const errors: string[] = []
            page.on('pageerror', error => errors.push(error.message))
            const metadataGate = gate(), historyGate = gate(), archiveGate = gate()
            const key = `cold-opening-${viewport.width}`
            const fixture = environment.hapi.add(key, 'Synthetic cold-opening source', 'machine-alpha')
            const title = fixture.session.metadata!.name!
            const staleText = `Native history ${key} in the official DSH Conversation.`
            const latestText = `Latest source tail ${key}; all prior history has been reconciled.`
            const draftText = `Unsent draft during generation handoff ${key}`
            const originalThread = fixture.session.metadata!.codexSessionId
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
                await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
                await page.goto('about:blank')

                // The Host already has an old materialized native transcript.
                // Original Hub metadata/history now lag independently. Do not
                // pre-project the new source rows into the display Session.
                fixture.readSession = async () => { metadataReads++; await metadataGate.promise; return fixture.session }
                fixture.readHistory = async url => {
                    historyReads++
                    const before = Number(url.searchParams.get('beforeSeq')), limit = Number(url.searchParams.get('limit') ?? 200)
                    const older = url.searchParams.has('beforeSeq')
                    // The limit=1 epoch validation belongs to the latest tail,
                    // while actual archive pages must stay blocked separately.
                    if (older && limit > 1) { archiveReads++; await archiveGate.promise }
                    else await historyGate.promise
                    const pool = older ? fixture.rows.filter(row => (row.seq ?? 0) < before) : fixture.rows
                    const selected = pool.slice(-(older ? limit : 3))
                    const oldest = selected[0], newest = fixture.rows.at(-1)
                    return { messages: structuredClone(selected), page: { direction: older ? 'before' : 'latest', limit,
                        epoch: 1, reset: false, nextBeforeSeq: oldest?.seq ?? null,
                        nextBeforeAt: oldest?.invokedAt ?? oldest?.createdAt ?? null,
                        nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: newest?.seq ?? null,
                        snapshotHeadAt: newest?.createdAt ?? null, hasMore: pool.length > selected.length } }
                }
                const at = Date.now(), seq = (fixture.rows.at(-1)?.seq ?? 0) + 1
                const nativeExecution = { threadId: originalThread, turnId: `cold-tail-${key}` }
                fixture.rows.push(
                    { id: `${key}-latest-input`, localId: `${key}-latest-input`, seq, createdAt: at, invokedAt: at,
                        content: { role: 'user', content: { type: 'text', text: `New source question ${key}` },
                            meta: { nativeExecution: { ...nativeExecution, itemId: 'input' } } } },
                    { id: `${key}-latest-answer`, localId: `${key}-latest-answer`, seq: seq + 1, createdAt: at + 1,
                        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: `${key}-latest-answer`,
                            message: latestText, streamSnapshot: true, nativeExecution: { ...nativeExecution, itemId: 'answer' } } } } },
                    { id: `${key}-latest-terminal`, localId: null, seq: seq + 2, createdAt: at + 2,
                        content: { role: 'agent', content: { type: 'codex', data: { type: 'native-turn', nativeExecution: {
                            ...nativeExecution, turn: { status: 'completed', started: true, ended: true },
                        } } } } },
                )
                fixture.session.updatedAt = at + 2
                fixture.session.metadataVersion++
                // Reusing an attached Agent via page.reload() bypasses create's
                // persisted opening-cache fast path. Restart the synthetic
                // Host, keeping the original profile and native source identity.
                await environment.restartHost()
                await installColdOpeningProbe(page, { paneSelector: `[data-pane-id="${paneId}"]`, expectedTitle: title,
                    expectedText: latestText, staleText, stableMs: 750, captureTitles: true })
                await page.goto(environment.launchUrl, { waitUntil: 'domcontentloaded' })
                sampling = true
                await page.waitForTimeout(500)
                metadataGate.release()
                await expect.poll(() => metadataReads).toBeGreaterThan(0)
                await expect.poll(() => historyReads).toBeGreaterThan(0)
                // Hold history past first shell/title paint. Sampling has been
                // active since navigation, including this stale interval.
                await page.waitForTimeout(750)
                const pending = await readColdOpeningProbe(page)
                expect(pending.first.latest).toBeNull()
                expect(pending.current?.ready).toBe(false)
                sourceReleasedAt = await page.evaluate(() => performance.now())
                historyGate.release()
                await page.waitForFunction(() => window.__hapiColdOpening.current?.ready
                    && window.__hapiColdOpening.current.stableForMs >= 750)
                await expect.poll(() => archiveReads).toBeGreaterThan(0)
                expect(archiveReleased, 'latest body and usable editor must not wait for the archive').toBe(false)
                const beforeArchive = await readColdOpeningProbe(page)
                expect(beforeArchive.current?.latestVisible).toBe(true)
                expect(beforeArchive.current?.editorUsable).toBe(true)
                const composer = pane.locator('[data-composer-input][contenteditable="true"]:visible')
                await composer.fill(draftText)
                await expect(composer).toHaveText(draftText)
                const image = await visualReview(environment.launchUrl, 'native-cold-latest-before-archive',
                    `${viewport.width}x${viewport.height}`, conversationReady(title,
                        `if (!pane.textContent.includes(${JSON.stringify(latestText)})) return false;`))
                if (image) await info.attach('latest-body-while-archive-blocked', { path: image, contentType: 'image/png' })
                expect(archiveReleased).toBe(false)
                archiveReleased = true
                archiveGate.release()
                // Keep observing after first success; late catalog replacement
                // or source replay must not erase the title or fresh suffix.
                await page.waitForTimeout(2000)
                await page.waitForFunction(() => window.__hapiColdOpening.current?.ready
                    && window.__hapiColdOpening.current.stableForMs >= 2000, undefined, { timeout: 3000 })
                const result = await readColdOpeningProbe(page, true)
                expect(result.states[0]?.reason).toBe('navigation')
                expect(result.first.latest).not.toBeNull()
                expect(result.first.latest! - sourceReleasedAt).toBeLessThan(3000)
                expect(result.current?.stableForMs).toBeGreaterThanOrEqual(2000)
                expect(coldOpeningIssues(result), JSON.stringify({ titles: result.titles, states: result.states })).toEqual([])
                // Retained predecessors may still exist, but only the active
                // visible generation may accept input, and its draft must live
                // through archive replacement without a send or manual copy.
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
                expect(fixture.session.metadata!.codexSessionId).toBe(originalThread)
                expect(environment.hapi.sent.filter(row => row.sessionId === fixture.session.id)).toEqual([])
                expect(environment.hapi.aborted).not.toContain(fixture.session.id)
                expect(errors).toEqual([])
            } finally {
                try {
                    if (sampling && !page.isClosed()) {
                        const timeline = JSON.stringify({ sourceReleasedAt, metadataReads, historyReads, archiveReads, archiveReleased, errors,
                            trace: await readColdOpeningProbe(page, true) }, null, 2)
                        const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
                        await mkdir(directory, { recursive: true })
                        const path = join(directory, `native-cold-opening-${viewport.width}-timeline.json`)
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

test('opening sampler rejects title and freshness regressions even when the final DOM recovers', async ({ page }) => {
    await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail',
        staleText: 'Old native body', stableMs: 25, captureTitles: true })
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

test('opening sampler accepts a Chinese pane label and still records a transient unnamed title', async ({ page }) => {
    await installColdOpeningProbe(page, { expectedTitle: '已有会话标题', expectedText: '最新消息正文', stableMs: 25, captureTitles: true })
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

test('opening sampler does not accept a latest marker below the viewport or an Untitled pane', async ({ page }) => {
    await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail', stableMs: 25 })
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

test('opening sampler follows visible replacements while a hidden previous generation stays connected', async ({ page }) => {
    await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail', stableMs: 25 })
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
    // Let several frames and the bounded body sampling interval run. The first
    // matching flow/editor still belong to the connected, hidden generation.
    await page.waitForTimeout(150)
    const replaced = await readColdOpeningProbe(page)
    expect(await page.locator('[data-hapi-session-view="original"]').count()).toBe(1)
    expect(replaced.current?.latestVisible).toBe(true)
    expect(replaced.current?.editorUsable).toBe(true)
    expect(coldOpeningIssues(replaced)).toEqual([])
    // Genuine blanking must still be recorded; changing scope selection must
    // not turn a missing intermediate frame into a successful final-only test.
    await page.locator('[data-hapi-session-view="replacement"]').evaluate(node => { (node as HTMLElement).hidden = true })
    await page.waitForFunction(() => !window.__hapiColdOpening.current?.latestVisible)
    await page.locator('[data-hapi-session-view="replacement"]').evaluate(node => { (node as HTMLElement).hidden = false })
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const recovered = await readColdOpeningProbe(page, true)
    expect(recovered.current?.ready).toBe(true)
    expect(coldOpeningIssues(recovered).some(row => row.startsWith('Latest source body disappeared'))).toBe(true)
})

test('opening sampler excludes transparent staging and never calls an inert predecessor ready', async ({ page }) => {
    await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail',
        staleText: 'Old native body', stableMs: 25 })
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
    expect(preparing.current?.editorVisible).toBe(true)
    expect(preparing.current?.editorUsable).toBe(false)
    expect(preparing.first.latest).toBeNull()
    expect(preparing.first.ready).toBeNull()
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
    expect(coldOpeningIssues(ready)).toEqual([])
})

test('opening sampler refreshes marker ranges when the same visible view is reparented', async ({ page }) => {
    await installColdOpeningProbe(page, { expectedTitle: 'Known native title', expectedText: 'Fresh native tail', stableMs: 25 })
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
