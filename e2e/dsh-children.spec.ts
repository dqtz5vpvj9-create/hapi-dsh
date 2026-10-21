import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Real official DSH Web/Conversation/Agent path with explicit original HAPI
 * child protocol fixtures; no live model credentials or source process. */
import { test, expect, type Page, type Locator } from '@playwright/test'
import type { SourceDshChildState } from '../src/hapi-agent/dsh-child-types.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import type { NativeFixture } from './hapi-fixture.ts'

const composerName = 'Message or run a task, / commands, @ files or sessions'
async function ready(page: Page, environment: OfficialEnvironment) {
  await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
  await acknowledgePreviewNotice(page, environment)
}
async function openChild(page: Page, parent: string, child: string, beside = false): Promise<{ pane: Locator; id: string }> {
  const branch = page.getByRole('button', { name: `Subagents · ${parent}`, exact: true })
  await expect(branch).toBeVisible()
  if (await branch.getAttribute('aria-expanded') !== 'true') await branch.click()
  const button = page.locator('.hapi-session-open').filter({ hasText: child })
  await expect(button).toBeVisible()
  const id = await button.locator('xpath=..').getAttribute('data-session-row')
  if (!id) throw new Error('The official source child is missing its catalog identity')
  await button.click(beside ? { modifiers: ['Shift'] } : {})
  const pane = page.getByRole('region', { name: `Pane: ${child}`, exact: true }); await expect(pane).toBeVisible()
  return { pane, id }
}
async function controls(pane: Locator) {
  const panel = pane.locator('details[data-dsh-child-controls]')
  await expect(panel).toBeVisible()
  if (await panel.getAttribute('open') === null) await panel.locator(':scope > summary').click()
  return panel
}

test.describe('original DSH source children in the unified official workspace', () => {
  let environment: OfficialEnvironment, alpha: NativeFixture, beta: NativeFixture
  test.beforeAll(async () => {
    environment = await startOfficialEnvironment()
    const source = environment.hapi.dshChildren
    alpha = source.seed(environment.hapi, 'alpha', 'machine-alpha')
    beta = source.seed(environment.hapi, 'beta', 'machine-beta')
    source.add(alpha, 'same-opaque-child', 'Alpha original worker')
    source.add(beta, 'same-opaque-child', 'Beta original worker')
    source.add(alpha, 'readonly-child', 'Original one-shot child', 'one-shot')
    source.add(alpha, 'recover-child', 'Recoverable original worker')
    source.add(alpha, 'empty-child', 'Empty original worker').rows.splice(0)
    environment.hapi.emit({ type: 'session-added', sessionId: alpha.session.id })
    environment.hapi.emit({ type: 'session-added', sessionId: beta.session.id })
  })
  test.afterAll(async () => { await environment?.close() })

  test('one sidebar retains exact original parent and machine while the official composer continues a child', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    try {
      await ready(page, environment)
      const a = await openChild(page, 'Source DSH parent alpha', 'Alpha original worker')
      await expect(a.pane.getByText('Original answer from Alpha original worker', { exact: true })).toBeVisible()
      const initial = await environment.rpc<SourceDshChildState>('hapi/sourceDshChild', { sessionId: a.id })
      expect(initial).toMatchObject({ sourceSessionId: alpha.session.id, parentDshSessionId: 'original-dsh-parent-alpha', childDshSessionId: 'same-opaque-child', machineId: 'machine-alpha', readOnly: false })
      await a.pane.getByRole('textbox', { name: composerName, exact: true }).fill('Continue only the original alpha child')
      const ordinaryReply = page.waitForResponse(response => response.url().endsWith('/api/subagents/prompt'))
      await a.pane.getByRole('button', { name: 'Send message', exact: true }).click()
      const refused = await (await ordinaryReply).json()
      expect(refused.result).toMatchObject({ ok: false, error: { code: 'subagent/delivery-unavailable' } })
      expect(refused.result.error.message).toContain('/child')
      expect(environment.hapi.dshChildren.prompts).toHaveLength(0)
      await expect(a.pane.getByRole('textbox', { name: composerName, exact: true })).toHaveText('Continue only the original alpha child')
      await expect(a.pane.locator('[data-submission-echo]')).toHaveCount(0)
      await a.pane.getByRole('button', { name: 'Use /child follow-up', exact: true }).click()
      await expect(a.pane.getByRole('textbox', { name: composerName, exact: true })).toContainText('/child')
      await a.pane.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => environment.hapi.dshChildren.prompts.length).toBe(1)
      expect(environment.hapi.dshChildren.prompts[0]).toMatchObject({ parentId: alpha.session.id, parentDshId: 'original-dsh-parent-alpha', childId: 'same-opaque-child', machineId: 'machine-alpha', text: 'Continue only the original alpha child', delivery: 'queue' })
      await expect(a.pane.getByText('Original fixture child response: Continue only the original alpha child', { exact: true })).toBeVisible()
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      // Explicit public CommandClaim uses the original editor and Send while
      // avoiding the default sink's uncorrelatable optimistic transcript row.
      const echo = { optimisticEchoCount: await a.pane.locator('[data-submission-echo]').count(),
        optimisticEchoText: await a.pane.locator('[data-submission-echo]').allTextContents(),
        receipt: (await environment.rpc<SourceDshChildState>('hapi/sourceDshChild', { sessionId: a.id })).receipts.at(-1)?.status }
      await info.attach('source-child-echo-protocol-diagnostic', { body: JSON.stringify(echo, null, 2), contentType: 'application/json' })
      console.info('Source child protocol observation:', JSON.stringify({ optimisticEchoCount: echo.optimisticEchoCount, sourceReceipt: echo.receipt }))
      expect(echo.optimisticEchoCount).toBe(0)
      const b = await openChild(page, 'Source DSH parent beta', 'Beta original worker', true)
      expect(b.id).not.toBe(a.id)
      await expect(b.pane.getByText('Original answer from Beta original worker', { exact: true })).toBeVisible()
      await expect(b.pane.getByText('Original answer from Alpha original worker', { exact: true })).toHaveCount(0)
      expect(await environment.rpc<SourceDshChildState>('hapi/sourceDshChild', { sessionId: b.id })).toMatchObject({ machineId: 'machine-beta', sourceSessionId: beta.session.id, childDshSessionId: 'same-opaque-child' })
      await b.pane.getByRole('button', { name: 'Close pane', exact: true }).click()
      expect(environment.hapi.dshChildren.interrupts).toHaveLength(0)
      const one = await openChild(page, 'Source DSH parent alpha', 'Original one-shot child')
      await expect(one.pane.getByText('Original answer from Original one-shot child', { exact: true })).toBeVisible()
      expect((await environment.rpc<SourceDshChildState>('hapi/sourceDshChild', { sessionId: one.id })).readOnly).toBe(true)
      await expect(one.pane.getByText('One-shot subagent record', { exact: true })).toBeVisible()
      await expect(one.pane.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0)
      await expect(one.pane.getByRole('button', { name: 'Interrupt original child', exact: true })).toHaveCount(0)
      expect(environment.hapi.sent).toHaveLength(0)
      await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1); await expect(page.locator('iframe')).toHaveCount(0)
      expect(errors).toEqual([])
    } finally { if (errors.length) await info.attach('source-child-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
  })

  test('lost original prompt and interrupt replies remain unknown across reload and source reads never replay them', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    try {
      await ready(page, environment)
      const child = await openChild(page, 'Source DSH parent alpha', 'Recoverable original worker')
      const original = environment.hapi.dshChildren.require(alpha.session.id, 'recover-child')
      original.dropPromptReply = true
      const before = environment.hapi.dshChildren.prompts.length
      await child.pane.getByRole('textbox', { name: composerName, exact: true }).fill('Original child submission whose reply is lost')
      await child.pane.getByRole('button', { name: 'Use /child follow-up', exact: true }).click()
      await child.pane.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => environment.hapi.dshChildren.prompts.length).toBe(before + 1)
      const panel = await controls(child.pane)
      await expect(panel.locator('[data-dsh-child-receipt="unknown"]')).toContainText('Original child submission whose reply is lost')
      const requestId = environment.hapi.dshChildren.prompts.at(-1)!.requestId
      await page.reload(); await expect(panel.locator('[data-dsh-child-receipt="unknown"]')).toContainText(requestId)
      await panel.getByRole('button', { name: 'Read original state and history', exact: true }).click()
      await expect(child.pane.getByText('Original fixture child response: Original child submission whose reply is lost', { exact: true })).toBeVisible()
      expect(environment.hapi.dshChildren.prompts.length).toBe(before + 1)
      expect((await environment.rpc<SourceDshChildState>('hapi/sourceDshChild', { sessionId: child.id })).receipts.find(receipt => receipt.requestId === requestId)?.status).toBe('unknown')

      environment.hapi.dshChildren.change(environment.hapi, alpha.session.id, 'recover-child', { activity: 'running', openSince: Date.now() })
      const interrupt = panel.getByRole('button', { name: 'Interrupt original child', exact: true })
      await expect(interrupt).toBeEnabled(); original.dropInterruptReply = true
      await interrupt.click(); await expect.poll(() => environment.hapi.dshChildren.interrupts.length).toBe(1)
      await expect(panel.locator('[data-dsh-child-receipt="unknown"]')).toHaveCount(2)
      const pending = await panel.locator('[data-dsh-child-pending]').getAttribute('data-dsh-child-pending'); expect(pending).toBeTruthy()
      await page.reload(); await expect(panel.locator('[data-dsh-child-pending]')).toHaveAttribute('data-dsh-child-pending', pending!)
      await expect(interrupt).toBeDisabled()
      await panel.getByRole('button', { name: 'Read original state and history', exact: true }).click()
      expect(environment.hapi.dshChildren.interrupts).toHaveLength(1)
      environment.hapi.dshChildren.change(environment.hapi, alpha.session.id, 'recover-child', { activity: 'inactive', lastTurnCompleted: false })
      await panel.getByRole('button', { name: 'Source is idle; close local waiting', exact: true }).click()
      await expect(panel.locator('[data-dsh-child-pending]')).toHaveCount(0)
      expect((await environment.rpc<SourceDshChildState>('hapi/sourceDshChild', { sessionId: child.id })).receipts.filter(receipt => receipt.status === 'unknown')).toHaveLength(2)
      expect(environment.hapi.dshChildren.prompts.length).toBe(before + 1); expect(environment.hapi.dshChildren.interrupts).toHaveLength(1)
      expect(errors).toEqual([])
    } finally { if (errors.length) await info.attach('source-child-recovery-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
  })

  test('an actual empty source child uses the public Source state view and can submit its first official prompt', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    try {
      await ready(page, environment)
      const child = await openChild(page, 'Source DSH parent alpha', 'Empty original worker')
      const initial = await environment.rpc<SourceDshChildState>('hapi/sourceDshChild', { sessionId: child.id })
      expect(initial.history.loaded).toBe(0)
      const composer = child.pane.getByRole('textbox', { name: composerName, exact: true })
      await expect(composer).toBeVisible(); await composer.fill('First task for the original empty child')
      await child.pane.getByRole('button', { name: 'Use /child follow-up', exact: true }).click()
      const before = environment.hapi.dshChildren.prompts.length
      await child.pane.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => environment.hapi.dshChildren.prompts.length).toBe(before + 1)
      await expect(child.pane.getByText('Original fixture child response: First task for the original empty child', { exact: true })).toBeVisible()
      const last = environment.hapi.dshChildren.prompts.at(-1)!
      expect(last).toMatchObject({ parentId: alpha.session.id, childId: 'empty-child', machineId: 'machine-alpha' })
      expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
    } finally { if (errors.length) await info.attach('source-empty-child-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
  })
})
