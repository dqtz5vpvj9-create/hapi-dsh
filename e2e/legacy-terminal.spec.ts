/** Real browser/xterm and original HAPI SessionTerminal Socket.IO transport.
 * PTY output and writes are explicit fixtures; no model or shell credentials. */
import { test, expect, type Locator } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

async function options(terminal: Locator): Promise<Locator> {
  await terminal.getByTestId('termbeam-touchbar').click({ button: 'right' })
  const dialog = terminal.page().getByRole('dialog', { name: 'Keyboard options', exact: true })
  await expect(dialog).toBeVisible(); return dialog
}

test.describe('existing HAPI v2 terminal controls', () => {
  let environment: OfficialEnvironment
  test.beforeAll(async () => { environment = await startOfficialEnvironment() })
  test.afterAll(async () => { await environment?.close() })

  test('preserves original PTY identity while restoring shared keys, macros, command mode, sticky modifiers and font', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const sourceId = 'native-alpha', terminalId = 'original-session-terminal'
    const wire = environment.hapi.workbench.legacy
    wire.seed(sourceId, terminalId)
    environment.hapi.legacyWorkspaces = { schemaVersion: 2, revision: 11, workspaces: [{
      id: 'existing-terminal-window', name: 'Original terminal workspace', autoName: false,
      root: { type: 'split', id: 'existing-terminal-split', axis: 'horizontal', weights: [1, 1], children: [
        { type: 'pane', id: 'existing-terminal-pane', resource: { kind: 'terminal', sessionId: sourceId, terminalId } },
        { type: 'pane', id: 'existing-chat-pane', resource: { kind: 'chat', sessionId: sourceId } },
      ] },
    }] }
    await page.addInitScript(() => {
      if (localStorage.getItem('legacy-terminal-fixture-seeded')) return
      localStorage.setItem('legacy-terminal-fixture-seeded', 'yes')
      localStorage.setItem('hapi-terminal-font-size', '9')
    })
    const pane = page.locator('[data-pane-id="existing-terminal-pane"]')
    const terminal = pane.locator(`[data-hapi-legacy-terminal="${terminalId}"]`)
    const input = terminal.locator('.xterm-helper-textarea')
    const control = terminal.getByRole('button', { name: 'Control', exact: true })
    try {
      await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
      const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
      if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(terminal.getByRole('status')).toContainText('Connected to source terminal')
      await expect(terminal).toHaveAttribute('data-terminal-font', '9')
      await expect(control).toBeEnabled()
      expect(wire.attachments).toHaveLength(1)
      expect(wire.attachments[0]).toMatchObject({ sessionId: sourceId, terminalId, replayProtocol: 1 })

      await control.click(); await input.pressSequentially('cn')
      await expect.poll(() => wire.inputs.map(row => row.data).join('')).toBe('\x03n')
      await control.click({ delay: 650 }); await expect(control).toHaveAttribute('aria-pressed', 'true')
      await input.pressSequentially('c')
      wire.output(sourceId, terminalId, '\r\nOriginal source output while modifier is locked\r\n')
      await expect(terminal.locator('.xterm-rows')).toContainText('Original source output while modifier is locked')
      await expect(control).toBeEnabled(); await expect(control).toHaveAttribute('aria-pressed', 'true')
      await input.pressSequentially('n')
      await expect.poll(() => wire.inputs.map(row => row.data).join('')).toBe('\x03n\x03\x0e')
      await control.click(); await expect(control).toHaveAttribute('aria-pressed', 'false')

      await (await options(terminal)).getByRole('button', { name: 'Command', exact: true }).click()
      const command = terminal.getByRole('textbox', { name: 'Command input', exact: true })
      await command.fill('pwd'); await terminal.getByRole('button', { name: 'Run command', exact: true }).click()
      await expect.poll(() => wire.inputs.at(-1)?.data).toBe('pwd\r'); await expect(command).toHaveValue('')

      await (await options(terminal)).getByRole('button', { name: 'Customize keys', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Customize keys', exact: true })
      await editor.getByRole('combobox', { name: 'Key to edit', exact: true }).selectOption('')
      await editor.getByRole('textbox', { name: 'Label', exact: true }).fill('Legacy macro')
      await editor.getByRole('combobox', { name: 'Action', exact: true }).selectOption('raw')
      await editor.getByRole('textbox', { name: 'Text to send', exact: true }).fill('echo saved\\r')
      await editor.getByRole('button', { name: 'Add key', exact: true }).click()
      await editor.getByRole('combobox', { name: 'Placement', exact: true }).selectOption('0')
      await editor.getByLabel('Close', { exact: true }).click()
      await terminal.getByRole('button', { name: 'Snippets', exact: true }).click()
      await page.getByRole('dialog', { name: 'Snippets', exact: true }).getByRole('button', { name: 'Legacy macro', exact: true }).click()
      await expect.poll(() => wire.inputs.at(-1)?.data).toBe('echo saved\r')

      const chat = page.locator('[data-pane-id="existing-chat-pane"]')
      await chat.getByRole('button', { name: 'Host settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('button', { name: 'HAPI appearance', exact: true }).click()
      await settings.getByRole('combobox', { name: 'Terminal font size', exact: true }).selectOption('15')
      await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0)
      await expect(terminal).toHaveAttribute('data-terminal-font', '15')
      expect(wire.attachments, 'Changing keys or font must not reconnect or replace the PTY').toHaveLength(1)
      await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
      const beforeReload = wire.inputs.length
      await page.reload(); await expect(terminal.getByRole('status')).toContainText('Connected to source terminal')
      await expect(terminal).toHaveAttribute('data-terminal-font', '15')
      await expect.poll(() => wire.attachments.length).toBe(2)
      expect(wire.inputs).toHaveLength(beforeReload)
      await terminal.getByRole('button', { name: 'Snippets', exact: true }).click()
      await page.getByRole('dialog', { name: 'Snippets', exact: true }).getByRole('button', { name: 'Legacy macro', exact: true }).click()
      await expect.poll(() => wire.inputs.length).toBe(beforeReload + 1)
      expect(wire.inputs.at(-1)?.data).toBe('echo saved\r')
      await pane.locator('.hapi-pane-header').getByRole('button', { name: 'Close pane', exact: true }).click()
      await expect(pane).toHaveCount(0); await expect.poll(() => wire.detachments.length).toBe(2)
      expect(wire.closeRequests).toEqual([])
      expect(wire.attachments.every(row => row.sessionId === sourceId && row.terminalId === terminalId)).toBe(true)
      expect(wire.inputs.every(row => row.sessionId === sourceId && row.terminalId === terminalId && row.machineId === 'machine-alpha')).toBe(true)
      expect(environment.hapi.workbench.terminalCommands).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await info.attach('original-terminal-wire', { body: JSON.stringify({ attachments: wire.attachments, inputs: wire.inputs,
        detachments: wire.detachments, closeRequests: wire.closeRequests, errors }, null, 2), contentType: 'application/json' })
      if (errors.length) await info.attach('official-host', { body: environment.diagnostics(), contentType: 'text/plain' })
    }
  })
})
