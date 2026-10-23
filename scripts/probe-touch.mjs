/** Read-only mobile gesture probe. Records geometry and anonymous DOM ordinals,
 * never source identifiers, messages, tool inputs, or credentials. */
export async function probeTouch(page, cdp) {
  const pane = page.locator('.hapi-pane-focused:visible').first()
  const port = pane.locator('[data-conversation-scroll]')
  const runs = []
  for (const direction of ['earlier', 'later']) {
    await pane.evaluate(pane => {
      const port = pane.querySelector('[data-conversation-scroll]')
      const ids = new WeakMap(); let next = 0
      const probe = { active: true, frames: [], gesture: -1, touching: false, stop() { intersections.disconnect(); changes.disconnect() } }
      window.__hapiTouchProbe = probe
      // Reading every off-screen rect defeats content-visibility and creates
      // the very layout stalls this probe is intended to measure.
      const visible = new Set(), observed = new WeakSet()
      const intersections = new IntersectionObserver(entries => {
        for (const entry of entries) entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target)
      }, { root: port })
      const discover = () => {
        for (const row of pane.querySelectorAll('[data-chat-anchor-key]')) {
          if (observed.has(row)) continue
          observed.add(row); intersections.observe(row)
        }
      }
      const changes = new MutationObserver(discover); changes.observe(port, { childList: true, subtree: true }); discover()
      let previousAnchor = null
      const tick = at => {
        if (!probe.active) return
        const box = port.getBoundingClientRect()
        let firstRow = null
        const rows = [...visible].flatMap(row => {
          if (!row.isConnected) { visible.delete(row); intersections.unobserve(row); return [] }
          const rect = row.getBoundingClientRect()
          if (!rect.height || rect.bottom <= box.top || rect.top >= box.bottom || row.closest('[hidden]')) return []
          firstRow ??= row
          if (!ids.has(row)) ids.set(row, ++next)
          return [{ id: ids.get(row), top: rect.top - box.top }]
        })
        // IntersectionObserver delivers asynchronously after a prepend. Verify
        // an apparent blank with bounded viewport hit tests, not an off-screen
        // transcript scan that would defeat content-visibility.
        const intersectionMiss = !rows.length
        if (intersectionMiss) {
          const bottom = Math.min(box.bottom, pane.querySelector('[data-composer-card]')?.getBoundingClientRect().top ?? box.bottom)
          for (const fraction of [.1, .3, .5, .7, .9]) {
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + (bottom - box.top) * fraction)
            const row = hit?.closest('[data-chat-anchor-key]')
            if (!row || !port.contains(row) || row.closest('[hidden]')) continue
            if (!ids.has(row)) ids.set(row, ++next)
            if (rows.some(value => value.id === ids.get(row))) continue
            const rect = row.getBoundingClientRect()
            if (rect.height > 0 && rect.bottom > box.top && rect.top < bottom) {
              firstRow ??= row
              rows.push({ id: ids.get(row), top: rect.top - box.top })
            }
          }
        }
        // Keep one old visible node across a prepend so a viewport-sized
        // displacement cannot disappear when the visible-key sets stop overlap.
        const retainedAnchorMove = previousAnchor?.element.isConnected && port.scrollHeight !== previousAnchor.height
          ? { id: ids.get(previousAnchor.element), before: previousAnchor.top,
            after: previousAnchor.element.getBoundingClientRect().top - box.top, heightChange: port.scrollHeight - previousAnchor.height } : null
        probe.frames.push({ at, gesture: probe.gesture, touching: probe.touching, top: port.scrollTop, height: port.scrollHeight, viewport: box.height,
          composerTop: pane.querySelector('[data-composer-card]')?.getBoundingClientRect().top, intersectionMiss, retainedAnchorMove,
          ...(retainedAnchorMove ? { overflowAnchor: getComputedStyle(port).overflowAnchor } : {}), rows })
        previousAnchor = firstRow ? { element: firstRow, top: rows[0].top, height: port.scrollHeight } : null
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    for (let gesture = 0; gesture < 12; gesture++) {
      const box = await port.boundingBox()
      if (!box) throw new Error('The production transcript disappeared during scrolling')
      const x = box.x + box.width * .55
      const start = box.y + box.height * (direction === 'earlier' ? .25 : .75)
      const end = box.y + box.height * (direction === 'earlier' ? .75 : .25)
      const points = y => [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }]
      const steps = gesture % 2 ? 6 : 12
      await page.evaluate(gesture => { window.__hapiTouchProbe.gesture = gesture; window.__hapiTouchProbe.touching = true }, gesture)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) })
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(start + (end - start) * i / steps) })
        await page.waitForTimeout(steps === 6 ? 8 : 18)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.evaluate(() => { window.__hapiTouchProbe.touching = false })
      await page.waitForTimeout(400)
    }
    const frames = await page.evaluate(() => { const probe = window.__hapiTouchProbe; probe.active = false; probe.stop(); return probe.frames.filter(frame => frame.gesture >= 0) })
    let reversePx = 0, maxStepPx = 0, totalPx = 0, maxFrameMs = 0, unpairedFrames = 0
    for (let i = 1; i < frames.length; i++) {
      const before = frames[i - 1], after = frames[i]
      maxFrameMs = Math.max(maxFrameMs, after.at - before.at)
      const previous = before.rows.find(row => after.rows.some(next => next.id === row.id))
      const next = previous && after.rows.find(row => row.id === previous.id)
      if (!previous || !next) { unpairedFrames++; continue }
      const dy = next.top - previous.top, signed = direction === 'earlier' ? dy : -dy
      reversePx = Math.max(reversePx, -signed); maxStepPx = Math.max(maxStepPx, Math.abs(dy)); totalPx += signed
    }
    runs.push({ direction, gestures: 12, frames, metrics: { reversePx, maxStepPx, totalPx, maxFrameMs, unpairedFrames,
      blankFrames: frames.filter(frame => !frame.rows.length).length,
      intersectionLagFrames: frames.filter(frame => frame.intersectionMiss && frame.rows.length).length,
      maxRetainedAnchorStepPx: Math.max(0, ...frames.map(frame => frame.retainedAnchorMove
        ? Math.abs(frame.retainedAnchorMove.after - frame.retainedAnchorMove.before) : 0)),
      composerShiftPx: Math.max(...frames.map(f => f.composerTop)) - Math.min(...frames.map(f => f.composerTop)) } })
  }
  return { environment: 'Trusted CDP touch, mobile Chromium emulation; physical finger and browser address-bar movement are not covered', runs }
}
