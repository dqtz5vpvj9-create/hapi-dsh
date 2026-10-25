import type { CDPSession, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { installColdOpeningObserver, type ColdOpeningOptions, type ColdOpeningResult } from '../scripts/cold-opening-observer.mjs'
export { coldOpeningIssues } from '../scripts/cold-opening-observer.mjs'

/**
 * Register before navigation. The observer is serialized into the init script,
 * so every opening and every deliberate reader action is sampled from before
 * application startup.
 */
export async function installColdOpeningProbe(page: Page, options: ColdOpeningOptions): Promise<void> {
    await page.addInitScript({ content: `(${installColdOpeningObserver.toString()})(${JSON.stringify(options)})` })
}

export async function readColdOpeningProbe(page: Page, stop = false): Promise<ColdOpeningResult> {
    return page.evaluate(stop => {
        const probe = window.__hapiColdOpening
        if (stop) probe.stop()
        return { first: probe.first, states: probe.states, titles: probe.titles, tasks: probe.tasks,
            current: probe.current, startedAt: probe.startedAt, stoppedAt: probe.stoppedAt,
            verifiedFreshness: probe.verifiedFreshness, verifiedTitle: probe.verifiedTitle,
            verifiedView: probe.verifiedView, verifiedTarget: probe.verifiedTarget,
            expectedViewSupplied: probe.expectedViewSupplied, navigationAction: probe.navigationAction,
            expectedNavigationTextSupplied: probe.expectedNavigationTextSupplied,
            stableMs: probe.stableMs, requiresHistory: probe.requiresHistory,
            requiresNavigation: probe.requiresNavigation, fullCapabilities: probe.fullCapabilities,
            requireEditorInput: probe.requireEditorInput, requireLiveUpdate: probe.requireLiveUpdate,
            requireHistoryAction: probe.requireHistoryAction, requireNavigationAction: probe.requireNavigationAction,
            observation: probe.observation, history: probe.history, navigation: probe.navigation,
            reader: probe.reader, input: probe.input, liveUpdateAt: probe.liveUpdateAt }
    }, stop) as Promise<ColdOpeningResult>
}

export async function waitForColdOpeningObservation(page: Page, timeout = 70_000): Promise<void> {
    await page.waitForFunction(() => window.__hapiColdOpening.observation.complete
        || window.__hapiColdOpening.observation.deadlineMissed, null, { timeout })
    const observation = await page.evaluate(() => window.__hapiColdOpening.observation)
    if (!observation.complete)
        throw new Error(`Observation did not complete (deadlineMissed=${observation.deadlineMissed}, lastSync=${observation.lastSyncActivityAt})`)
}

/** True only when the application actually painted a complete matrix. */
export async function currentColdOpeningReady(page: Page): Promise<boolean> {
    return page.evaluate(() => Boolean(window.__hapiColdOpening.current?.ready
        && window.__hapiColdOpening.current?.stableForMs >= window.__hapiColdOpening.stableMs))
}

export interface DraftActionEvidence {
    accepted: boolean
    retained: boolean
    cleared: boolean
    textLength: number
    markerMatched: boolean
    editorStable: boolean
    cleanupVerified: boolean
    failure: string | null
    input: ColdOpeningResult['input']
}

/**
 * Trusted marker typing on an *empty* official editor, verified on one
 * ElementHandle before and after. A nonempty existing draft is never touched.
 * The marker is cleared only while the same editor still contains exactly the
 * marker; any change stops cleanup and fails the action.
 */
export async function exerciseOpeningDraft(page: Page, pane: Locator, draft: string): Promise<DraftActionEvidence> {
    const editor = pane.locator('[data-composer-input][contenteditable="true"]:visible')
    const input = await page.evaluate(() => window.__hapiColdOpening.input)
    const fail = (failure: string, textLength = 0): DraftActionEvidence => ({ accepted: false, retained: false,
        cleared: false, textLength, markerMatched: false, editorStable: false, cleanupVerified: false, failure, input })
    if (await editor.count() !== 1) return fail('Expected exactly one usable official editor')
    const handle = await editor.elementHandle()
    if (!handle) return fail('Could not hold the official editor ElementHandle')
    const before = await handle.evaluate(node => ({ text: node.textContent ?? '',
        focused: document.activeElement === node || node.contains(document.activeElement), connected: node.isConnected }))
    if (before.text.length > 0) return fail('Existing nonempty draft; no write or cleanup was performed', before.text.length)
    if (!before.connected) return fail('Editor disconnected before typing')
    const revisionBefore = await page.evaluate(() => window.__hapiColdOpening.current?.editorRevision ?? 0)
    await editor.click()
    const focusedBefore = await handle.evaluate(node => document.activeElement === node
        || node.contains(document.activeElement))
    if (!focusedBefore) return fail('Editor did not receive trusted focus')
    await page.keyboard.type(draft, { delay: 8 })
    await page.waitForTimeout(650)
    const after = await handle.evaluate(node => ({ text: node.textContent ?? '', connected: node.isConnected,
        focused: document.activeElement === node || node.contains(document.activeElement) }))
    const stateAfter = await page.evaluate(() => ({ revision: window.__hapiColdOpening.current?.editorRevision ?? 0,
        focused: window.__hapiColdOpening.current?.editorFocused ?? false, input: window.__hapiColdOpening.input }))
    const markerMatched = after.text === draft
    const editorStable = after.connected && stateAfter.revision === revisionBefore && after.focused && stateAfter.focused
    if (!markerMatched || !editorStable) return { ...fail(markerMatched
        ? 'Editor identity or focus changed while typing the marker'
        : 'Typed marker was not exactly retained; cleanup was not attempted', after.text.length), input: stateAfter.input }
    const immediately = await handle.evaluate(node => ({ text: node.textContent ?? '', connected: node.isConnected,
        focused: document.activeElement === node || node.contains(document.activeElement) }))
    if (immediately.text !== draft || !immediately.connected || !immediately.focused)
        return { ...fail('Marker changed before safe cleanup; no Backspace was sent', immediately.text.length), input: stateAfter.input }
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(120)
    const final = await handle.evaluate(node => ({ text: node.textContent ?? '', connected: node.isConnected,
        focused: document.activeElement === node || node.contains(document.activeElement) }))
    const stateFinal = await page.evaluate(() => ({ revision: window.__hapiColdOpening.current?.editorRevision ?? 0,
        input: window.__hapiColdOpening.input }))
    const cleanupVerified = final.text === '' && final.connected && final.focused && stateFinal.revision === revisionBefore
    return { accepted: true, retained: stateAfter.input.everRetained, cleared: cleanupVerified,
        textLength: draft.length, markerMatched, editorStable, cleanupVerified,
        failure: cleanupVerified ? null : 'Cleanup failed to restore the same empty editor', input: stateFinal.input }
}

async function touchSwipe(page: Page, port: Locator, direction: 'older' | 'newer', cdp?: CDPSession, steps = 8): Promise<void> {
    const session = cdp ?? await page.context().newCDPSession(page)
    const box = await port.boundingBox()
    if (!box) throw new Error('The conversation scrollport is not visible')
    const x = box.x + box.width * 0.55
    const start = box.y + box.height * (direction === 'older' ? 0.25 : 0.75)
    const end = box.y + box.height * (direction === 'older' ? 0.75 : 0.25)
    const points = (y: number) => [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }]
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) })
    for (let step = 1; step <= steps; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(start + (end - start) * step / steps) })
        await page.waitForTimeout(18)
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    if (!cdp) await session.detach()
}

export interface HistoryActionEvidence {
    mode: 'wheel' | 'touch'
    requested: boolean
    committed: boolean
    commitAfterRequest: boolean
    anchorRetained: boolean | null
    anchorDriftPx: number | null
    scrollHeightGrew: boolean
    intents: number
    requests: number
    commits: number
    failure: string | null
}

/**
 * Trusted wheel (desktop) or CDP touch (mobile) at the older-history boundary.
 * The revision baseline is captured before the gesture sequence. Success
 * requires a source request and source commit from this action, plus the
 * observer's retained reading anchor. DOM row growth alone is never enough.
 */
export async function exerciseOpeningHistory(page: Page, pane: Locator, mode: 'wheel' | 'touch'): Promise<HistoryActionEvidence> {
    const port = pane.locator('[data-conversation-scroll]').first()
    await expect(port).toHaveCount(1)
    const box = await port.boundingBox()
    if (!box) throw new Error('The conversation scrollport is not visible')
    const baseline = await page.evaluate(() => ({
        at: performance.now(),
        intents: window.__hapiColdOpening.history?.intents ?? 0,
        requests: window.__hapiColdOpening.history?.requestRevision ?? 0,
        commits: window.__hapiColdOpening.history?.commitRevision ?? 0,
    }))
    const beforeHeight = await port.evaluate(element => element.scrollHeight)
    let failure: string | null = null
    if (mode === 'wheel') {
        await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4)
        for (let step = 0; step < 60; step++) {
            await page.mouse.wheel(0, -600)
            if (await port.evaluate(element => element.scrollTop) <= 1) break
            await page.waitForTimeout(16)
        }
        await page.mouse.wheel(0, -140)
    } else {
        const cdp = await page.context().newCDPSession(page)
        try {
            for (let gesture = 0; gesture < 48; gesture++) {
                await touchSwipe(page, port, 'older', cdp)
                if (await port.evaluate(element => element.scrollTop) <= 1) break
                await page.waitForTimeout(80)
            }
            await touchSwipe(page, port, 'older', cdp)
        } finally { await cdp.detach() }
    }
    try {
        await page.waitForFunction(base => {
            const h = window.__hapiColdOpening.history
            return (h?.intents ?? 0) > base.intents && (h?.requestRevision ?? 0) > base.requests
                && (h?.commitRevision ?? 0) > base.commits
        }, baseline, { timeout: 15_000 })
    } catch {
        failure = 'This gesture produced no source request plus source commit after the baseline'
    }
    const afterHeight = await port.evaluate(element => element.scrollHeight)
    const evidence = await page.evaluate(base => {
        const h = window.__hapiColdOpening.history
        return {
            intents: h?.intents ?? 0, requests: h?.requestRevision ?? 0, commits: h?.commitRevision ?? 0,
            requestAt: h?.requestAt ?? null, commitAt: h?.commitAt ?? null,
            anchorRetained: h?.anchorRetained ?? null, anchorDriftPx: h?.anchorDriftPx ?? null,
        }
    }, baseline)
    const requested = evidence.requests > baseline.requests && evidence.requestAt !== null
        && evidence.requestAt >= baseline.at - 100
    const committed = evidence.commits > baseline.commits && evidence.commitAt !== null
    const commitAfterRequest = requested && committed && evidence.commitAt! >= evidence.requestAt! - 50
    if (!requested && failure === null) failure = 'No source page request was observed for this gesture'
    else if (!committed && failure === null) failure = 'No source page commit was observed for this gesture'
    else if (!commitAfterRequest && failure === null) failure = 'The source commit did not follow this source request'
    return {
        mode,
        requested, committed, commitAfterRequest,
        anchorRetained: evidence.anchorRetained,
        anchorDriftPx: evidence.anchorDriftPx,
        scrollHeightGrew: afterHeight > beforeHeight + 8,
        intents: evidence.intents - baseline.intents,
        requests: evidence.requests - baseline.requests,
        commits: evidence.commits - baseline.commits,
        failure,
    }
}

async function findTurnRail(pane: Locator): Promise<Locator | undefined> {
    const named = pane.locator('nav[aria-label="Turn navigation"], nav[aria-label="轮次导航"]').first()
    if (await named.count() && await named.isVisible()) return named
    const navs = pane.locator('nav[aria-label]')
    const count = await navs.count()
    for (let index = 0; index < count; index++) {
        if (!await navs.nth(index).isVisible()) continue
        const labels = await navs.nth(index).locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? ''))
        if (labels.some(label => /jump to turn|load and jump|跳转到第|加载并跳转/i.test(label))) return navs.nth(index)
    }
    return undefined
}

export interface NavigationActionEvidence {
    attempted: boolean
    kind: string | null
    committed: boolean
    targetVisible: boolean | null
    failure: string | null
}

/** Click an unvisited official TurnNavigator target and require its exact text. */
export async function exerciseOpeningUnvisitedTarget(page: Page, pane: Locator, expectedText: string, targetTurn: number): Promise<NavigationActionEvidence> {
    const rail = await findTurnRail(pane)
    if (!rail || !await rail.count() || !await rail.isVisible())
        return { attempted: false, kind: null, committed: false, targetVisible: null, failure: 'No visible official TurnNavigator rail' }
    const buttons = rail.locator('button')
    const labels = await buttons.evaluateAll(nodes => nodes.map((node, index) => ({
        index, label: node.getAttribute('aria-label') ?? '',
        current: node.getAttribute('aria-current') === 'true',
        disabled: (node as HTMLButtonElement).disabled,
        turn: Number(/(?:turn|第)\s*(\d+)/i.exec(node.getAttribute('aria-label') ?? '')?.[1] ?? Number.NaN),
    })))
    const eligible = labels.filter(row => row.turn === targetTurn)
    const selected = eligible.find(row => !row.disabled && /load and jump|加载并跳转/.test(row.label))
        ?? eligible.find(row => !row.disabled && !row.current && /jump to turn|跳转到第/.test(row.label))
    if (!selected)
        return { attempted: false, kind: null, committed: false, targetVisible: null, failure: `Expected navigation turn ${targetTurn} was not present in the official rail` }
    if (await pane.getByText(expectedText, { exact: true }).isVisible().catch(() => false))
        return { attempted: false, kind: 'target', committed: false, targetVisible: true,
            failure: 'The navigation target was already visible; the action did not exercise navigation' }
    const baseline = await page.evaluate(() => window.__hapiColdOpening.navigation?.commitRevision ?? 0)
    const kind = /load and jump|加载并跳转/.test(selected.label) ? 'load-jump' : 'jump'
    await buttons.nth(selected.index).click()
    let failure: string | null = null
    try {
        await expect(pane.getByText(expectedText, { exact: true })).toBeVisible({ timeout: 12_000 })
        await page.waitForFunction(base => (window.__hapiColdOpening.navigation?.commitRevision ?? 0) > base, baseline, { timeout: 12_000 })
    } catch { failure = 'Unvisited navigation target did not commit the exact text' }
    const committed = await page.evaluate(base => (window.__hapiColdOpening.navigation?.commitRevision ?? 0) > base, baseline)
    const targetVisible = await pane.getByText(expectedText, { exact: true }).isVisible().catch(() => false)
    return { attempted: true, kind, committed, targetVisible, failure }
}

/** Return to the latest source marker. This is a distinct mobile action. */
export async function exerciseOpeningReturnLatest(page: Page, pane: Locator, latestText: string): Promise<NavigationActionEvidence> {
    const labels = await pane.locator('button[aria-label]').evaluateAll(nodes => nodes.map((node, index) => ({
        index, label: node.getAttribute('aria-label') ?? '', visible: Boolean((node as HTMLElement).getClientRects().length),
    })))
    const toBottom = labels.find(row => row.visible && /to bottom|回到(?:底部|最新)/i.test(row.label))
    if (toBottom === undefined)
        return { attempted: false, kind: null, committed: false, targetVisible: null, failure: 'No visible return-latest control' }
    if (await pane.getByText(latestText, { exact: true }).isVisible().catch(() => false))
        return { attempted: false, kind: 'to-bottom', committed: false, targetVisible: true,
            failure: 'The latest marker was already visible; return-latest was not exercised' }
    const baseline = await page.evaluate(() => window.__hapiColdOpening.navigation?.commitRevision ?? 0)
    await pane.locator('button[aria-label]').nth(toBottom.index).click()
    let failure: string | null = null
    try {
        await expect(pane.getByText(latestText, { exact: true })).toBeVisible({ timeout: 12_000 })
        await page.waitForFunction(base => (window.__hapiColdOpening.navigation?.commitRevision ?? 0) > base, baseline, { timeout: 12_000 })
    } catch { failure = 'Return-latest did not expose the latest marker and commit' }
    const committed = await page.evaluate(base => (window.__hapiColdOpening.navigation?.commitRevision ?? 0) > base, baseline)
    return { attempted: true, kind: 'to-bottom', committed, targetVisible: await pane.getByText(latestText, { exact: true }).isVisible().catch(() => false), failure }
}

/** Hashed evidence only; no transcript text or source node ids in artifacts. */
export async function readOpeningEvidence(page: Page): Promise<{
    history: ColdOpeningResult['history']
    navigation: ColdOpeningResult['navigation']
    reader: ColdOpeningResult['reader']
    input: ColdOpeningResult['input']
    liveUpdateAt: number | null
    observation: ColdOpeningResult['observation']
}> {
    return page.evaluate(() => ({
        history: window.__hapiColdOpening.history,
        navigation: window.__hapiColdOpening.navigation,
        reader: window.__hapiColdOpening.reader,
        input: window.__hapiColdOpening.input,
        liveUpdateAt: window.__hapiColdOpening.liveUpdateAt,
        observation: window.__hapiColdOpening.observation,
    }))
}
