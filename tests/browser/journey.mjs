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
      const rows = [...port.querySelectorAll('[data-chat-anchor-key]')].filter(node => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > box.top + 2 && rect.top < box.bottom - 100 })
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
  await step('browser keyboard, composition and independent drafts', () => exerciseDraftInput(page, context, mobile, result))
  const fixture = await stats()
  assert.equal(fixture.userMessageCount, 1440, 'the synthetic source retains all 1440 user messages')
  assert.deepEqual(fixture.userMessageRange, { first: 1, last: 1440 }, 'synthetic user bodies remain one continuous range')
  assert.equal(fixture.sourceEventCount, 1503, 'seven complete tool-bearing windows are added without dropping user messages')
  const baseline = await state(); let previousVisible = (await visible()).min
  await step('six real-input older boundary crossings', async () => {
    result.segments = []
    for (let segment = 1; segment <= 6; segment++) {
      const before = await state()
      const beforeStats = await stats()
      const lastUserId = 1440 - segment * 151
      const firstUserId = lastUserId - 150
      await gestures.boundary()
      await page.waitForFunction(rows => { const value = window.__hhpi.snapshot(); return value.a.rows > rows && !value.a.busy }, before.a.rows)
      await gestures.settle(); await gestures.scroll(-350)
      const current = await state(), body = await visible(), afterStats = await stats()
      assert.ok(body.min !== null && body.min < previousVisible, 'each upward segment must expose earlier real body text')
      assert.ok(body.min >= firstUserId && body.min <= lastUserId, 'visible body remains inside the newly committed continuous user range')
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
      assert.deepEqual(read.toolLifecycleIds, [`browser-tool-root-${6 - segment}`])
      assert.deepEqual(read.typeCounts, {
        'turn/start': 1, 'step/start': 1, 'assistant/message': 1, 'tool/call': 1,
        'tool/ptc-dispatch-start': 1, 'tool/ptc-dispatch': 1, 'tool/result': 1,
        'step/end': 1, 'turn/end': 1, 'user/message': 151,
      }, 'the real source page must include the full call, PTC, result and user-message lifecycle')
      const expectedRows = read.typeCounts['user/message'] + read.typeCounts['turn/start'] + read.typeCounts['tool/call']
      assert.equal(expectedRows, 153, 'official assembly should add 151 user rows, one turn row and one tool-call row')
      assert.equal(current.a.rows, before.a.rows + expectedRows, 'official Chat row growth must match the committed source events')
      assert.equal(read.page.after - read.page.before + 1, 160, 'selected source IDs must be contiguous across the full page')
      assert.equal(current.b.rows, baseline.b.rows, 'other occurrence must retain its window')
      assert.equal(JSON.stringify(current.b.before), JSON.stringify(baseline.b.before))
      assert.equal(current.a.draft, baseline.a.draft); assert.equal(current.b.draft, baseline.b.draft)
      assert.deepEqual(current.errors, [], 'failed/suspended automatic paging is not acceptance')
      previousVisible = body.min
      result.segments.push({ segment, rows: current.a.rows, firstVisible: body.min,
        sourceEventCount: read.eventCount, userMessageCount: read.userMessageIds.length,
        toolLifecycleCount: read.toolLifecycleCount, toolLifecycleIds: read.toolLifecycleIds,
        sourceRange: { first: read.page.before, last: read.page.after }, userMessageRange: { first: firstUserId, last: lastUserId },
        officialRowsAdded: expectedRows })
    }
    await page.waitForFunction(() => window.__hhpi.snapshot().corrections.length === 6)
    const current = await state()
    assert.equal(current.corrections.length, 6, 'all six mounted commits must be measured')
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
  })
  result.measurements = await state(); result.inputs = await gestures.inputs()
  assert.equal(result.inputs.untrusted, 0, 'all exercised gestures must come from the browser input protocol')
  assert.ok(mobile ? result.inputs.touchmove > 0 : result.inputs.wheel > 0, 'required input modality was not exercised')
  await page.evaluate(async () => { await window.__hhpi.dispose(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) })
  assert.deepEqual(result.errors, [], 'uncaught errors and error-level browser logs fail acceptance, including cleanup')
  assert.deepEqual(result.unexpectedRequests, [], 'fixture must not contact external services')
}
