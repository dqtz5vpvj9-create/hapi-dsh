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
  async function frames(count) {
    await page.evaluate(async count => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame) }, count)
  }
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
  async function scroll(delta, boundaryCrossing = false) {
    const box = await port.boundingBox()
    assert.ok(box && box.height > 100 && box.width > 100, 'official scrollport must have real geometry')
    const x = box.x + box.width / 2
    if (mobile) {
      const distance = Math.abs(delta)
      assert.ok(distance <= box.height - 220, 'one touch gesture must remain inside its scrollport')
      const y = box.y + (delta < 0 ? 80 : box.height - 140)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
      try {
        // The anchor test isolates a prepend from intentional finger movement:
        // approach outside the load runway, cross it with the final contact,
        // then hold the contact still through the commit. Cached traversal
        // below retains its twelve frame-paced moves. No geometry is replaced.
        const positions = boundaryCrossing ? [0.45, 1] : Array.from({ length: 12 }, (_, i) => (i + 1) / 12)
        for (const progress of positions) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - delta * progress, id: 1 }] })
          await frames(boundaryCrossing ? 3 : 1)
          if (boundaryCrossing && progress < 1) {
            const position = await port.evaluate(element => ({ top: element.scrollTop, runway: Math.min(element.clientHeight, 600) }))
            assert.ok(position.top > position.runway, 'the approach must remain outside the source load boundary')
            assert.equal(await page.evaluate(() => window.__hhpi.snapshot().a.busy), false)
          }
        }
        // Stationary contacts suppress an uncontrolled synthetic fling. The
        // ordinary browser still owns all scrolling and layout correction.
        await frames(6)
      } finally { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) }
    } else {
      const y = box.y + Math.min(200, box.height / 2)
      await page.mouse.move(x, y); await page.mouse.wheel(0, delta)
    }
    await settle()
  }
  async function boundary() {
    const before = await page.evaluate(() => window.__hhpi.snapshot().a.rows)
    // This setup moves only within accepted content; it is not evidence of a
    // touch traversal through all 160 rows. Browser input crosses the boundary.
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
    result.anchorProtocol = mobile ? 'final touch contact crosses runway; stationary contact through official commit' : 'completed wheel displacement followed by official commit'
    await scroll(-550, mobile)
  }
  return { settle, scroll, boundary, inputs: () => page.evaluate(() => window.__labInputs) }
}
