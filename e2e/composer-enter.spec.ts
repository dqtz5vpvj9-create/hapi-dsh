/** Official DSH editor/undo/menus/upload owner are real. HAPI delivery and explicit transport delays are fixtures. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

const composerName = 'Message or run a task, / commands, @ files or sessions'
async function admit(page: Page, environment: OfficialEnvironment): Promise<Locator> {
  await page.goto(environment.launchUrl)
  await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
  const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click()
  const pane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })
  await expect(pane.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible()
  await expect(pane.locator('[data-hapi-composer-enter]')).toHaveCount(1)
  return pane
}
async function preference(page: Page, pane: Locator, value: 'send' | 'newline'): Promise<void> {
  await pane.getByRole('button', { name: 'Host settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Message input', exact: true }).click()
  await settings.getByRole('combobox', { name: 'Enter key behavior', exact: true }).selectOption(value)
  await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0)
}

test.describe('original Enter preference on official composer owners', () => {
  let environment: OfficialEnvironment
  test.beforeAll(async () => { environment = await startOfficialEnvironment(true) })
  test.afterAll(async () => { await environment?.close() })

  test('selection, undo, file candidates, IME and held Enter preserve the original editor and exact source delivery', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    environment.hapi.workbench.updateFile('native-alpha', '/workspace/alpha/enter fixture.ts', 'File candidate fixture\n')
    const pane = await admit(page, environment), input = pane.getByRole('textbox', { name: composerName, exact: true })
    await preference(page, pane, 'newline')
    expect(await page.evaluate(() => localStorage.getItem('hapi-composer-enter-behavior'))).toBe('newline')
    const sent = environment.hapi.sent.length

    await input.fill('left SELECT right'); await input.press('Home')
    for (let index = 0; index < 5; index++) await input.press('ArrowRight')
    await page.keyboard.down('Shift')
    for (let index = 0; index < 6; index++) await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift'); await input.press('Enter')
    await expect.poll(() => input.innerText()).toBe('left \n right')
    await input.press('Control+z'); await expect(input).toHaveText('left SELECT right')
    expect(environment.hapi.sent).toHaveLength(sent)

    await input.fill('@enter')
    await expect(pane.getByRole('option').filter({ hasText: 'enter fixture.ts' })).toBeVisible()
    await input.press('Enter')
    await expect(pane.locator('[data-trigger-menu]')).toHaveCount(0)
    await expect(input.locator('[contenteditable="false"]')).toHaveCount(1)
    await input.press('End'); await input.press('Enter'); await page.keyboard.insertText('After the original file chip')
    await expect(input.locator('[contenteditable="false"]')).toHaveCount(1)
    await input.press('Control+Enter')
    await expect.poll(() => environment.hapi.sent.length).toBe(sent + 1)
    expect(environment.hapi.sent.at(-1)).toMatchObject({ sessionId: 'native-alpha' })
    expect(environment.hapi.sent.at(-1)!.message.text).toContain('@"enter fixture.ts"')
    expect(environment.hapi.sent.at(-1)!.message.text).toContain('\nAfter the original file chip')

    // CDP drives Chromium's actual composition engine; this is not a claim
    // about a particular desktop OS IME or mobile keyboard implementation.
    await input.fill('IME prefix ')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '候选', selectionStart: 2, selectionEnd: 2 })
    await expect(input).toContainText('候选')
    // A real IME consumes Enter's character event. Playwright.press also
    // emits an ordinary CR char, which is a separate edit rather than a
    // candidate confirmation; use the raw key around the actual commit.
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    expect(environment.hapi.sent).toHaveLength(sent + 1)
    expect(await input.innerText()).not.toContain('\n')
    await cdp.send('Input.insertText', { text: '中文' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await expect(input).toContainText('中文')
    // A normal key after composition settles remains ordinary editable text.
    await page.keyboard.insertText(' committed')
    await input.press('Control+Enter')
    await expect.poll(() => environment.hapi.sent.length).toBe(sent + 2)
    expect(environment.hapi.sent.at(-1)!.message.text).toContain('中文 committed')
    await cdp.detach()

    await input.fill('Held Enter submits once')
    await input.focus(); await page.keyboard.down('Control'); await page.keyboard.down('Enter'); await page.keyboard.down('Enter')
    await page.keyboard.up('Enter'); await page.keyboard.up('Control')
    await expect.poll(() => environment.hapi.sent.length).toBe(sent + 3)
    await expect(input).toHaveText('')
    await input.fill('Shift keeps the official line break'); await input.press('Shift+Enter'); await page.keyboard.insertText('second line')
    await expect.poll(() => input.innerText()).toBe('Shift keeps the official line break\nsecond line')
    expect(environment.hapi.sent).toHaveLength(sent + 3)

    await preference(page, pane, 'send')
    expect(await page.evaluate(() => localStorage.getItem('hapi-composer-enter-behavior'))).toBeNull()
    await input.fill('Default Enter keeps original DSH sending'); await input.press('Enter')
    await expect.poll(() => environment.hapi.sent.length).toBe(sent + 4)
    expect(environment.hapi.sent.at(-1)!.message.text).toBe('Default Enter keeps original DSH sending')
    expect(errors).toEqual([])
    await page.screenshot({ path: `${info.outputDir}/official-composer-enter-selection.png`, fullPage: true })
  })

  test('pending and failed attachments stay owned while newline preference survives remote panes and reload', async ({ page, context }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const pane = await admit(page, environment), input = pane.getByRole('textbox', { name: composerName, exact: true })
    await preference(page, pane, 'newline')
    const sent = environment.hapi.sent.length
    let release!: () => void, began = false
    const gate = new Promise<void>(resolve => { release = resolve })
    await context.route('**/api/session/uploadFileBinary?*', async route => {
      const name = new URL(route.request().url()).searchParams.get('name')
      if (name === 'pending-enter.txt') { began = true; await gate; await route.continue() }
      else if (name === 'failed-enter.txt') await route.fulfill({ status: 503, body: 'Explicit upload failure fixture' })
      else await route.continue()
    })
    try {
      await input.fill('Original draft with a pending attachment')
      await pane.locator('input[type="file"]').first().setInputFiles({ name: 'pending-enter.txt', mimeType: 'text/plain', buffer: Buffer.from('Original attachment bytes') })
      await expect.poll(() => began).toBe(true)
      await input.press('Control+Enter')
      // The official Toast is portalled to the owning graph's public overlay.
      await expect(page.getByText('Wait for the attachments to finish uploading before sending.', { exact: true })).toBeVisible()
      await expect(input).toHaveText('Original draft with a pending attachment')
      await expect(pane.getByRole('group', { name: 'Pending attachments', exact: true })).toContainText('pending-enter.txt')
      expect(environment.hapi.sent).toHaveLength(sent)
      release()
      await expect(pane.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
      await input.press('Control+Enter')
      await expect.poll(() => environment.hapi.sent.length).toBe(sent + 1)
      expect(environment.hapi.sent.at(-1)!.message.attachments).toHaveLength(1)
      await expect(pane.getByRole('group', { name: 'Pending attachments', exact: true })).toHaveCount(0)

      await input.fill('Original draft with a failed attachment')
      await pane.locator('input[type="file"]').first().setInputFiles({ name: 'failed-enter.txt', mimeType: 'text/plain', buffer: Buffer.from('Failure fixture bytes') })
      await expect(pane.getByRole('button', { name: 'Retry uploading failed-enter.txt', exact: true })).toBeVisible()
      await input.press('Meta+Enter')
      await expect(page.getByText('An attachment upload failed. Retry or remove it in the original attachment controls before sending.', { exact: true })).toBeVisible()
      expect(environment.hapi.sent).toHaveLength(sent + 1)
      await expect(input).toHaveText('Original draft with a failed attachment')
      await pane.getByRole('button', { name: 'Remove file failed-enter.txt', exact: true }).click()
      await input.fill('Local pane line one'); await input.press('Enter'); await page.keyboard.insertText('line two')
      await expect.poll(() => input.innerText()).toBe('Local pane line one\nline two')

      await page.getByRole('button', { name: 'Split left / right', exact: true }).click()
      await page.locator('.hapi-session-open').filter({ hasText: 'DSH remote conversation' }).click()
      const remote = page.getByRole('region', { name: 'Pane: DSH remote conversation', exact: true })
      await expect(remote.getByText('DSH fixture response through the official AgentLoop.', { exact: true }).first()).toBeVisible()
      const remoteInput = remote.getByRole('textbox', { name: composerName, exact: true })
      await expect(remote.locator('[data-hapi-composer-enter]')).toHaveCount(1)
      await remoteInput.fill('Remote pane line one'); await remoteInput.press('Enter'); await page.keyboard.insertText('line two')
      await expect.poll(() => remoteInput.innerText()).toBe('Remote pane line one\nline two')
      expect(environment.hapi.sent).toHaveLength(sent + 1)
      await page.reload()
      await expect(pane).toBeVisible(); await expect(remote).toBeVisible()
      // The original restore owner represents each semantic LF as a new
      // paragraph. Chromium innerText inserts two visual LFs between <p>s;
      // verify the original blocks, then the exact delivered source text.
      await expect(input.locator(':scope > p')).toHaveText(['Local pane line one', 'line two'])
      await expect(remoteInput.locator(':scope > p')).toHaveText(['Remote pane line one', 'line two'])
      await input.press('Control+End'); await input.press('Enter'); await page.keyboard.insertText('line three')
      expect(environment.hapi.sent).toHaveLength(sent + 1)
      await input.press('Control+Enter')
      await expect.poll(() => environment.hapi.sent.length).toBe(sent + 2)
      expect(environment.hapi.sent.at(-1)!.message.text).toBe('Local pane line one\nline two\nline three')
      await remoteInput.press('Meta+Enter')
      await expect(remoteInput).toHaveText('')
      await expect(remote.getByText('Remote pane line one\nline two', { exact: true })).toBeVisible()
      expect(environment.hapi.sent).toHaveLength(sent + 2)
      expect(errors).toEqual([])
      await page.screenshot({ path: `${info.outputDir}/official-composer-enter-attachments-remote.png`, fullPage: true })
    } finally { release(); await context.unrouteAll({ behavior: 'ignoreErrors' }) }
  })
})
