/** Real pinned DSH editors and shared AppFrame; source delivery/cancellation use explicit HAPI wire fixtures. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'

const composerName = 'Message or run a task, / commands, @ files or sessions'

async function admitShared(page: Page, environment: OfficialEnvironment): Promise<void> {
  await page.goto(environment.launchUrl)
  await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
  await acknowledgePreviewNotice(page, environment)
  // The launch-token redirect establishes admission and strips its query; the
  // admitted navigation must select the actual shared production path.
  await page.goto(`${environment.origin}/?hapiGraph=shared`)
  await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
  await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
}

async function open(page: Page, key: 'alpha' | 'beta', split = false): Promise<Locator> {
  if (split) await page.locator('.hapi-workspace-toolbar').getByRole('button', { name: 'Split left / right', exact: true }).click()
  await page.locator('.hapi-session-open').filter({ hasText: `Native Codex ${key}` }).click()
  const pane = page.getByRole('region', { name: `Pane: Native Codex ${key}`, exact: true })
  await expect(pane.locator('[data-hapi-session-view]')).toHaveCount(1)
  await expect(pane.getByText(`Native history ${key} in the official DSH Conversation.`, { exact: true })).toBeVisible()
  await expect(pane.locator('[data-hapi-composer-enter]')).toHaveCount(1)
  return pane
}

async function revealQueue(pane: Locator): Promise<Locator> {
  const queue = pane.locator('.hapi-native > details').filter({
    has: pane.page().getByRole('button', { name: 'Edit queued message', exact: true, includeHidden: true }),
  })
  await expect(queue).toHaveCount(1)
  if (await queue.getAttribute('open') === null) await queue.locator(':scope > summary').click()
  return queue
}

test.describe('shared graph composer ownership', () => {
  let environment: OfficialEnvironment
  test.beforeAll(async () => { environment = await startOfficialEnvironment() })
  test.afterAll(async () => { await environment?.close() })

  test('Enter and delayed queued-edit recovery stay with beta while alpha keeps its newer draft', async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    let release = () => {}
    try {
      await admitShared(page, environment)
      const alpha = await open(page, 'alpha')
      const alphaInput = alpha.getByRole('textbox', { name: composerName, exact: true })
      await alphaInput.fill('Independent alpha draft before beta submits')
      const beta = await open(page, 'beta', true)
      const betaInput = beta.getByRole('textbox', { name: composerName, exact: true })
      const originalBeta = 'Original beta queued text submitted by default Enter'
      await betaInput.fill(originalBeta)
      await expect(alphaInput).toHaveText('Independent alpha draft before beta submits')
      await expect(betaInput).toHaveText(originalBeta)
      expect(await page.evaluate(() => localStorage.getItem('hapi-composer-enter-behavior'))).toBeNull()

      const sentBefore = environment.hapi.sent.length
      await betaInput.press('Enter')
      await expect.poll(() => environment.hapi.sent.length).toBe(sentBefore + 1)
      const delivery = environment.hapi.sent.at(-1)!
      expect(delivery).toMatchObject({ sessionId: 'native-beta', message: { text: originalBeta } })
      await expect(betaInput).toHaveText('')
      await expect(alphaInput).toHaveText('Independent alpha draft before beta submits')

      const queue = await revealQueue(beta)
      await betaInput.fill('Beta draft captured before cancellation')
      let entered = false
      const barrier = new Promise<void>(resolve => { release = resolve })
      environment.hapi.beforeCancel = async sessionId => {
        if (sessionId === 'native-beta') { entered = true; await barrier }
      }
      await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
      await expect.poll(() => entered).toBe(true)
      const newerBeta = 'Newer beta draft typed while its cancellation waits'
      const newerAlpha = 'Newer alpha draft typed while beta cancellation waits'
      await betaInput.fill(newerBeta)
      await alphaInput.fill(newerAlpha)
      await expect(alpha).toHaveClass(/hapi-pane-focused/)
      release()
      environment.hapi.beforeCancel = undefined

      const recovery = beta.locator('[data-hapi-queued-edits]')
      await expect(recovery.locator('[data-queue-edit-status="cancelled"]')).toBeVisible()
      await expect(recovery.getByRole('alert')).toContainText('newer draft was kept')
      await expect(betaInput).toHaveText(newerBeta)
      await expect(alphaInput).toHaveText(newerAlpha)
      await expect(alpha).toHaveClass(/hapi-pane-focused/)
      await expect(alpha.locator('[data-hapi-queued-edits]')).toHaveCount(0)
      expect(environment.hapi.sent).toHaveLength(sentBefore + 1)
      expect(environment.hapi.cancelled.filter(id => id === delivery.message.localId)).toHaveLength(1)

      // The two live drafts and beta's receipt survive a new AppFrame. Merely
      // reopening a cancelled edit must not replace either restored draft.
      await page.reload()
      await expect(alpha.locator('[data-hapi-session-view]')).toHaveCount(1)
      await expect(beta.locator('[data-hapi-session-view]')).toHaveCount(1)
      await expect(alphaInput).toHaveText(newerAlpha)
      await expect(betaInput).toHaveText(newerBeta)
      await expect(recovery.locator('[data-queue-edit-status="cancelled"]')).toBeVisible()
      await expect(alpha.locator('[data-hapi-queued-edits]')).toHaveCount(0)

      // Explicit recovery intentionally replaces beta's draft, even though
      // alpha was the focused pane; it cannot target alpha or resend beta.
      await alphaInput.focus()
      await expect(alpha).toHaveClass(/hapi-pane-focused/)
      await recovery.getByRole('button', { name: 'Restore cancelled draft', exact: true }).click()
      await expect(betaInput).toHaveText(originalBeta)
      await expect(alphaInput).toHaveText(newerAlpha)
      await expect(betaInput).toBeFocused()
      await expect(recovery.getByRole('status')).toContainText('Draft restored; not sent')
      expect(environment.hapi.sent).toHaveLength(sentBefore + 1)
      expect(environment.hapi.sent.filter(item => item.sessionId === 'native-alpha')).toHaveLength(0)
      expect(environment.hapi.sent.filter(item => item.sessionId === 'native-beta')).toHaveLength(1)
      expect(environment.hapi.cancelled.filter(id => id === delivery.message.localId)).toHaveLength(1)
      expect(errors).toEqual([])
    } finally {
      release()
      environment.hapi.beforeCancel = undefined
      await info.attach('shared-composer-errors', { body: errors.join('\n'), contentType: 'text/plain' })
      await info.attach('shared-composer-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
    }
  })
})
