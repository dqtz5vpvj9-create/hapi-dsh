/** Trusted browser input against the official editor. No physical-device or OS-IME claim. */
import assert from 'node:assert/strict'

/** @param {import('playwright').Page} page @param {import('playwright').BrowserContext} context */
export async function exerciseDraftInput(page, context, mobile, result) {
  const editor = key => page.locator(`[data-lab-pane="${key}"] [contenteditable="true"]`)
  const state = () => page.evaluate(() => window.__hhpi.snapshot())
  const writes = () => page.evaluate(async () => (await (await fetch('/api/stats')).json()).writes.length)
  await page.evaluate(() => {
    window.__labKeyboard = { keydowns: 0, keyups: 0, composingEnters: 0, untrustedKeys: 0, compositionStarts: 0, compositionEnds: 0 }
    for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
      window.__labKeyboard[type === 'keydown' ? 'keydowns' : 'keyups']++
      if (!event.isTrusted) window.__labKeyboard.untrustedKeys++
      if (type === 'keydown' && event.key === 'Enter' && event.isComposing) window.__labKeyboard.composingEnters++
    }, true)
    document.addEventListener('compositionstart', () => { window.__labKeyboard.compositionStarts++ }, true)
    document.addEventListener('compositionend', () => { window.__labKeyboard.compositionEnds++ }, true)
  })
  await editor('a').click()
  await page.keyboard.type('Draft A'); await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('第二行')
  await page.waitForFunction(() => window.__hhpi.snapshot().a.draft.includes('第二行'))
  assert.match((await state()).a.draft, /Draft A\n第二行/)
  assert.equal(await writes(), 0, 'text and Shift+Enter must not submit')
  const cdp = await context.newCDPSession(page)
  try {
    await cdp.send('Input.imeSetComposition', { text: '拼音', selectionStart: 2, selectionEnd: 2 })
    await page.keyboard.press('Enter')
    assert.equal(await writes(), 0, 'Enter while the actual browser reports isComposing must not submit')
    await cdp.send('Input.insertText', { text: '拼音' })
    await page.waitForFunction(() => window.__labKeyboard.compositionEnds > 0 && window.__hhpi.snapshot().a.draft.includes('拼音'))
  } finally { await cdp.detach() }
  if (mobile) await page.locator('[data-select-pane="b"]').tap()
  await editor('b').click(); await page.keyboard.type('Draft B')
  await page.waitForFunction(() => window.__hhpi.snapshot().b.draft === 'Draft B')
  if (mobile) await page.locator('[data-select-pane="a"]').tap()
  assert.equal(await writes(), 0, 'typing, focus changes and composition confirmation must never send')
  result.keyboard = { ...await page.evaluate(() => window.__labKeyboard), transport: 'browser input protocol', physicalKeyboard: 'not-run', operatingSystemIME: 'not-run' }
  assert.equal(result.keyboard.untrustedKeys, 0)
  assert.ok(result.keyboard.keydowns > 0 && result.keyboard.keyups > 0)
  assert.equal(result.keyboard.composingEnters, 1, 'the composition guard must be exercised with a composing key event')
}
