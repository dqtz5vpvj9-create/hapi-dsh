/** Official DSH runtime with synthetic HAPI wire. No production messages or model calls. */
import { expect, type Locator, type Page } from '@playwright/test'
import type { WarmOfficialSession } from './warm-session.ts'
import { installUiProbe, paint, percentile, type UiSample } from './ui-probe.ts'
import { beginUiLive } from './ui-live-fixture.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { availableParallelism, loadavg } from 'node:os'
import { warmDirectory } from './warm-control.ts'

// Explicit local-Chromium engineering budgets. Device/production results are separate.
export const UI_BUDGETS = { warmBodyMs: 150, cachedBodyMs: 500, firstBodyMs: 1500, coldWorkspaceMs: 6000,
  scrollP95Ms: 50, frameTimestampToleranceMs: 0.2, maxFrameMs: 200, anchorPx: 1, mobileComposerPx: 160, mobileHeaderPx: 0, mobileBottomPx: 52 }
interface Check { name: string; passed: boolean; elapsedMs: number; metrics?: unknown; error?: string }
interface Opening { bodyMs: number; composerMs: number }
const composer = (pane: Locator) => pane.locator('[data-composer-input][contenteditable="true"]')
const paneFor = (page: Page, key: string) => page.getByRole('region', { name: `Pane: Native Codex ${key}`, exact: true })
const scrollport = (pane: Locator) => pane.locator('[data-conversation-scroll]')
const safe = (error: unknown) => String(error).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').slice(0, 2400)

/** Real sidebar action, browser clock and actual text/editor readiness, not a loading shell. */
async function open(page: Page, key: string, text: string): Promise<Opening> {
  return openTitle(page, `Native Codex ${key}`, text)
}
async function openTitle(page: Page, title: string, text: string): Promise<Opening> {
  const row = page.locator('.hapi-session-open').filter({ hasText: title }).first()
  await row.waitFor({ state: 'visible' })
  return row.evaluate(async (element, expected) => {
    const started = performance.now()
    ;(element as HTMLElement).click()
    let bodyMs: number | undefined, composerMs: number | undefined
    while (performance.now() - started < 15_000) {
      await new Promise(requestAnimationFrame)
      const pane = [...document.querySelectorAll('.hapi-pane-focused')]
        .find(pane => pane.getAttribute('aria-label') === `Pane: ${expected.title}`)
      const flow = pane?.querySelector('[data-chat-flow]')
      const input = pane?.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
      if (flow?.textContent?.includes(expected.text) && flow.getBoundingClientRect().height && bodyMs === undefined) bodyMs = performance.now() - started
      if (input && input.getBoundingClientRect().height && input.getAttribute('aria-disabled') !== 'true' && composerMs === undefined) composerMs = performance.now() - started
      if (bodyMs !== undefined && composerMs !== undefined) return { bodyMs, composerMs }
    }
    throw new Error(`Actual body/editor did not become usable: body=${bodyMs}, composer=${composerMs}`)
  }, { text, title })
}

async function split(page: Page): Promise<void> {
  const pane = page.locator('.hapi-pane-focused')
  const menu = pane.locator('.hapi-pane-header .hapi-pane-menu')
  await menu.locator(':scope > summary').click()
  await menu.getByRole('button', { name: 'Split left / right', exact: true }).click()
}

async function wheel(page: Page, pane: Locator, deltas: number[]): Promise<UiSample> {
  const box = await scrollport(pane).boundingBox()
  if (!box) throw new Error('No transcript scrollport')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.evaluate(() => window.__hapiUiProbe.begin())
  for (const dy of deltas) { await page.mouse.wheel(0, dy); await page.waitForTimeout(40) }
  await paint(page)
  return page.evaluate(() => window.__hapiUiProbe.end())
}

async function visibleAnchor(pane: Locator) {
  return pane.evaluate(pane => {
    const port = pane.querySelector('[data-conversation-scroll]')!, viewport = port.getBoundingClientRect()
    const row = [...pane.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')].find(row => {
      const box = row.getBoundingClientRect()
      return box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom && !row.closest('[hidden]')
    })
    if (!row) throw new Error('No visible reading anchor')
    return { key: row.dataset.chatAnchorKey!, text: row.textContent?.slice(0, 160) ?? '', offset: row.getBoundingClientRect().top - viewport.top, scrollTop: port.scrollTop }
  })
}

async function offsetOf(pane: Locator, anchor: { key: string; text: string }) {
  return pane.evaluate((pane, anchor) => {
    // Reconciliation may renumber display nodes. The synthetic source text is
    // unique per answer, so also verify semantic continuity across generations.
    const matches = [...pane.querySelectorAll('[data-chat-anchor-key]')].filter(row => row.textContent?.slice(0, 160) === anchor.text)
    const row = pane.querySelector(`[data-chat-anchor-key="${CSS.escape(anchor.key)}"]`) ?? (matches.length === 1 ? matches[0] : undefined)
    return row ? row.getBoundingClientRect().top - pane.querySelector('[data-conversation-scroll]')!.getBoundingClientRect().top : null
  }, anchor)
}

export async function runUiAcceptance(session: WarmOfficialSession, repetitions: number) {
  const started = performance.now(), checks: Check[] = [], opens: Opening[] = [], scrolls: UiSample[] = []
  const errors: string[] = []
  const observations: Record<string, unknown> = {}
  let currentCheck = ''
  let activePage: Page | undefined
  const record = <T,>(value: T): T => { observations[currentCheck] = value; return value }
  const check = async (name: string, operation: () => Promise<unknown>): Promise<boolean> => {
    const at = performance.now()
    currentCheck = name
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { void activePage?.close().catch(() => {}); reject(new Error('UI checkpoint exceeded 30s; the page was closed to contain a possible renderer freeze')) }, 30_000)
    })
    try { const metrics = await Promise.race([operation(), deadline]); checks.push({ name, passed: true, elapsedMs: performance.now() - at, metrics }); process.stdout.write(`[ui] PASS ${name}\n`); return true }
    catch (error) { checks.push({ name, passed: false, elapsedMs: performance.now() - at, error: safe(error) }); process.stdout.write(`[ui] FAIL ${name}: ${safe(error).slice(0, 200)}\n`); return false }
    finally { clearTimeout(timer) }
  }
  let dshId: string | undefined
  await check('ordinary DSH fixture via official AgentLoop', async () => {
    const existing = await session.environment.rpc<{ items: Array<{ sessionId: string; title?: string }> }>('session/list')
    dshId = existing.items.find(row => row.title === 'Acceptance DSH Web')?.sessionId
    if (!dshId) {
      const created = await session.environment.rpc<{ sessionId: string }>('session/create', { cwd: session.environment.directory })
      dshId = created.sessionId
      await session.environment.rpc('session/selectModel', { sessionId: dshId, provider: 'fixture', model: 'fixture-model' })
      await session.environment.rpc('session/rename', { sessionId: dshId, title: 'Acceptance DSH Web' })
      await session.environment.rpc('session/prompt', { sessionId: dshId, requestId: `ui-seed-${crypto.randomUUID()}`, mode: 'queue', content: [{ type: 'text', text: 'Synthetic acceptance prompt' }] })
    }
  })
  for (let run = 0; run < repetitions; run++) {
    const page = await session.page()
    activePage = page
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' && /event feed subscriber failed|conversation Context .*received/.test(message.text()))
        errors.push(message.text().slice(0, 300))
    })
    await installUiProbe(page)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const metrics = async () => {
      const response = await cdp.send('Performance.getMetrics')
      return Object.fromEntries(response.metrics.filter(row => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'JSHeapUsedSize', 'Nodes'].includes(row.name)).map(row => [row.name, row.value]))
    }
    const prefix = `desktop ${run + 1}`
    if (!await check(`${prefix}: cold document ready`, async () => {
      const at = performance.now(); await session.admit(page)
      const time = await page.evaluate(() => performance.now())
      expect(time).toBeLessThan(UI_BUDGETS.coldWorkspaceMs)
      return { documentMs: time, admissionAndAutomationMs: performance.now() - at, ...await metrics() }
    })) continue
    if (!await check(`${prefix}: first body and editor`, async () => {
      const result = record(await open(page, 'alpha', 'Native history alpha in the official DSH Conversation.'))
      expect(Math.max(result.bodyMs, result.composerMs)).toBeLessThan(UI_BUDGETS.firstBodyMs)
      return result
    })) continue
    await check(`${prefix}: short content starts at top`, async () => {
      const geometry = await paneFor(page, 'alpha').evaluate(pane => {
        const port = pane.querySelector('[data-conversation-scroll]')!, flow = pane.querySelector('[data-chat-flow]')!
        return { gap: flow.getBoundingClientRect().top - port.getBoundingClientRect().top }
      })
      expect(geometry.gap).toBeLessThan(64); expect(geometry.gap).toBeGreaterThanOrEqual(-1)
      return geometry
    })
    await check(`${prefix}: sidebar hover cannot freeze the page`, async () => {
      await page.evaluate(() => window.__hapiUiProbe.begin())
      for (const key of ['alpha', 'beta', 'warm-history', 'accept-history', 'alpha', 'beta']) {
        await page.locator('.hapi-session-open').filter({ hasText: `Native Codex ${key}` }).first().hover()
        await page.waitForTimeout(70)
      }
      await paint(page)
      const sample = record(await page.evaluate(() => window.__hapiUiProbe.end()))
      expect(sample.frames.length).toBeGreaterThan(0)
      expect(Math.max(...sample.frames)).toBeLessThan(1000)
    })
    await check(`${prefix}: cached opens and drafts`, async () => {
      await composer(paneFor(page, 'alpha')).fill('Acceptance alpha draft')
      await open(page, 'beta', 'Native history beta in the official DSH Conversation.')
      await composer(paneFor(page, 'beta')).fill('Acceptance beta draft')
      const samples: Opening[] = []
      for (const key of ['alpha', 'beta', 'alpha', 'beta']) {
        const result = await open(page, key, `Native history ${key} in the official DSH Conversation.`)
        samples.push(result); opens.push(result)
        await expect(composer(paneFor(page, key))).toHaveText(`Acceptance ${key} draft`)
      }
      expect(Math.max(...samples.map(row => Math.max(row.bodyMs, row.composerMs)))).toBeLessThan(UI_BUDGETS.cachedBodyMs)
      return samples
    })
    await check(`${prefix}: navigation to restored body and editor, with draft`, async () => {
      await page.addInitScript(() => {
        const times: { body: number | null; editor: number | null } = { body: null, editor: null }
        Reflect.set(window, '__hapiReloadReady', times)
        const tick = () => {
          const pane = document.querySelector('.hapi-pane-focused')
          const input = pane?.querySelector('[data-composer-input][contenteditable="true"]')
          if (!times.editor && input?.getBoundingClientRect().height) times.editor = performance.now()
          if (!times.body && pane?.querySelector('[data-chat-flow]')?.textContent?.includes('Native history beta in the official DSH Conversation.')) times.body = performance.now()
          if (!times.body || !times.editor) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await page.reload()
      await page.waitForFunction(() => { const times = Reflect.get(window, '__hapiReloadReady'); return times?.body && times?.editor })
      const times = record(await page.evaluate(() => Reflect.get(window, '__hapiReloadReady') as { body: number; editor: number }))
      await expect(composer(paneFor(page, 'beta'))).toHaveText('Acceptance beta draft')
      expect(Math.max(times.body, times.editor)).toBeLessThan(UI_BUDGETS.coldWorkspaceMs)
      return times
    })
    if (!await check(`${prefix}: long history first paint`, async () => {
      const result = record(await open(page, 'accept-history', 'Synthetic final answer 180.'))
      expect(Math.max(result.bodyMs, result.composerMs)).toBeLessThan(UI_BUDGETS.firstBodyMs)
      return { ...result, ...await metrics() }
    })) continue
    const history = paneFor(page, 'accept-history')
    let pages = 0
    const onRequest = (request: import('@playwright/test').Request) => {
      if (new URL(request.url()).pathname === '/api/session/page' && request.postData()?.includes('"beforeSeq"')) pages++
    }
    page.on('request', onRequest)
    await check(`${prefix}: stationary prepend all frames <= 1px`, async () => {
      const loadOlder = history.locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
      // A 20-message opening window can fit on screen. Load enough official
      // history to establish a scrollable reading position before measuring.
      for (let page = 0; page < 3; page++) {
        if (await scrollport(history).evaluate(port => port.scrollHeight > port.clientHeight * 2)) break
        await expect(loadOlder).toBeEnabled()
        const before = pages
        await loadOlder.evaluate(button => (button as HTMLButtonElement).click())
        await expect.poll(() => pages).toBeGreaterThan(before)
        await expect(loadOlder).toBeEnabled()
      }
      const initialBox = (await scrollport(history).boundingBox())!
      await page.mouse.move(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 3)
      await page.mouse.wheel(0, -600)
      await expect(history.locator('[data-chat-following-tail]')).toHaveCount(0)
      // Let the official scroll controller settle before establishing a stationary baseline.
      await page.waitForTimeout(700)
      const before = pages
      await history.evaluate(pane => {
        const port = pane.querySelector('[data-conversation-scroll]')!
        const row = [...pane.querySelectorAll('[data-chat-anchor-key]')].find(row => row.getBoundingClientRect().bottom > port.getBoundingClientRect().top)!
        if (!row) throw new Error('No visible semantic anchor')
        window.__hapiUiProbe.begin()
        window.__hapiUiProbe.anchor = { row, port, offset: row.getBoundingClientRect().top - port.getBoundingClientRect().top }
      })
      // Request a page without moving the viewport: wheel(-120) itself moves
      // the anchor by 120px and cannot measure stationary prepend stability.
      await expect(loadOlder).toBeEnabled()
      await loadOlder.evaluate(button => (button as HTMLButtonElement).click())
      await page.waitForTimeout(300)
      const stationaryDiagnostic = record({
        pagesBefore: before,
        pagesNow: pages,
        dom: await history.evaluate(pane => ({
          loadEarlier: [...pane.querySelectorAll('button')].filter(button => /Load earlier/i.test(button.innerText)).length,
          anchors: pane.querySelectorAll('[data-chat-anchor-key]').length,
          flow: Boolean(pane.querySelector('[data-chat-flow]')),
          height: pane.querySelector<HTMLElement>('[data-conversation-scroll]')?.scrollHeight ?? 0,
        })),
        marks: (await page.evaluate(() => performance.getEntriesByType('mark').map(entry => entry.name)))
          .filter(name => /hapi-dsh:(flush|source|facade|seamless|loadOlder)/.test(name)).slice(-14),
      })
      void stationaryDiagnostic
      await expect.poll(() => pages, { timeout: 12_000 }).toBeGreaterThan(before)
      await expect(history.locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()).toBeEnabled()
      await page.waitForTimeout(300); await paint(page)
      const sample = await page.evaluate(() => window.__hapiUiProbe.end())
      const drift = Math.max(0, ...sample.anchorOffsets.map(Math.abs))
      record({ drift, sample, pages: pages - before })
      expect(sample.anchorOffsets.length).toBeGreaterThan(0); expect(sample.missingAnchors).toBe(0)
      expect(drift).toBeLessThanOrEqual(UI_BUDGETS.anchorPx)
      return { drift, frames: sample.frames, pages: pages - before }
    })
    await check(`${prefix}: continuous up and down`, async () => {
      // Off-screen rendering must not override DSH's searchable collapsed
      // groups: hidden="until-found" relies on content-visibility:hidden.
      const folded = await history.locator('[hidden="until-found"]').evaluateAll(rows => ({
        count: rows.length,
        visible: rows.filter(row => getComputedStyle(row).contentVisibility !== 'hidden' && getComputedStyle(row).display !== 'none').length,
      }))
      expect(folded.count).toBeGreaterThan(0); expect(folded.visible).toBe(0)
      const before = await metrics()
      const sample = await wheel(page, history, [...Array<number>(15).fill(-320), ...Array<number>(15).fill(320)])
      scrolls.push(sample)
      const result = record({ sample, p95: percentile(sample.frames, .95), maximum: Math.max(0, ...sample.frames), before, after: await metrics() })
      if (repetitions === 1 && (result.p95! > UI_BUDGETS.scrollP95Ms || result.maximum > UI_BUDGETS.maxFrameMs)) {
        await cdp.send('Profiler.enable'); await cdp.send('Profiler.start')
        await wheel(page, history, [...Array<number>(12).fill(-320), ...Array<number>(12).fill(320)])
        const { profile } = await cdp.send('Profiler.stop')
        const path = join(warmDirectory, `scroll-diagnostic-${Date.now()}.cpuprofile`)
        await writeFile(path, JSON.stringify(profile), { mode: 0o600 })
        observations[`${currentCheck} diagnostic profile`] = path
      }
      // Chromium rAF timestamps quantize three 60 Hz intervals to either
      // 50.0 or 50.1 ms. Keep raw measurements and allow only that resolution;
      // a fourth missed interval (~66.7 ms) must still fail.
      expect(result.p95).not.toBeNull(); expect(result.p95!).toBeLessThanOrEqual(UI_BUDGETS.scrollP95Ms + UI_BUDGETS.frameTimestampToleranceMs)
      expect(result.maximum).toBeLessThanOrEqual(UI_BUDGETS.maxFrameMs)
      return result
    })
    await check(`${prefix}: cached history reversal does not reload`, async () => {
      // Stay inside the already loaded window, then reverse without hitting its top edge.
      await scrollport(history).evaluate(element => { element.scrollTop = Math.max(1000, element.scrollHeight / 2) })
      await page.waitForTimeout(300)
      const before = pages, reads = session.historyRequests.length
      const sample = await wheel(page, history, [-120, -120, -120, 120, 120, 120])
      expect(pages).toBe(before); expect(session.historyRequests.length).toBe(reads)
      return { additionalPages: pages - before, additionalSourceReads: session.historyRequests.length - reads, sample }
    })
    await check(`${prefix}: live updates preserve reader and editor`, async () => {
      await composer(history).fill('Draft while reading and streaming')
      await scrollport(history).evaluate(port => { port.scrollTop = port.scrollHeight })
      await page.waitForTimeout(250)
      record({
        liveEdge: await history.evaluate(pane => {
          const port = pane.querySelector<HTMLElement>('[data-conversation-scroll]')
          return {
            following: Boolean(pane.querySelector('[data-chat-following-tail]')),
            toBottom: [...pane.querySelectorAll('button')].filter(button => [...button.classList].some(name => name.includes('toBottom'))).length,
            remaining: port === null ? null : port.scrollHeight - port.clientHeight - port.scrollTop,
          }
        }),
      })
      const identityBefore = await history.getAttribute('data-session-id')
      const input = await composer(history).elementHandle()
      const live = beginUiLive(session.environment.hapi, 'native-accept-history', 'indexed')
      const text = `Acceptance live answer ${crypto.randomUUID()}`
      const latencyMs: number[] = []
      let before: Awaited<ReturnType<typeof visibleAnchor>> | undefined
      try {
        for (let chunk = 1; chunk <= 6; chunk++) {
          const value = `${text}: ${'streaming content '.repeat(chunk)}`, emitted = performance.now()
          live.update(value)
          const reply = history.getByText(value.trim(), { exact: true })
          if (chunk === 1) await expect(reply).toBeVisible({ timeout: 1500 })
          else await expect(reply).toHaveCount(1, { timeout: 1500 })
          latencyMs.push(performance.now() - emitted)
          if (chunk === 1) {
            // Prove visible streaming before completion, then leave the tail
            // and prove subsequent chunks cannot steal the reading position.
            await scrollport(history).evaluate(port => { port.scrollTop = port.scrollHeight / 2 })
            await page.waitForTimeout(350)
            before = await visibleAnchor(history)
          }
        }
      } catch (error) {
        const catalog = await session.environment.rpc<{ items: Array<{ sessionId: string; running: boolean; projections: unknown }> }>('session/list', { _request: {} })
        const id = await history.getAttribute('data-session-id')
        record({ failure: safe(error), before, identityBefore, id, latencyMs,
          domText: await history.evaluate(pane => {
            const text = pane instanceof HTMLElement ? pane.innerText : String(pane.textContent ?? '')
            return {
              tail: text.slice(-600),
              hasStreaming: /streaming content/.test(text),
              anchorKeys: pane.querySelectorAll('[data-chat-anchor-key]').length,
              nodes: pane.querySelectorAll('*').length,
            }
          }),
          marks: (await page.evaluate(() => performance.getEntriesByType('mark').map(entry => entry.name)))
            .filter(name => /hapi-dsh:(live|loadOlder|flush)/.test(name)).slice(-20),
          liveFlow: (await page.evaluate(() => performance.getEntriesByType('mark').map(entry => entry.name)))
            .filter(name => /hapi-dsh:live:(queue|accepted|mapped|retention|commit|after-commit|chunks)/.test(name)).slice(-16),
          streamTexts: await history.evaluate(pane => [...pane.querySelectorAll('*')]
            .filter(element => element.children.length === 0 && /streaming content|Acceptance live answer/.test(element.textContent ?? ''))
            .slice(0, 8).map(element => ({ tag: element.tagName, cls: String(element.className).slice(0, 50), text: (element.textContent ?? '').slice(0, 180) }))),
          state: catalog.items.find(row => row.sessionId === id),
          text: (await history.innerText()).slice(-1600),
          anchors: await history.locator('[data-chat-anchor-key]').evaluateAll(rows => rows.map(e => e.getAttribute('data-chat-anchor-key'))) })
        throw error
      } finally { live.finish() }
      if (!before) throw new Error('The first live frame never became visible')
      await expect(history.getByText(`${text}: ${'streaming content '.repeat(6).trim()}`, { exact: true })).toHaveCount(1)
      const after = await offsetOf(history, before)
      record({ before, after, latencyMs, drift: after === null ? null : Math.abs(after - before.offset), identityBefore,
        identityAfter: await history.getAttribute('data-session-id'), reading: await history.evaluate(pane => ({
          states: [...pane.querySelectorAll('[data-hapi-reading]')].map(e => e.getAttribute('data-hapi-reading')),
          errors: [...pane.querySelectorAll('.hapi-reading-error')].map(e => e.textContent),
          anchors: [...pane.querySelectorAll('[data-chat-anchor-key]')].map(e => e.getAttribute('data-chat-anchor-key')),
        })) })
      expect(after).not.toBeNull()
      expect(Math.abs(after! - before.offset)).toBeLessThanOrEqual(1)
      await expect(composer(history)).toHaveText('Draft while reading and streaming')
      expect(await input!.evaluate(element => element.isConnected)).toBe(true)
    })
    await check(`${prefix}: disconnected source retains visible body and draft`, async () => {
      const before = session.environment.hapi.sent.length
      const body = history.locator('[data-chat-flow]').first(), anchor = await visibleAnchor(history)
      const reading = () => history.evaluate(pane => ({ state: [...pane.querySelectorAll('[data-hapi-reading]')].map(row => row.getAttribute('data-hapi-reading')),
        bookmarks: Object.fromEntries(Object.keys(sessionStorage).filter(key => key.startsWith('hapi-dsh:reload-reading:')).map(key => [key, sessionStorage.getItem(key)])),
        errors: [...pane.querySelectorAll('.hapi-reading-error')].map(row => row.textContent) }))
      const readingBefore = await reading()
      const connections = session.environment.hapi.eventConnections
      session.environment.hapi.disconnectEvents()
      await expect(body).toBeVisible()
      await expect(composer(history)).toHaveText('Draft while reading and streaming')
      await expect.poll(() => session.environment.hapi.eventConnections, { timeout: 10_000 }).toBeGreaterThan(connections)
      await expect.poll(() => offsetOf(history, anchor), { timeout: 10_000 }).not.toBeNull()
      const after = await offsetOf(history, anchor)
      record({ anchor, after, readingBefore, readingAfter: await reading() })
      expect(after).not.toBeNull(); expect(Math.abs(after! - anchor.offset)).toBeLessThanOrEqual(1)
      expect(session.environment.hapi.sent.length).toBe(before)
    })
    await check(`${prefix}: 2 and 4 independent panes`, async () => {
      const counts: unknown[] = []
      for (const key of ['alpha', 'beta', 'warm-history']) {
        await split(page)
        await open(page, key, key === 'warm-history' ? 'Synthetic final answer 70.' : `Native history ${key} in the official DSH Conversation.`)
        await composer(paneFor(page, key)).fill(`Independent ${key}`)
        const count = await page.locator('.hapi-pane').count()
        const scroll = count === 2 || count === 4 ? await wheel(page, history, [-160, -160, -160, 160, 160, 160]) : undefined
        counts.push({ panes: count, ...(scroll ? { scroll, p95: percentile(scroll.frames, .95) } : {}), ...await metrics() })
      }
      for (const key of ['alpha', 'beta', 'warm-history']) await expect(composer(paneFor(page, key))).toHaveText(`Independent ${key}`)
      expect(await page.locator('.hapi-pane').count()).toBe(4)
      return counts
    })
    await check(`${prefix}: isolated approval and close only view`, async () => {
      const id = `accept-approval-${crypto.randomUUID()}`
      session.environment.hapi.requestApproval('native-alpha', id)
      await expect(paneFor(page, 'alpha').locator(`[data-native-request="${id}"]`)).toBeVisible()
      await expect(paneFor(page, 'beta').locator('[data-native-request]')).toHaveCount(0)
      session.environment.hapi.settleApproval('native-alpha', id)
      const before = session.environment.hapi.aborted.length
      const pane = page.locator('.hapi-pane-focused')
      await pane.locator('.hapi-pane-header').getByRole('button', { name: 'Close pane', exact: true }).click()
      await expect(page.locator('.hapi-pane')).toHaveCount(3)
      expect(session.environment.hapi.aborted.length).toBe(before)
    })
    await check(`${prefix}: queued edit preserves the other draft`, async () => {
      const alpha = paneFor(page, 'alpha'), beta = paneFor(page, 'beta')
      await composer(alpha).fill('Acceptance queued text')
      const sent = session.environment.hapi.sent.length
      await composer(alpha).press('Enter')
      await expect.poll(() => session.environment.hapi.sent.length).toBe(sent + 1)
      const delivery = session.environment.hapi.sent.at(-1)!
      await expect(composer(alpha)).toHaveText('')
      await alpha.getByRole('button', { name: 'Edit queued message', exact: true }).click()
      await expect.poll(() => session.environment.hapi.cancelled.includes(delivery.message.localId)).toBe(true)
      await expect(composer(alpha)).toHaveText('Acceptance queued text')
      await expect(composer(beta)).toHaveText('Independent beta')
      expect(session.environment.hapi.sent.length).toBe(sent + 1)
      await expect(alpha.locator('[data-slot="conversation.input.dock"] .hapi-queued-edit-recovery')).toHaveCount(0)
      // A successful edit may already be acknowledged. Any retained recovery
      // receipt must live behind this pane's existing menu, never in the input
      // dock or in another persistent status button.
      const recovery = alpha.locator('.hapi-queued-edit-recovery')
      if (await recovery.count()) {
        expect(await recovery.evaluateAll(rows => rows.every(row => row.closest('.hapi-pane-header') !== null))).toBe(true)
        const menu = alpha.locator('.hapi-pane-header .hapi-pane-menu')
        const status = menu.locator('.hapi-pane-source-status')
        await expect(status).toBeHidden()
        await menu.locator(':scope > summary').click()
        await status.locator(':scope > summary').click()
        await expect(recovery).toBeVisible()
        await menu.locator(':scope > summary').click()
        await expect(status).toBeHidden()
      }
    })
    await check(`${prefix}: ordinary DSH body and editor`, async () => {
      const result = record(await openTitle(page, 'Acceptance DSH Web', 'DSH fixture response through the official AgentLoop.'))
      expect(Math.max(result.bodyMs, result.composerMs)).toBeLessThan(UI_BUDGETS.firstBodyMs)
      const flow = page.locator('.hapi-pane-focused [data-chat-flow]').first()
      const box = await flow.boundingBox()
      expect(box!.width).toBeGreaterThan(100)
      expect(await page.locator('iframe').count()).toBe(0)
      return result
    })
    if (run === 0) await check('voice and PNG capture load only on use', async () => {
      await open(page, 'alpha', 'Native history alpha in the official DSH Conversation.')
      const chunks = () => page.evaluate(() => window.__hapiUiProbe.loadedChunks)
      expect(await chunks()).toEqual([])
      const alpha = paneFor(page, 'alpha')
      await alpha.getByRole('button', { name: 'Voice and dictation', exact: true }).click()
      const voice = page.getByRole('dialog', { name: 'Voice and dictation', exact: true })
      await expect(voice).toBeVisible()
      await expect.poll(async () => (await chunks()).some(path => path.endsWith('client.voice.js'))).toBe(true)
      await voice.getByRole('button', { name: 'Close voice', exact: true }).click()
      await expect(voice).toHaveCount(0)
      await alpha.getByRole('button', { name: 'Share this turn', exact: true }).first().click()
      const share = page.getByRole('dialog', { name: 'Share this turn', exact: true })
      await expect(share.locator('[data-hapi-share-preview]')).toContainText('Native history alpha')
      const downloaded = page.waitForEvent('download')
      await share.getByRole('button', { name: 'Save PNG', exact: true }).click()
      const file = await downloaded, bytes = await readFile((await file.path())!)
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(bytes.readUInt32BE(20)).toBeGreaterThan(100)
      await expect.poll(async () => (await chunks()).some(path => path.endsWith('client.capture.js'))).toBe(true)
      await share.getByRole('button', { name: 'Close share preview', exact: true }).click()
    })
    page.off('request', onRequest)
  }
  for (const width of [360, 390]) {
    await check(`mobile ${width}: full width, compact controls, keyboard and rotation`, async () => {
      const page = await session.page({ width, height: 844 }, true)
      activePage = page
      page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' && /event feed subscriber failed|conversation Context .*received/.test(message.text()))
        errors.push(message.text().slice(0, 300))
    })
      await installUiProbe(page); await session.admit(page)
      // Mobile picker is the public entry point; use its normal session button.
      const picker = page.locator('.hapi-mobile-back')
      if (await picker.isVisible()) await picker.click()
      await open(page, 'alpha', 'Native history alpha in the official DSH Conversation.')
      const pane = paneFor(page, 'alpha')
      await composer(pane).fill('Mobile draft survives width changes')
      const measure = () => pane.evaluate(pane => {
        const size = (selector: string) => pane.querySelector(selector)?.getBoundingClientRect().height ?? 0
        return { left: pane.getBoundingClientRect().left, width: pane.getBoundingClientRect().width, viewport: innerWidth,
          overflow: document.documentElement.scrollWidth - innerWidth, composer: size('[data-composer-card]'), header: size('.hapi-pane-header'),
          bottom: document.querySelector('.hapi-statusbar')?.getBoundingClientRect().height ?? 0,
          scrollBoundary: { root: getComputedStyle(document.documentElement).overscrollBehaviorY,
            body: getComputedStyle(document.body).overscrollBehaviorY,
            transcript: getComputedStyle(pane.querySelector('[data-conversation-scroll]')!).overscrollBehaviorY } }
      })
      const portrait = await measure()
      expect(portrait.left).toBeLessThanOrEqual(2); expect(portrait.width).toBeGreaterThanOrEqual(width - 4)
      expect(portrait.overflow).toBeLessThanOrEqual(1)
      expect(portrait.composer).toBeLessThanOrEqual(UI_BUDGETS.mobileComposerPx)
      expect(portrait.header).toBe(UI_BUDGETS.mobileHeaderPx)
      expect(portrait.bottom).toBeLessThanOrEqual(UI_BUDGETS.mobileBottomPx)
      // Headless Chromium has no Android refresh spinner. Verify the effective
      // browser CSS contract rather than claiming a physical Chrome UI test.
      expect(portrait.scrollBoundary).toEqual({ root: 'none', body: 'none', transcript: 'contain' })
      await page.setViewportSize({ width, height: 440 }); await expect(composer(pane)).toBeVisible()
      await page.setViewportSize({ width: 844, height: width }); await expect(composer(pane)).toHaveText('Mobile draft survives width changes')
      await page.setViewportSize({ width, height: 844 }); await expect(composer(pane)).toHaveText('Mobile draft survives width changes')
      await expect(pane.locator('.hapi-pane-header')).toBeHidden()
      return { portrait, restored: await measure(), device: 'Chromium mobile emulation; viewport resize is not a physical soft keyboard' }
    })
  }
  await check('browser errors', async () => { expect(errors).toEqual([]) })
  if (opens.length) await check('warm body p95', async () => {
    const p95 = percentile(opens.map(row => row.bodyMs), .95)!
    expect(p95).toBeLessThan(UI_BUDGETS.warmBodyMs); return { samples: opens, p95 }
  })
  session.checked()
  return { schema: 1, passed: checks.every(row => row.passed), environment: 'pinned official DSH + synthetic HAPI wire; local Chromium',
    repetitions, durationMs: performance.now() - started, budgets: UI_BUDGETS, checks,
    observations, openingSamples: opens, scrollSamples: scrolls, errors, runtime: session.status(),
    hostLoad: { availableCpus: availableParallelism(), loadAverage: loadavg() } }
}
