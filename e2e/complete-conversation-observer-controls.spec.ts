/**
 * Synthetic sampler controls for the complete-conversation observer.
 *
 * These are deliberately data: URLs and are NOT product acceptance. The real
 * official Host cases are in native-cold-opening.spec.ts and
 * complete-conversation-observer.spec.ts. Each test here names the sampler
 * mechanic it exercises and the required failure/recovery evidence.
 */
import { test, expect } from '@playwright/test'
import { installColdOpeningProbe, readColdOpeningProbe, coldOpeningIssues, exerciseOpeningDraft } from './cold-opening-probe.ts'
import type { ColdOpeningOptions } from '../scripts/cold-opening-observer.mjs'

test.use({ screenshot: 'off' })
test.setTimeout(60_000)

const title = 'Known native title'
const latest = 'Fresh native tail'

function paneMarkup(options: { editorDisabled?: boolean; latestText?: string; returnLatest?: boolean; brokenReturn?: boolean } = {}): string {
    return `<main class="hapi-pane hapi-pane-focused" aria-label="Pane: ${title}" style="width:600px;height:600px;display:flex;flex-direction:column">
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
    await page.waitForFunction(() => window.__hapiColdOpening.current?.ready && window.__hapiColdOpening.current.stableForMs >= 25)
    const trace = await readColdOpeningProbe(page, true)
    expect(trace.states.some(row => row.firstBodyWrong)).toBe(true)
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
