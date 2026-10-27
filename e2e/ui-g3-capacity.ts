/**
 * G3 artifact sampler: traverse the capacity fixture's whole source history
 * (>=20k nodes), then drive 100 consecutive window commits while recording the
 * client window metrics exposed by __hapiDshCapacityProbe, and write the ext G3
 * dataset shape.
 */
import { writeFileSync } from 'node:fs'
import type { Page } from 'playwright'
import { beginUiLive } from './ui-live-fixture.ts'
import { WarmOfficialSession } from './warm-session.ts'

const outPath = process.env.HAPI_DSH_G3_REPORT ?? '/mnt/cache/src/hapi-dsh/.tmp/gates/g3-artifact.json'
const MIN_TRAVERSED = 20_000
const COMMITS = 100

const CAPACITY_TITLE = 'Native Codex capacity-history'
function pane(page: Page) { return page.getByRole('region', { name: `Pane: ${CAPACITY_TITLE}`, exact: true }) }
function port(page: Page) { return pane(page).locator('[data-conversation-scroll]').first() }
function loadOlder(page: Page) {
  return pane(page).locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
}

async function openCapacity(page: Page): Promise<void> {
  await page.locator('button.hapi-session-open').filter({ hasText: CAPACITY_TITLE }).first().click({ timeout: 30000 })
  await page.getByRole('region', { name: `Pane: ${CAPACITY_TITLE}`, exact: true })
    .locator('[data-chat-flow]').first().waitFor({ timeout: 180000 })
  await page.getByRole('region', { name: `Pane: ${CAPACITY_TITLE}`, exact: true })
    .locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 60000 })
}

const session = new WarmOfficialSession()
try {
  await session.start()
  const page = await session.page()
  await page.addInitScript(() => { Reflect.set(globalThis, '__hapiDshCapacityProbe', { commits: [] }) })
  await session.admit(page)
  await page.locator('[data-hapi-workspace]').waitFor({ timeout: 60000 })
  await openCapacity(page)
  const probeSize = () => page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__hapiDshCapacityProbe') as { commits: unknown[], seen?: Set<number> } | undefined
    return { commits: probe?.commits.length ?? 0, seen: probe?.seen?.size ?? 0 }
  })
  // Traverse older history in pages until the first (oldest) source input is
  // mounted. The fixture session itself then proves >=20k traversed nodes.
  const capacity = [...session.environment.hapi.sessions.values()]
    .find(entry => entry.session.id === 'native-capacity-history') as unknown as { session: { id: string }, rows: unknown[] } | undefined
  if (!capacity) throw new Error('capacity fixture session is missing')
  const totalRows = capacity.rows.length
  const pageCounts = (session.environment.hapi as unknown as { historyPageCounts: Map<string, number> }).historyPageCounts
  const older = loadOlder(page)
  let oldestSeen = false
  let pages = 0
  for (let attempt = 0; attempt < 400; attempt++) {
    oldestSeen = await pane(page).evaluate(element => ((element as HTMLElement).innerText ?? '').includes('Synthetic original input 1.'))
    if (oldestSeen) break
    if (!await older.isEnabled().catch(() => false)) {
      await page.waitForTimeout(700)
      if (!await older.isEnabled().catch(() => false)) break
    }
    const before = pageCounts.get(capacity.session.id) ?? 0
    await port(page).evaluate(element => { element.scrollTop = 0 })
    await page.waitForTimeout(120)
    await older.evaluate(button => (button as HTMLButtonElement).click()).catch(() => {})
    for (let wait = 0; wait < 15; wait++) {
      await page.waitForTimeout(100)
      if ((pageCounts.get(capacity.session.id) ?? 0) > before) break
    }
    pages = pageCounts.get(capacity.session.id) ?? pages
    if (attempt % 20 === 0) console.error(`[g3] traversal attempt ${attempt} pages=${pages}`)
  }
  console.error(`[g3] traversal done oldestSeen=${oldestSeen} pages=${pages} totalRows=${totalRows}`)
  if (!oldestSeen) throw new Error(`capacity traversal stopped before the oldest source input after ${pages} pages`)
  const traversed = totalRows
  const traversedState = await probeSize()
  console.error(`[g3] live-base commits=${traversedState.commits} probeSeen=${traversedState.seen}`)
  const start = traversedState.commits
  // Drive live increments until the probe recorded 100 more window commits.
  const live = beginUiLive(session.environment.hapi, 'native-capacity-history', 'indexed')
  const prefix = `G3 capacity answer ${crypto.randomUUID()}`
  try {
    for (let index = 1; index <= 260; index++) {
      live.update(`${prefix}: ${'capacity content '.repeat(index)}`)
      for (let wait = 0; wait < 16; wait++) {
        await page.waitForTimeout(70)
        if ((await probeSize()).commits >= start + COMMITS) break
      }
      if ((await probeSize()).commits >= start + COMMITS) break
    }
  } finally { live.finish() }
  const commits = await page.evaluate((from) => {
    const probe = Reflect.get(globalThis, '__hapiDshCapacityProbe') as { commits: Array<Record<string, unknown>> } | undefined
    return (probe?.commits ?? []).slice(from, from + 100).map((commit, index) => ({ ...commit, index }))
  }, start)
  console.error(`[g3] live commits collected ${commits.length}`)
  const windowMetrics = await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__hapiDshCapacityProbe') as { window?: { assistantMessages?: number } } | undefined
    return { domNodes: document.querySelectorAll('*').length, bodyMarkers: probe?.window?.assistantMessages ?? 0 }
  })
  const dataset = { schema: 1, gate: 'G3', environment: 'artifact warm fixture + managed private runtime',
    windowBudgetB: 2000, traversedHistoryNodes: traversed, commits, windowMetrics }
  writeFileSync(outPath, JSON.stringify(dataset, null, 1))
  const metrics = commits as Array<Record<string, unknown>>
  console.log(JSON.stringify({ traversed, commits: commits.length, windowMetrics,
    maxLiveDerivedNodes: Math.max(0, ...metrics.map(commit => Number(commit.liveDerivedNodes ?? 0))),
    maxEvents: Math.max(0, ...metrics.map(commit => Number(commit.events ?? 0))),
    maxBodyBytes: Math.max(0, ...metrics.map(commit => Number(commit.bodyBytes ?? 0))) }, null, 1))
} catch (error) {
  console.error(`[g3] FAILED: ${String(error).slice(0, 600)}`)
  try {
    const pages = session.environment ? undefined : undefined
    void pages
  } catch { /* ignore */ }
  throw error
} finally { await session.close().catch(() => {}) }
