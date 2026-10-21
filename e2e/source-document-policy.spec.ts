/** The original HAPI read policy differs from its active-session mutation policy.
 * Source authorization and bytes are explicit fixtures; viewers/HTTP are real. */
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { startOfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=', 'base64')
function pdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 32 120 Td (${text}) Tj ET\n`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`]
  let body = '%PDF-1.4\n'; const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const start = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(body)
}

test('inactive source documents outside chat cwd render, download and reload under the original Runner browse policy', async ({ page }, info) => {
  const environment = await startOfficialEnvironment()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const source = environment.hapi.require('native-alpha').session
  source.active = false
  source.metadata!.codexNativeConnection = 'history'
  environment.hapi.emit({ type: 'session-updated', sessionId: source.id })
  const wire = environment.hapi.workbench
  wire.browseRoots.set(source.id, ['/workspace/alpha', '/shared/reports'])
  const markdown = '# Authorized source report\n\nThe chat is offline; its original Runner still serves this document.\n\n![Source image](image.png)\n'
  wire.updateFile(source.id, '/shared/reports/review.md', markdown, 'text/markdown')
  wire.updateFile(source.id, '/shared/reports/image.png', pixel, 'image/png')
  wire.updateFile(source.id, '/shared/reports/review.pdf', pdf('Original source PDF'), 'application/pdf')
  wire.updateFile(source.id, '/private/denied.md', '# Must not be visible', 'text/markdown')
  const pane = (id: string, path: string) => ({ type: 'pane' as const, id, resource: { kind: 'document' as const,
    sessionId: source.id, document: { kind: 'file' as const, path, machineId: 'machine-alpha' } } })
  environment.hapi.legacyWorkspaces = { schemaVersion: 2, revision: 1, workspaces: [
    { id: 'source-documents', name: 'Source documents', autoName: false, root: { type: 'split', id: 'source-documents-split', axis: 'horizontal', weights: [1, 1],
      children: [pane('source-markdown', '/shared/reports/review.md'), pane('source-pdf', '/shared/reports/review.pdf')] } },
    { id: 'source-denied', name: 'Denied source document', autoName: false, root: pane('denied-document', '/private/denied.md') },
  ] }
  try {
    await page.setViewportSize({ width: 2048, height: 1088 })
    await page.goto(environment.launchUrl)
    await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
    const markdownPane = page.locator('[data-pane-id="source-markdown"]')
    const pdfPane = page.locator('[data-pane-id="source-pdf"]')
    await expect(markdownPane.getByRole('heading', { name: 'Authorized source report', exact: true })).toBeVisible()
    await expect.poll(() => markdownPane.getByRole('img', { name: 'Source image', exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(pdfPane.locator('[data-pdf-page="1"] canvas')).toBeVisible()
    await expect(pdfPane.locator('[data-pdf-text]')).toContainText('Original source PDF')
    const download = page.waitForEvent('download')
    await markdownPane.locator('.hapi-source-download button').click()
    const result = await download
    expect(result.suggestedFilename()).toBe('review.md')
    expect(await readFile((await result.path())!, 'utf8')).toBe(markdown)
    await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
    await page.reload()
    await expect(markdownPane.getByRole('heading', { name: 'Authorized source report', exact: true })).toBeVisible()
    await expect(pdfPane.locator('[data-pdf-text]')).toContainText('Original source PDF')
    wire.updateFile(source.id, '/shared/reports/review.md', '# Refreshed source report\n')
    await expect(markdownPane.getByRole('heading', { name: 'Refreshed source report', exact: true })).toBeVisible()
    await page.screenshot({ path: `${info.outputDir}/inactive-source-documents.png`, fullPage: true })
    await page.locator('.hapi-window-tabs').getByRole('tab', { name: /denied\.md/ }).click()
    const denied = page.locator('[data-pane-id="denied-document"]')
    await expect(denied).toContainText('Path is outside workspace roots')
    await expect(denied.getByRole('heading', { name: 'Must not be visible' })).toHaveCount(0)
    expect(wire.fileRequests.filter(request => request.path.startsWith('/shared/reports/')).every(request => request.sessionId === source.id && request.machineId === 'machine-alpha' && ['file', 'file-info'].includes(request.route))).toBe(true)
    expect(wire.fileRequests.some(request => request.route === 'file' && request.path === '/private/denied.md')).toBe(false)
    expect(wire.fileWrites).toEqual([])
    expect(environment.hapi.sent).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await info.attach('source-document-protocol', { body: JSON.stringify(wire.fileRequests, null, 2), contentType: 'application/json' })
    await info.attach('official-host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' })
    await environment.close()
  }
})
