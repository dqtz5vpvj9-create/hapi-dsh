/** One bounded journey of real official layout, reading and editor input. */
import assert from 'node:assert/strict'
import { createGestures } from './gestures.mjs'
import { exerciseDraftInput } from './keyboard.mjs'

export async function runJourney(page, context, origin, mode, result) {
  const mobile = mode === 'mobile'
  const state = () => page.evaluate(() => window.__hhpi.snapshot())
  const stats = () => fetch(origin + '/api/stats').then(response => response.json())
  const preciseAnchorKind = key => {
    if (key.startsWith('call:')) return 'call'
    if (key.startsWith('group:')) return 'group'
    try {
      const value = JSON.parse(key)
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') return 'segmented'
    } catch {}
    return 'node'
  }
  const pane = key => page.locator(`[data-lab-pane="${key}"]`)
  const editor = key => pane(key).locator('[contenteditable="true"]')
  let gestures
  async function step(name, action) {
    result.activeStep = name; const start = performance.now()
    await action(); result.steps.push({ name, ms: Math.round(performance.now() - start) }); delete result.activeStep
  }
  async function visible() {
    return pane('a').evaluate(element => {
      const port = element.querySelector('[data-conversation-scroll]'), box = port.getBoundingClientRect()
      const rows = [...port.querySelectorAll('[data-chat-node-key][data-chat-flow-kind="user"][data-chat-anchor-key]')].filter(node => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > box.top + 2 && rect.top < box.bottom - 100 })
      const numbers = rows.flatMap(node => [...node.textContent.matchAll(/body-(\d+)/g)].map(value => Number(value[1])))
      return { min: numbers.length ? Math.min(...numbers) : null, keys: rows.map(node => node.getAttribute('data-chat-anchor-key')), top: port.scrollTop, height: port.clientHeight, total: port.scrollHeight }
    })
  }
  async function assertLayout() {
    const layout = await pane('a').evaluate(element => {
      const port = element.querySelector('[data-conversation-scroll]'), input = element.querySelector('[contenteditable="true"]')
      const rect = input.getBoundingClientRect(), view = port.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + Math.min(20, rect.width / 2), rect.top + rect.height / 2)
      return { viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
        portWidth: port.clientWidth, contentWidth: port.scrollWidth, editor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        port: { x: view.x, y: view.y, width: view.width, height: view.height }, editorHit: !!hit && (input === hit || input.contains(hit)),
        failures: element.querySelectorAll('[data-slot-error],[data-factory-error]').length }
    })
    result.lastLayout = layout
    assert.equal(layout.failures, 0, 'official slot/factory errors are not a usable first view')
    assert.ok(layout.pageWidth <= layout.viewport.width + 1, 'page must not overflow horizontally')
    assert.ok(layout.contentWidth <= layout.portWidth + 1, 'long source lines must not overflow the official scrollport')
    assert.ok(layout.editor.width > 100 && layout.editor.height > 10 && layout.editor.y >= 0 && layout.editor.y + layout.editor.height <= layout.viewport.height + 1, 'official editable input must be inside viewport')
    assert.ok(layout.editorHit, 'official editor must be hit-testable, not covered')
    return layout
  }
  await step('first usable official view', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__hhpiFailure || (window.__hhpi?.ready && window.__hhpi.snapshot().a.control && window.__hhpi.snapshot().b.control))
    assert.equal(await page.evaluate(() => window.__hhpiFailure), undefined)
    gestures = await createGestures(page, context, mobile, result)
    await gestures.settle(); result.initialLayout = await assertLayout()
    assert.ok((await visible()).min !== null, 'first target frame must contain visible source bodies')
  })
  await step('idle update stream closes without failing the mounted readers', async () => {
    await page.waitForFunction(async () => (await (await fetch('/api/stats')).json()).followRequests.length === 1)
    const before = await state(), beforeStats = await stats(), anchor = await visible()
    for (const count of [2, 3]) {
      await page.evaluate(async () => {
        const response = await fetch('/api/interrupt-updates', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hhpi-fixture': '1' }, body: '{}' })
        if (!response.ok) throw new Error('Synthetic update interruption refused')
      })
      await page.waitForFunction(async count => (await (await fetch('/api/stats')).json()).followRequests.length === count, count)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    const after = await state(), afterStats = await stats(), retained = await visible()
    assert.equal(after.a.phase, 'ready'); assert.equal(after.b.phase, 'ready')
    assert.equal(after.a.rows, before.a.rows); assert.equal(after.b.rows, before.b.rows)
    assert.equal(afterStats.reads, beforeStats.reads, 'idle reconnect must not fetch or replace accepted body')
    assert.deepEqual(afterStats.followRequests[1], afterStats.followRequests[0], 'idle reconnect resumes the accepted source cursor')
    assert.deepEqual(afterStats.followRequests[2], afterStats.followRequests[0], 'another idle reconnect without updates resumes the same cursor')
    assert.deepEqual(retained.keys, anchor.keys, 'idle reconnect retains visible official body keys')
    assert.ok(Math.abs(retained.top - anchor.top) <= 2, 'idle reconnect must not move the reading position')
    result.idleReconnect = { subscriptions: afterStats.followRequests.length, extraReads: afterStats.reads - beforeStats.reads, drift: retained.top - anchor.top, panesReady: 2 }
  })
  await step('browser keyboard, composition and independent drafts', () => exerciseDraftInput(page, context, mobile, result))
  const fixture = await stats()
  assert.equal(fixture.userMessageCount, 2497, 'the synthetic source retains all 2497 user messages')
  assert.deepEqual(fixture.userMessageRange, { first: 1, last: 2497 }, 'synthetic user bodies remain one continuous range')
  assert.equal(fixture.sourceEventCount, 2623, 'fourteen complete tool-bearing windows are added without dropping user messages')
  const baseline = await state(); let previousVisible = (await visible()).min
  await step('thirteen real-input older boundary crossings beyond the old node ceiling', async () => {
    result.segments = []
    for (let segment = 1; segment <= 13; segment++) {
      const before = await state()
      const beforeStats = await stats()
      const lastUserId = 2497 - segment * 151
      const firstUserId = lastUserId - 150
      await gestures.boundary()
      await page.waitForFunction(rows => { const value = window.__hhpi.snapshot(); return value.a.rows > rows && !value.a.busy }, before.a.rows)
      let body = await visible(), bodyGestures = 0
      // A real tool group can be taller than one gesture. Read past it with
      // bounded browser input; a fixed travel distance is not a body verdict.
      while ((body.min === null || body.min > lastUserId) && bodyGestures < 4) {
        await gestures.scroll(-350); body = await visible(); bodyGestures++
      }
      const current = await state(), afterStats = await stats()
      assert.ok(body.min !== null && body.min < previousVisible, 'each upward segment must expose earlier real body text')
      assert.ok(body.min >= firstUserId && body.min <= lastUserId,
        `visible body ${body.min} must belong to the newly committed range ${firstUserId}..${lastUserId} after ${bodyGestures} gestures`)
      assert.equal(afterStats.reads, beforeStats.reads + 1, 'one boundary crossing must issue exactly one source read')
      assert.equal(afterStats.readPages.length, beforeStats.readPages.length + 1, 'one boundary crossing must commit exactly one audited source page')
      const read = afterStats.readPages.at(-1), previousRead = beforeStats.readPages.at(-1)
      assert.ok(read && previousRead, 'the accepted source page must have an auditable predecessor')
      assert.equal(read.request.before, previousRead.page.before, 'prepend cursor must continue exactly from the accepted older boundary')
      assert.equal(read.page.after, read.request.before - 1, 'older page must end immediately before its request cursor')
      assert.equal(read.page.before, read.page.after - 159, 'the source page must cover one contiguous 160-event interval')
      assert.equal(read.eventCount, 160, 'the source page must commit exactly 160 body events')
      assert.deepEqual(read.contextEventSeqs, [], 'synthetic page events must not hide extra dependency reads')
      assert.equal(read.userMessageIds.length, 151, 'each tool-bearing page must preserve its 151 user messages')
      assert.deepEqual(read.userMessageIds, Array.from({ length: 151 }, (_, index) => `message-${firstUserId + index}`),
        'each page must contain the next uninterrupted range of user messages')
      assert.equal(read.toolLifecycleCount, 1, 'each older page must carry one complete tool lifecycle')
      assert.deepEqual(read.toolLifecycleIds, [`browser-tool-root-${13 - segment}`])
      assert.deepEqual(read.typeCounts, {
        'turn/start': 1, 'step/start': 1, 'assistant/message': 1, 'tool/call': 1,
        'tool/ptc-dispatch-start': 1, 'tool/ptc-dispatch': 1, 'tool/result': 1,
        'step/end': 1, 'turn/end': 1, 'user/message': 151,
      }, 'the real source page must include the full call, PTC, result and user-message lifecycle')
      const expectedRows = read.typeCounts['user/message'] + read.typeCounts['turn/start'] + read.typeCounts['assistant/message'] + read.typeCounts['tool/call']
      assert.equal(expectedRows, 154, 'official assembly adds 151 user rows, one turn row, one assistant step and one tool-call row')
      assert.equal(current.a.rows, before.a.rows + expectedRows, 'official Chat row growth must match the committed source events')
      assert.equal(read.page.after - read.page.before + 1, 160, 'selected source IDs must be contiguous across the full page')
      assert.equal(current.b.rows, baseline.b.rows, 'other occurrence must retain its window')
      assert.equal(JSON.stringify(current.b.before), JSON.stringify(baseline.b.before))
      assert.equal(current.a.draft, baseline.a.draft); assert.equal(current.b.draft, baseline.b.draft)
      assert.deepEqual(current.errors, [], 'failed/suspended automatic paging is not acceptance')
      previousVisible = body.min
      result.segments.push({ segment, rows: current.a.rows, firstVisible: body.min, bodyGestures,
        sourceEventCount: read.eventCount, userMessageCount: read.userMessageIds.length,
        toolLifecycleCount: read.toolLifecycleCount, toolLifecycleIds: read.toolLifecycleIds,
        sourceRange: { first: read.page.before, last: read.page.after }, userMessageRange: { first: firstUserId, last: lastUserId },
        officialRowsAdded: expectedRows })
    }
    await page.waitForFunction(() => window.__hhpi.snapshot().corrections.length === 13)
    const current = await state()
    assert.equal(current.corrections.length, 13, 'all thirteen mounted commits must be measured')
    assert.ok(current.corrections.every(value => value.delta !== null && Math.abs(value.delta) <= 2), `reader anchor drift exceeds 2 CSS pixels: ${JSON.stringify(current.corrections)}`)
    result.preciseCommitAnchors = current.corrections.map(value => ({ key: value.key, kind: preciseAnchorKind(value.key), delta: value.delta }))
    result.preciseCommitAnchorKinds = result.preciseCommitAnchors.reduce((counts, anchor) => {
      counts[anchor.kind] = (counts[anchor.kind] ?? 0) + 1
      return counts
    }, {})
    result.segments.forEach((segment, index) => {
      segment.preciseCommitAnchor = result.preciseCommitAnchors[index]
    })
  })
  await step('real viewport width change preserves the reading anchor', async () => {
    const started = performance.now()
    const originalWidth = mobile ? 390 : 1440, height = mobile ? 844 : 900
    const changedWidth = mobile ? 450 : 1320
    const anchor = await pane('a').evaluate(element => {
      const port = element.querySelector('[data-conversation-scroll]'), box = port.getBoundingClientRect()
      const node = [...port.querySelectorAll('[data-chat-node-key][data-chat-flow-kind="user"][data-chat-anchor-key]')].find(value => {
        const rect = value.getBoundingClientRect()
        return rect.height > 0 && rect.bottom > box.top + 2 && rect.top < box.bottom - 100
      })
      if (!node) return null
      const body = node.textContent.match(/body-(\d+)/)
      return { key: node.getAttribute('data-chat-anchor-key'), nodeKey: node.getAttribute('data-chat-node-key'),
        bodyId: body ? Number(body[1]) : null, offset: node.getBoundingClientRect().top - box.top }
    })
    assert.ok(anchor?.key && anchor.nodeKey && anchor.bodyId !== null, 'resize contract must begin from a visible actual user node')
    const before = await state(), reads = (await stats()).reads, samples = []
    for (const width of [changedWidth, originalWidth]) {
      await page.setViewportSize({ width, height })
      await gestures.settle()
      const sample = await pane('a').evaluate((element, identity) => {
        const port = element.querySelector('[data-conversation-scroll]')
        const node = [...port.querySelectorAll('[data-chat-node-key][data-chat-flow-kind="user"][data-chat-anchor-key]')].find(value =>
          value.getAttribute('data-chat-anchor-key') === identity.key && value.getAttribute('data-chat-node-key') === identity.nodeKey)
        if (!node) return null
        const portBox = port.getBoundingClientRect(), nodeBox = node.getBoundingClientRect()
        return { key: node.getAttribute('data-chat-anchor-key'), nodeKey: node.getAttribute('data-chat-node-key'),
          bodyId: Number(node.textContent.match(/body-(\d+)/)?.[1]), nodeHeight: nodeBox.height,
          offset: nodeBox.top - portBox.top, viewport: { width: innerWidth, height: innerHeight } }
      }, anchor)
      assert.ok(sample && sample.nodeHeight > 0, `the same user node ${anchor.bodyId} must remain mounted after resizing to ${width}px`)
      assert.equal(sample.key, anchor.key); assert.equal(sample.nodeKey, anchor.nodeKey); assert.equal(sample.bodyId, anchor.bodyId)
      assert.deepEqual(sample.viewport, { width, height }, 'resize must exercise the requested real viewport dimensions')
      const delta = sample.offset - anchor.offset
      assert.ok(Math.abs(delta) <= 2, `viewport ${width}px moved user anchor ${anchor.bodyId} by ${delta}px`)
      const resized = await state()
      assert.equal(resized.a.rows, before.a.rows, 'viewport reflow must preserve the current pane body count')
      assert.equal(resized.b.rows, before.b.rows, 'viewport reflow must preserve the other pane body count')
      assert.equal(resized.a.draft, before.a.draft); assert.equal(resized.b.draft, before.b.draft, 'viewport reflow must preserve both drafts')
      assert.equal((await stats()).reads, reads, 'viewport reflow must not request another source page')
      samples.push({ width, delta, offset: sample.offset })
    }
    result.viewportResizeAnchor = { key: anchor.key, nodeKey: anchor.nodeKey, bodyId: anchor.bodyId,
      originalWidth, height, samples, elapsedMs: Math.round(performance.now() - started) }
    assert.ok(performance.now() - started < 5000, 'both real viewport reflows must finish within five seconds')
  })
  await step('cached round trip and latest navigation', async () => {
    const before = await stats(), reading = await visible()
    await gestures.scroll(500); await gestures.scroll(-500)
    const after = await visible()
    assert.ok(Math.abs(after.top - reading.top) <= 2, `cached round trip moved the reading offset: ${reading.top} -> ${after.top}`)
    assert.equal((await stats()).reads, before.reads, 'cached reading must not request another source page')
    await page.evaluate(() => window.__hhpi.latest('a')); await gestures.settle()
    const tail = await visible(), latest = await stats()
    assert.ok(tail.total - tail.top - tail.height < 120, 'mounted toLatest must land at real scroll tail')
    for (let i = 0; i < 3; i++) { await gestures.scroll(-180); assert.ok((await visible()).min !== null, 'cached tail scroll must contain actual text') }
    assert.equal((await stats()).reads, latest.reads, 'loaded tail interval must not be fetched again')
    result.finalLayout = await assertLayout()
  })
  await step('synthetic native submission through official keyboard', async () => {
    await editor('a').click(); await page.keyboard.press('Enter')
    await page.waitForFunction(async () => (await (await fetch('/api/stats')).json()).writes.length === 1)
    const value = await stats()
    assert.equal(value.writes.length, 1); assert.equal(value.writes[0].kind, 'send')
    assert.equal(value.writes[0].text, baseline.a.draft)
    assert.equal(value.writes[0].sessionId, 'hhpi:browser-fixture:native-fixture:codex:synthetic-only')
    assert.equal((await state()).b.draft, baseline.b.draft)
    result.syntheticWrites = value.writes.length
  })
  result.measurements = await state(); result.inputs = await gestures.inputs()
  assert.equal(result.inputs.untrusted, 0, 'all exercised gestures must come from the browser input protocol')
  assert.ok(mobile ? result.inputs.touchmove > 0 : result.inputs.wheel > 0, 'required input modality was not exercised')
  await page.evaluate(async () => { await window.__hhpi.dispose(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) })
  assert.deepEqual(result.errors, [], 'uncaught errors and error-level browser logs fail acceptance, including cleanup')
  assert.deepEqual(result.unexpectedRequests, [], 'fixture must not contact external services')
}
