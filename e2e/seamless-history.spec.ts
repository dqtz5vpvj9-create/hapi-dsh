/**
 * Seamless earlier-history loading (R7) through the unchanged official DSH Web.
 *
 * The fixture is a long synthetic HAPI source history (1040 wire rows, more than
 * one client history window) served through the real HAPI wire contract while
 * the official pinned DSH Session/Conversation and the HAPI projection remain
 * the real implementations. Scroll paging itself reads the DSH Host journal the
 * projection already seeded, so no new source read is expected per page.
 *
 * Verified here:
 * - an upward gesture at the top starts exactly one earlier page without a
 *   manual click, and the reader's anchor row keeps its viewport offset;
 * - a slow page keeps single flight: repeated gestures never issue a second
 *   page request while the official control reports loading;
 * - an aborted page leaves the manual control available, a later gesture
 *   recovers, and a failure streak suspends automation without an automatic
 *   retry loop (the manual control still pages and resumes automation).
 */
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { nativeIndexedHistory, useBoundedSourceHistory } from './source-conversation-fixture.ts'

const PANE_NAME = 'Native Codex seamless-history'
const OLDER_PAGE_URL = '**/api/session/page'
const TARGET_ANSWER = 'Synthetic final answer 80.'

let environment: OfficialEnvironment
let sourceHistory: ReturnType<typeof useBoundedSourceHistory>

test.beforeAll(async () => {
    environment = await startOfficialEnvironment()
    const source = environment.hapi.add('seamless-history', 'Synthetic Runner', 'machine-alpha')
    // 80 turns x 13 messages: several 500-message client windows of older history.
    source.rows = nativeIndexedHistory(source.session.metadata!.codexSessionId!, 80, 12)
    sourceHistory = useBoundedSourceHistory(source)
    environment.hapi.emit({ type: 'session-added', sessionId: source.session.id })
})
test.afterAll(async () => { await environment?.close() })

async function openPane(page: Page): Promise<Locator> {
    await page.goto(environment.launchUrl)
    await acknowledgePreviewNotice(page, environment)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    await page.locator('.hapi-session-open').filter({ hasText: PANE_NAME }).click()
    const pane = page.getByRole('region', { name: `Pane: ${PANE_NAME}`, exact: true })
    await expect(pane).toBeVisible()
    await expect(pane.getByText(TARGET_ANSWER, { exact: true })).toBeVisible({ timeout: 60_000 })
    return pane
}

/** The official conversation scrollport. */
function scrollport(pane: Locator): Locator { return pane.locator('[data-conversation-scroll]') }
/** The outer chat column (the nested process-group columns are excluded). */
function column(pane: Locator): Locator { return pane.locator('[data-chat-flow]:not([data-step-process-content])') }
/**
 * The official manual older-history control, located structurally (no locale
 * text or hashed CSS): the only direct column child that wraps exactly one button.
 */
function olderButton(pane: Locator): Locator {
    return column(pane).locator('xpath=./div[count(*)=1 and count(button)=1]/button').first()
}

async function olderPageRequests(page: Page): Promise<string[]> {
    const requests: string[] = []
    page.on('request', request => {
        if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/session/page') return
        if ((request.postData() ?? '').includes('"beforeSeq"')) requests.push(request.url())
    })
    return requests
}

/** Put the reader at the top and wait until the official view owns history mode. */
async function settleAtTop(page: Page, pane: Locator): Promise<void> {
    await scrollport(pane).evaluate(element => { element.scrollTop = 0 })
    await expect.poll(() => pane.locator('[data-chat-following-tail]').count()).toBe(0)
    // The plugin only trusts scroll samples attributable to a real reader input;
    // this window also clears its jump suppression after the programmatic scroll.
    await page.waitForTimeout(700)
    await expect(olderButton(pane)).toBeVisible()
    await expect(olderButton(pane)).toBeEnabled()
}

/** One real wheel sample toward earlier content. */
async function wheelUp(page: Page, pane: Locator, deltaY = -160): Promise<void> {
    await scrollport(pane).evaluate((element, delta) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true, cancelable: true }))
    }, deltaY)
}

/**
 * Real reader wheel input over the transcript until another older page lands.
 *
 * Programmatic `scrollTop = 0` is not reader input: the official view may still
 * own a paging anchor and re-assert it on the next layout commit, so an
 * end-to-end assertion after a manual page uses trusted wheel events instead.
 */
async function wheelUntilAnotherPage(page: Page, pane: Locator, rowsBefore: number, timeoutMs = 30_000): Promise<void> {
    const box = await scrollport(pane).boundingBox()
    if (box === null) throw new Error('The conversation scrollport has no box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await rowCount(pane) > rowsBefore) return
        await page.mouse.wheel(0, -400)
        await page.waitForTimeout(200)
    }
    throw new Error(`No older page loaded after ${timeoutMs}ms of wheel input`)
}

async function rowCount(pane: Locator): Promise<number> {
    return column(pane).locator('[data-chat-anchor-key]').count()
}

/** Identity and viewport offset of the topmost row, used for anchor stability. */
async function topRow(pane: Locator): Promise<{ key: string; offset: number }> {
    return pane.evaluate(paneElement => {
        const scroller = paneElement.querySelector('[data-conversation-scroll]')!
        const column = paneElement.querySelector('[data-chat-flow]:not([data-step-process-content])')!
        const row = column.querySelector('[data-chat-anchor-key]')
        if (row === null) throw new Error('The transcript has no anchored row')
        return { key: row.getAttribute('data-chat-anchor-key')!, offset: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top }
    })
}

/** Current viewport offset of a row captured by {@link topRow}. */
async function rowOffset(pane: Locator, key: string): Promise<number | null> {
    return pane.evaluate((paneElement, anchorKey) => {
        const scroller = paneElement.querySelector('[data-conversation-scroll]')!
        const rows = [...paneElement.querySelectorAll('[data-chat-anchor-key]')]
        const row = rows.find(candidate => candidate.getAttribute('data-chat-anchor-key') === anchorKey)
        return row === undefined ? null : row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    }, key)
}

/** Whether the middle of the transcript shows real conversation content. */
async function transcriptBlank(pane: Locator): Promise<boolean> {
    return pane.evaluate(paneElement => {
        const scroller = paneElement.querySelector('[data-conversation-scroll]')!
        const box = scroller.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 3)
        return hit === null || hit.closest('[data-conversation-content]') === null
    })
}

test('an upward gesture at the top pages older history automatically and keeps the reader anchor', async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const pane = await openPane(page)
    const sourceReads = sourceHistory.requests.length
    const requests = await olderPageRequests(page)
    await settleAtTop(page, pane)
    const before = await topRow(pane)
    const rows = await rowCount(pane)
    // No click: the wheel sample itself must trigger the official control.
    await wheelUp(page, pane)
    await expect.poll(() => rowCount(pane), { timeout: 15_000 }).toBeGreaterThan(rows)
    // One gesture, one page request: the plugin never chains from render/scroll
    // compensation, and the page came from the DSH journal rather than the HAPI wire.
    expect(requests.length).toBe(1)
    expect(sourceHistory.requests.length).toBe(sourceReads)
    const after = await rowOffset(pane, before.key)
    expect(after).not.toBeNull()
    expect(Math.abs(after! - before.offset)).toBeLessThanOrEqual(2)
    expect(await transcriptBlank(pane)).toBe(false)
    // The manual control stays available as the user-facing fallback.
    await expect(olderButton(pane)).toBeVisible()
    await expect(pane).not.toHaveAttribute('data-hapi-seamless')
    expect(errors).toEqual([])
    await info.attach('seamless-anchor-before-after', { body: JSON.stringify({ before, after }), contentType: 'application/json' })
})

test('a slow page keeps one request in flight no matter how many gestures arrive', async ({ page }) => {
    const pane = await openPane(page)
    await settleAtTop(page, pane)
    const rows = await rowCount(pane)
    const requests: string[] = []
    await page.route(OLDER_PAGE_URL, async route => {
        const request = route.request()
        if (request.method() !== 'POST' || !(request.postData() ?? '').includes('"beforeSeq"')) { await route.continue(); return }
        requests.push(request.url())
        await new Promise(resolve => setTimeout(resolve, 1_200))
        await route.continue()
    })
    try {
        await wheelUp(page, pane)
        await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(1)
        // Gestures during the slow page must not issue another request.
        await wheelUp(page, pane)
        await page.waitForTimeout(200)
        await wheelUp(page, pane)
        await page.waitForTimeout(400)
        expect(requests.length).toBe(1)
        await expect.poll(() => rowCount(pane), { timeout: 15_000 }).toBeGreaterThan(rows)
        expect(requests.length).toBe(1)
    } finally {
        await page.unroute(OLDER_PAGE_URL)
    }
})

test('a failed page leaves the manual control working and the next gesture recovers', async ({ page }) => {
    const pane = await openPane(page)
    await settleAtTop(page, pane)
    const rows = await rowCount(pane)
    const requests: string[] = []
    let failOlderPages = true
    await page.route(OLDER_PAGE_URL, async route => {
        const request = route.request()
        if (request.method() !== 'POST' || !(request.postData() ?? '').includes('"beforeSeq"')) { await route.continue(); return }
        requests.push(request.url())
        if (failOlderPages) { await route.abort('failed'); return }
        await route.continue()
    })
    try {
        await wheelUp(page, pane)
        await expect(pane).toHaveAttribute('data-hapi-seamless', 'error', { timeout: 15_000 })
        await expect(olderButton(pane)).toBeVisible()
        await expect(olderButton(pane)).toBeEnabled()
        // The next gesture after the cooldown retries and recovers; the marker is cleared.
        await page.waitForTimeout(1_500)
        failOlderPages = false
        await wheelUp(page, pane)
        await expect.poll(() => rowCount(pane), { timeout: 15_000 }).toBeGreaterThan(rows)
        await expect(pane).not.toHaveAttribute('data-hapi-seamless', { timeout: 10_000 })
        expect(requests.length).toBe(2)
    } finally {
        await page.unroute(OLDER_PAGE_URL)
    }
})

test('a failure streak suspends automation, and manual progress resumes it', async ({ page }, info) => {
    const pane = await openPane(page)
    const requests: string[] = []
    let failOlderPages = true
    await page.route(OLDER_PAGE_URL, async route => {
        const request = route.request()
        if (request.method() !== 'POST' || !(request.postData() ?? '').includes('"beforeSeq"')) { await route.continue(); return }
        requests.push(request.url())
        if (failOlderPages) { await route.abort('failed'); return }
        await route.continue()
    })
    try {
        // Three deliberate failures from the latest window suspend automatic loading.
        for (let attempt = 0; attempt < 5; attempt++) {
            if (await pane.getAttribute('data-hapi-seamless') === 'suspended') break
            await settleAtTop(page, pane)
            await wheelUp(page, pane)
            await page.waitForTimeout(2_500)
        }
        await expect(pane).toHaveAttribute('data-hapi-seamless', 'suspended', { timeout: 20_000 })
        const suspendedRows = await rowCount(pane)
        const suspendedRequests = requests.length
        // Suspended means no more automatic clicks: further gestures are inert.
        await wheelUp(page, pane)
        await page.waitForTimeout(1_500)
        await wheelUp(page, pane)
        await page.waitForTimeout(1_500)
        expect(requests.length).toBe(suspendedRequests)
        expect(await rowCount(pane)).toBe(suspendedRows)

        // The manual control still pages; observed progress resumes automation.
        failOlderPages = false
        await olderButton(pane).click()
        await expect.poll(() => rowCount(pane), { timeout: 15_000 }).toBeGreaterThan(suspendedRows)
        await expect(pane).not.toHaveAttribute('data-hapi-seamless', { timeout: 10_000 })
        // Automation resumed: trusted wheel input reaches the new top and pages again.
        const resumedRows = await rowCount(pane)
        await wheelUntilAnotherPage(page, pane, resumedRows)
        await info.attach('seamless-suspension', {
            body: JSON.stringify({ requests: requests.length, suspendedRequests, suspendedRows, resumedRows }), contentType: 'application/json',
        })
    } finally {
        await page.unroute(OLDER_PAGE_URL)
    }
})

test('reload restores the pane and automation issues no duplicate page requests', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    let pane = await openPane(page)
    await page.reload()
    await acknowledgePreviewNotice(page, environment)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    pane = page.getByRole('region', { name: `Pane: ${PANE_NAME}`, exact: true })
    await expect(pane).toBeVisible({ timeout: 60_000 })
    await expect(pane.getByText(TARGET_ANSWER, { exact: true })).toBeVisible({ timeout: 60_000 })
    const requests = await olderPageRequests(page)
    await settleAtTop(page, pane)
    const rows = await rowCount(pane)
    await wheelUp(page, pane)
    await expect.poll(() => rowCount(pane), { timeout: 15_000 }).toBeGreaterThan(rows)
    expect(requests.length).toBe(1)
    expect(errors).toEqual([])
})
