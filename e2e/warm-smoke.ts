/** Eight bounded smoke checks share one official Host and one browser process. */
import { expect, type Locator } from '@playwright/test'
import { WarmOfficialSession } from './warm-session.ts'

const composerName = 'Message or run a task, / commands, @ files or sessions'
export interface WarmCheck { name: string; durationMs: number; passed: boolean; error?: string }
export interface WarmNavigationTiming { bootLayoutMarkMs: number | null; workspaceReadyMarkMs: number | null; firstContentfulPaintMs: number | null }
export interface WarmReport {
  passed: boolean
  durationMs: number
  checks: WarmCheck[]
  hostStarts: number
  browserStarts: number
  graphRequestsForSplit: number
  browserErrors: string[]
  navigation: { initial: WarmNavigationTiming | null; restored: WarmNavigationTiming | null }
}

export async function runWarmSmoke(session: WarmOfficialSession): Promise<WarmReport> {
  const started = performance.now()
  const page = await session.page()
  const environment = session.environment
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  const navigation: WarmReport['navigation'] = { initial: null, restored: null }
  const navigationTiming = () => page.evaluate(() => ({
    bootLayoutMarkMs: performance.getEntriesByName('hapi:boot-layout')[0]?.startTime ?? null,
    workspaceReadyMarkMs: performance.getEntriesByName('hapi:workspace-ready')[0]?.startTime ?? null,
    firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
  }))
  let graphRequests = 0, graphRequestsForSplit = 0
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === '/hapi-dsh/bootstrap' || path.startsWith('/plugins/') && path !== '/plugins/events') graphRequests++
  })
  const checks: WarmCheck[] = []
  const check = async (name: string, action: () => Promise<void>): Promise<void> => {
    const at = performance.now()
    try { await action(); checks.push({ name, durationMs: Math.round(performance.now() - at), passed: true }) }
    catch (error) {
      checks.push({ name, durationMs: Math.round(performance.now() - at), passed: false,
        error: String(error).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').slice(0, 5000) })
      throw error
    }
  }
  let alpha: Locator, beta: Locator
  const pane = (key: string) => page.getByRole('region', { name: `Pane: Native Codex ${key}`, exact: true })
  const composer = (view: Locator) => view.getByRole('textbox', { name: composerName, exact: true })
  const open = async (key: string): Promise<Locator> => {
    await page.locator('.hapi-session-open').filter({ hasText: `Native Codex ${key}` }).click()
    const view = pane(key)
    await expect(view.locator('[data-hapi-session-view]')).toHaveCount(1)
    await expect(composer(view)).toBeVisible()
    return view
  }
  try {
    await check('workspace and one sidebar', async () => {
      await session.admit(page)
      navigation.initial = await navigationTiming()
      await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
      await expect(page.locator('iframe')).toHaveCount(0)
    })
    await check('first session transcript and composer', async () => {
      alpha = await open('alpha')
      await expect(alpha.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible()
    })
    await check('split shares the Host graph', async () => {
      const before = graphRequests
      await page.locator('.hapi-workspace-toolbar').getByRole('button', { name: 'Split left / right', exact: true }).click()
      beta = await open('beta')
      await expect(beta.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toBeVisible()
      graphRequestsForSplit = graphRequests - before
      expect(graphRequestsForSplit).toBe(0)
    })
    await check('independent drafts and focus', async () => {
      await composer(alpha).fill('Warm smoke alpha draft')
      await composer(beta).fill('Warm smoke beta draft')
      await expect(composer(alpha)).toHaveText('Warm smoke alpha draft')
      await expect(composer(beta)).toHaveText('Warm smoke beta draft')
      await expect(beta).toHaveClass(/hapi-pane-focused/)
    })
    await check('Enter queues once and cancellation restores only beta', async () => {
      const sent = environment.hapi.sent.length
      await composer(beta).press('Enter')
      await expect.poll(() => environment.hapi.sent.length).toBe(sent + 1)
      const delivery = environment.hapi.sent.at(-1)!
      expect(delivery).toMatchObject({ sessionId: 'native-beta', message: { text: 'Warm smoke beta draft' } })
      await expect(composer(beta)).toHaveText('')
      const queue = beta.locator('.hapi-native > details').filter({ has: page.getByRole('button', { name: 'Edit queued message', exact: true, includeHidden: true }) })
      await expect(queue).toHaveCount(1)
      if (await queue.getAttribute('open') === null) await queue.locator(':scope > summary').click()
      await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
      await expect.poll(() => environment.hapi.cancelled.includes(delivery.message.localId)).toBe(true)
      await expect(composer(beta)).toHaveText('Warm smoke beta draft')
      await expect(composer(alpha)).toHaveText('Warm smoke alpha draft')
      expect(environment.hapi.sent.length).toBe(sent + 1)
    })
    await check('approval stays in its source pane', async () => {
      const id = `warm-approval-${crypto.randomUUID()}`
      environment.hapi.requestApproval('native-alpha', id)
      const approval = alpha.locator(`[data-native-request="${id}"]`)
      await expect(approval).toBeVisible()
      await expect(beta.locator('[data-native-request]')).toHaveCount(0)
      await approval.getByRole('button', { name: 'Approve', exact: true }).click()
      await expect.poll(() => environment.hapi.approvals.at(-1)).toMatchObject({ sessionId: 'native-alpha', requestId: id })
      environment.hapi.settleApproval('native-alpha', id)
      await expect(approval).toHaveCount(0)
    })
    await check('previous history is present without a new source execution', async () => {
      const aborted = environment.hapi.aborted.length
      const sent = environment.hapi.sent.length
      await page.locator('.hapi-workspace-toolbar').getByRole('button', { name: 'Split left / right', exact: true }).click()
      const history = await open('warm-history')
      await expect(history.getByText('Synthetic final answer 70.', { exact: true })).toBeVisible()
      // A short source fits one DSH page. Accept initial automatic backfill or
      // exercise the unchanged public earlier-history control if still present.
      const prior = history.getByText('Synthetic final answer 69.', { exact: true })
      if (await prior.count() === 0) {
        const button = history.locator('[data-chat-flow]:not([data-step-process-content])').locator('xpath=./div[count(*)=1 and count(button)=1]/button').first()
        await expect(button).toBeEnabled()
        await button.focus(); await button.press('Enter')
      }
      await expect(prior).toHaveCount(1)
      await expect(history.getByText('Synthetic final answer 70.', { exact: true })).toHaveCount(1)
      expect(environment.hapi.sent.length).toBe(sent)
      expect(environment.hapi.aborted.length).toBe(aborted)
    })
    await check('layout and drafts survive reload; closing a pane does not abort', async () => {
      await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
      await page.reload()
      await expect(composer(alpha)).toHaveText('Warm smoke alpha draft')
      await expect(composer(beta)).toHaveText('Warm smoke beta draft')
      navigation.restored = await navigationTiming()
      const aborted = environment.hapi.aborted.length
      await composer(beta).focus()
      const menu = page.locator('.hapi-statusbar .hapi-pane-actions')
      await menu.locator(':scope > summary').click()
      await menu.getByRole('button', { name: 'Close pane', exact: true }).click()
      await expect(beta).toHaveCount(0)
      expect(environment.hapi.aborted.length).toBe(aborted)
      expect(browserErrors).toEqual([])
    })
  } catch {
    // The report retains the failing checkpoint. A contaminated run is not
    // reused: the command owner restarts the synthetic environment on failure.
  }
  session.checked()
  const status = session.status()
  return { passed: checks.length === 8 && checks.every(check => check.passed), durationMs: Math.round(performance.now() - started),
    checks, hostStarts: status.hostStarts, browserStarts: status.browserStarts, graphRequestsForSplit, browserErrors, navigation }
}
