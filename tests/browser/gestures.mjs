/** Browser-input driver; real geometry throughout, explicit bounded positioning. */
import assert from 'node:assert/strict'

/** @param {import('playwright').Page} page @param {import('playwright').BrowserContext} context */
export async function createGestures(page, context, mobile, result) {
  const port = page.locator('[data-lab-pane="a"] [data-conversation-scroll]')
  const cdp = mobile ? await context.newCDPSession(page) : undefined
  await page.evaluate(() => {
    window.__labInputs = { wheel: 0, touchstart: 0, touchmove: 0, touchend: 0, untrusted: 0 }
    for (const type of ['wheel', 'touchstart', 'touchmove', 'touchend']) document.addEventListener(type, event => {
      window.__labInputs[type]++; if (!event.isTrusted) window.__labInputs.untrusted++
    }, { capture: true, passive: true })
  })
  async function settle() {
    await page.evaluate(async () => {
      let stable = 0, prior = ''
      for (let frame = 0; frame < 45; frame++) {
        await new Promise(requestAnimationFrame)
        const next = [...document.querySelectorAll('[data-conversation-scroll]')].map(port => port.scrollTop).join(',')
        if (next === prior && !window.__hhpi.snapshot().a.busy) stable++; else stable = 0
        prior = next; if (stable >= 3) return
      }
      throw new Error('Real scroll/layout did not settle within 45 animation frames')
    })
  }
  async function scroll(delta) {
    const box = await port.boundingBox()
    assert.ok(box && box.height > 100 && box.width > 100, 'official scrollport must have real geometry')
    const x = box.x + box.width / 2
    if (mobile) {
      // Dispatch trusted touch contacts, rather than synthesizeScrollGesture,
      // whose touch backend can acknowledge without delivering touchmove.
      const distance = Math.abs(delta)
      assert.ok(distance <= box.height - 220, 'one touch gesture must remain inside its scrollport')
      const y = box.y + (delta < 0 ? 80 : box.height - 140)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
      try {
        for (let step = 1; step <= 12; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - delta * step / 12, id: 1 }] })
          await page.evaluate(() => new Promise(requestAnimationFrame))
        }
        // End with stationary contacts to avoid adding an uncontrolled fling.
        // These are browser animation frames, not a fixture scroll correction.
        await page.evaluate(async () => { for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame) })
      } finally { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) }
    } else {
      const y = box.y + Math.min(200, box.height / 2)
      await page.mouse.move(x, y); await page.mouse.wheel(0, delta)
    }
    await settle()
  }
  async function boundary() {
    const before = await page.evaluate(() => window.__hhpi.snapshot().a.rows)
    // Position only within already accepted content. This is setup, never a
    // claimed touch traversal of all 160 rows. The boundary crossing below
    // must come from trusted browser input and the production paging policy.
    if (mobile) {
      await port.evaluate(element => element.scrollTo({ top: 900, behavior: 'instant' }))
      await page.evaluate(async () => {
        const start = performance.now()
        while (performance.now() - start < 450) await new Promise(requestAnimationFrame)
      })
    } else {
      const top = await port.evaluate(element => element.scrollTop)
      await scroll(900 - top)
    }
    await settle()
    assert.equal(await page.evaluate(() => window.__hhpi.snapshot().a.rows), before, 'loaded-window positioning must not page the source')
    result.positioning = mobile ? 'native scrollTo inside accepted window; trusted touch crosses each boundary' : 'trusted wheel through accepted window and boundary'
    await scroll(-550)
  }
  return { settle, scroll, boundary, inputs: () => page.evaluate(() => window.__labInputs) }
}
