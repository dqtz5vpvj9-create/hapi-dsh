/**
 * Synthetic sampler controls for the complete-conversation observer.
 *
 * These are deliberately data: URLs and are NOT product acceptance. The real
 * official Host cases are in native-cold-opening.spec.ts and
 * complete-conversation-observer.spec.ts. Each test here names the sampler
 * mechanic it exercises and the required failure/recovery evidence.
 */
import { test, expect } from '@playwright/test'
import { installColdOpeningProbe, readColdOpeningProbe, coldOpeningIssues, exerciseOpeningDraft, exerciseOpeningReturnLatest, exerciseOpeningUnvisitedTarget } from './cold-opening-probe.ts'
import type { ColdOpeningOptions } from '../scripts/cold-opening-observer.mjs'
import { textInConversationViewport } from '../scripts/probe-navigation.mjs'

test.use({ screenshot: 'off' })
test.setTimeout(60_000)

const title = 'Known native title'
const latest = 'Fresh native tail'

function paneMarkup(options: { editorDisabled?: boolean; latestText?: string; returnLatest?: boolean; brokenReturn?: boolean } = {}): string {
    return `<main data-pane-id="pane-1" class="hapi-pane hapi-pane-focused" aria-label="Pane: ${title}" style="width:600px;height:600px;display:flex;flex-direction:column">
        <div data-hapi-session-view="view-1" style="min-height:0;display:flex;flex-direction:column">
            <nav aria-label="Turn navigation" style="height:44px;flex:0 0 auto">
                <button type="button" data-index="0" aria-label="Load and jump to turn 1">1</button>
                <button type="button" data-index="1" aria-label="Load and jump to turn 2">2</button>
                <button type="button" data-index="2" aria-label="Jump to turn 3" aria-current="true">3</button>
            </nav>
            <section data-conversation-scroll style="height:150px;overflow:auto;flex:1 1 auto">
                <div data-chat-flow>
                    <div><button type="button">Load older</button></div>
                    <article data-chat-node-key="latest" data-chat-anchor-key="latest" style="height:60px">${options.latestText ?? latest}</article>
                    <article data-chat-node-key="older-1" data-chat-anchor-key="older-1" style="height:90px">Older history body one</article>
                    <article data-chat-node-key="older-2" data-chat-anchor-key="older-2" style="height:90px">Older history body two</article>
                    <article data-chat-node-key="older-3" data-chat-anchor-key="older-3" style="height:90px">Older history body three</article>
                </div>
            </section>
            ${options.returnLatest || options.brokenReturn ? `<button type="button" aria-label="Back to bottom" style="height:28px"${options.brokenReturn ? '' : ` onclick="document.querySelector('[data-conversation-scroll]').scrollTop=0"`}>Back to bottom</button>` : ''}
            <div data-composer-input contenteditable="true" style="height:40px;flex:0 0 auto"${options.editorDisabled ? ' aria-disabled="true"' : ''}>Draft</div>
        </div>
    </main>`
}

async function open(page: import('@playwright/test').Page, options: Partial<ColdOpeningOptions>): Promise<void> {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, stableMs: 25, captureTitles: true,
        requiresHistory: false, requiresNavigation: false, fullCapabilities: false,
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
        ...options,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
}

for (const structured of [false, true]) {
    test(`text watermark outer-whitespace matches the complete paragraph through ${structured ? 'source marker' : 'legacy text'}`, async ({ page }) => {
        const padded = ` \n${latest}\n\t`
        await open(page, structured ? { expectedSourceTarget: { kind: 'text', text: padded } } : { expectedText: padded })
        expect((await readColdOpeningProbe(page)).current).toMatchObject({ latestAttached: true, latestVisible: true, ready: true })
        expect(await page.evaluate(text => window.__hapiColdOpening.sourceTargetVisible(text), padded)).toBe(true)
        expect(await page.evaluate(text => window.__hapiColdOpening.sourceTargetVisible({ kind: 'text', text }), padded)).toBe(true)
        expect(await textInConversationViewport(page.locator('main'), padded)).toBe(true)
        for (const wrong of ['Fresh  native tail', 'Fresh native stale', '**Fresh native tail**', ' \n\t']) {
            expect(await page.evaluate(text => window.__hapiColdOpening.sourceTargetVisible(text), wrong)).toBe(false)
            expect(await textInConversationViewport(page.locator('main'), wrong)).toBe(false)
        }
    })
}

test('text watermark outer-whitespace does not accept stale or wrong first body', async ({ page }) => {
    await installColdOpeningProbe(page, { expectedTitle: title, expectedText: ` \n${latest}\n`,
        staleText: ' \nStale native tail\n', expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup({ latestText: 'Stale native tail' }))}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.current).toMatchObject({ latestAttached: false, latestVisible: false, staleVisible: true, ready: false })
    expect(trace.first.full).toBeNull()
    expect(coldOpeningIssues(trace).some(issue => issue.startsWith('First visible target body did not match'))).toBe(true)
})

test('text watermark outer-whitespace stays consistent for pinned navigation and return latest targets', async ({ page }) => {
    await open(page, { expectedViewId: 'view-1' })
    await page.evaluate(() => {
        const port = document.querySelector('[data-conversation-scroll]')!
        document.querySelector('nav button')!.addEventListener('click', () => { port.scrollTop = port.scrollHeight })
        const button = document.createElement('button'); button.setAttribute('aria-label', 'Back to bottom')
        button.textContent = 'Latest'; button.onclick = () => { port.scrollTop = 0 }
        document.querySelector('[data-hapi-session-view]')!.append(button)
    })
    expect(await page.evaluate(() => window.__hapiColdOpening.setNavigationTarget(' \nOlder history body three\n'))).toBe(true)
    await page.locator('nav button').first().click()
    await page.waitForFunction(() => window.__hapiColdOpening.navigation.targetCommits === 1)
    expect(await page.evaluate(text => window.__hapiColdOpening.setReturnLatestTarget({ kind: 'text', text }), ` \n${latest}\n`)).toBe(true)
    await page.getByRole('button', { name: 'Back to bottom', exact: true }).click()
    await page.waitForFunction(() => window.__hapiColdOpening.navigation.returnLatestCommits === 1)
    expect((await readColdOpeningProbe(page, true)).navigation).toMatchObject({ targetCommitted: true, returnLatestCommitted: true })
})

test('text watermark outer-whitespace applies to initial return latest configuration', async ({ page }) => {
    await open(page, { expectedNavigationText: ` \n${latest}\n`, navigationAction: 'return-latest' })
    await page.evaluate(() => {
        const port = document.querySelector('[data-conversation-scroll]')!
        port.scrollTop = port.scrollHeight
        const button = document.createElement('button'); button.setAttribute('aria-label', 'Back to bottom')
        button.textContent = 'Latest'; button.onclick = () => { port.scrollTop = 0 }
        document.querySelector('[data-hapi-session-view]')!.append(button)
    })
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible === false)
    await page.getByRole('button', { name: 'Back to bottom', exact: true }).click()
    await page.waitForFunction(() => window.__hapiColdOpening.navigation.returnLatestCommits === 1)
    expect((await readColdOpeningProbe(page, true)).navigation.returnLatestCommitted).toBe(true)
})

test('painted partial exposure shorter than 100 ms is retained', async ({ page }) => {
    // Full capability mode, but history/navigation are not required for this
    // mechanic. The editor is painted inert for three frames, then enabled.
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, stableMs: 25, fullCapabilities: true, expectedViewId: 'view-1',
        requiresHistory: false, requiresNavigation: false, observeAfterReadyMs: 0, checkpointsMs: [],
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup({ editorDisabled: true }))}`)
    const windowMs = await page.evaluate(async () => {
        // Keep the inert editor painted for exactly three frames after the
        // observer records the first partial paint, then recover.
        for (;;) {
            if (window.__hapiColdOpening.first.partial !== null) break
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        }
        const started = performance.now()
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        document.querySelector('[data-composer-input]')!.removeAttribute('aria-disabled')
        return performance.now() - started
    })
    const firstPartial = await page.evaluate(() => window.__hapiColdOpening.first.partial)
    const partialState = await page.evaluate(() => window.__hapiColdOpening.states.find(row => row.partialExposure)?.partialExposure)
    expect(windowMs, 'the painted partial window must be shorter than 100 ms').toBeLessThan(100)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const trace = await readColdOpeningProbe(page, true)
    expect(firstPartial, 'the painted partial frame must be recorded before recovery').not.toBeNull()
    expect(partialState?.editorUsable).toBe(false)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Partial conversation exposed'))).toBe(true)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Editor became unusable'))).toBe(true)
})

test('a same-task prepaint assembly is not a partial frame', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, stableMs: 25, fullCapabilities: true, expectedViewId: 'view-1',
        requiresHistory: false, requiresNavigation: false, observeAfterReadyMs: 0, checkpointsMs: [],
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto('data:text/html,<main></main>')
    await page.evaluate(markup => {
        // One JS task: body, editor, history and rail are assembled before the
        // browser can paint. This is the React commit order the spec permits.
        document.querySelector('main')!.outerHTML = markup
    }, paneMarkup())
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.first.partial).toBeNull()
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Partial conversation exposed'))).toBe(false)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Visible session view did not match'))).toBe(false)
})

test('a wrong first session view is rejected before a later exact target appears', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup().replace('data-hapi-session-view="view-1"', 'data-hapi-session-view="other-view"'))}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible
        && window.__hapiColdOpening.current.viewMatches === false)
    await page.evaluate(() => document.querySelector('[data-hapi-session-view]')!.setAttribute('data-hapi-session-view', 'view-1'))
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    expect(coldOpeningIssues(await readColdOpeningProbe(page, true))
        .some(row => row.startsWith('Visible session view did not match'))).toBe(true)
})

test('a wrong first target body cannot be excused by a later correct body', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup({ latestText: 'Wrong generation body' }))}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    await page.evaluate(text => { document.querySelector('[data-chat-node-key="latest"]')!.textContent = text }, latest)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible
        && window.__hapiColdOpening.current.firstBodyWrong && !window.__hapiColdOpening.current.ready)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.states.some(row => row.firstBodyWrong)).toBe(true)
    expect(trace.first.stable).toBeNull()
    expect(coldOpeningIssues(trace).some(row => row.startsWith('First visible target body did not match'))).toBe(true)
})

test('a retained draft replaced by different nonempty text of the same length is rejected', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: true,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const editor = page.locator('[data-composer-input]')
    await page.evaluate(() => { document.querySelector('[data-composer-input]')!.textContent = '' })
    await editor.click()
    await page.keyboard.type('marker-one')
    await page.waitForTimeout(650)
    expect((await page.evaluate(() => window.__hapiColdOpening.input)).everRetained).toBe(true)
    await page.evaluate(() => { document.querySelector('[data-composer-input]')!.textContent = 'marker-two' })
    await page.waitForTimeout(150)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.states.some(row => row.draftReplaced)).toBe(true)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Unsent editor draft changed without trusted input'))).toBe(true)
})

test('an async focus/editor identity change is rejected', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    await page.locator('[data-composer-input]').click()
    await page.evaluate(() => {
        const editor = document.querySelector('[data-composer-input]')!
        setTimeout(() => {
            const replacement = editor.cloneNode(true) as HTMLElement
            editor.replaceWith(replacement)
            replacement.focus()
        }, 100)
    })
    await page.waitForTimeout(350)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.states.some(row => row.editorIdentityChanged)).toBe(true)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Editor identity changed'))).toBe(true)
})

test('a pure DOM prepend without a source request is not a history commit', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: true, requiresNavigation: false,
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: true, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const port = page.locator('[data-conversation-scroll]')
    const box = (await port.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4)
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(100)
    await page.evaluate(() => {
        const row = document.createElement('article')
        row.dataset.chatNodeKey = 'pure-prepend'
        row.dataset.chatAnchorKey = 'pure-prepend'
        row.textContent = 'Pure DOM prepend with no source page request'
        document.querySelector('[data-chat-flow]')!.prepend(row)
    })
    await page.waitForTimeout(5_300)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.history.domPrependRevision).toBeGreaterThan(0)
    expect(trace.history.requestRevision).toBe(0)
    expect(trace.history.commitRevision).toBe(0)
    const failures = coldOpeningIssues(trace)
    expect(failures.some(row => row.startsWith('Trusted history paging did not issue a source page request'))).toBe(true)
    expect(failures.some(row => row.startsWith('Source page request did not commit'))).toBe(false)
})

test('return-latest is a distinct mobile action and must commit the latest marker', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        expectedNavigationText: latest, navigationAction: 'return-latest',
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: true,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup({ returnLatest: true }))}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const port = page.locator('[data-conversation-scroll]')
    const box = (await port.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4)
    await page.mouse.wheel(0, 180)
    await page.waitForFunction(() => !window.__hapiColdOpening.current?.latestVisible)
    await page.getByRole('button', { name: 'Back to bottom' }).click()
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible)
    await page.waitForTimeout(100)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.navigation.action).toBe('return-latest')
    expect(trace.navigation.returnLatestIntents).toBeGreaterThan(0)
    expect(trace.navigation.commitRevision).toBeGreaterThan(0)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Return-latest'))).toBe(false)
})

test('return-latest without a commit is rejected even though navigationRequired is false', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        expectedNavigationText: latest, navigationAction: 'return-latest',
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: true,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup({ brokenReturn: true }))}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const port = page.locator('[data-conversation-scroll]')
    const box = (await port.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4)
    await page.mouse.wheel(0, 180)
    await page.waitForFunction(() => !window.__hapiColdOpening.current?.latestVisible)
    await page.getByRole('button', { name: 'Back to bottom' }).click()
    await page.waitForTimeout(5_300)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.navigation.required).toBe(false)
    expect(trace.navigation.returnLatestIntents).toBeGreaterThan(0)
    expect(trace.navigation.commitRevision).toBe(0)
    const failures = coldOpeningIssues(trace)
    expect(failures.some(row => row.startsWith('Return-latest action did not commit'))).toBe(true)
    expect(failures.some(row => row.startsWith('Return-latest action did not expose'))).toBe(true)
})

test('a live update just before the window extends observation and a later failure is retained', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        observeAfterReadyMs: 200, failureDeadlineMs: 800, checkpointsMs: [],
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    await page.waitForTimeout(150)
    await page.evaluate(() => {
        const row = document.createElement('article')
        row.dataset.chatNodeKey = 'late-live'
        row.dataset.chatAnchorKey = 'late-live'
        row.textContent = 'Live near the original window edge'
        document.querySelector('[data-chat-flow]')!.append(row)
    })
    await page.waitForTimeout(100)
    await page.evaluate(async () => {
        const editor = document.querySelector('[data-composer-input]')!
        editor.setAttribute('aria-disabled', 'true')
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        editor.removeAttribute('aria-disabled')
    })
    await page.waitForFunction(() => window.__hapiColdOpening.observation.complete, null, { timeout: 2_000 })
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.observation.complete).toBe(true)
    expect(trace.observation.deadlineMissed).toBe(false)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Editor became unusable'))).toBe(true)
})

test('continuous live updates beyond the deadline leave observation incomplete', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        observeAfterReadyMs: 200, failureDeadlineMs: 500, checkpointsMs: [],
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    for (let index = 0; index < 6; index++) {
        await page.waitForTimeout(100)
        await page.evaluate(index => {
            const row = document.createElement('article')
            row.dataset.chatNodeKey = `continuous-live-${index}`
            row.dataset.chatAnchorKey = `continuous-live-${index}`
            row.textContent = `Continuous live update ${index}`
            document.querySelector('[data-chat-flow]')!.append(row)
        }, index)
    }
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.observation.complete).toBe(false)
    expect(trace.observation.deadlineMissed).toBe(true)
    const failures = coldOpeningIssues(trace)
    expect(failures.some(row => row.startsWith('Observation window did not complete'))).toBe(true)
    expect(failures.some(row => row.startsWith('Opening or observation exceeded'))).toBe(true)
})

test('nonempty body replacement without staleText fails; a live append is accepted', async ({ page }) => {
    await open(page, { fullCapabilities: false })
    // A normal live append at the tail keeps the old marker attached.
    await page.evaluate(() => {
        const row = document.createElement('article')
        row.dataset.chatNodeKey = 'live'
        row.dataset.chatAnchorKey = 'live'
        row.style.height = '90px'
        row.textContent = 'Live follow-up from the source'
        document.querySelector('[data-chat-flow]')!.append(row)
    })
    await page.waitForTimeout(150)
    const appended = await readColdOpeningProbe(page)
    expect(coldOpeningIssues(appended).some(row => row.startsWith('Nonempty body'))).toBe(false)
    expect(coldOpeningIssues(appended).some(row => row.startsWith('Latest source body left'))).toBe(false)
    // An unprompted nonempty replacement must fail even though no staleText was
    // supplied and the editor/scroll root stayed the same.
    await page.evaluate(() => {
        const row = document.querySelector('[data-chat-node-key="latest"]')!
        row.textContent = 'Different nonempty body from another generation'
    })
    await page.waitForTimeout(150)
    const replaced = await readColdOpeningProbe(page, true)
    expect(coldOpeningIssues(replaced).some(row => row.startsWith('Nonempty body was replaced'))).toBe(true)
})

test('broken paging is rejected by the trusted history gesture evidence', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, stableMs: 25, fullCapabilities: true, expectedViewId: 'view-1',
        requiresHistory: true, requiresNavigation: false, observeAfterReadyMs: 0, checkpointsMs: [],
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: true, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const port = page.locator('[data-conversation-scroll]')
    const box = (await port.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4)
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(5_300)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.history.intents).toBeGreaterThan(0)
    expect(trace.history.commitRevision).toBe(0)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Trusted history paging did not issue a source page request'))).toBe(true)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Trusted history paging gesture produced no older-page commit'))).toBe(true)
})

test('decorative rail navigation is rejected by the target commit evidence', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedNavigationText: 'A target only present after navigation',
        stableMs: 25, fullCapabilities: true, expectedViewId: 'view-1', requiresHistory: false, requiresNavigation: true,
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false, requireLiveUpdate: false,
        requireHistoryAction: false, requireNavigationAction: true,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    await page.locator('nav[aria-label] button').nth(1).click()
    await page.waitForTimeout(5_300)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.navigation.intents).toBeGreaterThan(0)
    expect(trace.navigation.commitRevision).toBe(0)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Trusted navigation intent produced no target commit'))).toBe(true)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Trusted reading navigation did not commit'))).toBe(true)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Unvisited navigation target did not commit'))).toBe(true)
})

test('an editor that accepts focus but ignores input is rejected', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, stableMs: 25, fullCapabilities: true, expectedViewId: 'view-1',
        requiresHistory: false, requiresNavigation: false, observeAfterReadyMs: 0, checkpointsMs: [],
        requireEditorInput: true, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    await page.evaluate(() => {
        document.querySelector('[data-composer-input]')!.addEventListener('beforeinput', event => event.preventDefault())
    })
    const editor = page.locator('[data-composer-input]')
    await editor.click()
    await page.keyboard.type('ignored draft')
    await page.waitForTimeout(2_300)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.input.printableKeys).toBeGreaterThan(0)
    expect(trace.input.textRevision).toBe(0)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Editor accepted focus but ignored input'))).toBe(true)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('No retained unsent draft'))).toBe(true)
})


test('an unsent draft cleared without trusted input is rejected', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, stableMs: 25, fullCapabilities: true, expectedViewId: 'view-1',
        requiresHistory: false, requiresNavigation: false, observeAfterReadyMs: 0, checkpointsMs: [],
        requireEditorInput: true, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const editor = page.locator('[data-composer-input]')
    await editor.click()
    await page.keyboard.type('retained draft')
    await page.waitForTimeout(650)
    expect((await page.evaluate(() => window.__hapiColdOpening.input)).everRetained).toBe(true)
    // No trusted key clears it. A product that drops the unsent draft during a
    // background handoff must not be accepted.
    await page.evaluate(() => { document.querySelector('[data-composer-input]')!.textContent = '' })
    await page.waitForTimeout(150)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.input.everRetained).toBe(true)
    expect(coldOpeningIssues(trace).some(row => row.startsWith('Unsent editor draft was not retained'))).toBe(true)
})

test('6 s and 20 s failures followed by recovery remain in the final issue list', async ({ page }) => {
    test.setTimeout(90_000)
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, stableMs: 25, fullCapabilities: true, expectedViewId: 'view-1',
        requiresHistory: false, requiresNavigation: false, observeAfterReadyMs: 22_000,
        checkpointsMs: [6_000, 20_000], failureDeadlineMs: 60_000,
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    await page.waitForTimeout(6_000)
    await page.evaluate(async () => {
        const editor = document.querySelector('[data-composer-input]')!
        editor.setAttribute('aria-disabled', 'true')
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        editor.removeAttribute('aria-disabled')
    })
    await page.waitForTimeout(13_500)
    await page.evaluate(() => {
        const row = document.querySelector('[data-chat-node-key="latest"]')!
        ;(window as unknown as { __replacedText: string | null }).__replacedText = row.textContent
        row.textContent = 'Nonempty replacement at twenty seconds'
    })
    await page.waitForTimeout(200)
    await page.evaluate(() => {
        const row = document.querySelector('[data-chat-node-key="latest"]')!
        row.textContent = (window as unknown as { __replacedText: string | null }).__replacedText
    })
    await page.waitForFunction(() => window.__hapiColdOpening.observation.complete, null, { timeout: 45_000 })
    const trace = await readColdOpeningProbe(page, true)
    const names = trace.observation.checkpoints.map(row => row.name)
    expect(names).toContain('t+6000')
    expect(names).toContain('t+20000')
    expect(trace.current?.ready).toBe(true)
    const failures = coldOpeningIssues(trace)
    expect(failures.some(row => row.startsWith('Editor became unusable'))).toBe(true)
    expect(failures.some(row => row.startsWith('Nonempty body was replaced'))).toBe(true)
})


test('draft action preserves existing text and refuses multiple official editors', async ({ page }) => {
    await open(page, { fullCapabilities: false })
    const pane = page.locator('.hapi-pane-focused')
    const existing = await exerciseOpeningDraft(page, pane, 'probe marker')
    expect(existing.accepted).toBe(false)
    expect(existing.failure).toContain('Existing nonempty draft')
    await expect(pane.locator('[data-composer-input]')).toHaveText('Draft')
    await page.evaluate(() => {
        const editor = document.querySelector('[data-composer-input]')!
        editor.textContent = ''
        editor.after(editor.cloneNode(true))
    })
    const ambiguous = await exerciseOpeningDraft(page, pane, 'probe marker')
    expect(ambiguous.accepted).toBe(false)
    expect(ambiguous.failure).toContain('exactly one')
    await expect(pane.locator('[data-composer-input]')).toHaveText(['', ''])
})

async function openHistoryControl(page: import('@playwright/test').Page): Promise<void> {
    await open(page, { expectedViewId: 'view-1', fullCapabilities: true, requiresHistory: true, requireHistoryAction: true })
    await page.locator('[data-conversation-scroll]').evaluate(port => { (port as HTMLElement).style.overflowAnchor = 'none' })
    const box = (await page.locator('[data-conversation-scroll]').boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await page.mouse.wheel(0, -120)
    await page.waitForFunction(() => window.__hapiColdOpening.history.intents > 0)
}

async function historyEvent(page: import('@playwright/test').Page, type: string, overrides: Record<string, unknown> = {}): Promise<void> {
    await page.evaluate(({ type, overrides }) => {
        window.dispatchEvent(new CustomEvent('hapi-dsh:seamless-history', { detail: {
            type, paneId: 'pane-1', sessionId: 'view-1', identity: 'host/view-1', detail: null, ...overrides,
        } }))
    }, { type, overrides })
}

async function commitHistoryControl(page: import('@playwright/test').Page, options: { drift?: number; nextRequest?: boolean } = {}): Promise<void> {
    await page.evaluate(({ drift, nextRequest }) => {
        const port = document.querySelector<HTMLElement>('[data-conversation-scroll]')!
        const flow = document.querySelector('[data-chat-flow]')!
        const row = document.createElement('article')
        row.dataset.chatNodeKey = `page-${window.__hapiColdOpening.history.operationRevision}`
        row.dataset.chatAnchorKey = row.dataset.chatNodeKey
        row.style.height = '80px'
        row.textContent = 'Synthetic older source page'
        flow.insertBefore(row, flow.querySelector('article'))
        port.scrollTop += 80 + (drift ?? 0)
        const emit = (type: string) => window.dispatchEvent(new CustomEvent('hapi-dsh:seamless-history', { detail: {
            type, paneId: 'pane-1', sessionId: 'view-1', identity: 'host/view-1', detail: null,
        } }))
        emit('committed')
        if (nextRequest) emit('requested')
    }, options)
}

test('history operations keep the first commit paired when the next request starts before sampling', async ({ page }) => {
    await openHistoryControl(page)
    await historyEvent(page, 'requested')
    await commitHistoryControl(page, { nextRequest: true })
    const pending = await readColdOpeningProbe(page)
    expect(pending.history.operations.map(operation => operation.status)).toEqual(['committed', 'pending'])
    expect(coldOpeningIssues(pending)).toContain('Source page request did not commit a source page')
    expect(coldOpeningIssues(pending)).not.toContain('Source page commit predates its request')
    await commitHistoryControl(page)
    const complete = await readColdOpeningProbe(page, true)
    expect(complete.history.operations.map(operation => operation.status)).toEqual(['committed', 'committed'])
    expect(complete.history.operations.every(operation => operation.anchorRetained && Math.abs(operation.anchorDriftPx!) <= 2)).toBe(true)
    expect(complete.history.violations).toEqual([])
    expect(coldOpeningIssues(complete).filter(issue => /Source page|Older-page/.test(issue))).toEqual([])
})

test('continued trusted scrolling is excluded from the page commit anchor error', async ({ page }) => {
    await openHistoryControl(page)
    await historyEvent(page, 'requested')
    await page.mouse.wheel(0, 85)
    await page.waitForFunction(() => document.querySelector('[data-conversation-scroll]')!.scrollTop > 60)
    await commitHistoryControl(page)
    const trace = await readColdOpeningProbe(page, true)
    const operation = trace.history.operations[0]!
    expect(operation.anchorAt!).toBeGreaterThan(operation.requestAt)
    expect(operation.anchorRetained).toBe(true)
    expect(Math.abs(operation.anchorDriftPx!)).toBeLessThanOrEqual(2)
    expect(trace.history.violations).toEqual([])
})

test('an independently measured anchor jump beyond 2 px remains a failure', async ({ page }) => {
    await openHistoryControl(page)
    await historyEvent(page, 'requested')
    await commitHistoryControl(page, { drift: 12 })
    const trace = await readColdOpeningProbe(page, true)
    expect(Math.abs(trace.history.operations[0]!.anchorDriftPx!)).toBeGreaterThan(2)
    expect(coldOpeningIssues(trace).some(issue => issue.startsWith('Older-page commit drifted'))).toBe(true)
})

test('a source commit without a request is rejected even after an independent DOM prepend', async ({ page }) => {
    await openHistoryControl(page)
    await commitHistoryControl(page)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.history.requestRevision).toBe(0)
    expect(trace.history.commitRevision).toBe(0)
    expect(coldOpeningIssues(trace)).toContain('Source page commit had no matching request in its pane/session/identity')
})

test('a source request and commit without a DOM prepend cannot prove history', async ({ page }) => {
    await openHistoryControl(page)
    await historyEvent(page, 'requested')
    await historyEvent(page, 'committed')
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.history.operations[0]!.domPrepend).toBe(false)
    expect(trace.history.operations[0]!.domAt).toBeNull()
    expect(trace.history.operations[0]!.anchorAt).toBeNull()
    expect(coldOpeningIssues(trace)).toContain('Source page commit had no independently observed DOM prepend')
})

async function hiddenHistorySentinel(page: import('@playwright/test').Page): Promise<void> {
    await page.evaluate(() => {
        const sentinel = document.createElement('div')
        sentinel.dataset.chatAnchorKey = 'hidden-process-control'
        sentinel.setAttribute('hidden', 'until-found')
        const nested = document.createElement('div')
        nested.dataset.chatNodeKey = 'hidden-process-member'
        nested.textContent = 'Hidden process member'
        sentinel.append(nested)
        const flow = document.querySelector('[data-chat-flow]')!
        flow.insertBefore(sentinel, flow.querySelector('article'))
    })
}

test('visible history group prepend succeeds past an unchanged hidden process sentinel', async ({ page }) => {
    await openHistoryControl(page)
    await hiddenHistorySentinel(page)
    await historyEvent(page, 'requested')
    await page.evaluate(() => {
        const flow = document.querySelector('[data-chat-flow]')!
        const group = document.createElement('div')
        group.dataset.chatGroupKey = 'older-process-group'
        group.dataset.chatAnchorKey = 'group:older-process-group'
        group.dataset.stepProcess = 'true'
        group.style.height = '80px'
        const heading = document.createElement('button')
        heading.type = 'button'; heading.textContent = 'Older source process'
        group.append(heading)
        flow.insertBefore(group, flow.querySelector('article'))
        document.querySelector<HTMLElement>('[data-conversation-scroll]')!.scrollTop += 80
        window.dispatchEvent(new CustomEvent('hapi-dsh:seamless-history', { detail: {
            type: 'committed', paneId: 'pane-1', sessionId: 'view-1', identity: 'host/view-1', detail: null,
        } }))
    })
    const trace = await readColdOpeningProbe(page, true)
    expect(await page.locator('[data-chat-anchor-key]').first().getAttribute('data-chat-anchor-key')).toBe('hidden-process-control')
    expect(trace.history.operations[0]).toMatchObject({ domPrepend: true, anchorRetained: true })
    expect(Math.abs(trace.history.operations[0]!.anchorDriftPx!)).toBeLessThanOrEqual(2)
    expect(trace.history.violations).toEqual([])
})

for (const kind of ['append', 'hidden-only growth'] as const) test(`history ${kind} preserves diagnostics but cannot prove a visible prepend`, async ({ page }) => {
    await openHistoryControl(page)
    await hiddenHistorySentinel(page)
    await historyEvent(page, 'requested')
    await page.evaluate(kind => {
        const flow = document.querySelector('[data-chat-flow]')!
        const row = document.createElement('article')
        row.dataset.chatNodeKey = 'not-a-visible-prepend'
        row.dataset.chatAnchorKey = 'not-a-visible-prepend'
        row.textContent = 'Source change without an older visible head'
        row.style.height = '80px'
        if (kind === 'append') flow.append(row)
        else {
            row.setAttribute('hidden', '')
            flow.insertBefore(row, flow.querySelector('[data-chat-anchor-key]'))
        }
        window.dispatchEvent(new CustomEvent('hapi-dsh:seamless-history', { detail: {
            type: 'committed', paneId: 'pane-1', sessionId: 'view-1', identity: 'host/view-1', detail: null,
        } }))
    }, kind)
    const trace = await readColdOpeningProbe(page, true), operation = trace.history.operations[0]!
    expect(operation.domPrepend).toBe(false)
    expect(operation.domAt).not.toBeNull()
    expect(operation.anchorAt).not.toBeNull()
    expect(operation.anchorRetained).toBe(true)
    expect(Math.abs(operation.anchorDriftPx!)).toBeLessThanOrEqual(2)
    expect(coldOpeningIssues(trace)).toContain('Source page commit had no independently observed DOM prepend')
    expect(coldOpeningIssues(trace)).not.toContain('Older-page commit did not measure a retained reading anchor')
})

test('discarded non-prepend DOM samples remain diagnostic evidence after mutation delivery', async ({ page }) => {
    await openHistoryControl(page)
    await historyEvent(page, 'requested')
    await page.evaluate(async () => {
        const row = document.createElement('article')
        row.dataset.chatAnchorKey = 'later-tail'
        row.textContent = 'Later source tail'
        document.querySelector('[data-chat-flow]')!.append(row)
        await new Promise(resolve => setTimeout(resolve, 0))
        window.dispatchEvent(new CustomEvent('hapi-dsh:seamless-history', { detail: {
            type: 'committed', paneId: 'pane-1', sessionId: 'view-1', identity: 'host/view-1', detail: null,
        } }))
    })
    const trace = await readColdOpeningProbe(page, true), operation = trace.history.operations[0]!
    expect(operation).toMatchObject({ domPrepend: false, domProbeDiscarded: true, anchorRetained: null, anchorDriftPx: null })
    expect(operation.domAt).not.toBeNull()
    expect(operation.anchorAt).not.toBeNull()
    expect(operation.anchorOffset).not.toBeNull()
    expect(coldOpeningIssues(trace)).toContain('Source page commit had no independently observed DOM prepend')
    expect(coldOpeningIssues(trace)).toContain('Older-page commit did not measure a retained reading anchor')
})

test('duplicate requests remain ambiguous and cannot be paired with one later commit', async ({ page }) => {
    await openHistoryControl(page)
    await historyEvent(page, 'requested')
    await historyEvent(page, 'requested')
    await commitHistoryControl(page)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.history.commitRevision).toBe(0)
    expect(trace.history.operations[0]!.status).toBe('ambiguous')
    expect(coldOpeningIssues(trace)).toContain('Source page request overlapped an unresolved request; correlation is ambiguous')
})

for (const mismatch of [{ paneId: 'pane-2' }, { sessionId: 'view-2' }, { identity: 'host/another-source' }]) {
    test(`a commit with the wrong ${Object.keys(mismatch)[0]} cannot complete this pane's request`, async ({ page }) => {
        await openHistoryControl(page)
        await historyEvent(page, 'requested')
        await historyEvent(page, 'committed', mismatch)
        const trace = await readColdOpeningProbe(page, true)
        expect(trace.history.commitRevision).toBe(0)
        expect(trace.history.operations[0]!.status).toBe('pending')
        expect(coldOpeningIssues(trace)).toContain('Source page request did not commit a source page')
    })
}

test('resource timing does not duplicate a controller request or supply a missing source request', async ({ page }) => {
    await page.route('https://observer.invalid/**', route => route.fulfill({ status: 200, body: '{}',
        headers: { 'access-control-allow-origin': '*' } }))
    await openHistoryControl(page)
    const resource = () => page.evaluate(async () => {
        await fetch('https://observer.invalid/session/page?sessionId=view-1&beforeSeq=20')
    })
    await resource()
    await page.waitForFunction(() => window.__hapiColdOpening.history.networkOlder > 0)
    expect((await readColdOpeningProbe(page)).history.requestRevision).toBe(0)
    await historyEvent(page, 'requested')
    await resource()
    await page.waitForFunction(() => window.__hapiColdOpening.history.networkOlder > 1)
    await commitHistoryControl(page)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.history.requestRevision).toBe(1)
    expect(trace.history.commitRevision).toBe(1)
    expect(trace.history.violations).toEqual([])
})


test("another pane cannot supply the target pane's trusted history intent or controller request", async ({ page }) => {
    await open(page, { expectedViewId: 'view-1', fullCapabilities: true, requiresHistory: true, requireHistoryAction: true })
    await page.evaluate(() => {
        const other = document.querySelector<HTMLElement>('[data-pane-id="pane-1"]')!.cloneNode(true) as HTMLElement
        other.dataset.paneId = 'pane-2'
        other.classList.remove('hapi-pane-focused')
        other.style.cssText += ';position:absolute;top:0;left:650px;'
        other.querySelector<HTMLElement>('[data-hapi-session-view]')!.dataset.hapiSessionView = 'view-2'
        document.body.append(other)
    })
    const box = (await page.locator('[data-pane-id="pane-2"] [data-conversation-scroll]').boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await page.mouse.wheel(0, -120)
    await historyEvent(page, 'requested', { paneId: 'pane-2', sessionId: 'view-2' })
    await historyEvent(page, 'committed', { paneId: 'pane-2', sessionId: 'view-2' })
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.history.intents).toBe(0)
    expect(trace.history.requestRevision).toBe(0)
    expect(trace.history.commitRevision).toBe(0)
})

test('a commit without controller identity cannot complete a pending page', async ({ page }) => {
    await openHistoryControl(page)
    await historyEvent(page, 'requested')
    await historyEvent(page, 'committed', { identity: null })
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.history.commitRevision).toBe(0)
    expect(trace.history.operations[0]!.status).toBe('pending')
    expect(coldOpeningIssues(trace)).toContain('Source page event had no exact controller identity')
})


test('pending body changes are sampled before declaring the quiet observation window complete', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        bodySampleMs: 1_000, observeAfterReadyMs: 200, failureDeadlineMs: 2_000, checkpointsMs: [],
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.first.full !== null)
    const appendedAt = await page.evaluate(() => {
        const row = document.createElement('article')
        row.dataset.chatNodeKey = 'pending-at-quiet-boundary'
        row.dataset.chatAnchorKey = row.dataset.chatNodeKey
        row.textContent = 'Source append before the body sampling interval'
        document.querySelector('[data-chat-flow]')!.append(row)
        return performance.now()
    })
    await page.waitForFunction(() => window.__hapiColdOpening.observation.complete)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.observation.lastSyncActivityAt!).toBeGreaterThanOrEqual(appendedAt)
    expect(trace.observation.completeAt! - trace.observation.lastSyncActivityAt!).toBeGreaterThanOrEqual(200)
    expect(trace.observation.deadlineMissed).toBe(false)
})

test('source activity after a completed quiet interval requires a new full interval', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        bodySampleMs: 16, observeAfterReadyMs: 200, failureDeadlineMs: 2_000, checkpointsMs: [],
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.observation.complete)
    const priorCompleteAt = (await readColdOpeningProbe(page)).observation.completeAt!
    await page.evaluate(() => {
        const row = document.createElement('article')
        row.dataset.chatNodeKey = 'after-quiet-interval'
        row.dataset.chatAnchorKey = row.dataset.chatNodeKey
        row.textContent = 'Source append after the first quiet interval'
        document.querySelector('[data-chat-flow]')!.append(row)
    })
    await page.waitForFunction(() => !window.__hapiColdOpening.observation.complete)
    await page.waitForFunction(() => window.__hapiColdOpening.observation.complete)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.observation.completeAt!).toBeGreaterThan(priorCompleteAt)
    expect(trace.observation.completeAt! - trace.observation.lastSyncActivityAt!).toBeGreaterThanOrEqual(200)
    expect(trace.observation.deadlineMissed).toBe(false)
})


test('return-latest helper accepts an attached marker outside the scrollport and requires its visible return', async ({ page }) => {
    await installColdOpeningProbe(page, {
        expectedTitle: title, expectedText: latest, expectedViewId: 'view-1', stableMs: 25,
        fullCapabilities: true, requiresHistory: false, requiresNavigation: false,
        expectedNavigationText: latest, navigationAction: 'return-latest',
        observeAfterReadyMs: 0, checkpointsMs: [], requireEditorInput: false,
        requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: true,
    })
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup({ returnLatest: true }))}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready)
    const pane = page.locator('[data-pane-id="pane-1"]')
    const port = pane.locator('[data-conversation-scroll]')
    const box = (await port.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4)
    await page.mouse.wheel(0, 180)
    await page.waitForFunction(() => !window.__hapiColdOpening.current?.latestVisible)
    expect(await pane.getByText(latest, { exact: true }).isVisible()).toBe(true)
    const result = await exerciseOpeningReturnLatest(page, pane, latest)
    expect(result).toMatchObject({ attempted: true, committed: true, targetVisible: true, failure: null })
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.navigation.commitRevision).toBeGreaterThan(0)
})

for (const present of [true, false]) {
    test(`virtualized rail helper ${present ? 'scrolls to the exact unmounted target' : 'rejects an absent exact target without clicking another turn'}`, async ({ page }) => {
        const targetText = 'Exact virtual rail target'
        await open(page, { expectedNavigationText: targetText, expectedViewId: 'view-1', navigationAction: 'unvisited-target' })
        await page.evaluate(({ targetText }) => {
            const rail = document.querySelector('nav')!
            rail.style.cssText = 'height:120px;flex:0 0 120px;position:relative'
            rail.innerHTML = '<div style="height:120px;width:100px;overflow-y:auto"><div style="height:1200px;position:relative"></div></div>'
            const scroll = rail.firstElementChild as HTMLElement
            const content = scroll.firstElementChild as HTMLElement
            Reflect.set(window, '__virtualRail', { wheels: 0, clicks: [] as number[] })
            scroll.addEventListener('wheel', event => { if (event.isTrusted) Reflect.get(window, '__virtualRail').wheels++ })
            const render = () => {
                const first = Math.max(1, Math.floor(scroll.scrollTop / 20))
                content.replaceChildren()
                for (let turn = first; turn <= Math.min(60, first + 8); turn++) {
                    const button = document.createElement('button')
                    button.setAttribute('aria-label', `Load and jump to turn ${turn}`)
                    button.style.cssText = `position:absolute;top:${(turn - 1) * 20}px;height:20px;width:90px`
                    button.textContent = String(turn)
                    button.onclick = event => {
                        if (event.isTrusted) Reflect.get(window, '__virtualRail').clicks.push(turn)
                        const row = document.createElement('article')
                        row.dataset.chatNodeKey = 'virtual-target'
                        row.textContent = targetText
                        document.querySelector('[data-chat-flow]')!.prepend(row)
                        document.querySelector('[data-conversation-scroll]')!.scrollTop = 0
                    }
                    content.append(button)
                }
            }
            scroll.addEventListener('scroll', render)
            scroll.scrollTop = 900
            render()
        }, { targetText })
        const pane = page.locator('[data-pane-id="pane-1"]')
        const result = await exerciseOpeningUnvisitedTarget(page, pane, targetText, present ? 3 : 500)
        const actions = await page.evaluate(() => Reflect.get(window, '__virtualRail'))
        expect(actions.wheels).toBeGreaterThan(0)
        if (present) {
            expect(result.failure).toBeNull()
            expect(result.committed).toBe(true)
            expect(result.targetVisible).toBe(true)
            expect(actions.clicks).toEqual([3])
        } else {
            expect(result.attempted).toBe(false)
            expect(result.committed).toBe(false)
            expect(result.failure).toContain('500')
            expect(actions.clicks).toEqual([])
        }
    })
}

test('native touch momentum is reader-owned, but a later programmatic jump still fails', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 600, height: 700 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    try {
        await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
            const meta = document.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width,initial-scale=1'
            document.head.append(meta)
        }))
        await open(page, { expectedViewId: 'view-1' })
        await page.evaluate(() => {
            const row = document.querySelector<HTMLElement>('[data-chat-node-key="latest"]')!
            row.style.cssText = 'height:180px;padding-top:30px;box-sizing:border-box'
            for (const sibling of document.querySelectorAll<HTMLElement>('[data-chat-node-key^="older"]')) sibling.style.height = '300px'
            const port = document.querySelector<HTMLElement>('[data-conversation-scroll]')!
            port.style.cssText = 'height:280px;overflow:auto;flex:0 0 280px'
            Reflect.set(window, '__touchMotion', { ended: false, topAtEnd: 0, topAtScrollEnd: 0, visibleAtEnd: false })
            port.addEventListener('touchend', () => {
                const state = Reflect.get(window, '__touchMotion'); state.ended = true; state.topAtEnd = port.scrollTop
                state.visibleAtEnd = window.__hapiColdOpening.current?.latestVisible
            })
            port.addEventListener('scrollend', () => { Reflect.get(window, '__touchMotion').topAtScrollEnd = port.scrollTop })
        })
        await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible)
        const port = page.locator('[data-conversation-scroll]')
        const box = (await port.boundingBox())!
        const cdp = await context.newCDPSession(page)
        const points = (y: number) => [{ x: box.x + box.width / 2, y, id: 1 }]
        const start = box.y + box.height * 0.8
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) })
        for (let step = 1; step <= 4; step++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(start - step * 18) })
            await page.waitForTimeout(12)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForFunction(() => {
            const state = Reflect.get(window, '__touchMotion')
            return state.ended && state.topAtScrollEnd > state.topAtEnd + 5
        })
        const motion = await page.evaluate(() => Reflect.get(window, '__touchMotion'))
        expect(motion.visibleAtEnd, JSON.stringify(motion)).toBe(true)
        await expect.poll(() => page.evaluate(() => window.__hapiColdOpening.current?.latestVisible),
            { timeout: 3_000, message: JSON.stringify(motion) }).toBe(false)
        expect(coldOpeningIssues(await readColdOpeningProbe(page)).some(issue => issue.startsWith('Latest source body left'))).toBe(false)
        await port.evaluate(element => { element.scrollTop = 0 })
        await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible)
        await port.evaluate(element => { element.scrollTop = 350 })
        await page.waitForFunction(() => window.__hapiColdOpening.states.some(row => row.latestOffscreenUnprompted))
        expect(coldOpeningIssues(await readColdOpeningProbe(page, true)).some(issue => issue.startsWith('Latest source body left'))).toBe(true)
        await cdp.detach()
    } finally { await context.close() }
})

test('a programmatic jump from scrollend cannot reuse native motion', async ({ page }) => {
    await open(page, { expectedViewId: 'view-1' })
    await page.evaluate(() => {
        const port = document.querySelector<HTMLElement>('[data-conversation-scroll]')!
        port.style.cssText = 'height:280px;overflow:auto;flex:0 0 280px'
        document.querySelector<HTMLElement>('[data-chat-node-key="latest"]')!.style.cssText = 'height:180px;padding-top:100px;box-sizing:border-box'
        for (const sibling of document.querySelectorAll<HTMLElement>('[data-chat-node-key^="older"]')) sibling.style.height = '300px'
        port.addEventListener('scrollend', () => {
            Reflect.set(window, '__nativeScrollEndTop', port.scrollTop)
            port.scrollTop = 350
        }, { once: true })
    })
    const box = (await page.locator('[data-conversation-scroll]').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 30)
    await page.waitForFunction(() => window.__hapiColdOpening.states.some(row => row.latestOffscreenUnprompted))
    expect(await page.evaluate(() => Reflect.get(window, '__nativeScrollEndTop'))).toBe(30)
    expect(coldOpeningIssues(await readColdOpeningProbe(page, true)).some(issue => issue.startsWith('Latest source body left'))).toBe(true)
})

test('upward native wheel departure is attributed once across later gestures and scrollend', async ({ page }) => {
    await open(page, { expectedViewId: 'view-1' })
    await page.evaluate(() => {
        const port = document.querySelector<HTMLElement>('[data-conversation-scroll]')!
        port.style.cssText = 'height:280px;overflow:auto;flex:0 0 280px'
        const row = document.querySelector<HTMLElement>('[data-chat-node-key="latest"]')!
        row.style.cssText = 'height:180px;padding-top:80px;box-sizing:border-box'
        for (const sibling of document.querySelectorAll<HTMLElement>('[data-chat-node-key^="older"]')) sibling.style.height = '600px'
        row.parentElement!.append(row)
        port.scrollTop = port.scrollHeight
    })
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible)
    const box = (await page.locator('[data-conversation-scroll]').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -240)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible === false)
    for (let step = 0; step < 3; step++) {
        await page.mouse.wheel(0, -60)
        await page.waitForTimeout(40)
    }
    await page.waitForFunction(() => window.__hapiColdOpening.reader.motion?.at(-1)?.phase === 'scrollend')
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.reader.departures, JSON.stringify(trace.reader)).toEqual([
        expect.objectContaining({ kind: 'offscreen', intended: true }),
    ])
    expect(coldOpeningIssues(trace).some(issue => issue.startsWith('Latest source body left'))).toBe(false)
})

test('an accepted unmount is not reclassified when its navigation intent expires', async ({ page }) => {
    await open(page, { expectedViewId: 'view-1', expectedNavigationText: 'Older history body one' })
    await page.evaluate(() => {
        document.querySelector('nav button')!.addEventListener('click', () => {
            document.querySelector('[data-chat-node-key="latest"]')!.remove()
        })
    })
    await page.locator('nav button').first().click()
    await page.waitForFunction(() => window.__hapiColdOpening.navigation.commitRevision > 0)
    await page.waitForTimeout(3_100)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.reader.departures).toEqual([expect.objectContaining({ kind: 'unmounted', intended: true })])
    expect(coldOpeningIssues(trace).some(issue => issue.startsWith('Nonempty body was replaced'))).toBe(false)
})

for (const correctReturn of [true, false]) {
    test(`far navigation then latest ${correctReturn ? 'keeps six later live updates usable' : 'rejects the old opening marker in place of the independent current head'}`, async ({ page }) => {
        const targetText = 'Older history body one', liveText = 'Independent latest source watermark'
        await open(page, { expectedViewId: 'view-1', fullCapabilities: true, requiresNavigation: true,
            requireNavigationAction: true, expectedNavigationText: targetText, navigationAction: 'unvisited-target',
            observeAfterReadyMs: 200, failureDeadlineMs: 12_000 })
        await page.evaluate(({ liveText, correctReturn }) => {
            const port = document.querySelector<HTMLElement>('[data-conversation-scroll]')!
            port.style.cssText = 'height:280px;overflow:auto;flex:0 0 280px'
            const flow = document.querySelector('[data-chat-flow]')!
            const opening = document.querySelector<HTMLElement>('[data-chat-node-key="latest"]')!
            for (const row of document.querySelectorAll<HTMLElement>('[data-chat-node-key^="older"]')) row.style.height = '500px'
            flow.append(opening)
            const live = document.createElement('article'); live.dataset.chatNodeKey = 'independent-live'
            live.textContent = correctReturn ? liveText : 'Different source content'; live.style.height = '40px'; flow.append(live)
            port.scrollTop = port.scrollHeight
            document.querySelector('nav button')!.addEventListener('click', () => { port.scrollTop = 0 })
            const latestButton = document.createElement('button'); latestButton.setAttribute('aria-label', 'Back to bottom')
            latestButton.textContent = 'Latest'; latestButton.onclick = () => { port.scrollTop = port.scrollHeight }
            document.querySelector('[data-hapi-session-view]')!.append(latestButton)
        }, { liveText, correctReturn })
        await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible)
        await page.locator('nav button').first().click()
        await page.waitForFunction(() => window.__hapiColdOpening.navigation.targetCommits === 1)
        expect(await page.evaluate(text => window.__hapiColdOpening.setReturnLatestTarget(text), liveText)).toBe(true)
        await page.getByRole('button', { name: 'Back to bottom', exact: true }).click()
        if (!correctReturn) {
            await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible)
            await page.waitForFunction(() => window.__hapiColdOpening.current?.navigationIntentUncommitted)
            const trace = await readColdOpeningProbe(page, true)
            expect(trace.navigation.returnLatestCommits).toBe(0)
            expect(coldOpeningIssues(trace).some(issue => issue.startsWith('Trusted navigation intent produced no target commit'))).toBe(true)
            return
        }
        await page.waitForFunction(() => window.__hapiColdOpening.navigation.returnLatestCommits === 1)
        for (let index = 0; index < 6; index++) {
            const revision = await page.evaluate(() => window.__hapiColdOpening.current?.liveUpdateRevision ?? 0)
            await page.evaluate(index => {
                const row = document.createElement('article'); row.dataset.chatNodeKey = `later-live-${index}`
                row.textContent = `Later live source update ${index}`; row.style.height = '180px'
                document.querySelector('[data-chat-flow]')!.append(row)
                const port = document.querySelector('[data-conversation-scroll]')!; port.scrollTop = port.scrollHeight
            }, index)
            await page.waitForFunction(before => (window.__hapiColdOpening.current?.liveUpdateRevision ?? 0) > before,
                revision, { timeout: 1500 })
        }
        await page.waitForFunction(() => window.__hapiColdOpening.observation.complete)
        const trace = await readColdOpeningProbe(page, true)
        expect(trace.navigation).toMatchObject({ targetCommits: 1, returnLatestCommits: 1, targetCommitted: true, returnLatestCommitted: true })
        expect(trace.current).toMatchObject({ ready: true, latestAttached: true, latestVisible: false, navigationIntentUncommitted: false })
        expect(trace.current?.liveUpdateRevision).toBeGreaterThanOrEqual(6)
        expect(coldOpeningIssues(trace)).toEqual([])
    })
}

test('a navigation target is pinned after opening and cannot be reconfigured after intent', async ({ page }) => {
    await open(page, { expectedViewId: 'view-1', navigationAction: 'unvisited-target' })
    expect(await page.evaluate(() => window.__hapiColdOpening.setNavigationTarget('Older history body one'))).toBe(true)
    expect(await page.evaluate(() => window.__hapiColdOpening.setNavigationTarget('Different target'))).toBe(false)
    await page.locator('nav button').first().click()
    expect(await page.evaluate(() => window.__hapiColdOpening.setNavigationTarget('Different target'))).toBe(false)
})

test('trusted actions extend the diagnostic window only to the fixed opening-plus-observation cap', async ({ page }) => {
    // Short diagnostic durations exercise the same 60s + 30s = 90s cap without
    // spending 90s in a sampler control. Continuous source updates cannot move it.
    await open(page, { expectedViewId: 'view-1', observeAfterReadyMs: 700, failureDeadlineMs: 1200 })
    const box = (await page.locator('[data-conversation-scroll]').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 20)
    await page.waitForFunction(() => window.__hapiColdOpening.reader.wheel > 0)
    const deadline = await page.evaluate(() => window.__hapiColdOpening.observation.deadlineAt)
    expect(await page.evaluate(() => window.__hapiColdOpening.observation.deadlineAt
        - window.__hapiColdOpening.observation.startedAt)).toBe(1900)
    await page.evaluate(() => {
        let revision = 0
        const timer = setInterval(() => {
            document.querySelector('[data-chat-node-key="older-3"]')!.textContent = `Source update ${revision++}`
            if (window.__hapiColdOpening.observation.deadlineMissed) clearInterval(timer)
        }, 70)
    })
    await page.waitForFunction(() => window.__hapiColdOpening.observation.deadlineMissed)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.observation.deadlineAt).toBe(deadline)
    expect(trace.observation.complete).toBe(false)
    expect(trace.first.full!).toBeLessThan(1500)
})

const completedToolMarker = { kind: 'tool-result' as const, callId: 'exact-source-call' }
function toolHeadMarkup(state = 'ok', body = 'Completed command'): string {
    return paneMarkup({ returnLatest: true }).replace(latest,
        `<div data-chat-call-id="exact-source-call"><div data-sample="bash" data-variant="bash" data-state="${state}"><span>${body}</span></div></div>`)
}
async function installToolHeadControl(page: import('@playwright/test').Page, options: Partial<ColdOpeningOptions> = {}): Promise<void> {
    await installColdOpeningProbe(page, {
        paneSelector: '[data-pane-id="pane-1"]', expectedTitle: title, expectedViewId: 'view-1',
        expectedSourceTarget: completedToolMarker, expectedNavigationTarget: completedToolMarker,
        navigationAction: 'return-latest', stableMs: 25, fullCapabilities: true,
        requiresHistory: false, requiresNavigation: false, observeAfterReadyMs: 0, checkpointsMs: [],
        requireEditorInput: false, requireLiveUpdate: false, requireHistoryAction: false, requireNavigationAction: false,
        ...options,
    })
}

test('tool head exact call supports return-latest and remains qualified after normal live appends', async ({ page }) => {
    await installToolHeadControl(page)
    await page.goto(`data:text/html,${encodeURIComponent(toolHeadMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const port = page.locator('[data-conversation-scroll]'), box = await port.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, 140)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible === false)
    await page.getByRole('button', { name: 'Back to bottom', exact: true }).click()
    await page.waitForFunction(() => window.__hapiColdOpening.navigation.returnLatestCommitted)
    await page.evaluate(() => {
        const flow = document.querySelector('[data-chat-flow]')!
        const article = document.createElement('article'); article.dataset.chatNodeKey = 'live-after-frozen-head'
        article.style.height = '800px'; article.textContent = 'New live source content after the frozen tool result'
        flow.append(article)
        const port = document.querySelector<HTMLElement>('[data-conversation-scroll]')!
        port.scrollTop = port.scrollHeight
    })
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible === false
        && window.__hapiColdOpening.current.latestAttached === true && window.__hapiColdOpening.current.ready)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.navigation.returnLatestCommitted).toBe(true)
    expect(trace.current?.latestOffscreenUnprompted).toBe(false)
    expect(coldOpeningIssues(trace)).toEqual([])
})

test('tool head rejects a running same-id card even after it later settles', async ({ page }) => {
    await installToolHeadControl(page)
    await page.goto(`data:text/html,${encodeURIComponent(toolHeadMarkup('running'))}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    expect(await page.evaluate(() => window.__hapiColdOpening.first.full)).toBeNull()
    await page.evaluate(() => document.querySelector('[data-sample="bash"]')!.setAttribute('data-state', 'ok'))
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestVisible === true)
    const trace = await readColdOpeningProbe(page, true)
    expect(coldOpeningIssues(trace).some(issue => issue.startsWith('First visible target body'))).toBe(true)
})

test('tool head identity in another pane does not qualify the exact target pane', async ({ page }) => {
    await installToolHeadControl(page)
    const foreign = toolHeadMarkup().replaceAll('pane-1', 'other-pane').replaceAll('view-1', 'other-view')
    await page.goto(`data:text/html,${encodeURIComponent(paneMarkup() + foreign)}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.first.latest).toBeNull()
    expect(trace.first.full).toBeNull()
})

test('tool head requires visible card content rather than a tall overlapping empty box', async ({ page }) => {
    await installToolHeadControl(page)
    const markup = toolHeadMarkup().replace('data-state="ok"', 'data-state="ok" style="height:800px"')
        .replace('style="height:60px"', 'style="height:800px"')
        + '<script>document.querySelector("[data-conversation-scroll]").scrollTop=200</script>'
    await page.goto(`data:text/html,${encodeURIComponent(markup)}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.current?.latestAttached).toBe(true)
    expect(trace.first.latest).toBeNull()
    expect(trace.first.full).toBeNull()
})

test('tool head still detects an unprompted jump away from its frozen card', async ({ page }) => {
    await installToolHeadControl(page)
    await page.goto(`data:text/html,${encodeURIComponent(toolHeadMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    await page.evaluate(() => { document.querySelector<HTMLElement>('[data-conversation-scroll]')!.scrollTop = 130 })
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestOffscreenUnprompted)
    const trace = await readColdOpeningProbe(page, true)
    expect(coldOpeningIssues(trace).some(issue => issue.startsWith('Latest source body left the viewport without'))).toBe(true)
})

test('tool head also accepts the official GenericToolCard shape', async ({ page }) => {
    await installToolHeadControl(page)
    const markup = toolHeadMarkup().replace('data-sample="bash" data-variant="bash"', 'data-tool="Read"')
    await page.goto(`data:text/html,${encodeURIComponent(markup)}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    expect(coldOpeningIssues(await readColdOpeningProbe(page, true))).toEqual([])
})

// The installed rc.3 ChatGroupSeat DOM contract: members remain mounted under
// hidden="until-found" and the group's own button names that body by id. These
// are browser sampler controls with synthetic content, not a Host acceptance.
function foldedToolHeadMarkup(options: { state?: string; callId?: string; controls?: string; emptyCard?: boolean } = {}): string {
    const group = `<div data-chat-group-key="exact-process-group" data-chat-flow-key="exact-process-group" data-step-process>
        <div><button type="button" data-process-activity="tools" aria-expanded="false" aria-controls="${options.controls ?? 'exact-process-body'}"
            onclick="const body=this.parentElement.nextElementSibling;body.removeAttribute('hidden');this.setAttribute('aria-expanded','true')">Called tools</button></div>
        <div id="exact-process-body" data-step-process-body hidden="until-found"><div data-step-process-content data-chat-flow>
            <div data-chat-node-key="tool-result"><div data-chat-call-id="${options.callId ?? completedToolMarker.callId}">
                <div data-sample="bash" data-variant="bash" data-state="${options.state ?? 'ok'}">${options.emptyCard ? '' : '<span>Completed command</span>'}</div>
            </div></div>
        </div></div>
    </div>`
    return paneMarkup({ returnLatest: true }).replace(
        `<article data-chat-node-key="latest" data-chat-anchor-key="latest" style="height:60px">${latest}</article>`, group)
}

test('official folded tool group proves the exact completed call through its own visible disclosure', async ({ page }) => {
    await installToolHeadControl(page)
    await page.goto(`data:text/html,${encodeURIComponent(foldedToolHeadMarkup())}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    expect(await page.evaluate(() => window.__hapiColdOpening.current?.latestRepresentation)).toBe('collapsed-tool-group')
    await expect(page.locator('[data-step-process-body]')).toHaveAttribute('hidden', 'until-found')
    await expect(page.locator('[data-chat-call-id]')).toBeAttached()
    await expect(page.locator('[data-chat-call-id]')).not.toBeVisible()
    await page.getByRole('button', { name: 'Called tools', exact: true }).click()
    await expect(page.getByText('Completed command', { exact: true })).toBeVisible()
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestRepresentation === 'tool-card')
    await page.waitForFunction(() => window.__hapiColdOpening.observation.complete)
    expect(coldOpeningIssues(await readColdOpeningProbe(page, true))).toEqual([])
})

test('official folded tool group rejects ambiguous associated disclosure controls', async ({ page }) => {
    await installToolHeadControl(page)
    const markup = foldedToolHeadMarkup().replace('<div id="exact-process-body"',
        '<button type="button" data-process-activity="tools" aria-expanded="false" aria-controls="exact-process-body">Other tools</button><div id="exact-process-body"')
    await page.goto(`data:text/html,${encodeURIComponent(markup)}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.first.latest).toBeNull()
    expect(trace.first.full).toBeNull()
})

test('a hidden completed tool without its own official group disclosure stays unverified', async ({ page }) => {
    await installToolHeadControl(page)
    const markup = toolHeadMarkup().replace('<div data-chat-call-id="exact-source-call">',
        '<div hidden="until-found" data-chat-call-id="exact-source-call">')
    await page.goto(`data:text/html,${encodeURIComponent(markup)}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.current?.latestAttached).toBe(true)
    expect(trace.first.latest).toBeNull()
    expect(trace.first.full).toBeNull()
})

for (const [name, options] of [
    ['absent exact call', { callId: 'different-call' }],
    ['running exact call', { state: 'running' }],
    ['unrelated disclosure', { controls: 'another-process-body' }],
    ['empty completed card', { emptyCard: true }],
] as const) test(`official folded tool group rejects ${name}`, async ({ page }) => {
    await installToolHeadControl(page)
    await page.goto(`data:text/html,${encodeURIComponent(foldedToolHeadMarkup(options))}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.first.latest).toBeNull()
    expect(trace.first.full).toBeNull()
    expect(coldOpeningIssues(trace).some(issue => issue.startsWith('First visible target body'))).toBe(true)
})

test('official folded tool group rejects an offscreen or disabled associated disclosure', async ({ page }) => {
    await installToolHeadControl(page)
    const markup = foldedToolHeadMarkup().replace('data-process-activity="tools"', 'data-process-activity="tools" disabled')
    await page.goto(`data:text/html,${encodeURIComponent(markup)}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    expect(await page.evaluate(() => window.__hapiColdOpening.current?.latestVisible)).toBe(false)
    await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('button[data-process-activity]')!.disabled = false
        document.querySelector<HTMLElement>('[data-conversation-scroll]')!.scrollTop = 100
    })
    await page.waitForTimeout(100)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.first.latest).toBeNull()
    expect(trace.first.full).toBeNull()
})

test('official folded tool heading alone cannot qualify a bodyless conversation', async ({ page }) => {
    await installToolHeadControl(page)
    const markup = foldedToolHeadMarkup().replace(/<article data-chat-node-key="older-[123]"[^>]*>[^<]*<\/article>/g, '')
    await page.goto(`data:text/html,${encodeURIComponent(markup)}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.latestRepresentation === 'collapsed-tool-group')
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.current?.bodyVisible).toBe(false)
    expect(trace.first.body).toBeNull()
    expect(trace.first.full).toBeNull()
})

test('official folded tool proof does not excuse a non-scrollable history window', async ({ page }) => {
    await installToolHeadControl(page, { requiresHistory: true })
    const markup = foldedToolHeadMarkup().replaceAll('height:90px', 'height:10px')
    await page.goto(`data:text/html,${encodeURIComponent(markup)}`)
    await page.waitForFunction(() => window.__hapiColdOpening.current?.bodyVisible)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.current).toMatchObject({ latestRepresentation: 'collapsed-tool-group', historyHasMore: true, historyScrollable: false })
    expect(trace.first.full).toBeNull()
    expect(coldOpeningIssues(trace).some(issue => issue.startsWith('Source history was not scrollable'))).toBe(true)
})
