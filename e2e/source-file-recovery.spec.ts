import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Official DSH Files/Document views plus a simulated HAPI source filesystem.
 * This exercises actual browser IDB/Web Locks and HTTP/SSE, not a real Runner disk. */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

async function sourceFile(page: Page, environment: OfficialEnvironment): Promise<Locator> {
  await page.goto(environment.launchUrl)
  await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
  await acknowledgePreviewNotice(page, environment)
  await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click()
  const chat = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })
  await expect(chat.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible()
  const ids = new Set(await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id'))))
  const menu = chat.locator('.hapi-pane-header > .hapi-pane-menu')
  await menu.locator('summary').click(); await menu.getByRole('button', { name: 'Project files', exact: true }).click()
  await expect.poll(async () => (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).filter(id => !ids.has(id)).length).toBe(1)
  const id = (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).find(id => !ids.has(id))!
  const pane = page.locator(`[data-pane-id="${id}"]`)
  await pane.locator('[data-files-entry="file"]').getByRole('button', { name: 'source.txt', exact: true }).click()
  await expect(pane.getByText('Source file from machine-alpha', { exact: true })).toBeVisible()
  await chat.locator('.hapi-pane-header').getByRole('button', { name: 'Close pane', exact: true }).click()
  return pane
}

test('lost file-operation acknowledgement survives display rebind and page reload without a second mutation', async ({ page }, info) => {
  const environment = await startOfficialEnvironment(), failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') void dialog.accept(); else void dialog.dismiss() })
  try {
    const pane = await sourceFile(page, environment), source = environment.hapi.workbench
    const dialog = page.getByRole('dialog', { name: 'Source file tools', exact: true })
    const writes = () => source.fileWrites.filter(row => row.route === 'filesystem' || row.route === 'filesystem/upload')
    const display = () => environment.rpc<{ sessions: Array<{ id: string; hapiSessionId: string }> }>('hapi/catalog').then(result => result.sessions.find(row => row.hapiSessionId === 'native-alpha')!)
    const originalDisplay = (await display()).id
    await pane.getByRole('button', { name: 'Source file tools', exact: true }).click()
    await dialog.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('copy')
    await dialog.getByRole('button', { name: 'Inspect target', exact: true }).click()
    await expect(dialog.getByText(/Inspected source revision:/)).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Destination path', exact: true }).fill('/workspace/alpha/recovery-copy.txt')
    source.loseNextMutationAcknowledgement = true
    await dialog.getByRole('button', { name: 'Apply source operation', exact: true }).click()
    await expect(dialog.getByText(/The source result is unconfirmed or changed/)).toBeVisible()
    expect(writes()).toHaveLength(1)
    expect(source.files.get('native-alpha')!.get('/workspace/alpha/recovery-copy.txt')!.bytes.toString()).toBe(source.files.get('native-alpha')!.get('/workspace/alpha/source.txt')!.bytes.toString())
    const operationId = await dialog.locator('[data-source-file-operation]').getAttribute('data-source-file-operation')
    expect(operationId).toMatch(/^[a-f0-9-]{36}$/)
    await dialog.locator('footer').getByRole('button', { name: 'Close', exact: true }).click()
    const originalActions = await pane.getByRole('button', { name: 'Source file tools', exact: true }).elementHandle()
    expect(originalActions).not.toBeNull()

    // An actual source history correction retires its DSH display generation.
    // The resource pane keeps its source tuple while its old graph is disposed.
    const fixture = environment.hapi.require('native-alpha'), answer = fixture.rows[1]!
    answer.content = JSON.parse(JSON.stringify(answer.content).replace('Native history alpha in the official DSH Conversation.', 'Corrected source history in the same native thread.')) as unknown
    environment.hapi.emit({ type: 'messages-invalidated', sessionId: fixture.session.id, reason: 'native-history' })
    await expect.poll(async () => (await display()).id).not.toBe(originalDisplay)
    await expect.poll(() => originalActions!.evaluate(node => node.isConnected)).toBe(false)
    await expect(pane.getByText('Source file from machine-alpha', { exact: true })).toBeVisible()
    await pane.getByRole('button', { name: 'Recover source file operation', exact: true }).click()
    await expect(dialog.locator('[data-source-file-operation]')).toHaveAttribute('data-source-file-operation', operationId!)
    await expect(dialog.getByText(/The source result is unconfirmed or changed/)).toBeVisible()
    expect(writes()).toHaveLength(1)
    await dialog.locator('footer').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
    await page.reload()
    await expect(pane.getByRole('button', { name: 'Recover source file operation', exact: true })).toBeVisible()
    await pane.getByRole('button', { name: 'Recover source file operation', exact: true }).click()
    await expect(dialog.locator('[data-source-file-operation]')).toHaveAttribute('data-source-file-operation', operationId!)
    await expect(dialog.getByRole('button', { name: 'Apply source operation', exact: true })).toBeDisabled()
    expect(writes()).toHaveLength(1)
    const inspections = source.fileRequests.length
    await dialog.getByRole('button', { name: 'Inspect current source', exact: true }).click()
    const review = dialog.getByRole('button', { name: 'I reviewed the source; start a new action', exact: true })
    await expect(review).toBeEnabled()
    expect(source.fileRequests.slice(inspections).filter(row => row.route === 'filesystem/entry').map(row => row.path)).toEqual(['/workspace/alpha/source.txt', '/workspace/alpha/recovery-copy.txt'])
    expect(writes()).toHaveLength(1)
    await review.click()
    await expect(dialog.getByText(/You acknowledged the current source state locally/)).toBeVisible()
    await expect(dialog.getByText('Source confirmed this operation.', { exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('combobox', { name: 'Operation', exact: true })).toBeEnabled()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ sessionId: 'native-alpha', machineId: 'machine-alpha', body: { action: 'copy', path: '/workspace/alpha/source.txt', destination: '/workspace/alpha/recovery-copy.txt' } })
    expect(source.files.get('native-beta')!.has('/workspace/beta/recovery-copy.txt')).toBe(false)
    await page.screenshot({ path: `${info.outputDir}/source-file-operation-recovered.png`, fullPage: true })
    expect(failures).toEqual([])
  } finally { await environment.close() }
})

test('a browser without Web Locks preserves source reads and explicitly refuses file mutations', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined }) })
  const environment = await startOfficialEnvironment()
  try {
    const pane = await sourceFile(page, environment)
    await pane.getByRole('button', { name: 'Source file tools', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Source file tools', exact: true })
    await expect(dialog.getByRole('alert')).toContainText('Web Locks on trusted HTTPS or localhost')
    await expect(dialog.getByRole('button', { name: 'Apply source operation', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Upload files', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Inspect target', exact: true }).click()
    await expect(dialog.getByText(/Inspected source revision:/)).toBeVisible()
    expect(environment.hapi.workbench.fileWrites).toHaveLength(0)
    expect(failures).toEqual([])
  } finally { await environment.close() }
})
