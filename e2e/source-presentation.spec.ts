/** Production-shaped HAPI wire records; rendering and editing use the pinned official DSH runtime. */
import { test, expect } from '@playwright/test'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import type { HapiMessage } from '../src/codex/contracts.ts'

const composerName = 'Message or run a task, / commands, @ files or sessions'
test.use({ screenshot: 'off' })
const input = {
  command: '/usr/bin/zsh -lc "sed -n \'1,80p\' /workspace/example.ts"',
  cwd: '/workspace',
  command_actions: [{ type: 'read', command: "sed -n '1,80p' /workspace/example.ts", name: 'example.ts', path: '/workspace/example.ts' }],
}

test.describe('source receipts and official command presentation', () => {
  let environment: OfficialEnvironment
  test.beforeAll(async () => {
    environment = await startOfficialEnvironment()
    const fixture = environment.hapi.add('presentation', 'Laptop', 'machine-alpha')
    const terminal = fixture.rows.pop()!
    const at = fixture.rows.at(-1)!.createdAt
    const append = (type: string, fields: Record<string, unknown>, itemId: string): void => {
      const seq = fixture.rows.length + 1
      fixture.rows.push({ id: `presentation-${seq}`, localId: `presentation-${seq}`, seq, createdAt: at + seq,
        content: { role: 'agent', content: { type: 'codex', data: { type, ...fields,
          nativeExecution: { threadId: 'codex-thread-presentation', turnId: 'turn-1', itemId } } } } })
    }
    append('tool-call', { callId: 'read-example', name: 'CodexBash', input }, 'read-example')
    append('tool-call-result', { callId: 'read-example', output: { output: 'Full source command output', exit_code: 2 } }, 'read-example')
    append('tool-call', { callId: 'unknown-exit', name: 'CodexBash', input: { command: ['/bin/bash', '-lc', 'check-service'] } }, 'unknown-exit')
    append('tool-call-result', { callId: 'unknown-exit', output: 'Source did not report the process exit code' }, 'unknown-exit')
    fixture.rows.push({ ...terminal, seq: fixture.rows.length + 1, createdAt: at + fixture.rows.length + 1 })
    for (let index = 0; index < 5; index++) {
      const row: HapiMessage = { id: `receipt-${index}`, localId: `receipt-${index}`, seq: fixture.rows.length + 1,
        createdAt: Date.now(), invokedAt: null, deliveryState: 'indeterminate',
        content: { role: 'user', content: { type: 'text', text: `Uncertain source receipt ${index}` }, meta: { sentFrom: 'webapp', deliveryMode: 'queue' } } }
      fixture.rows.push(row)
    }
    environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
  })
  test.afterAll(async () => { await environment?.close() })

  test('unknown receipts stay outside the dock across reload; real queue editing still works', async ({ page }) => {
    await page.goto(environment.launchUrl)
    await acknowledgePreviewNotice(page, environment)
    await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex presentation' }).click()
    const pane = page.getByRole('region', { name: 'Pane: Native Codex presentation', exact: true })
    const composer = pane.getByRole('textbox', { name: composerName, exact: true })
    await expect(composer).toBeVisible()
    const status = pane.locator('.hapi-pane-source-status')
    await expect(status.locator('[data-delivery-state="indeterminate"]')).toHaveCount(5)
    await expect(pane.locator('.hapi-source-queue')).toHaveCount(0)
    await status.locator(':scope > summary').click()
    await expect(status.getByRole('button', { name: 'Check source result', exact: true })).toHaveCount(5)
    await expect(status.getByRole('button', { name: 'Steer now', exact: true })).toHaveCount(0)
    await status.getByRole('button', { name: 'Check source result', exact: true }).first().click()
    await expect(status.locator('[data-delivery-state="indeterminate"]').first()).toHaveAttribute('aria-busy', 'false')
    await expect(status.getByRole('alert')).toHaveCount(0)
    await page.reload()
    await expect(composer).toBeVisible()
    await expect(status.locator('[data-delivery-state="indeterminate"]')).toHaveCount(5)
    await expect(pane.locator('.hapi-source-queue')).toHaveCount(0)
    expect(environment.hapi.sent).toHaveLength(0)
    expect(environment.hapi.cancelled).toHaveLength(0)

    await composer.fill('A real source queue entry')
    await pane.getByRole('button', { name: 'Send message', exact: true }).click()
    const queue = pane.locator('.hapi-source-queue')
    await expect(queue).toContainText('A real source queue entry')
    await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
    await expect(composer).toHaveText('A real source queue entry')
    await expect(queue).toHaveCount(0)
    expect(environment.hapi.sent).toHaveLength(1)
    expect(environment.hapi.cancelled).toHaveLength(1)
    await expect(status.locator('[data-delivery-state="indeterminate"]')).toHaveCount(5)
  })

  test('official compact rows show source action summaries and preserve expanded output on desktop and mobile', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(environment.launchUrl)
    await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
    await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex presentation' }).click()
    const pane = page.getByRole('region', { name: 'Pane: Native Codex presentation', exact: true })
    const rows = pane.locator('[data-sample="bash"]')
    await expect(rows).toHaveCount(2)
    const read = rows.filter({ hasText: 'Read example.ts' })
    const unknown = rows.filter({ hasText: 'check-service' })
    // The official completed turn and its tool group start collapsed.
    await pane.locator('button[data-turn-process]').click()
    await pane.locator('[data-step-process] button[data-process-activity]').click()
    await expect(read).toHaveAttribute('aria-expanded', 'false')
    await expect(read).not.toContainText('/usr/bin/zsh')
    await expect(read).toHaveAttribute('data-state', 'error')
    await read.click()
    await expect(pane.getByText('Full source command output', { exact: true })).toBeVisible()
    await expect(pane.getByText("sed -n '1,80p' /workspace/example.ts", { exact: true })).toBeVisible()
    await read.click()
    await unknown.click()
    await expect(pane.getByText('Source did not report the process exit code', { exact: true })).toBeVisible()
    await unknown.click()
    for (const width of [1536, 390, 360]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(read).toBeVisible()
      expect(await read.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await expect(pane.getByRole('textbox', { name: composerName, exact: true })).toBeVisible()
      await expect(pane.locator('.hapi-source-queue')).toHaveCount(0)
    }
    expect(errors).toEqual([])
    if (process.env.HAPI_DSH_VISUAL_OUTPUT) {
      // Capture the actual fixture application in a fresh browser via the host's
      // supported webshot command. No fake UI or production source is mutated.
      const ready = `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) [...dialog.querySelectorAll('button')].find(b => /^(Continue|继续)$/.test(b.textContent.trim()))?.click();
        const pane = document.querySelector('[aria-label="Pane: Native Codex presentation"]');
        if (!pane) [...document.querySelectorAll('.hapi-session-open')].find(b => b.textContent.includes('Native Codex presentation'))?.click();
        pane?.querySelector('button[data-turn-process][aria-expanded="false"]')?.click();
        pane?.querySelector('[data-step-process] button[data-process-activity][aria-expanded="false"]')?.click();
        const row = pane?.querySelector('[data-sample="bash"]');
        return !!row?.getBoundingClientRect().height && !!pane?.querySelector('[role="textbox"]');
      })()`
      for (const viewport of ['1440x900', '390x844']) {
        await promisify(execFile)('webshot', ['--url', environment.launchUrl, '--output', `${process.env.HAPI_DSH_VISUAL_OUTPUT}-${viewport}.png`,
          '--viewport', viewport, '--ready-js', ready, '--timeout-ms', '30000', '--quiet'], { timeout: 35000 })
      }
    }
  })
})
