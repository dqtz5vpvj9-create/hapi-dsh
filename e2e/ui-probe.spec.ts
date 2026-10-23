/** Negative controls for the measurement infrastructure, not product acceptance. */
import { expect, test } from '@playwright/test'
import { installUiProbe, paint } from './ui-probe.ts'
test.use({ screenshot: 'off', trace: 'off' })

test('the sampler detects a deliberate main-thread stall', async ({ page }) => {
  await installUiProbe(page); await page.goto('data:text/html,<main>Probe negative control</main>')
  await page.evaluate(() => window.__hapiUiProbe.begin()); await paint(page)
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(() => {
    const until = performance.now() + 250
    while (performance.now() < until) { /* Deliberate event-loop failure stimulus. */ }
    resolve()
  }, 0)))
  await paint(page)
  const sample = await page.evaluate(() => window.__hapiUiProbe.end())
  expect(Math.max(...sample.frames)).toBeGreaterThan(200)
  expect(Math.max(...sample.tasks)).toBeGreaterThan(200)
})

test('the sampler detects an intermediate prepend jump', async ({ page }) => {
  await installUiProbe(page); await page.goto('data:text/html,<main><p id="row">Stable anchor</p></main>')
  await page.evaluate(() => {
    const row = document.querySelector('#row')!, port = document.querySelector('main')!
    window.__hapiUiProbe.begin()
    window.__hapiUiProbe.anchor = { row, port, offset: row.getBoundingClientRect().top - port.getBoundingClientRect().top }
  })
  await paint(page)
  await page.evaluate(() => { const spacer = document.createElement('div'); spacer.style.height = '40px'; document.querySelector('main')!.prepend(spacer) })
  await paint(page)
  const sample = await page.evaluate(() => window.__hapiUiProbe.end())
  expect(Math.max(...sample.anchorOffsets)).toBeGreaterThan(1)
  expect(sample.missingAnchors).toBe(0)
})
