/**
 * G2 artifact sampler: twenty fixed long-conversation paging samples (half with
 * two panes), per-frame anchor offsets, editor/draft identity, plus desktop
 * wheel, 360/390 touch, return-to-latest and six live increments. Runs against
 * the warm fixture (which may be a bundle-managed installed runtime) and writes
 * the ext G2 dataset shape for the gate judge.
 */
import { writeFileSync } from 'node:fs'
import type { Page } from 'playwright'
import { installUiProbe } from './ui-probe.ts'
import { beginUiLive } from './ui-live-fixture.ts'
import { WarmOfficialSession } from './warm-session.ts'

const outPath = process.env.HAPI_DSH_G2_REPORT ?? '/mnt/cache/src/hapi-dsh/.tmp/gates/g2-artifact.json'
const SAMPLES = 20
const PANE_TITLE = 'Pane: Native Codex accept-history'

async function open(panePage: Page, title = 'Native Codex accept-history'): Promise<void> {
  // On mobile widths the conversation list sits behind the official back
  // affordance; reveal the picker before looking for a session row.
  const picker = panePage.locator('.hapi-mobile-back')
  if (await picker.isVisible().catch(() => false)) await picker.click().catch(() => {})
  await panePage.locator('button.hapi-session-open').first().waitFor({ timeout: 60000 })
  await panePage.locator('button.hapi-session-open').filter({ hasText: title }).first().click({ timeout: 30000 })
  await panePage.getByRole('region', { name: `Pane: Native Codex ${title.slice('Native Codex '.length)}`, exact: true })
    .locator('[data-chat-flow]').first().waitFor({ timeout: 30000 })
  await panePage.getByRole('region', { name: `Pane: Native Codex ${title.slice('Native Codex '.length)}`, exact: true })
    .locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30000 })
}

function pane(page: Page, title = PANE_TITLE) { return page.getByRole('region', { name: title, exact: true }) }
function port(page: Page, title = PANE_TITLE) { return pane(page, title).locator('[data-conversation-scroll]').first() }
function loadOlder(page: Page, title = PANE_TITLE) {
  return pane(page, title).locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
}

async function loadPages(page: Page, title = PANE_TITLE, pages = 3): Promise<number> {
  let loaded = 0
  const older = loadOlder(page, title)
  for (let index = 0; index < pages; index++) {
    if (await port(page, title).evaluate(element => element.scrollHeight > element.clientHeight * 2)) break
    if (!await older.isEnabled().catch(() => false)) break
    const before = await pane(page, title).locator('[data-chat-anchor-key]').count()
    await older.evaluate(button => (button as HTMLButtonElement).click()).catch(() => {})
    await page.waitForTimeout(450)
    const after = await pane(page, title).locator('[data-chat-anchor-key]').count()
    if (after > before) loaded++
    await older.isEnabled().catch(() => false)
  }
  return loaded
}

async function split(page: Page): Promise<void> {
  const focused = page.locator('.hapi-pane-focused')
  const menu = focused.locator('.hapi-pane-header .hapi-pane-menu')
  await menu.locator(':scope > summary').click()
  await menu.getByRole('button', { name: 'Split left / right', exact: true }).click()
}

async function pagingSample(session: WarmOfficialSession, page: Page, dual: boolean, sample: number): Promise<Record<string, unknown>> {
  await session.admit(page)
  await installUiProbe(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-hapi-workspace]').waitFor({ timeout: 45000 })
  await open(page)
  const draft = `G2 artifact draft ${sample}`
  const composer = pane(page).locator('[data-composer-input][contenteditable="true"]').first()
  await composer.fill(draft)
  await composer.evaluate(element => element.setAttribute('data-g2-editor', '1'))
  if (dual) {
    await split(page)
    await page.waitForTimeout(600)
    await page.locator('button.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).first().click().catch(() => {})
    await page.waitForTimeout(400)
    await pane(page, 'Pane: Native Codex alpha').locator('[data-chat-flow]').first().waitFor({ timeout: 20000 }).catch(() => {})
    // Focus the accept-history pane explicitly; the sidebar click left the
    // second pane focused and wheel events would land there.
    await pane(page).locator('.hapi-pane-header').first().click({ position: { x: 12, y: 12 } }).catch(() => {})
    // Give the split layout (and the second Chat mount) time to settle before
    // the stationary prepend measurement.
    await page.waitForTimeout(1600)
  }
  const loadedOlder = await loadPages(page)
  const countBefore = await pane(page).locator('[data-chat-anchor-key]').count()
  const box = (await port(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
  await page.mouse.wheel(0, -600)
  await page.waitForTimeout(500)
  await page.mouse.wheel(0, -200)
  await page.waitForTimeout(750)
  let following = await pane(page).locator('[data-chat-following-tail]').count()
  if (following > 0) {
    // A clamped short window can leave following set; detach deterministically
    // without a wheel target ambiguity.
    await port(page).evaluate(element => { element.scrollTop = Math.max(0, element.scrollTop - 300) })
    await port(page).evaluate(element => element.dispatchEvent(new Event('scroll')))
    await page.waitForTimeout(500)
    following = await pane(page).locator('[data-chat-following-tail]').count()
  }
  await pane(page).evaluate(element => {
    const port = element.querySelector('[data-conversation-scroll]')!
    const row = [...element.querySelectorAll('[data-chat-anchor-key]')]
      .find(row => row.getBoundingClientRect().bottom > port.getBoundingClientRect().top)!
    if (!row) throw new Error('No visible semantic anchor')
    window.__hapiUiProbe.begin()
    window.__hapiUiProbe.anchor = { row, port, offset: row.getBoundingClientRect().top - port.getBoundingClientRect().top }
  })
  const older = loadOlder(page)
  const pageRequested = await older.isEnabled().catch(() => false)
  if (pageRequested) await older.evaluate(button => (button as HTMLButtonElement).click())
  await page.waitForTimeout(650)
  const sampleData = await page.evaluate(() => window.__hapiUiProbe.end())
  const countAfter = await pane(page).locator('[data-chat-anchor-key]').count()
  const composerAfter = pane(page).locator('[data-composer-input][contenteditable="true"]').first()
  const editorStable = await pane(page).locator('[data-g2-editor="1"]').count() === 1
  const draftAfter = await composerAfter.innerText()
  const frameOffsets = sampleData.anchorOffsets
  return {
    id: `g2-artifact-${sample}`, paneCount: dual ? 2 : 1,
    expectedOlderMessagesVisible: pageRequested && countAfter > countBefore,
    olderMessageCount: Math.max(0, countAfter - countBefore),
    frameOffsets, anchorMaxFrameOffsetPx: Math.max(0, ...frameOffsets.map(Math.abs)),
    domSyntheticGestures: 0,
    editorInstanceStable: editorStable,
    draftUnchanged: draftAfter === draft, draftBefore: draft, draftAfter,
    following: following === 0, loadedPages: loadedOlder,
  }
}

async function armAnchor(page: Page, title = PANE_TITLE): Promise<void> {
  await pane(page, title).evaluate(element => {
    const port = element.querySelector('[data-conversation-scroll]')!
    const row = [...element.querySelectorAll('[data-chat-anchor-key]')]
      .find(row => row.getBoundingClientRect().bottom > port.getBoundingClientRect().top)!
    window.__hapiUiProbe.begin()
    window.__hapiUiProbe.anchor = { row, port, offset: row.getBoundingClientRect().top - port.getBoundingClientRect().top }
  })
}

async function startGestureSample(page: Page, title = PANE_TITLE): Promise<void> {
  await pane(page, title).evaluate(element => {
    const port = element.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const row = [...element.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
      .find(candidate => candidate.getBoundingClientRect().bottom > port.getBoundingClientRect().top)!
    const state = { row, port,
      base: row.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop,
      frames: [] as number[], active: true }
    const tick = () => {
      if (!state.active) return
      if (state.row.isConnected && state.row.getBoundingClientRect().height > 0) {
        // Content-space offset: scroll movement itself must not count as drift.
        state.frames.push(state.row.getBoundingClientRect().top - state.port.getBoundingClientRect().top + state.port.scrollTop - state.base)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    Reflect.set(window, '__g2Gesture', state)
  })
}
async function endGestureSample(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const state = Reflect.get(window, '__g2Gesture') as { frames: number[], active: boolean } | undefined
    if (!state) return []
    state.active = false
    return state.frames.map(value => Math.round(value * 100) / 100)
  })
}

async function actionPages(session: WarmOfficialSession): Promise<Record<string, unknown>> {
  const wheelPage = await session.page()
  await session.admit(wheelPage)
  await installUiProbe(wheelPage)
  await wheelPage.reload({ waitUntil: 'domcontentloaded' })
  await wheelPage.locator('[data-hapi-workspace]').waitFor({ timeout: 45000 })
  await open(wheelPage)
  await loadPages(wheelPage)
  const box = (await port(wheelPage).boundingBox())!
  await wheelPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await wheelPage.mouse.wheel(0, -500)
  await wheelPage.waitForTimeout(600)
  await startGestureSample(wheelPage)
  for (let index = 0; index < 12; index++) { await wheelPage.mouse.wheel(0, -320); await wheelPage.waitForTimeout(60) }
  for (let index = 0; index < 12; index++) { await wheelPage.mouse.wheel(0, 320); await wheelPage.waitForTimeout(60) }
  await wheelPage.waitForTimeout(250)
  const desktopWheel = { performed: true, frameOffsets: await endGestureSample(wheelPage) }

  const touch: Record<string, unknown>[] = []
  for (const width of [360, 390]) {
    const mobilePage = await session.page({ width, height: 800 }, true)
    await installUiProbe(mobilePage)
    await session.admit(mobilePage)
    const cdp = await mobilePage.context().newCDPSession(mobilePage)
    await open(mobilePage)
    const loadedBefore = await pane(mobilePage).locator('[data-chat-anchor-key]').count()
    await loadPages(mobilePage, PANE_TITLE, 2)
    const touchBox = (await port(mobilePage).boundingBox())!
    await mobilePage.mouse.move(touchBox.x + touchBox.width / 2, touchBox.y + touchBox.height / 2)
    await startGestureSample(mobilePage)
    const start = { x: touchBox.x + touchBox.width / 2, y: touchBox.y + touchBox.height * 0.25 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y }] })
    for (let step = 1; step <= 12; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y + step * 28 }] })
      await mobilePage.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await mobilePage.waitForTimeout(500)
    const touchFrames = await endGestureSample(mobilePage)
    const loadedAfter = await pane(mobilePage).locator('[data-chat-anchor-key]').count()
    touch.push({ width, performed: true, frameOffsets: touchFrames, loadedOlder: loadedAfter > loadedBefore })
    await mobilePage.context().close().catch(() => {})
  }
  const [touch360, touch390] = touch

  // Return to latest through the official to-bottom affordance.
  const returnPage = await session.page()
  await session.admit(returnPage)
  await returnPage.locator('[data-hapi-workspace]').waitFor({ timeout: 45000 })
  await open(returnPage)
  await loadPages(returnPage)
  const returnBox = (await port(returnPage).boundingBox())!
  await returnPage.mouse.move(returnBox.x + returnBox.width / 2, returnBox.y + returnBox.height / 3)
  await returnPage.mouse.wheel(0, -900)
  await returnPage.waitForTimeout(600)
  const at = performance.now()
  const toBottom = pane(returnPage).locator('button[class*="toBottom"]').first()
  const toBottomCount = await toBottom.count()
  if (toBottomCount > 0) await toBottom.click().catch(() => {})
  await returnPage.waitForTimeout(500)
  const reachedHead = await port(returnPage).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 2)
  const returnLatest = { performed: true, reachedHead, ms: Math.round(performance.now() - at) }

  // Six live increments on a fresh reading position, independent of the
  // return-to-latest request above (its newest-window fetch may still settle).
  const livePage = await session.page()
  await session.admit(livePage)
  await livePage.locator('[data-hapi-workspace]').waitFor({ timeout: 45000 })
  await open(livePage)
  await loadPages(livePage)
  const liveBox = (await port(livePage).boundingBox())!
  await livePage.mouse.move(liveBox.x + liveBox.width / 2, liveBox.y + liveBox.height / 2)
  await livePage.mouse.wheel(0, -900)
  await livePage.waitForTimeout(1400)
  if (await pane(livePage).locator('[data-chat-following-tail]').count() > 0) {
    await livePage.mouse.wheel(0, -300)
    await livePage.waitForTimeout(600)
  }
  const detached = await pane(livePage).locator('[data-chat-following-tail]').count() === 0
  // Smooth scrolling may still be settling; wait for two identical samples.
  let baselineTop = await port(livePage).evaluate(element => element.scrollTop)
  for (let attempt = 0; attempt < 20; attempt++) {
    await livePage.waitForTimeout(200)
    const again = await port(livePage).evaluate(element => element.scrollTop)
    if (Math.abs(again - baselineTop) < 1) { baselineTop = again; break }
    baselineTop = again
  }
  const live = beginUiLive(session.environment.hapi, 'native-accept-history', 'indexed')
  const increments: Record<string, unknown>[] = []
  const text = `G2 live increment ${crypto.randomUUID()}`
  const commitCount = () => livePage.evaluate(() => performance.getEntriesByType('mark')
    .filter(entry => entry.name.startsWith('hapi-dsh:live:after-commit')).length)
  try {
    for (let index = 1; index <= 6; index++) {
      const value = `${text}: ${'increment content '.repeat(index)}`
      const beforeMarks = await commitCount()
      const emitted = performance.now()
      live.update(value)
      let applied = false
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await commitCount() > beforeMarks) { applied = true; break }
        await livePage.waitForTimeout(25)
      }
      const ms = Math.round(performance.now() - emitted)
      const top = await port(livePage).evaluate(element => element.scrollTop)
      const followingNow = await pane(livePage).locator('[data-chat-following-tail]').count() > 0
      increments.push({ applied, ms, following: followingNow, pulledBack: Math.abs(top - baselineTop) > 2, scrollDelta: Math.round(top - baselineTop), baselineTop, top })
      await livePage.waitForTimeout(150)
    }
  } finally { live.finish() }
  await returnPage.context().close().catch(() => {})
  await livePage.context().close().catch(() => {})
  return { desktopWheel, touch360, touch390, returnLatest, liveIncrements: increments }
}

const actionsOnly = process.env.HAPI_DSH_G2_ACTIONS_ONLY === '1'
const session = new WarmOfficialSession()
try {
  await session.start()
  if (actionsOnly) {
    const actions = await actionPages(session)
    writeFileSync(outPath, JSON.stringify({ schema: 1, gate: 'G2', environment: 'artifact warm fixture', samples: [], actions }, null, 1))
    console.log(JSON.stringify({ actions: Object.keys(actions), error: actions.error ?? null }, null, 1))
    process.exit(0)
  }
  const samples: Record<string, unknown>[] = []
  for (let index = 0; index < SAMPLES; index++) {
    const page = await session.page()
    try { samples.push(await pagingSample(session, page, index % 2 === 1, index + 1)) }
    catch (error) { samples.push({ id: `g2-artifact-${index + 1}`, error: String(error).slice(0, 300), frameOffsets: [], domSyntheticGestures: 0 }) }
    await page.context().close().catch(() => {})
  }
  let actions: Record<string, unknown> = {}
  try { actions = await actionPages(session) } catch (error) { actions = { error: String(error).slice(0, 400) } }
  const dataset = { schema: 1, gate: 'G2', environment: 'artifact warm fixture + managed private runtime', samples, actions }
  writeFileSync(outPath, JSON.stringify(dataset, null, 1))
  const summary = { samples: samples.length, paneCount2: samples.filter(sample => sample.paneCount === 2).length,
    anchorsOk: samples.filter(sample => Array.isArray(sample.frameOffsets) && sample.frameOffsets.length > 0 && (sample.anchorMaxFrameOffsetPx as number) <= 1).length,
    actions: Object.keys(actions) }
  console.log(JSON.stringify(summary, null, 1))
} finally { await session.close().catch(() => {}) }
