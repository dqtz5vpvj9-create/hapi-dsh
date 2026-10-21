/** Official DSH browser integration with explicit HAPI wire fixtures, without model/CLI credentials. */
import { test, expect, type Page } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import type { SourceHistoryPiResult, SourceHistoryTools } from '../src/hapi-agent/history-types.ts'

async function openWorkspace(page: Page, environment: OfficialEnvironment) {
  await page.goto(environment.launchUrl)
  await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
  const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
}
async function openSource(page: Page, name: string, tab: string) {
  await page.locator('.hapi-session-open').filter({ hasText: name }).click()
  const pane = page.getByRole('region', { name: `Pane: ${name}`, exact: true })
  await expect(pane).toBeVisible()
  await pane.getByRole('combobox', { name: 'Conversation tools', exact: true }).selectOption(tab)
  return pane
}

test.describe('original Pi histories and native migrations in official plugin tabs', () => {
  let environment: OfficialEnvironment
  test.beforeAll(async () => {
    environment = await startOfficialEnvironment()
    environment.hapi.history.addPi('recover')
    environment.hapi.history.addPi('bulk')
    environment.hapi.history.homes.set('machine-alpha', [
      { id: 'home-alpha', label: 'Personal', path: '/home/alpha/.codex' },
      { id: 'home-target', label: 'Fixture migration target', path: '/fixture/target-codex-home' },
    ])
    const cursor = environment.hapi.history.addCursor(environment.hapi, 'cross-host')
    environment.hapi.history.cursorRefusals.set(cursor.session.id, { ok: false, sessionId: cursor.session.id,
      reason: 'cross_host_session', message: 'Fixture legacy store belongs to another HAPI host', durationMs: 1 })
  })
  test.afterAll(async () => { await environment?.close() })

  test('lost Pi import recovers the original branch and continues it once after reload', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await openWorkspace(page, environment)
    let pane = await openSource(page, 'Native Codex alpha', 'hapi-library')
    await pane.getByRole('tab', { name: 'Pi history', exact: true }).click()
    let history = pane.getByRole('region', { name: 'Pi history', exact: true })
    await expect(history.getByText('Pi history recover', { exact: true })).toBeVisible()
    await history.getByRole('searchbox', { name: 'Search title, native identity, path or model', exact: true }).fill('recover')
    await history.locator('.hapi-source-notes > li').filter({ hasText: 'Pi history recover' }).getByRole('checkbox').check()
    environment.hapi.history.dropNextImportReply = true
    await history.getByRole('button', { name: 'Import and continue selected Pi session', exact: true }).click()
    await expect.poll(() => environment.hapi.history.imports.length).toBe(1)
    await expect(history.getByRole('button', { name: 'Continue this imported Pi session', exact: true })).toBeVisible()
    expect(environment.hapi.history.reopens).toHaveLength(0)
    const sourceId = environment.hapi.history.piHistories.get('pi-native-recover')!.sourceId!
    const original = await environment.rpc<SourceHistoryPiResult>('hapi/sourceHistoryPi', { machineId: 'machine-alpha' })
    const operationId = original.operations[0]!.operationId

    await page.reload(); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    pane = await openSource(page, 'Native Codex alpha', 'hapi-library')
    await pane.getByRole('tab', { name: 'Pi history', exact: true }).click()
    history = pane.getByRole('region', { name: 'Pi history', exact: true })
    await expect(history.getByText(operationId, { exact: true })).toBeVisible()
    await history.getByRole('button', { name: 'Continue this imported Pi session', exact: true }).click()
    const imported = page.getByRole('region', { name: 'Pane: Pi history recover', exact: true })
    await expect(imported).toBeVisible()
    await expect(imported.getByText('Original pi answer in the official DSH Conversation.', { exact: true })).toBeVisible()
    expect(environment.hapi.history.imports).toHaveLength(1)
    expect(environment.hapi.history.reopens).toEqual([sourceId])
    expect(environment.hapi.require(sourceId).session.metadata?.piSessionId).toBe('pi-native-recover')
    const read = await environment.rpc<SourceHistoryPiResult>('hapi/sourceHistoryPi', { machineId: 'machine-alpha' })
    expect(read.operations[0]).toMatchObject({ operationId, status: 'confirmed', sourceSessionId: sourceId })
    expect(read.operations[0]?.items[0]).toMatchObject({ confirmation: 'metadata', action: null, appended: null })
    await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
    await expect(page.locator('iframe')).toHaveCount(0); expect(errors).toEqual([])
  })

  test('a lost Codex home migration response stays unknown when target metadata becomes visible', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await openWorkspace(page, environment)
    let pane = await openSource(page, 'Native Codex alpha', 'hapi-session-tools')
    let migration = pane.getByRole('region', { name: 'Native history and migration', exact: true })
    type Catalog = { sessions: Array<{ id: string; hapiSessionId: string }> }
    const current = async () => (await environment.rpc<Catalog>('hapi/catalog')).sessions.find(row => row.hapiSessionId === 'native-alpha')!
    const originalDisplay = (await current()).id
    await migration.getByRole('combobox', { name: 'Target home on the same Runner', exact: true }).selectOption('home-target')
    environment.hapi.history.dropNextCodexMigrationReply = true
    await migration.getByRole('button', { name: 'Review home migration', exact: true }).click()
    await migration.getByRole('group', { name: 'Confirm native history operation', exact: true })
      .getByRole('button', { name: 'Confirm source operation', exact: true }).click()
    await expect.poll(() => environment.hapi.history.codexMigrations.length).toBe(1)
    expect(environment.hapi.history.codexMigrations[0]).toMatchObject({ machineId: 'machine-alpha', body: {
      sourceHome: '/home/alpha/.codex', targetHome: '/fixture/target-codex-home', targetHomeId: 'home-target',
      threadId: 'codex-thread-alpha', sessionId: 'native-alpha', stopSource: true,
    } })
    await expect.poll(async () => (await current()).id).not.toBe(originalDisplay)
    const tools = await environment.rpc<SourceHistoryTools>('hapi/sourceHistoryTools', { sessionId: (await current()).id })
    const operationId = tools.operations[0]!.operationId
    await environment.rpc('hapi/sourceHistoryOperationRead', { operationId })
    await page.reload(); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    pane = await openSource(page, 'Native Codex alpha', 'hapi-session-tools')
    migration = pane.getByRole('region', { name: 'Native history and migration', exact: true })
    await expect(migration.getByText(/file-verification outcome remain unknown/)).toBeVisible()
    await migration.getByRole('button', { name: 'Read original receipt', exact: true }).click()
    const observed = await environment.rpc<SourceHistoryTools>('hapi/sourceHistoryTools', { sessionId: (await current()).id })
    expect(observed.operations[0]).toMatchObject({ operationId, status: 'indeterminate', codexResult: null,
      observation: { targetObserved: true, nativeId: 'codex-thread-alpha', codexHome: '/fixture/target-codex-home' } })
    expect(environment.hapi.history.codexMigrations).toHaveLength(1)
    expect(environment.hapi.require('native-alpha').session.metadata?.codexSessionId).toBe('codex-thread-alpha')
    expect(errors).toEqual([])
  })

  test('Cursor shows exact source refusal without private response fields, then retains the legacy store on explicit migration', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await openWorkspace(page, environment)
    const pane = await openSource(page, 'Cursor history cross-host', 'hapi-session-tools')
    const migration = pane.getByRole('region', { name: 'Native history and migration', exact: true })
    await expect(migration.getByRole('checkbox', { name: 'Keep the original legacy store after migration', exact: true })).toBeChecked()
    const confirm = async () => {
      await migration.getByRole('button', { name: 'Review Cursor migration', exact: true }).click()
      await migration.getByRole('group', { name: 'Confirm native history operation', exact: true })
        .getByRole('button', { name: 'Confirm source operation', exact: true }).click()
    }
    await confirm()
    await expect(migration.getByText(/cross_host_session: Fixture legacy store belongs to another HAPI host/)).toBeVisible()
    expect(environment.hapi.history.cursorMigrations).toHaveLength(1)
    const sourceId = 'source-cursor-cross-host'
    const catalog = await environment.rpc<{ sessions: Array<{ id: string; hapiSessionId: string }> }>('hapi/catalog')
    const sessionId = catalog.sessions.find(row => row.hapiSessionId === sourceId)!.id
    const failed = await environment.rpc<SourceHistoryTools>('hapi/sourceHistoryTools', { sessionId })
    expect(failed.operations[0]?.cursorResult).toMatchObject({ ok: false, reason: 'cross_host_session' })
    expect(JSON.stringify(failed)).not.toContain(environment.hapi.history.privateFieldSentinel)
    await expect(migration).not.toContainText(environment.hapi.history.privateFieldSentinel)

    environment.hapi.history.cursorRefusals.delete(sourceId)
    await confirm()
    await expect(migration.getByText(/Legacy source retained/)).toBeVisible()
    expect(environment.hapi.history.cursorMigrations).toHaveLength(2)
    expect(environment.hapi.history.cursorMigrations[1]).toEqual({ sourceId, body: { keepSource: true, forceArchiveRunning: false, skipVerify: false } })
    expect(environment.hapi.require(sourceId).session.metadata).toMatchObject({ cursorSessionId: 'cursor-native-cross-host', cursorSessionProtocol: 'acp' })
    await expect(migration.getByRole('button', { name: 'Review Cursor migration', exact: true })).toBeDisabled()
    expect(errors).toEqual([])
  })
})
