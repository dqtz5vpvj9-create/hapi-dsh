/** Trusted touch gestures against the actual official Conversation. Synthetic
 * source data only; screenshots use webshot and require human visual review. */
import { test, expect, type Page, type Locator, type CDPSession } from '@playwright/test'
import { WarmOfficialSession } from './warm-session.ts'
import { beginUiLive } from './ui-live-fixture.ts'
import { visualReview, conversationReady } from './visual-review.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeIndexedHistory, useBoundedSourceHistory } from './source-conversation-fixture.ts'

type MotionFrame = { at: number; top: number; height: number; portTop: number; portHeight: number;
  composerTop: number; headerHeight: number; rows: Array<{ key: string; top: number }>;
  hitRows: Array<{ key: string; top: number }>; intersectionMiss: boolean;
  retainedAnchorMove: { key: string; before: number; after: number; heightChange: number } | null;
  boundaryAnchor: { key: string; retained: boolean; offset: number } | null;
  touching: boolean; overflowAnchor?: string; following: boolean }
let warm: WarmOfficialSession
test.beforeAll(async () => {
  warm = new WarmOfficialSession(); await warm.start()
  const fixture = warm.environment.hapi.add('touch-tools', 'Synthetic mobile tool history', 'machine-alpha')
  const threadId = fixture.session.metadata!.codexSessionId!
  fixture.rows = nativeIndexedHistory(threadId, 12, 101)
  for (const row of fixture.rows) {
    const envelope = row.content as { content?: { data?: Record<string, unknown> }; meta?: { nativeExecution: { turnId: string; itemId: string } } }
    if (envelope.content?.data?.type !== 'reasoning') continue
    const execution = envelope.meta!.nativeExecution, ordinal = Number(execution.itemId.replace('item-', ''))
    const callId = `${execution.turnId}-tool-${Math.floor(ordinal / 2)}`
    const toolExecution = { threadId, ...execution, itemId: callId }
    envelope.meta!.nativeExecution = toolExecution
    const type = ordinal % 2 ? 'tool-call-result' : 'tool-call'
    envelope.content.data = { type, id: row.id, callId, nativeExecution: toolExecution,
      ...(type === 'tool-call' ? { name: 'CodexBash', input: { command: `rg -n 'touch history ${ordinal}' src/client`, description: `Inspect scroll step ${ordinal}` } }
        : { output: Array(30).fill('Synthetic output: retained text must stay in place during a touch gesture.').join('\n') }) }
  }
  useBoundedSourceHistory(fixture)
  warm.environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
})
test.afterAll(async () => { await warm?.close() })
test.use({ screenshot: 'off', trace: { mode: 'retain-on-failure', snapshots: process.env.HAPI_DSH_TOUCH_SNAPSHOTS === '1' } })

async function frames(page: Page, pane: Locator, active: boolean): Promise<MotionFrame[]> {
  if (!active) return page.evaluate(() => {
    const probe = Reflect.get(window, '__touchMotion'); probe.active = false; probe.stop(); return probe.frames
  })
  await pane.evaluate(pane => {
    const port = pane.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const visible = new Set<HTMLElement>(), observed = new WeakSet<HTMLElement>()
    const intersections = new IntersectionObserver(entries => {
      for (const entry of entries) entry.isIntersecting ? visible.add(entry.target as HTMLElement) : visible.delete(entry.target as HTMLElement)
    }, { root: port })
    const discover = () => {
      for (const row of pane.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
        if (observed.has(row)) continue
        observed.add(row); intersections.observe(row)
      }
    }
    const changes = new MutationObserver(discover); changes.observe(port, { childList: true, subtree: true }); discover()
    const longFrames: Array<Record<string, unknown>> = []
    const collectLongFrames = (entries: PerformanceEntry[]) => {
      for (const entry of entries) longFrames.push({ at: entry.startTime, duration: entry.duration,
        blocking: Reflect.get(entry, 'blockingDuration'), renderStart: Reflect.get(entry, 'renderStart'),
        styleAndLayoutStart: Reflect.get(entry, 'styleAndLayoutStart'),
        scripts: ((Reflect.get(entry, 'scripts') ?? []) as Array<Record<string, unknown>>).map(script => {
          const url = typeof script.sourceURL === 'string' && script.sourceURL ? new URL(script.sourceURL, location.href) : null
          // The official combo URL identifies code in its query. Keep only
          // known package resource names, never tokens or arbitrary query data.
          const packages = url?.pathname.endsWith('/plugins/')
            ? [...new Set(url.search.match(/@deepseek-ai\/[a-z0-9_-]+\/client\.js/g) ?? [])] : []
          return {
            duration: script.duration, forcedLayout: script.forcedStyleAndLayoutDuration,
            function: script.sourceFunctionName, invoker: script.invoker, invokerType: script.invokerType,
            sourceCharPosition: script.sourceCharPosition,
            source: url ? url.pathname + (packages.length ? `?${packages.join(',')}` : '') : '',
          }
        }) })
    }
    const longObserver = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
      ? new PerformanceObserver(list => collectLongFrames(list.getEntries())) : null
    longObserver?.observe({ type: 'long-animation-frame' })
    const historyEvents: Array<Record<string, unknown>> = []
    const marker = 'data-hapi-interrupted-prepend'
    const record = (type: string, detail: Record<string, unknown> = {}) => {
      historyEvents.push({ at: performance.now(), type, top: port.scrollTop, marker: port.hasAttribute(marker), ...detail })
    }
    let requestedHead: { element: HTMLElement; key: string } | null = null
    const history = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string; detail: string | null; sessionPages: number }>).detail
      let structure: Record<string, unknown> = {}
      if (['requested', 'reset', 'committed', 'failed'].includes(detail.type)) {
        const column = port.querySelector('[data-chat-flow]:not([data-step-process-content])')
        const rows = [...column?.querySelectorAll<HTMLElement>('[data-chat-anchor-key]') ?? []]
        const first = rows.find(row => !row.closest('[hidden]') && row.dataset.chatAnchorKey)
        if (detail.type === 'requested') requestedHead = first ? { element: first, key: first.dataset.chatAnchorKey! } : null
        structure = { anchorCount: rows.length, firstKey: first?.dataset.chatAnchorKey,
          earlierDisabled: column?.querySelector<HTMLButtonElement>(':scope > div > button')?.disabled,
          requestedHeadIndex: requestedHead ? rows.indexOf(requestedHead.element) : -1,
          requestedHeadRetained: !!requestedHead && !!column?.contains(requestedHead.element) && requestedHead.element.dataset.chatAnchorKey === requestedHead.key }
      }
      record(detail.type, { detail: detail.detail, sessionPages: detail.sessionPages, ...structure })
    }
    // Event-frequency, local ancestry only. A drag can start on a process
    // button, and a previous gesture's scrollend may arrive after touchstart.
    // Keep their ordering alongside ownership without reading message text.
    const input = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      let innerScrollable = false, ancestor = target
      for (let depth = 0; ancestor && ancestor !== port && port.contains(ancestor) && depth < 12; depth++, ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLElement && ancestor.scrollHeight > ancestor.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(ancestor).overflowY)) {
          innerScrollable = true; break
        }
      }
      const button = target?.closest('button')
      record(event.type, { trusted: event.isTrusted, targetIsPort: target === port, inPort: !!target && port.contains(target),
        tag: target?.tagName, button: !!button, processButton: !!button?.hasAttribute('data-turn-process'), innerScrollable })
    }
    const markerChanges = new MutationObserver(records => {
      for (const mutation of records) record('anchor-marker', { wasArmed: mutation.oldValue !== null })
    })
    markerChanges.observe(port, { attributes: true, attributeOldValue: true, attributeFilter: [marker] })
    window.addEventListener('hapi-dsh:seamless-history', history)
    for (const type of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(type, input, { capture: true, passive: true })
    for (const type of ['touchstart', 'touchend', 'touchcancel', 'scrollend']) port.addEventListener(type, input, { capture: true, passive: true })
    let touching = false
    const start = () => { touching = true }
    const end = () => { touching = false }
    // A recording can begin while the previous gesture still has inertia.
    // Attribute direction only after the new gesture actually starts moving;
    // keep every frame for stalls, blanks and anchor discontinuities.
    const firstMove = (event: TouchEvent) => {
      if (!event.isTrusted || probe.firstTrustedTouchMoveAt !== null) return
      probe.firstTrustedTouchMoveAt = performance.now()
      record('first-touchmove', { trusted: true })
    }
    port.addEventListener('touchstart', start, { passive: true })
    port.addEventListener('touchend', end, { passive: true })
    port.addEventListener('touchcancel', end, { passive: true })
    port.addEventListener('touchmove', firstMove, { passive: true })
    const probe = { active: true, frames: [] as MotionFrame[], longFrames, historyEvents, firstTrustedTouchMoveAt: null as number | null, stop() {
      intersections.disconnect(); changes.disconnect(); markerChanges.disconnect()
      if (longObserver) { collectLongFrames(longObserver.takeRecords()); longObserver.disconnect() }
      window.removeEventListener('hapi-dsh:seamless-history', history)
      for (const type of ['pointerdown', 'keydown', 'wheel']) window.removeEventListener(type, input, true)
      for (const type of ['touchstart', 'touchend', 'touchcancel', 'scrollend']) port.removeEventListener(type, input, true)
      port.removeEventListener('touchstart', start); port.removeEventListener('touchend', end); port.removeEventListener('touchcancel', end)
      port.removeEventListener('touchmove', firstMove)
    } }
    Reflect.set(window, '__touchMotion', probe)
    let primed = false
    let previousAnchor: { element: HTMLElement; top: number; height: number } | null = null
    const sample = (at: number) => {
      if (!probe.active) return
      const box = port.getBoundingClientRect()
      let firstRow: HTMLElement | null = null
      const rows = [...visible].flatMap(row => {
        if (!row.isConnected) { visible.delete(row); intersections.unobserve(row); return [] }
        const r = row.getBoundingClientRect()
        if (r.height <= 0 || r.bottom <= box.top || r.top >= box.bottom || row.closest('[hidden]')) return []
        firstRow ??= row
        return [{ key: row.dataset.chatAnchorKey!, top: r.top - box.top }]
      })
      // A prepend can move every observed row before IntersectionObserver's
      // next delivery. Record bounded synchronous hit tests as independent
      // evidence; never force layout for the whole retained transcript.
      const intersectionMiss = rows.length === 0, hitRows: MotionFrame['rows'] = []
      if (!rows.length) {
        const bottom = Math.min(box.bottom, pane.querySelector('[data-composer-card]')!.getBoundingClientRect().top)
        for (const fraction of [.1, .3, .5, .7, .9]) {
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + (bottom - box.top) * fraction)
          const row = hit?.closest<HTMLElement>('[data-chat-anchor-key]')
          if (!row || !port.contains(row) || row.closest('[hidden]') || hitRows.some(item => item.key === row.dataset.chatAnchorKey)) continue
          const rect = row.getBoundingClientRect()
          if (rect.height > 0 && rect.bottom > box.top && rect.top < bottom) {
            firstRow ??= row
            hitRows.push({ key: row.dataset.chatAnchorKey!, top: rect.top - box.top })
          }
        }
      }
      rows.push(...hitRows)
      // Retain one previously visible element across a size change. A prepend
      // can evict every old row from the viewport; paired-only motion then
      // cannot describe the discontinuity, even with accurate blank detection.
      const retainedAnchorMove = previousAnchor?.element.isConnected && port.scrollHeight !== previousAnchor.height
        ? { key: previousAnchor.element.dataset.chatAnchorKey!, before: previousAnchor.top,
          after: previousAnchor.element.getBoundingClientRect().top - box.top, heightChange: port.scrollHeight - previousAnchor.height } : null
      const boundary = Reflect.get(window, '__earliestBoundary') as { row: HTMLElement; port: HTMLElement; key: string } | undefined
      const boundaryAnchor = boundary?.port === port ? { key: boundary.key,
        retained: boundary.row.isConnected && port.contains(boundary.row) && boundary.row.dataset.chatAnchorKey === boundary.key,
        offset: boundary.row.getBoundingClientRect().top - box.top } : null
      if (rows.length) primed = true
      if (primed) probe.frames.push({ at, top: port.scrollTop, height: port.scrollHeight, portTop: box.top, portHeight: box.height,
        composerTop: pane.querySelector('[data-composer-card]')!.getBoundingClientRect().top,
        headerHeight: pane.querySelector('.hapi-pane-header')!.getBoundingClientRect().height,
        rows, hitRows, intersectionMiss, retainedAnchorMove, boundaryAnchor, touching,
        ...(retainedAnchorMove ? { overflowAnchor: getComputedStyle(port).overflowAnchor } : {}),
        following: !!pane.querySelector('[data-chat-following-tail]') })
      previousAnchor = firstRow ? { element: firstRow, top: rows[0]!.top, height: port.scrollHeight } : null
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  return []
}

async function swipe(page: Page, cdp: CDPSession, pane: Locator, direction: 'earlier' | 'later', onMove?: () => void, fast = false, outerOnly = false) {
  const scroller = pane.locator('[data-conversation-scroll]')
  const port = await scroller.boundingBox()
  if (!port) throw new Error('No mobile transcript viewport')
  const x = port.x + (outerOnly ? 6 : port.width * .55)
  const first = port.y + port.height * (direction === 'earlier' ? .25 : .75)
  const last = port.y + port.height * (direction === 'earlier' ? .75 : .25)
  const route = outerOnly ? await scroller.evaluate((port, { x, y, direction }) => {
    const target = port.ownerDocument.elementFromPoint(x, y)
    let ancestor = target, innerScrollable = false, innerConsumes = false
    while (ancestor && ancestor !== port && port.contains(ancestor)) {
      if (ancestor instanceof HTMLElement && ancestor.scrollHeight > ancestor.clientHeight + 1
        && /auto|scroll/.test(getComputedStyle(ancestor).overflowY)) {
        innerScrollable = true
        innerConsumes ||= direction === 'earlier' ? ancestor.scrollTop > 0 : ancestor.scrollTop < ancestor.scrollHeight - ancestor.clientHeight
      }
      ancestor = ancestor.parentElement
    }
    return { x, y, direction, inPort: !!target && port.contains(target), tag: target?.tagName, innerScrollable, innerConsumes }
  }, { x, y: first, direction }) : undefined
  if (route) {
    expect(route.inPort, 'the outer gesture must start inside the chat viewport').toBe(true)
    expect(route.innerConsumes, 'the outer gesture must not be consumed by nested tool output').toBe(false)
  }
  const touch = (y: number) => [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(first) })
  const steps = fast ? 6 : 12
  for (let i = 1; i <= steps; i++) {
    if (i === steps / 2) onMove?.()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(first + (last - first) * i / steps) })
    await page.waitForTimeout(fast ? 8 : 18)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  // Include native inertial frames after the finger leaves the screen.
  await page.waitForTimeout(400)
  return route
}

/** Optional scheduling trace, kept separate from ordinary acceptance runs. */
async function traceMotion(cdp: CDPSession): Promise<() => Promise<string | undefined>> {
  if (process.env.HAPI_DSH_TOUCH_TRACE !== '1') return async () => undefined
  await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream',
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,latencyInfo,cc,input,v8' })
  await cdp.send('Runtime.evaluate', { expression: "performance.mark('hapi-touch-trace-start:' + performance.now())" })
  return async () => {
    const completed = new Promise<string>(resolve => cdp.once('Tracing.tracingComplete', event => resolve(event.stream!)))
    await cdp.send('Tracing.end')
    const handle = await completed, chunks: string[] = []
    for (;;) {
      const part = await cdp.send('IO.read', { handle })
      chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data)
      if (part.eof) break
    }
    await cdp.send('IO.close', { handle })
    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
    await mkdir(directory, { recursive: true })
    const path = `${directory}/touch-scheduling-${Date.now()}.json`
    await writeFile(path, chunks.join(''))
    return path
  }
}

function movement(samples: MotionFrame[], direction: 'earlier' | 'later', directionSince?: number) {
  let reverse = 0, largestStep = 0, total = 0, paired = 0
  const frames: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1]!, after = samples[i]!
    frames.push(after.at - before.at)
    const previous = before.rows.find(row => after.rows.some(next => next.key === row.key))
    const next = previous && after.rows.find(row => row.key === previous.key)
    if (!previous || !next) continue
    const dy = next.top - previous.top
    largestStep = Math.max(largestStep, Math.abs(dy))
    if (directionSince !== undefined && before.at < directionSince) continue
    const signed = direction === 'earlier' ? dy : -dy
    reverse = Math.max(reverse, -signed); total += signed; paired++
  }
  return { reverse, largestStep, total, paired, maxFrameMs: Math.max(0, ...frames),
    blankFrames: samples.filter(row => row.rows.length === 0).length,
    intersectionLagFrames: samples.filter(row => row.intersectionMiss && row.hitRows.length > 0).length,
    retainedAnchorStep: Math.max(0, ...samples.map(row => row.retainedAnchorMove
      ? Math.abs(row.retainedAnchorMove.after - row.retainedAnchorMove.before) : 0)),
    composerShift: Math.max(...samples.map(s => s.composerTop)) - Math.min(...samples.map(s => s.composerTop)),
    headerShift: Math.max(...samples.map(s => s.headerHeight)) - Math.min(...samples.map(s => s.headerHeight)) }
}

test('mobile held finger: automatic history must not pin a drag at the earlier-page threshold', async ({}, info) => {
  test.setTimeout(120_000)
  const page = await warm.page({ width: 390, height: 844 }, true)
  await warm.admit(page)
  await page.locator('.hapi-mobile-back').click()
  await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex accept-history' }).click()
  const pane = page.getByRole('region', { name: 'Pane: Native Codex accept-history', exact: true })
  await expect(pane.getByText('Synthetic final answer 180.', { exact: false })).toBeVisible()
  const port = pane.locator('[data-conversation-scroll]')
  const cdp = await page.context().newCDPSession(page)
  await swipe(page, cdp, pane, 'earlier')
  const older = pane.locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
  await expect(older).toBeEnabled()
  // Position only the fixture setup. The measured crossing below uses one
  // trusted, unbroken touch, including the source reply while the finger moves.
  await port.evaluate(element => { element.scrollTop = 550 })
  await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(550)
  await page.waitForTimeout(350)
  let held = false, requestedWhileHeld = 0, pages = 0
  await page.route('**/api/session/page', async route => {
    if (!route.request().postData()?.includes('"beforeSeq"')) return route.continue()
    pages++; if (held) requestedWhileHeld++
    await delay(120); await route.continue()
  })
  let samples: MotionFrame[] = []
  try {
    await frames(page, pane, true)
    const box = (await port.boundingBox())!
    const first = box.y + 70, distance = Math.min(430, box.height - 140), x = box.x + box.width * .55
    const touch = (y: number) => [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }]
    held = true
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(first) })
    for (let index = 1; index <= 30; index++) {
      if (index === 16) {
        await page.waitForTimeout(650)
        expect(pages, 'a held finger remains the reader even while stationary').toBe(0)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(first + distance * index / 30) })
      await page.waitForTimeout(24)
    }
    samples = await frames(page, pane, false)
    held = false
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const metrics = movement(samples, 'earlier')
    // Reverse alone misses a scroll owner repeatedly snapping back before rAF.
    // The whole available drag must move, not just the first few samples.
    expect(metrics.total, 'history anchoring must not freeze an ongoing finger drag').toBeGreaterThan(distance - 65)
    expect(metrics.reverse).toBeLessThanOrEqual(2)
    expect(requestedWhileHeld, 'the explicit paging control must not acquire an anchor during a touch').toBe(0)
    await expect.poll(() => pages).toBeGreaterThan(0)
  } finally {
    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
    await mkdir(directory, { recursive: true })
    const path = `${directory}/touch-held-${Date.now()}.json`
    await writeFile(path, JSON.stringify({ pages, requestedWhileHeld, samples, metrics: movement(samples, 'earlier') }))
    await info.attach('held-finger-motion', { path, contentType: 'application/json' })
    await page.unrouteAll({ behavior: 'wait' })
    await page.close()
    const shot = await visualReview(warm.environment.launchUrl, 'mobile-held-finger', '390x844', conversationReady('Native Codex accept-history'))
    if (shot) await info.attach('held-finger-visual', { path: shot, contentType: 'image/png' })
  }
})

test('mobile fling: wait for outer inertia to end before acquiring the paging anchor', async ({}, info) => {
  test.setTimeout(120_000)
  const page = await warm.page({ width: 390, height: 844 }, true)
  await warm.admit(page)
  await page.locator('.hapi-mobile-back').click()
  await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex accept-history' }).click()
  const pane = page.getByRole('region', { name: 'Pane: Native Codex accept-history', exact: true })
  await expect(pane.getByText('Synthetic final answer 180.', { exact: false })).toBeVisible()
  const cdp = await page.context().newCDPSession(page)
  await swipe(page, cdp, pane, 'earlier')
  const port = pane.locator('[data-conversation-scroll]')
  await expect(pane.locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()).toBeEnabled()
  await port.evaluate(element => { element.scrollTop = 950 })
  await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(950)
  await page.waitForTimeout(500)
  await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(950)
  await port.evaluate(port => {
    const probe = { held: false, moving: false, touchEndedAt: 0, inertiaSamples: 0, scrollEndedAt: 0, events: [] as string[],
      requests: [] as Array<{ at: number; held: boolean; moving: boolean; scrollEndedAt: number }> }
    Reflect.set(window, '__flingPaging', probe)
    port.addEventListener('touchstart', () => { probe.held = true; probe.events.push('touchstart') })
    port.addEventListener('touchend', () => { probe.held = false; probe.touchEndedAt = performance.now(); probe.events.push('touchend') })
    port.addEventListener('touchcancel', () => { probe.held = false; probe.events.push('touchcancel') })
    port.addEventListener('touchmove', () => { probe.events.push('touchmove') })
    port.addEventListener('scroll', event => {
      if (event.target !== port) return
      probe.moving = true
      if (!probe.held && performance.now() - probe.touchEndedAt > 32) probe.inertiaSamples++
    })
    port.addEventListener('scrollend', event => {
      if (event.target !== port) return
      probe.moving = false; probe.scrollEndedAt = performance.now()
    })
    window.addEventListener('hapi-dsh:seamless-history', event => {
      if ((event as CustomEvent).detail.type === 'requested') probe.requests.push({ at: performance.now(), held: probe.held,
        moving: probe.moving, scrollEndedAt: probe.scrollEndedAt })
    })
  })
  let samples: MotionFrame[] = []
  try {
    await frames(page, pane, true)
    const box = (await port.boundingBox())!
    // Explicit event timestamps preserve the physical fling velocity instead
    // of folding CDP round-trip latency into the virtual finger movement.
    const started = Date.now() / 1000, x = box.x + box.width * .55, y = box.y + 70
    const touch = (offset: number) => [{ x, y: y + offset, id: 1, radiusX: 5, radiusY: 5, force: 1 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(0), timestamp: started })
    for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: touch(430 * step / 6), timestamp: started + .012 * step })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: started + .074 })
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__flingPaging').requests.length), { timeout: 5000 }).toBeGreaterThan(0)
    const probe = await page.evaluate(() => Reflect.get(window, '__flingPaging'))
    samples = await frames(page, pane, false)
    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
    await mkdir(directory, { recursive: true })
    const path = `${directory}/touch-fling-${Date.now()}.json`
    await writeFile(path, JSON.stringify({ probe, samples, metrics: movement(samples, 'earlier') }))
    await info.attach('fling-paging-motion', { path, contentType: 'application/json' })
    expect(probe.inertiaSamples, 'the regression must include actual movement after touchend').toBeGreaterThan(2)
    expect(probe.requests).toHaveLength(1)
    expect(probe.requests[0].held).toBe(false)
    expect(probe.requests[0].moving).toBe(false)
    expect(probe.requests[0].scrollEndedAt).toBeGreaterThan(0)
    expect(movement(samples, 'earlier').reverse).toBeLessThanOrEqual(2)
  } finally {
    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
    await mkdir(directory, { recursive: true })
    const probe = await page.evaluate(() => ({ ...Reflect.get(window, '__flingPaging'), top: document.querySelector('[data-conversation-scroll]')?.scrollTop }))
    if (!samples.length) samples = await frames(page, pane, false)
    await writeFile(`${directory}/touch-fling-final-${Date.now()}.json`, JSON.stringify({ probe, samples, metrics: movement(samples, 'earlier') }))
    await page.close()
    const shot = await visualReview(warm.environment.launchUrl, 'mobile-fling-paging', '390x844', conversationReady('Native Codex accept-history'))
    if (shot) await info.attach('fling-paging-visual', { path: shot, contentType: 'image/png' })
  }
})

for (const mode of ['fling', 'held pause', 'process button'] as const) test(`mobile in-flight ${mode}: a delayed prepend preserves continued reader motion`, async ({}, info) => {
  test.setTimeout(120_000)
  const page = await warm.page({ width: 360, height: 844 }, true)
  await warm.admit(page)
  await page.locator('.hapi-mobile-back').click()
  await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex accept-history' }).click()
  const pane = page.getByRole('region', { name: 'Pane: Native Codex accept-history', exact: true })
  await expect(pane.getByText('Synthetic final answer 180.', { exact: false })).toBeVisible()
  const port = pane.locator('[data-conversation-scroll]'), cdp = await page.context().newCDPSession(page)
  const older = pane.locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
  await swipe(page, cdp, pane, 'earlier')
  await expect(older).toBeEnabled()
  await port.tap({ position: { x: 30, y: 100 } })
  await page.waitForTimeout(300)
  await port.evaluate(element => { element.scrollTop = 900 })
  await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(900)
  let requested = false, released = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve() } })
  await page.route('**/api/session/page', async route => {
    if (!route.request().postData()?.includes('"beforeSeq"') || requested) return route.continue()
    requested = true
    await gate
    await route.continue()
  })
  let samples: MotionFrame[] = [], primaryFailure: unknown, recording = false
  try {
    await swipe(page, cdp, pane, 'earlier')
    await expect.poll(() => requested).toBe(true)
    // Finish the original explicit-control preservation before positioning
    // this fixture. The measured gesture below is a separate trusted drag.
    if (mode === 'process button') await port.tap({ position: { x: 30, y: 100 } })
    const buttonStart = mode === 'process button' ? await port.evaluate(port => {
      const box = port.getBoundingClientRect()
      const button = [...port.querySelectorAll<HTMLElement>('button[data-turn-process]')].find(button => {
        const documentTop = button.getBoundingClientRect().top - box.top + port.scrollTop
        return button.checkVisibility() && documentTop > 80 && documentTop < 450
      })
      if (!button) throw new Error('The fixture needs a retained process heading to begin this drag')
      port.scrollTop += button.getBoundingClientRect().top - box.top - 80
      const target = button.getBoundingClientRect()
      return { x: target.left + target.width / 2, y: target.top + target.height / 2 }
    }) : null
    await port.evaluate(port => {
      const probe = { held: false, endedAt: 0, inertiaSamples: 0, scrollEndedAt: 0 }
      Reflect.set(window, '__inflightFling', probe)
      port.addEventListener('touchstart', () => { probe.held = true })
      port.addEventListener('touchend', () => { probe.held = false; probe.endedAt = performance.now() })
      port.addEventListener('scroll', event => {
        if (event.target === port && !probe.held && probe.endedAt && performance.now() - probe.endedAt > 16) probe.inertiaSamples++
      })
      port.addEventListener('scrollend', event => { if (event.target === port) probe.scrollEndedAt = performance.now() })
    })
    await frames(page, pane, true)
    recording = true
    const box = (await port.boundingBox())!, started = Date.now() / 1000
    const touch = (offset: number) => [{ x: buttonStart?.x ?? box.x + box.width * .55,
      y: mode === 'fling' ? box.y + box.height - 80 - offset : (buttonStart?.y ?? box.y + 80) + offset, id: 1, radiusX: 5, radiusY: 5, force: 1 }]
    if (mode === 'fling') {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(0), timestamp: started })
      for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: touch(360 * step / 6), timestamp: started + .012 * step })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: started + .074 })
      await expect.poll(() => page.evaluate(() => Reflect.get(window, '__inflightFling').inertiaSamples), { intervals: [10] }).toBeGreaterThan(1)
      release()
      await expect(older).toBeEnabled()
    } else if (mode === 'process button') {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(0) })
      for (let step = 1; step <= 30; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(360 * step / 30) })
        if (step === 10) release()
        await page.waitForTimeout(24)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(older).toBeEnabled()
    } else {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(0) })
      for (let step = 1; step <= 6; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(120 * step / 6) })
        await page.waitForTimeout(24)
      }
      // Native scrollend can happen while the finger is still held. Deliver
      // the old page during that pause, then continue the very same touch.
      await page.waitForTimeout(250)
      release()
      await expect(older).toBeEnabled()
      await page.waitForTimeout(80)
      for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(120 + 240 * step / 10) })
        await page.waitForTimeout(24)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await page.waitForTimeout(500)
    samples = await frames(page, pane, false)
    if (mode === 'process button') {
      const events = await page.evaluate(() => Reflect.get(window, '__touchMotion').historyEvents as Array<Record<string, unknown>>)
      expect(events.find(event => event.type === 'touchstart')?.processButton, 'the trusted drag must start on the native process button').toBe(true)
    }
    const commit = samples.findIndex(frame => (frame.retainedAnchorMove?.heightChange ?? 0) > 1000)
    expect(commit, 'the held history request must actually commit during this gesture').toBeGreaterThanOrEqual(0)
    expect(samples[commit]!.touching).toBe(mode !== 'fling')
    const direction = mode === 'fling' ? 'later' : 'earlier'
    const tail = movement(samples.slice(commit + 1), direction), metrics = movement(samples, direction)
    expect(metrics.retainedAnchorStep, 'the delayed page must not evict the old visible row').toBeLessThan(160)
    expect(metrics.reverse).toBeLessThanOrEqual(2)
    expect(metrics.blankFrames).toBe(0)
    expect(metrics.maxFrameMs).toBeLessThan(200.2)
    if (mode === 'fling') expect(tail.total, 'page compensation must not cancel the remaining native fling').toBeGreaterThan(50)
    else expect(metrics.total, 'resuming the same held finger must not be pinned after scrollend').toBeGreaterThan(295)
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    if (!released) release()
    if (recording && !samples.length && !page.isClosed()) samples = await frames(page, pane, false)
    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
    await mkdir(directory, { recursive: true })
    const label = mode.replace(' ', '-')
    const path = `${directory}/touch-inflight-${label}-${Date.now()}.json`
    const diagnostics = recording && !page.isClosed() ? await page.evaluate(() => {
      const probe = Reflect.get(window, '__touchMotion'); return { historyEvents: probe.historyEvents, longFrames: probe.longFrames }
    }) : {}
    await writeFile(path, JSON.stringify({ requested, released, samples, metrics: movement(samples, mode === 'fling' ? 'later' : 'earlier'), ...diagnostics }))
    await info.attach('inflight-fling-motion', { path, contentType: 'application/json' })
    try {
      await page.unrouteAll({ behavior: 'wait' })
      await page.close()
      const shot = await visualReview(warm.environment.launchUrl, `mobile-inflight-${label}`, '360x844', conversationReady('Native Codex accept-history'))
      if (shot) await info.attach('inflight-fling-visual', { path: shot, contentType: 'image/png' })
    } catch (error) {
      if (!primaryFailure) throw error
      await info.attach('inflight-fling-cleanup-error', { body: String(error), contentType: 'text/plain' })
    }
  }
})

for (const phase of ['held', 'released gap', 'manual released gap', 'manual reverse'] as const) test(`mobile earliest boundary ${phase}: continued loading-area gestures preserve the old first row`, async ({}, info) => {
  test.setTimeout(120_000)
  const manual = phase.startsWith('manual'), reverse = phase === 'manual reverse'
  const direction = reverse ? 'later' : 'earlier'
  const page = await warm.page({ width: 360, height: 844 }, true)
  await warm.admit(page)
  await page.locator('.hapi-mobile-back').click()
  await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex accept-history' }).click()
  const pane = page.getByRole('region', { name: 'Pane: Native Codex accept-history', exact: true })
  await expect(pane.getByText('Synthetic final answer 180.', { exact: false })).toBeVisible()
  const port = pane.locator('[data-conversation-scroll]'), cdp = await page.context().newCDPSession(page)
  const older = pane.locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
  await swipe(page, cdp, pane, 'earlier')
  await expect(older).toBeEnabled()
  await port.tap({ position: { x: 30, y: 100 } })
  await page.waitForTimeout(300)
  await port.evaluate((element, top) => { element.scrollTop = top }, manual ? 0 : 400)
  await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(manual ? 0 : 400)
  let requested = false, released = false, release!: () => void, requestDelayMs = 0
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve() } })
  await page.route('**/api/session/page', async route => {
    if (!route.request().postData()?.includes('"beforeSeq"') || requested) return route.continue()
    requested = true
    const at = Date.now()
    await Promise.all([delay(600), gate])
    requestDelayMs = Date.now() - at
    await route.continue()
  })
  type BoundaryReading = { at: number; key: string; retained: boolean; offset: number; documentTop: number; scrollTop: number; height: number; controlDisabled: boolean | undefined }
  const readBoundary = () => page.evaluate(() => {
    const { row, port, key } = Reflect.get(window, '__earliestBoundary') as { row: HTMLElement; port: HTMLElement; key: string }
    const offset = row.getBoundingClientRect().top - port.getBoundingClientRect().top
    return { at: performance.now(), key, retained: row.isConnected && port.contains(row) && row.dataset.chatAnchorKey === key,
      offset, documentTop: offset + port.scrollTop, scrollTop: port.scrollTop, height: port.scrollHeight,
      controlDisabled: port.querySelector<HTMLButtonElement>('[data-chat-flow]:not([data-step-process-content]) > div > button')?.disabled }
  })
  let before: BoundaryReading | undefined, after: BoundaryReading | undefined, edge: BoundaryReading | undefined, samples: MotionFrame[] = []
  let budgetBefore: number | undefined
  let recording = false, fingerHeld = false, primaryFailure: unknown
  try {
    // Cover both automatic paging and a real tap on the official control: the
    // latter does not create an automatic controller-owned pending request.
    // Two more trusted gestures reach the boundary while that page is held.
    if (manual) {
      await frames(page, pane, true); recording = true
      await older.tap()
    } else await swipe(page, cdp, pane, 'earlier')
    await expect.poll(() => requested).toBe(true)
    await expect(older).toBeDisabled()
    if (!recording) { await frames(page, pane, true); recording = true }
    await port.evaluate(port => {
      const row = [...port.querySelectorAll<HTMLElement>('[data-chat-flow]:not([data-step-process-content]) [data-chat-anchor-key]')]
        .find(row => !row.closest('[hidden]') && row.dataset.chatAnchorKey)
      if (!row) throw new Error('The retained history needs an identifiable first row')
      Reflect.set(window, '__earliestBoundary', { row, port, key: row.dataset.chatAnchorKey })
    })
    const box = (await port.boundingBox())!
    const pan = async (x: number, y: number, end: boolean, sign = 1) => {
      const points = (offset: number) => [{ x, y: y + offset, id: 1, radiusX: 5, radiusY: 5, force: 1 }]
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) }); fingerHeld = true
      for (let step = 1; step <= 6; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(sign * step * 20) })
        await page.waitForTimeout(12)
      }
      if (end) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); fingerHeld = false }
    }
    await pan(box.x + box.width * .55, box.y + 70, true)
    await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(0)
    await page.waitForTimeout(100)
    const loading = (await older.boundingBox())!
    await pan(loading.x + loading.width / 2, loading.y + loading.height / 2, phase !== 'held')
    // Observe native scrollend if Chromium delivers it at the held boundary;
    // do not synthesize an event that the browser did not actually send.
    await page.waitForTimeout(250)
    edge = await readBoundary()
    expect(edge.scrollTop).toBe(0)
    if (reverse) {
      // The retained boundary bookmark must not erase a subsequent deliberate
      // move toward newer messages while the same older request is in flight.
      await pan(box.x + box.width * .55, box.y + box.height - 80, true, -1)
      await page.waitForTimeout(250)
    }
    before = await readBoundary()
    if (reverse) {
      expect(before.scrollTop, 'the reverse gesture must actually leave the oldest boundary').toBeGreaterThan(80)
      expect(before.documentTop).toBe(edge.documentTop)
    } else expect(before.scrollTop).toBe(0)
    expect(before.controlDisabled).toBe(true)
    release()
    await expect.poll(() => port.evaluate(element => element.scrollHeight)).toBeGreaterThan(before.height + 1000)
    await page.waitForTimeout(80)
    after = await readBoundary()
    samples = await frames(page, pane, false)
    const events = await page.evaluate(() => Reflect.get(window, '__touchMotion').historyEvents as Array<Record<string, unknown>>)
    const touchStarts = events.filter(event => event.type === 'touchstart')
    expect(touchStarts).toHaveLength((manual ? 3 : 2) + (reverse ? 1 : 0))
    if (manual) {
      expect(events.filter(event => event.type === 'requested'), 'the official manual request must not be mistaken for an automatic one').toHaveLength(0)
      const observations = events.filter(event => event.type === 'observed' && event.detail === 'upstream-page')
      expect(observations).toHaveLength(1)
      budgetBefore = observations[0]?.sessionPages as number | undefined
      expect(typeof budgetBefore, 'read the real budget when this existing upstream request is observed').toBe('number')
      const commits = events.filter(event => event.type === 'committed')
      expect(commits).toHaveLength(1)
      expect(commits[0]?.detail).toBe('observed-page')
      expect(commits[0]?.sessionPages, 'observing an existing manual request must not spend automatic-page budget').toBe(budgetBefore)
    }
    expect(touchStarts[manual ? 2 : 1]?.button, 'the boundary drag must begin on the top loading control').toBe(true)
    expect(after.retained, 'compare the same old first DOM row, not a newly visible replacement').toBe(true)
    expect(after.documentTop - before.documentTop, 'older content must actually be inserted before the retained row').toBeGreaterThan(1000)
    expect(Math.abs(after.offset - before.offset), 'a page arriving at the earliest boundary must continue from its bottom, not skip to its top').toBeLessThanOrEqual(2)
    expect(Math.abs((after.scrollTop - before.scrollTop) - (after.documentTop - before.documentTop))).toBeLessThanOrEqual(2)
    const commitFrames = samples.filter(sample => sample.at >= before!.at && sample.at <= after!.at)
    expect(commitFrames.length, 'measure every rendered frame during prepend, not just its settled position').toBeGreaterThan(0)
    expect(commitFrames.every(sample => sample.boundaryAnchor?.retained && sample.boundaryAnchor.key === before!.key)).toBe(true)
    expect(Math.max(...commitFrames.map(sample => Math.abs(sample.boundaryAnchor!.offset - before!.offset))),
      'the same old row must not jump away and recover between the two final measurements').toBeLessThanOrEqual(2)
    expect(movement(samples, direction).blankFrames).toBe(0)
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    if (!released) release()
    if (recording && !samples.length && !page.isClosed()) samples = await frames(page, pane, false)
    const diagnostics = recording && !page.isClosed() ? await page.evaluate(() => {
      const probe = Reflect.get(window, '__touchMotion'); return { historyEvents: probe.historyEvents, longFrames: probe.longFrames }
    }) : {}
    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
    await mkdir(directory, { recursive: true })
    const label = phase.replaceAll(' ', '-'), path = `${directory}/touch-earliest-${label}-${Date.now()}.json`
    await writeFile(path, JSON.stringify({ phase, requestDelayMs, budgetBefore, edge, before, after, samples, metrics: movement(samples, direction), ...diagnostics }))
    await info.attach('earliest-boundary-motion', { path, contentType: 'application/json' })
    try {
      if (fingerHeld) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.unrouteAll({ behavior: 'wait' }); await page.close()
      const shot = await visualReview(warm.environment.launchUrl, `mobile-earliest-${label}`, '360x844', conversationReady('Native Codex accept-history'))
      if (shot) await info.attach('earliest-boundary-visual', { path: shot, contentType: 'image/png' })
    } catch (error) {
      if (!primaryFailure) throw error
      await info.attach('earliest-boundary-cleanup-error', { body: String(error), contentType: 'text/plain' })
    }
  }
})

for (const width of [390, 360]) test(`mobile ${width}: repeated touch scrolling, delayed prepend, streaming and inertia stay continuous`, async ({}, info) => {
  test.setTimeout(150_000)
  const page = await warm.page({ width, height: 844 }, true)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await warm.admit(page)
  const picker = page.locator('.hapi-mobile-back')
  if (await picker.isVisible()) await picker.click()
  await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex accept-history' }).click()
  const pane = page.getByRole('region', { name: 'Pane: Native Codex accept-history', exact: true })
  await expect(pane.getByText('Synthetic final answer 180.', { exact: false })).toBeVisible()
  const editor = pane.locator('[data-composer-input]')
  await editor.fill('Touch scrolling must preserve this draft')
  await editor.evaluate(element => (element as HTMLElement).blur())
  const port = pane.locator('[data-conversation-scroll]')
  const older = pane.locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
  // Establish a retained reading window, then test actual trusted gestures.
  for (let i = 0; i < 3 && await port.evaluate(e => e.scrollHeight < e.clientHeight * 4); i++) {
    await expect(older).toBeEnabled(); await older.evaluate(e => (e as HTMLButtonElement).click())
    await expect(older).toBeEnabled()
  }
  const cdp = await page.context().newCDPSession(page)
  // Finish the real opening/reader handoff, then position this fixture. A
  // successful automatic prepend raises scrollTop while preserving the row,
  // so repeatedly swiping until a raw top <=700 would keep fetching history.
  await swipe(page, cdp, pane, 'earlier')
  await expect(older).toBeEnabled()
  await port.tap({ position: { x: 30, y: 100 } })
  await page.waitForTimeout(300)
  await port.evaluate(element => { element.scrollTop = 700 })
  await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(700)
  let pages = 0, inFlight = 0, maxInFlight = 0
  await page.route('**/api/session/page', async route => {
    if (!route.request().postData()?.includes('"beforeSeq"')) return route.continue()
    pages++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    try { await delay(width === 390 ? 80 : 600); await route.continue() }
    finally { inFlight-- }
  })
  const recordings: { direction: string; directionSince: number; frames: MotionFrame[]; metrics: ReturnType<typeof movement>; longFrames: unknown[]; historyEvents: unknown[] }[] = []
  const live = beginUiLive(warm.environment.hapi, 'native-accept-history')
  let primaryFailure: unknown
  try {
    for (const direction of ['earlier', 'later'] as const) {
      await frames(page, pane, true)
      for (let i = 0; i < 4; i++) await swipe(page, cdp, pane, direction, () => live.update(`Touch regression live update ${direction} ${i}`), i % 2 === 1)
      const samples = await frames(page, pane, false)
      const directionSince: number | null = await page.evaluate(() => Reflect.get(window, '__touchMotion').firstTrustedTouchMoveAt)
      expect(directionSince, 'the direction must be established by a trusted touchmove').not.toBeNull()
      const result = movement(samples, direction, directionSince!)
      const longFrames: unknown[] = await page.evaluate(() => Reflect.get(window, '__touchMotion').longFrames)
      const historyEvents: unknown[] = await page.evaluate(() => Reflect.get(window, '__touchMotion').historyEvents)
      recordings.push({ direction, directionSince: directionSince!, frames: samples, metrics: result, longFrames, historyEvents })
      expect(result.paired).toBeGreaterThan(20)
      expect(result.total).toBeGreaterThan(100)
      expect(result.reverse, 'a held gesture must not jump against the finger').toBeLessThanOrEqual(2)
      expect(result.largestStep, 'a single frame must not jump across a viewport').toBeLessThan(160)
      expect(result.retainedAnchorStep, 'prepend must not evict the previously visible anchor by a viewport').toBeLessThan(160)
      expect(result.blankFrames).toBe(0)
      expect(result.composerShift).toBeLessThanOrEqual(1)
      expect(result.headerShift).toBeLessThanOrEqual(1)
      expect(samples.every(frame => frame.headerHeight === 0), 'mobile pane headers must stay hidden throughout the gesture').toBe(true)
      expect(result.maxFrameMs).toBeLessThan(200.2)
    }
    expect(pages).toBeGreaterThan(0); expect(maxInFlight).toBe(1)
    await expect(editor).toHaveText('Touch scrolling must preserve this draft')
    expect(errors).toEqual([])
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    live.finish()
    const report = JSON.stringify({ width, pageDelayMs: width === 390 ? 80 : 600, pages, maxInFlight, recordings, errors })
    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
    await mkdir(directory, { recursive: true })
    const reportPath = `${directory}/touch-${width}-${Date.now()}.json`
    await writeFile(reportPath, report)
    await info.attach('touch-frames', { path: reportPath, contentType: 'application/json' })
    try {
      await page.unrouteAll({ behavior: 'wait' })
      await page.close()
      for (const [state, action] of [['latest', ''], ['reading', `if (!window.__readingPosition) { port.dispatchEvent(new WheelEvent('wheel', {deltaY:-100, bubbles:true})); port.scrollTop = 100; window.__readingPosition = performance.now(); return false; } if (performance.now() - window.__readingPosition < 300) return false; if (Math.abs(port.scrollTop - 100) > 1) { delete window.__readingPosition; return false; }`]]) {
        const path = await visualReview(warm.environment.launchUrl, `mobile-touch-${state}`, `${width}x844`, conversationReady('Native Codex accept-history', action))
        if (path) await info.attach(`visual-${state}`, { path, contentType: 'image/png' })
      }
    } catch (error) {
      if (!primaryFailure) throw error
      await info.attach('visual-cleanup-error', { body: String(error), contentType: 'text/plain' })
    }
  }
})

test('mobile expanded tool history: continuous swipes keep visible content and the composer steady', async ({}, info) => {
  test.setTimeout(120_000)
  const page = await warm.page({ width: 390, height: 844 }, true)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const optionalRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/plugins/')) for (const id of ['dsh-client-ui-settings-account', 'dsh-client-hmr']) {
      if (decodeURIComponent(url.search).includes(`${id}/client.js`)) optionalRequests.push(id)
    }
  })
  await warm.admit(page)
  await page.locator('.hapi-mobile-back').click()
  await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex touch-tools' }).click()
  const pane = page.getByRole('region', { name: 'Pane: Native Codex touch-tools', exact: true })
  await expect(pane.getByText('Synthetic final answer 12.', { exact: false })).toBeVisible()
  const cdp = await page.context().newCDPSession(page)
  const results: { direction: string; directionSince: number; frames: MotionFrame[]; metrics: ReturnType<typeof movement>; longFrames: unknown[]; historyEvents: unknown[]; outerRoutes: unknown[]; retainedAnchors: number }[] = []
  let stopTrace: (() => Promise<string | undefined>) | undefined
  let sampling = false
  let interactionEnd: number | undefined
  let completeMotion: Record<string, unknown> | undefined
  try {
    // Reach history with a real gesture before tapping. Playwright's implicit
    // programmatic scroll does not take ownership from the initial tail landing.
    await swipe(page, cdp, pane, 'earlier')
    await pane.locator('button[data-turn-process]:visible').last().tap()
    const activity = pane.locator('[data-step-process] button[data-process-activity][aria-expanded=false]:visible').last()
    if (await activity.count()) await activity.tap()
    const command = pane.locator('[data-sample=bash]:visible').last()
    await command.tap()
    await expect(command).toHaveAttribute('aria-expanded', 'true')
    await expect(pane.getByText('Synthetic output: retained text must stay in place during a touch gesture.', { exact: false }).last()).toBeVisible()
    stopTrace = await traceMotion(cdp)
    // Keep one sampler alive across direction boundaries and deferred startup.
    // Stopping it between directions used to hide plugin-load long tasks.
    await frames(page, pane, true)
    sampling = true
    for (const direction of ['earlier', 'later', 'earlier'] as const) {
      const begin = await page.evaluate(() => {
        const probe = Reflect.get(window, '__touchMotion')
        probe.firstTrustedTouchMoveAt = null
        return { frames: probe.frames.length, longFrames: probe.longFrames.length, historyEvents: probe.historyEvents.length }
      })
      const outerRoutes: unknown[] = []
      for (let i = 0; i < 5; i++) outerRoutes.push(await swipe(page, cdp, pane, direction, undefined, true, true))
      const samples: MotionFrame[] = await page.evaluate(begin => Reflect.get(window, '__touchMotion').frames.slice(begin.frames), begin)
      const diagnostics = await page.evaluate(begin => {
        const probe = Reflect.get(window, '__touchMotion')
        return { longFrames: probe.longFrames.slice(begin.longFrames), historyEvents: probe.historyEvents.slice(begin.historyEvents), directionSince: probe.firstTrustedTouchMoveAt as number | null,
          deferredPlugins: performance.getEntriesByType('mark').filter(entry => entry.name.startsWith('hapi:deferred-plugins-') || entry.name === 'hapi:conversation-plugins-ready')
            .map(entry => ({ name: entry.name, at: entry.startTime })) }
      }, begin)
      expect(diagnostics.directionSince, 'the direction must be established by a trusted touchmove').not.toBeNull()
      const metrics = movement(samples, direction, diagnostics.directionSince!)
      const retainedAnchors = await pane.locator('[data-chat-flow]:not([data-step-process-content]) [data-chat-anchor-key]').count()
      results.push({ direction, frames: samples, metrics, ...diagnostics, directionSince: diagnostics.directionSince!, outerRoutes, retainedAnchors })
      const starts = (diagnostics.historyEvents as Array<Record<string, unknown>>).filter(event => event.type === 'touchstart')
      expect(starts).toHaveLength(5)
      expect(starts.every(event => event.inPort && !event.innerScrollable), 'every measured touch must reach outer history, not nested tool output').toBe(true)
      expect(metrics.total).toBeGreaterThan(100)
      expect(metrics.reverse).toBeLessThanOrEqual(2)
      expect(metrics.blankFrames).toBe(0)
      expect(metrics.composerShift).toBeLessThanOrEqual(1)
      expect(metrics.headerShift).toBeLessThanOrEqual(1)
      expect(samples.every(frame => frame.headerHeight === 0), 'expanded tools must not bring back the mobile pane header').toBe(true)
      expect.soft(metrics.maxFrameMs).toBeLessThan(200.2)
    }
    interactionEnd = await page.evaluate(() => performance.now())
    await page.waitForFunction(() => performance.getEntriesByName('hapi:conversation-plugins-ready').length > 0, undefined, { timeout: 30_000 })
    // Full sampling continues through a quiet interval longer than the former
    // background trigger. Account/HMR must stay unloaded until Settings demand.
    await page.waitForTimeout(1500)
    expect(optionalRequests).toEqual([])
    expect(await page.evaluate(() => performance.getEntriesByName('hapi:deferred-plugins-start').length)).toBe(0)
    const completeFrames = await frames(page, pane, false)
    sampling = false
    completeMotion = await page.evaluate(() => {
      const probe = Reflect.get(window, '__touchMotion')
      return { frames: probe.frames, longFrames: probe.longFrames, historyEvents: probe.historyEvents,
        deferredPlugins: performance.getEntriesByType('mark').filter(entry => entry.name.startsWith('hapi:deferred-plugins-') || entry.name === 'hapi:conversation-plugins-ready')
          .map(entry => ({ name: entry.name, at: entry.startTime })) }
    })
    expect(movement(completeFrames, 'earlier').maxFrameMs, 'all frames, including direction gaps and deferred activation, meet the existing budget').toBeLessThan(200.2)
    expect(results.at(-1)?.retainedAnchors, 'exercise at least the 1260-anchor history that exposed the long-frame regression').toBeGreaterThanOrEqual(1260)
    expect(errors).toEqual([])
  } finally {
    if (sampling) {
      await frames(page, pane, false)
      completeMotion = await page.evaluate(() => {
        const probe = Reflect.get(window, '__touchMotion')
        return { frames: probe.frames, longFrames: probe.longFrames, historyEvents: probe.historyEvents,
          deferredPlugins: performance.getEntriesByType('mark').filter(entry => entry.name.startsWith('hapi:deferred-plugins-') || entry.name === 'hapi:conversation-plugins-ready')
            .map(entry => ({ name: entry.name, at: entry.startTime })) }
      })
    }
    const timeline = await stopTrace?.()
    if (timeline) await info.attach('touch-scheduling-diagnostic', { path: timeline, contentType: 'application/json' })
    const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
    await mkdir(directory, { recursive: true })
    const path = `${directory}/touch-tools-${Date.now()}.json`
    await writeFile(path, JSON.stringify({ results, interactionEnd, completeMotion, optionalRequests, errors }))
    await info.attach('expanded-tool-motion', { path, contentType: 'application/json' })
    await page.close()
    const action = `if (!window.__turnOpened) {
      const turn = [...pane.querySelectorAll('button[data-turn-process]')].filter(b=>b.checkVisibility()).at(-1);
      if (!turn) return false;
      if (turn.getAttribute('aria-expanded') !== 'true') turn.click();
      window.__turnOpened = true; return false;
    }
    if (!window.__toolsOpened) {
      [...pane.querySelectorAll('[data-step-process] button[data-process-activity][aria-expanded=false]')].filter(b=>b.checkVisibility()).at(-1)?.click();
      const command = [...pane.querySelectorAll('[data-sample=bash]')].filter(b=>b.checkVisibility()).at(-1);
      if (!command?.checkVisibility()) return false;
      if (command.getAttribute('aria-expanded') !== 'true') command.click();
      document.activeElement?.blur(); window.__toolsOpened = true; return false;
    }
    const hasOutput = e => e.textContent.includes('Synthetic output: retained text');
    const output = [...pane.querySelectorAll('pre,code,p,div,span')].find(e => hasOutput(e) && ![...e.children].some(hasOutput) && e.checkVisibility());
    if (!output) return false;
    if (!window.__outputPositioned) { output.scrollIntoView({block:'center'}); window.__outputPositioned = performance.now(); return false; }
    return performance.now() - window.__outputPositioned > 400;`
    const screenshot = await visualReview(warm.environment.launchUrl, 'mobile-touch-expanded-tools', '390x844', conversationReady('Native Codex touch-tools', action))
    if (screenshot) await info.attach('expanded-tool-visual', { path: screenshot, contentType: 'image/png' })
  }
})
