/** Cold native source → real production Host portals → official Chat and live readonly recovery. */
import assert from 'node:assert/strict'

export async function runColdOpenJourney(page, _context, origin, _mode, result) {
  const pane = id => page.locator(`[data-lab-pane="${id}"]`)
  const state = () => page.evaluate(() => window.__hhpi.snapshot())
  const stats = () => fetch(origin + '/api/stats').then(response => response.json())
  async function step(name, run) {
    result.activeStep = name
    const start = performance.now()
    await run(); result.steps.push({ name, ms: Math.round(performance.now() - start) }); delete result.activeStep
  }
  await step('unprepared native archive opens read-only history without an all-archive scan', async () => {
    await page.goto(origin + '/?native-open', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__hhpiFailure || window.__hhpi?.snapshot().ready?.includes('a'))
    assert.equal(await page.evaluate(() => window.__hhpiFailure), undefined)
    const first = await state(), source = await stats()
    assert.deepEqual(first.failures, [])
    assert.equal(first.panes.a.visible, 'visible')
    assert.equal(first.panes.a.body, true)
    assert.ok(first.readonly, 'the same native source genuinely refuses writing at first paint')
    assert.equal(source.seededDisplayEvents, 0)
    assert.equal(source.nativeTurns, 2048)
    assert.ok(source.bodyReads > 0 && source.bodyReads <= 7, 'first paint reads only a native metadata page, never 2048 turn bodies')
    assert.ok(source.nativeCalls.every(call => call.method !== 'thread/turns/list'))
    assert.equal(await pane('a').locator('[data-hapi-session-loading]').count(), 0)
    assert.ok(await pane('a').locator('[data-chat-flow]').isVisible())
    result.firstNativePaint = { ms: first.firstReadMs, nativeTurns: source.nativeTurns, bodyReads: source.bodyReads, readonlyBodyVisible: true }
  })
  await step('a second official Pane opens independently from the shared accepted source page', async () => {
    const before = await stats()
    await page.locator('[data-select-pane="b"]').click()
    await page.waitForFunction(() => window.__hhpi.snapshot().ready.includes('b'))
    assert.ok(await pane('b').locator('[data-chat-flow]').isVisible())
    assert.equal((await stats()).bodyReads, before.bodyReads)
    await page.locator('[data-select-pane="a"]').click()
    assert.ok(await pane('a').locator('[data-chat-flow]').isVisible())
  })
  await step('read-only input recovers in place without replacing the official reader or submitting its draft', async () => {
    const editor = pane('a').locator('[data-composer-input]')
    const send = pane('a').getByRole('button', { name: (await state()).sendLabel, exact: true })
    await editor.evaluate(element => { element.dataset.coldIdentity = 'same-editor' })
    assert.equal(await send.isDisabled(), true)
    const reply = await fetch(origin + '/api/native-writable', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hhpi-fixture': '1' }, body: '{}' })
    assert.equal(reply.ok, true)
    await page.waitForFunction(() => window.__hhpi.snapshot().readonly === null)
    assert.equal(await editor.getAttribute('data-cold-identity'), 'same-editor')
    await editor.fill('Unsent native source draft')
    assert.equal(await send.isDisabled(), false)
    const readonly = await fetch(origin + '/api/native-readonly', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hhpi-fixture': '1' }, body: '{}' })
    assert.equal(readonly.ok, true)
    await page.waitForFunction(() => window.__hhpi.snapshot().readonly !== null)
    assert.equal(await editor.textContent(), 'Unsent native source draft')
    assert.equal(await send.isDisabled(), true)
    await fetch(origin + '/api/native-writable', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hhpi-fixture': '1' }, body: '{}' })
    await page.waitForFunction(() => window.__hhpi.snapshot().readonly === null)
    assert.equal(await editor.textContent(), 'Unsent native source draft')
    assert.equal(await editor.getAttribute('data-cold-identity'), 'same-editor')
    assert.deepEqual((await stats()).writes, [])
  })
  await step('closing and reopening a Pane reuses native bodies and restores the official reader', async () => {
    const before = await stats()
    await page.evaluate(async () => window.__hhpi.reopen())
    await page.waitForFunction(() => window.__hhpi.snapshot().ready.includes('a'))
    assert.ok(await pane('a').locator('[data-chat-flow]').isVisible())
    assert.equal((await stats()).bodyReads, before.bodyReads)
    assert.deepEqual((await state()).failures, [])
  })
  await page.evaluate(async () => { await window.__hhpi.dispose(); await new Promise(requestAnimationFrame) })
}
