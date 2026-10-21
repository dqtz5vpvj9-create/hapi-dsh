import { acknowledgePreviewNotice } from './preview-notice.ts'
/** The official menu/editor/Remote are real; source filesystem and native delivery are explicit HTTP fixtures. */
import { test, expect } from '@playwright/test'
import { startOfficialEnvironment } from './official-runtime.ts'

test('official @ file candidates and reference chips stay on their original source machines', async ({ page }, info) => {
  const environment = await startOfficialEnvironment()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    environment.hapi.workbench.updateFile('native-alpha', '/workspace/alpha/alpha only.ts', 'Alpha file fixture\n')
    environment.hapi.workbench.updateFile('native-beta', '/workspace/beta/beta only.ts', 'Beta file fixture\n')
    await page.goto(environment.launchUrl)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    await acknowledgePreviewNotice(page, environment)
    await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click()
    const alpha = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true })
    await expect(alpha.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible()
    const alphaInput = alpha.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
    await alphaInput.fill('@alpha')
    const alphaCandidate = alpha.getByRole('option').filter({ hasText: 'alpha only.ts' })
    await expect(alphaCandidate).toBeVisible()
    await expect(alpha.getByRole('option').filter({ hasText: 'beta only.ts' })).toHaveCount(0)
    await alphaCandidate.click()
    await expect(alphaInput).toContainText('alpha only.ts')
    await expect(alpha.locator('[data-trigger-menu]')).toHaveCount(0)
    await alpha.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => environment.hapi.sent.filter(row => row.sessionId === 'native-alpha').length).toBe(1)
    expect(environment.hapi.sent[0]!.message.text).toContain('@"alpha only.ts"')
    expect(environment.hapi.sent[0]!.sessionId).toBe('native-alpha')

    await alphaInput.fill('@src/')
    await expect(alpha.getByRole('option').filter({ hasText: 'nested.txt' })).toBeVisible()
    await alphaInput.press('Escape')
    await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click()
    const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true })
    await expect(beta.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toBeVisible()
    const betaInput = beta.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
    await betaInput.fill('@beta')
    const betaCandidate = beta.getByRole('option').filter({ hasText: 'beta only.ts' })
    await expect(betaCandidate).toBeVisible()
    await expect(beta.getByRole('option').filter({ hasText: 'alpha only.ts' })).toHaveCount(0)
    await betaCandidate.click()
    await beta.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => environment.hapi.sent.filter(row => row.sessionId === 'native-beta').length).toBe(1)
    expect(environment.hapi.sent.at(-1)!.message.text).toContain('@"beta only.ts"')

    const reads = environment.hapi.workbench.fileRequests.filter(row => ['files', 'directory'].includes(row.route))
    expect(reads.some(row => row.sessionId === 'native-alpha' && row.machineId === 'machine-alpha' && row.route === 'files')).toBe(true)
    expect(reads.some(row => row.sessionId === 'native-beta' && row.machineId === 'machine-beta' && row.route === 'files')).toBe(true)
    expect(reads.some(row => row.sessionId === 'native-alpha' && row.path === '/workspace/alpha/src')).toBe(true)
    expect(reads.every(row => row.path === `/workspace/${row.sessionId.replace('native-', '')}`
      || row.path.startsWith(`/workspace/${row.sessionId.replace('native-', '')}/`))).toBe(true)
    expect(environment.hapi.workbench.fileWrites).toEqual([])
    expect(errors).toEqual([])
    await page.screenshot({ path: `${info.outputDir}/official-source-file-reference.png`, fullPage: true })
  } finally {
    await info.attach('source-reference-requests', { body: JSON.stringify(environment.hapi.workbench.fileRequests, null, 2), contentType: 'application/json' })
    await environment.close()
  }
})
