/** Actual official DSH Web/input/Agent gateway over explicit HAPI queue wire fixtures. */
import { test, expect, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
interface CatalogRead { sessions: Array<{ id: string; title: string }> }

const composerName = 'Message or run a task, / commands, @ files or sessions'
async function open(page: Page, environment: OfficialEnvironment, title: string) {
  await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
  const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
  await notice.waitFor({ state: 'visible', timeout: 2000 }).catch(() => undefined);
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.locator('.hapi-session-open').filter({ hasText: title }).click()
  const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
  const row = (await environment.rpc<CatalogRead>('hapi/catalog')).sessions.find(value => value.title === title)
  if (!row) throw new Error('The source fixture has no official catalog identity')
  await expect(pane.getByRole('textbox', { name: composerName, exact: true })).toBeVisible()
  return { pane, row, composer: pane.getByRole('textbox', { name: composerName, exact: true }) }
}
async function revealQueue(pane: ReturnType<Page['locator']>) {
  const queue = pane.locator('.hapi-native > details').filter({ has: pane.page().getByRole('button', { name: 'Edit queued message', exact: true, includeHidden: true }) })
  await expect(queue).toHaveCount(1)
  if (await queue.getAttribute('open') === null) await queue.locator(':scope > summary').click()
  return queue
}

test.describe('original queued-message editing through the official composer', () => {
  let environment: OfficialEnvironment
  test.beforeAll(async () => { environment = await startOfficialEnvironment(); environment.hapi.addObserved('claude', 'edit-recovery', 'machine-alpha') })
  test.afterAll(async () => { await environment?.close() })

  test('cancel confirms once and a draft typed during the wait wins until explicit restoration', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    let release = () => {}
    try {
      const { pane, composer } = await open(page, environment, 'Native Codex alpha')
      await composer.fill('Original queued text for a source-owned edit')
      await pane.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => environment.hapi.sent.filter(item => item.sessionId === 'native-alpha').length).toBe(1)
      const queue = await revealQueue(pane)
      await composer.fill('Draft before cancellation')
      let entered = false
      const barrier = new Promise<void>(resolve => { release = resolve })
      environment.hapi.beforeCancel = async id => { if (id === 'native-alpha') { entered = true; await barrier } }
      await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
      await expect.poll(() => entered).toBe(true)
      await composer.fill('Newer draft typed while source cancellation was pending')
      release(); environment.hapi.beforeCancel = undefined
      const recovery = pane.locator('[data-hapi-queued-edits]')
      await expect(recovery.locator('[data-queue-edit-status="cancelled"]')).toBeVisible()
      await expect(composer).toHaveText('Newer draft typed while source cancellation was pending')
      await expect(recovery.getByRole('alert')).toContainText('newer draft was kept')
      await recovery.getByRole('button', { name: 'Restore cancelled draft', exact: true }).click()
      await expect(composer).toHaveText('Original queued text for a source-owned edit')
      expect(environment.hapi.sent.filter(item => item.sessionId === 'native-alpha')).toHaveLength(1)
      expect(environment.hapi.cancelled.filter(id => id === environment.hapi.sent.find(item => item.sessionId === 'native-alpha')!.message.localId)).toHaveLength(1)
      expect(errors).toEqual([])
    } finally { release(); environment.hapi.beforeCancel = undefined; if (errors.length) await info.attach('queue-edit-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
  })

  test('a future queued edit opens the existing schedule page with the exact original absolute time and does not send', async ({ page }) => {
    const { pane, row, composer } = await open(page, environment, 'Native Codex beta')
    const scheduledAt = Date.now() + 6 * 60_000
    await environment.rpc('hapi/nativeSchedule', { sessionId: row.id, operationId: crypto.randomUUID(), text: 'Retain the exact original future time', scheduledAt })
    const queue = await revealQueue(pane)
    await composer.fill('Keep this independent current composer draft')
    await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
    const schedulePane = page.getByRole('region', { name: 'Pane: Scheduled messages', exact: true })
    const schedule = schedulePane.getByRole('region', { name: 'Scheduled messages', exact: true })
    await expect(schedule).toBeVisible()
    await expect(schedule.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Retain the exact original future time')
    const draft = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('hapi-dsh:schedule:') && key.includes('native-beta'))
      return key ? JSON.parse(localStorage.getItem(key)!) : null
    })
    expect(draft).toMatchObject({ selection: { type: 'absolute', ms: scheduledAt }, intent: null, receipt: null })
    await expect(composer).toHaveText('Keep this independent current composer draft')
    expect(environment.hapi.sent.filter(item => item.sessionId === 'native-beta')).toHaveLength(1)
    await expect(schedule.getByRole('button', { name: 'Schedule message', exact: true })).toBeEnabled()
  })

  test('a lost original cancellation acknowledgement remains unknown across reload and only an exact source event unlocks restore', async ({ page }) => {
    const fixture = environment.hapi.require('source-edit-recovery')
    const title = fixture.session.metadata!.name!
    const { pane, composer } = await open(page, environment, title)
    await composer.fill('Original Claude queue edit with a lost reply')
    await pane.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => environment.hapi.sent.filter(item => item.sessionId === fixture.session.id).length).toBe(1)
    const sent = environment.hapi.sent.find(item => item.sessionId === fixture.session.id)!, original = fixture.rows.find(item => item.localId === sent.message.localId)!
    const queue = await revealQueue(pane)
    environment.hapi.dropNextCancelReply = true; environment.hapi.suppressNextCancelEvent = true
    await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
    const recovery = pane.locator('[data-hapi-queued-edits]')
    await expect(recovery.locator('[data-queue-edit-status="unknown"]')).toBeVisible()
    await expect(recovery.getByRole('button', { name: 'Restore cancelled draft', exact: true })).toHaveCount(0)
    await composer.fill('New draft retained across reload')
    await page.reload(); await expect(recovery.locator('[data-queue-edit-status="unknown"]')).toBeVisible()
    await recovery.getByRole('button', { name: 'Read this edit', exact: true }).click()
    expect(environment.hapi.cancelled.filter(id => id === sent.message.localId)).toHaveLength(1)
    environment.hapi.emit({ type: 'message-cancelled', sessionId: fixture.session.id, messageId: original.id, localId: sent.message.localId })
    await expect(recovery.locator('[data-queue-edit-status="cancelled"]')).toBeVisible()
    await expect(composer).toHaveText('New draft retained across reload')
    await recovery.getByRole('button', { name: 'Restore cancelled draft', exact: true }).click()
    await expect(composer).toHaveText('Original Claude queue edit with a lost reply')
    expect(environment.hapi.cancelled.filter(id => id === sent.message.localId)).toHaveLength(1)
    expect(environment.hapi.sent.filter(item => item.sessionId === fixture.session.id)).toHaveLength(1)
  })
})
