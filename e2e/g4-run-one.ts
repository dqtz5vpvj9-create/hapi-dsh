/**
 * G4 child: run the twelve default-path scenarios three times against one
 * composition (original rc.3 or one feature-switch combination) and write the
 * normalized-able observations. The parent runs this once per variant.
 */
import { writeFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright'
import { chromium } from '@playwright/test'
import { initialWorkspace } from '../src/client/model.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { beginUiLive } from './ui-live-fixture.ts'

const variant = process.env.HAPI_DSH_G4_VARIANT ?? 'original'
const combo = process.env.HAPI_DSH_G4_COMBO ?? '111'
const outPath = process.env.HAPI_DSH_G4_OUT ?? '/mnt/cache/src/hapi-dsh/.tmp/gates/g4-variant.json'
const ROUNDS = Number(process.env.HAPI_DSH_G4_ROUNDS ?? '3')
const ALL_SCENARIOS = ['open', 'page-older', 'page-newer', 'send', 'queue', 'approval', 'reconnect', 'close',
  'draft', 'live-update', 'split-pane', 'restore'] as const
const SCENARIOS = process.env.HAPI_DSH_G4_ONLY
  ? ALL_SCENARIOS.filter(scenario => process.env.HAPI_DSH_G4_ONLY!.split(',').includes(scenario)) : ALL_SCENARIOS

function panel(page: Page, title: string) { return page.getByRole('region', { name: `Pane: ${title}`, exact: true }) }
function composer(page: Page, title: string) {
  return panel(page, title).locator('[data-composer-input][contenteditable="true"]').first()
}
async function resetLayout(environment: OfficialEnvironment): Promise<void> {
  const document = await environment.rpc<{ revision: number }>('hapi/workspaceGet')
  let serial = 0
  await environment.rpc('hapi/workspacePut', { expectedRevision: document.revision,
    operationId: `g4-reset-${crypto.randomUUID()}`, state: initialWorkspace(() => `g4-layout-${++serial}`) })
}
async function makePage(environment: OfficialEnvironment, browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
  if (variant !== 'original' && combo !== '111') {
    await context.addInitScript(bits => {
      const [history, mounted, window] = bits.split('')
      if (history === '0') Reflect.set(globalThis, '__DSH_CLIENT_HISTORY_SOURCE', 'off')
      if (mounted === '0') Reflect.set(globalThis, '__DSH_CLIENT_MOUNTED_CHAT', 'off')
      if (window === '0') Reflect.set(globalThis, '__DSH_CLIENT_WINDOW_COMMIT', 'off')
    }, combo)
  }
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  await resetLayout(environment)
  await page.request.get(environment.launchUrl, { maxRedirects: 0 })
  await page.goto(environment.origin + '/', { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.locator('[data-hapi-workspace]').waitFor({ timeout: 60_000 })
  const notice = page.getByRole('dialog', { name: /^(Preview Notice|预览版说明)$/ })
  if (await notice.isVisible().catch(() => false)) await notice.getByRole('button', { name: /^(Continue|继续)$/ }).click().catch(() => {})
  return page
}
async function openTitle(page: Page, title: string): Promise<void> {
  const row = page.locator('button.hapi-session-open').filter({ hasText: title }).first()
  await row.waitFor({ timeout: 30_000 })
  await row.click()
  await page.getByRole('region', { name: `Pane: ${title}`, exact: true })
    .locator('[data-chat-flow]').first().waitFor({ timeout: 30_000 })
  await composer(page, title).waitFor({ timeout: 30_000 })
}
async function addFixture(environment: OfficialEnvironment, name: string) {
  const fixture = environment.hapi.add(`g4-${name}`, 'Laptop', 'machine-alpha')
  environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
  return fixture
}
async function runScenario(environment: OfficialEnvironment, page: Page, scenario: string, round: number, title: string): Promise<void> {
  const fixture = await addFixture(environment, `${scenario}-${round}`)
  const secondTitle = `Native Codex g4-${scenario}-${round}-b`
  switch (scenario) {
    case 'open': await openTitle(page, title); break
    case 'page-older': {
      await openTitle(page, title)
      const load = panel(page, title).locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
      for (let index = 0; index < 2; index++) {
        if (!await load.isEnabled().catch(() => false)) break
        await load.evaluate(button => (button as HTMLButtonElement).click()).catch(() => {})
        await page.waitForTimeout(450)
      }
      break
    }
    case 'page-newer': {
      await openTitle(page, title)
      const load = panel(page, title).locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
      await load.evaluate(button => (button as HTMLButtonElement).click()).catch(() => {})
      await page.waitForTimeout(400)
      const bottom = panel(page, title).locator('button[class*="toBottom"]').first()
      if (await bottom.count()) await bottom.click().catch(() => {})
      else await panel(page, title).locator('[data-conversation-scroll]').first().evaluate(element => { element.scrollTop = element.scrollHeight })
      await page.waitForTimeout(400)
      break
    }
    case 'send': {
      await openTitle(page, title)
      await composer(page, title).fill(`G4 send ${round}`)
      await composer(page, title).press('Enter')
      await page.waitForTimeout(900)
      break
    }
    case 'queue': {
      fixture.session.execution = { ...fixture.session.execution!, sequence: (fixture.session.execution?.sequence ?? 1) + 1,
        status: 'active', turnId: 'g4-queue', startedAt: Date.now(), completedAt: null, waitingOn: [] }
      fixture.session.executionVersion = (fixture.session.executionVersion ?? 0) + 1
      environment.hapi.emit({ type: 'session-updated', sessionId: fixture.session.id })
      await openTitle(page, title)
      await composer(page, title).fill(`G4 queued ${round}`)
      await composer(page, title).press('Enter')
      await page.waitForTimeout(900)
      break
    }
    case 'approval': {
      environment.hapi.requestApproval(fixture.session.id, `g4-approval-${round}`)
      await openTitle(page, title)
      await page.waitForTimeout(500)
      const approve = panel(page, title).getByRole('button', { name: /^(Approve|允许|批准|接受)/ }).first()
      if (await approve.count()) await approve.click().catch(() => {})
      await page.waitForTimeout(600)
      break
    }
    case 'reconnect': {
      await openTitle(page, title)
      environment.hapi.disconnectEvents()
      await page.waitForTimeout(1600)
      if (!await composer(page, title).isVisible().catch(() => false)) await openTitle(page, title)
      await page.waitForTimeout(2400)
      break
    }
    case 'close': {
      await openTitle(page, title)
      const pane = panel(page, title)
      const close = pane.locator('.hapi-pane-header').getByRole('button', { name: 'Close pane', exact: true }).first()
      if (await close.count()) await close.click().catch(() => {})
      await page.waitForTimeout(500)
      break
    }
    case 'draft': {
      await openTitle(page, title)
      await composer(page, title).fill(`G4 draft ${round}`)
      await addFixture(environment, `${scenario}-${round}-b`)
      await page.locator('button.hapi-session-open').filter({ hasText: secondTitle }).first().click().catch(() => {})
      await page.waitForTimeout(500)
      await page.locator('button.hapi-session-open').filter({ hasText: title }).first().click().catch(() => {})
      await page.waitForTimeout(700)
      break
    }
    case 'live-update': {
      const live = beginUiLive(environment.hapi, fixture.session.id, 'indexed')
      try {
        await openTitle(page, title)
        for (let chunk = 1; chunk <= 2; chunk++) {
          live.update(`G4 live ${round} ${'chunk '.repeat(chunk)}`)
          await page.waitForTimeout(700)
        }
      } finally { live.finish() }
      break
    }
    case 'split-pane': {
      await openTitle(page, title)
      const focused = page.locator('.hapi-pane-focused')
      const menu = focused.locator('.hapi-pane-header .hapi-pane-menu')
      await menu.locator(':scope > summary').click()
      await menu.getByRole('button', { name: 'Split left / right', exact: true }).click()
      await addFixture(environment, `${scenario}-${round}-b`)
      await page.waitForTimeout(600)
      await page.locator('button.hapi-session-open').filter({ hasText: secondTitle }).first().click().catch(() => {})
      await page.waitForTimeout(700)
      break
    }
    case 'restore': {
      await openTitle(page, title)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[data-hapi-workspace]').waitFor({ timeout: 60_000 })
      await page.waitForTimeout(900)
      break
    }
    default: throw new Error(`unknown scenario ${scenario}`)
  }
}
/** Wait for fixture traffic to settle so a trailing poll cannot straddle the observation boundary. */
async function settle(page: Page, environment: OfficialEnvironment): Promise<void> {
  let last = -1, stableSince = Date.now()
  while (Date.now() - stableSince < 500) {
    const length = environment.hapi.requestLog.length + environment.hapi.emittedLog.length
    if (length !== last) { last = length; stableSince = Date.now() }
    await page.waitForTimeout(75)
  }
}

async function capture(page: Page, environment: OfficialEnvironment, startEvents: number, startCalls: number) {
  const dom = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('.hapi-pane')].map(pane => ({
      title: pane.getAttribute('aria-label') ?? '',
      focused: pane.classList.contains('hapi-pane-focused'),
      hasFlow: Boolean(pane.querySelector('[data-chat-flow]')),
      composer: pane.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')?.innerText ?? null,
    }))
    // The second sidebar line is a relative-time label ("Now", a date, ...);
    // it depends on the wall clock at render time, not on the composition.
    const sidebar = [...document.querySelectorAll('button.hapi-session-open')].slice(0, 8)
      .map(row => [((row as HTMLElement).innerText ?? '').split('\n')[0] ?? '', '<time>'])
    return { panes, sidebar, loading: document.querySelectorAll('.hapi-session-loading').length }
  }).catch(() => ({ panes: [], sidebar: [], loading: -1 }))
  const sessions = [...environment.hapi.sessions.values()].map(fixture => ({
    name: fixture.session.metadata?.name ?? '',
    status: fixture.session.execution?.status ?? null,
    rows: fixture.rows.length,
  })).sort((left, right) => left.name.localeCompare(right.name))
  const sessionIds = new Set([...environment.hapi.sessions.keys()])
  const mask = (value: string): string => {
    let masked = value
    for (const id of sessionIds) masked = masked.replaceAll(id, '<session>')
    return masked
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '<uuid>')
      .replace(/accept-live-\d+/gu, 'accept-live-<ts>')
      .replace(/fixture-\d+/gu, 'fixture-<n>')
      .replace(/\b1\d{12}\b/gu, '<epoch>')
  }
  return {
    sourceEvents: environment.hapi.emittedLog.slice(startEvents).map(event => ({ type: event.type, session: event.sessionId ? mask(event.sessionId) : null })),
    // Periodic catalog discovery is scheduler noise, not scenario semantics:
    // it fires at different moments on the original and patched clients and
    // would make two otherwise identical runs differ. Drop only those reads;
    // every action-triggered session request stays in the observation.
    calls: environment.hapi.requestLog.slice(startCalls)
      .filter(call => !(call.method === 'GET' && ['/api/machines', '/api/sessions', '/api/hub-settings'].includes(call.path)))
      // Presence heartbeat POSTs race the scenario boundary the same way.
      .filter(call => call.path !== '/api/visibility')
      .map(call => ({ method: call.method, path: mask(call.path) })),
    semanticState: { dom, sessions },
    providerRegistrations: 0,
    newWindows: 0,
  }
}

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/home/chris/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome' })
const environment = await startOfficialEnvironment()
const cases: Array<Record<string, unknown>> = []
try {
  for (let round = 1; round <= ROUNDS; round++) {
    for (const scenario of SCENARIOS) {
      const page = await makePage(environment, browser)
      const title = `Native Codex g4-${scenario}-${round}`
      const startEvents = environment.hapi.emittedLog.length
      const startCalls = environment.hapi.requestLog.length
      let failed = false
      let debugError: string | undefined
      try { await runScenario(environment, page, scenario, round, title); await settle(page, environment) }
      catch (error) {
        failed = true
        if (process.env.HAPI_DSH_G4_DEBUG === '1') {
          const debugState = await page.evaluate(() => ({
            text: (document.body.innerText ?? '').slice(0, 600),
            loading: document.querySelectorAll('.hapi-session-loading').length,
            panes: [...document.querySelectorAll('.hapi-pane')].map(pane => ({ label: pane.getAttribute('aria-label'), flow: Boolean(pane.querySelector('[data-chat-flow]')), hidden: getComputedStyle(pane).display })),
          })).catch(() => ({ text: 'debug evaluate failed' }))
          debugError = `${String(error).slice(0, 300)} | state=${JSON.stringify(debugState)}`
        } else debugError = undefined
      }
      const observation = await capture(page, environment, startEvents, startCalls)
      cases.push({ variant, ...(variant === 'original' ? {} : { switches: { historySource: Number(combo[0]), mountedChat: Number(combo[1]), windowCommit: Number(combo[2]) } }),
        scenario, round, observation: { ...observation, failed, ...(debugError && process.env.HAPI_DSH_G4_DEBUG === '1' ? { debugError } : {}) } })
      await page.context().close().catch(() => {})
    }
  }
  writeFileSync(outPath, JSON.stringify({ variant, combo, cases }, null, 1))
  console.log(JSON.stringify({ variant, combo, cases: cases.length, failed: cases.filter(entry => (entry.observation as { failed?: boolean }).failed).length }))
} finally {
  await browser.close().catch(() => {})
  await environment.close().catch(() => {})
}
