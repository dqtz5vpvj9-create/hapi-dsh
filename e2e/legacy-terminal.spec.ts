import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Real browser/xterm and original HAPI SessionTerminal Socket.IO transport.
 * PTY output and writes are explicit fixtures; no model or shell credentials. */
import { test, expect, type Locator } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { panes, type WorkspaceState } from '../src/client/model.ts'

async function options(terminal: Locator): Promise<Locator> {
  await terminal.getByTestId('termbeam-touchbar').click({ button: 'right' })
  const dialog = terminal.page().getByRole('dialog', { name: 'Keyboard options', exact: true })
  await expect(dialog).toBeVisible(); return dialog
}

test.describe('existing HAPI v2 terminals in the official DSH view', () => {
  let environment: OfficialEnvironment
  test.beforeEach(async () => { environment = await startOfficialEnvironment() })
  test.afterEach(async () => { await environment?.close() })

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
    const official = terminal.locator('[data-sidebar-terminal]')
    const composed = terminal.locator('[data-hapi-terminal-controls]')
    const input = official.getByRole('textbox', { name: 'Terminal', exact: true })
    const control = terminal.getByRole('button', { name: 'Control', exact: true })
    try {
      await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
      await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
      await expect(terminal.locator('.hapi-legacy-terminal-toolbar [role=status]')).toContainText('Connected to source terminal')
      await expect(official.locator('.xterm')).toBeVisible()
      await expect(composed).toHaveCount(1)
      await expect(composed).toHaveAttribute('data-terminal-font', '9')
      await expect(official.locator('.xterm-char-measure-element').first()).toHaveCSS('font-size', '9px')
      await expect(pane.locator('.hapi-remote-shell')).toBeVisible()
      await expect(terminal.locator('.hapi-legacy-terminal-compat summary')).toContainText('Legacy SessionTerminal transport')
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
      const refused = 'x'.repeat(70_000), beforeRefusal = wire.inputs.length
      await command.fill(refused); await terminal.getByRole('button', { name: 'Run command', exact: true }).click()
      await expect(command).toHaveValue(refused)
      await expect(terminal.getByRole('button', { name: 'Run command', exact: true })).toBeDisabled()
      expect(wire.inputs).toHaveLength(beforeRefusal)
      await terminal.getByRole('button', { name: 'Reload terminal view', exact: true }).click()
      await expect(control).toBeEnabled(); await expect(command).toHaveValue(refused)
      expect(wire.inputs).toHaveLength(beforeRefusal)
      await command.fill('')

      await terminal.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await expect(official.locator('.xterm-char-measure-element').first()).toHaveCSS('font-size', '10px')
      await terminal.getByRole('button', { name: 'Zoom out', exact: true }).click()
      await expect(official.locator('.xterm-char-measure-element').first()).toHaveCSS('font-size', '9px')
      wire.output(sourceId, terminalId, '\r\n' + Array.from({ length: 450 }, (_, index) => `Legacy retained row ${index}`).join('\r\n') + '\r\n')
      await expect(official.locator('.xterm-rows')).toContainText('Legacy retained row 449')
      const beforeCopy = wire.inputs.length, beforeCopyAttaches = wire.attachments.length, beforeCopyResizes = wire.resizes.length
      await (await options(terminal)).getByRole('button', { name: 'Copy', exact: true }).click()
      const copy = page.getByRole('dialog', { name: 'Copy terminal text', exact: true })
      await expect(copy).toContainText('observed by this terminal adapter')
      await expect(copy).toContainText('bounded replay tail')
      await expect(copy.getByRole('textbox')).toHaveCount(0)
      await expect(copy.getByLabel('Terminal text snapshot', { exact: true })).toContainText('Legacy retained row 449')
      while (await copy.getByRole('button', { name: /^Load more/ }).count()) await copy.getByRole('button', { name: /^Load more/ }).click()
      await expect(copy.getByLabel('Terminal text snapshot', { exact: true })).toContainText('Legacy retained row 0')
      expect(wire.inputs).toHaveLength(beforeCopy); expect(wire.attachments).toHaveLength(beforeCopyAttaches); expect(wire.resizes).toHaveLength(beforeCopyResizes)
      await copy.getByLabel('Close', { exact: true }).click()

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
      await chat.locator('.hapi-pane-header > .hapi-pane-menu > summary').click()
      await chat.getByRole('button', { name: 'Host settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('button', { name: 'HAPI appearance', exact: true }).click()
      await settings.getByRole('combobox', { name: 'Terminal font size', exact: true }).selectOption('15')
      await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0)
      await expect(composed).toHaveAttribute('data-terminal-font', '15')
      await expect(official.locator('.xterm-char-measure-element').first()).toHaveCSS('font-size', '15px')
      expect(wire.attachments, 'Changing keys or font must not reconnect or replace the PTY').toHaveLength(1)
      await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
      const beforeReload = wire.inputs.length
      await page.reload(); await expect(terminal.locator('.hapi-legacy-terminal-toolbar [role=status]')).toContainText('Connected to source terminal')
      await expect(composed).toHaveAttribute('data-terminal-font', '15')
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
      await page.screenshot({ path: `${info.outputDir}/legacy-official-controls.png`, fullPage: true })
      expect(errors).toEqual([])
    } finally {
      await info.attach('original-terminal-wire', { body: JSON.stringify({ attachments: wire.attachments, inputs: wire.inputs,
        detachments: wire.detachments, closeRequests: wire.closeRequests, errors }, null, 2), contentType: 'application/json' })
      await info.attach('official-host', { body: environment.diagnostics(), contentType: 'text/plain' })
    }
  })

  test('separate original sources with the same terminal ID keep official tab navigation, titles, plugin views and detach-only lifetime', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const wire = environment.hapi.workbench.legacy, terminalId = 'same-original-terminal'
    wire.seed('native-alpha', terminalId, 'Original alpha terminal\r\n$ ')
    wire.seed('native-beta', terminalId, 'Original beta terminal\r\n$ ')
    environment.hapi.legacyWorkspaces = { schemaVersion: 2, revision: 12, workspaces: [{ id: 'two-source-legacy', name: 'Two original machines', autoName: false,
      root: { type: 'split', id: 'two-source-split', axis: 'horizontal', weights: [1, 2], children: [
        { type: 'pane', id: 'legacy-alpha', resource: { kind: 'terminal', sessionId: 'native-alpha', terminalId } },
        { type: 'pane', id: 'legacy-beta', resource: { kind: 'terminal', sessionId: 'native-beta', terminalId } },
      ] },
    }] }
    const alpha = page.locator('[data-pane-id="legacy-alpha"]'), beta = page.locator('[data-pane-id="legacy-beta"]')
    const savedTargets = async (alphaTarget: Record<string, unknown>): Promise<void> => {
      await expect.poll(async () => {
        const saved = await environment.rpc<{ state: WorkspaceState }>('hapi/workspaceGet')
        const window = saved.state?.windows.find(row => row.id === 'two-source-legacy')
        return window ? panes(window.root).map(pane => ({ id: pane.id, ...pane.resource })) : []
      }).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'legacy-alpha', kind: 'terminal', terminalId, sourceSessionId: 'native-alpha', sourceHubId: 'e2e-native-hub', target: expect.objectContaining(alphaTarget) }),
        expect.objectContaining({ id: 'legacy-beta', kind: 'terminal', terminalId, sourceSessionId: 'native-beta', sourceHubId: 'e2e-native-hub',
          target: expect.objectContaining({ type: 'tab', kind: 'hapi-legacy-terminal' }) }),
      ]))
    }
    try {
      await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
      await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
      await expect(alpha.locator('[data-sidebar-terminal] .xterm-rows')).toContainText('Original alpha terminal')
      await expect(beta.locator('[data-sidebar-terminal] .xterm-rows')).toContainText('Original beta terminal')
      await alpha.getByRole('textbox', { name: 'Terminal', exact: true }).pressSequentially('alpha-only\r')
      await beta.getByRole('textbox', { name: 'Terminal', exact: true }).pressSequentially('beta-only\r')
      await expect.poll(() => wire.inputs.filter(row => row.sessionId === 'native-alpha').map(row => row.data).join('')).toBe('alpha-only\r')
      await expect.poll(() => wire.inputs.filter(row => row.sessionId === 'native-beta').map(row => row.data).join('')).toBe('beta-only\r')
      expect(wire.attachments).toHaveLength(2)

      // This is the original TerminalTitle contribution, including its real
      // double-click rename action, bound to the isolated official model.
      await alpha.locator('[data-dockkit-tab]').filter({ hasText: 'HAPI SessionTerminal' }).dblclick()
      const rename = alpha.getByRole('textbox', { name: 'Terminal name', exact: true })
      await rename.fill('Alpha original alias'); await rename.press('Enter')
      await expect(alpha.locator('[data-dockkit-tab]').filter({ hasText: 'Alpha original alias' })).toBeVisible()
      await expect(beta.locator('[data-dockkit-tab]').filter({ hasText: 'HAPI SessionTerminal' })).toBeVisible()

      await alpha.locator('.hapi-pane-header > .hapi-pane-menu > summary').click()

      await alpha.getByRole('button', { name: 'Plugin views', exact: true }).click()
      await alpha.getByRole('button', { name: /Workspace files/ }).click()
      await expect(alpha.locator('[data-files-root]')).toHaveAttribute('data-files-root', '/workspace/alpha')
      await alpha.locator('[data-files-entry="file"]').getByRole('button', { name: 'source.txt', exact: true }).click()
      await expect(alpha.getByText('Source file from machine-alpha', { exact: true })).toBeVisible()
      await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
      await savedTargets({ type: 'resource' })
      await page.reload()
      await expect(alpha.getByText('Source file from machine-alpha', { exact: true })).toBeVisible()
      await expect(beta.locator('[data-sidebar-terminal] .xterm-rows')).toContainText('Original beta terminal')
      await savedTargets({ type: 'resource' })

      // A retained, inactive original tab also restores its exact source after
      // a graph reload; its transient TabDomain params are not a new PTY ID.
      await alpha.getByRole('tab').filter({ hasText: /Alpha original alias|Legacy terminal/ }).click()
      await expect(alpha.locator('[data-sidebar-terminal] .xterm-rows')).toContainText('Original alpha terminal')
      await savedTargets({ type: 'tab', kind: 'hapi-legacy-terminal' })
      await alpha.getByRole('tab').filter({ hasText: 'source.txt' }).click()
      await expect(alpha.getByText('Source file from machine-alpha', { exact: true })).toBeVisible()
      await savedTargets({ type: 'resource' })

      // Explicit Conversation must not be changed by retained hidden tabs.
      // Re-expanding the real sidebar is an explicit navigation choice.
      await alpha.locator('.hapi-pane-header > .hapi-pane-menu > summary').click()
      await alpha.getByRole('group', { name: 'Host tools', exact: true }).getByRole('button', { name: 'Conversation', exact: true }).click()
      await expect(alpha.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible()
      await expect(alpha.getByRole('button', { name: 'Open right sidebar', exact: true })).toBeVisible()
      await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
      await savedTargets({ type: 'conversation' })
      await page.reload()
      await expect(alpha.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible()
      await savedTargets({ type: 'conversation' })
      await alpha.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await expect(alpha.getByText('Source file from machine-alpha', { exact: true })).toBeVisible()
      await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
      await savedTargets({ type: 'resource' })
      await page.reload()
      await expect(alpha.getByText('Source file from machine-alpha', { exact: true })).toBeVisible()
      await savedTargets({ type: 'resource' })

      const saved = await environment.rpc<{ state: WorkspaceState }>('hapi/workspaceGet')
      const window = saved.state.windows.find(row => row.id === 'two-source-legacy')!
      expect(window.root.type).toBe('split')
      if (window.root.type === 'split') expect(window.root.weights[1]! / window.root.weights[0]!).toBeCloseTo(2)
      const resources = panes(window.root).map(pane => pane.resource)
      expect(resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'terminal', terminalId, sourceSessionId: 'native-alpha', target: expect.objectContaining({ type: 'resource' }) }),
        expect.objectContaining({ kind: 'terminal', terminalId, sourceSessionId: 'native-beta' }),
      ]))
      await page.screenshot({ path: `${info.outputDir}/legacy-official-plugin-navigation.png`, fullPage: true })
      await alpha.locator('.hapi-pane-header').getByRole('button', { name: 'Close pane', exact: true }).click()
      await beta.locator('.hapi-pane-header').getByRole('button', { name: 'Close pane', exact: true }).click()
      await expect(alpha).toHaveCount(0); await expect(beta).toHaveCount(0)
      expect(wire.closeRequests).toEqual([])
      expect(wire.inputs.every(row => row.terminalId === terminalId && row.machineId === `machine-${row.sessionId.replace('native-', '')}`)).toBe(true)
      expect(wire.inputs.map(row => row.data).join('')).toBe('alpha-only\rbeta-only\r')
      expect(environment.hapi.workbench.terminalCommands).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await info.attach('original-terminal-navigation-wire', { body: JSON.stringify({ attachments: wire.attachments, inputs: wire.inputs, detachments: wire.detachments, closeRequests: wire.closeRequests, errors }, null, 2), contentType: 'application/json' })
      await info.attach('official-host', { body: environment.diagnostics(), contentType: 'text/plain' })
    }
  })
})
