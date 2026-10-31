/** Two viewport checks of the actual official tool rows through production Codex adaptation. */
import assert from 'node:assert/strict'

export async function runCodexRenderingJourney(page, _context, origin, _mode, result) {
  const pane = page.locator('[data-lab-pane="a"]')
  const stats = () => fetch(origin + '/api/stats').then(response => response.json())
  let initialImageState
  async function step(name, action) {
    result.activeStep = name
    const start = performance.now()
    await action()
    result.steps.push({ name, ms: Math.round(performance.now() - start) })
    delete result.activeStep
  }
  async function layout() {
    const value = await pane.evaluate(element => {
      const port = element.querySelector('[data-conversation-scroll]')
      const input = element.querySelector('[contenteditable="true"]')
      const box = input?.getBoundingClientRect()
      const hit = box ? document.elementFromPoint(box.left + 20, box.top + box.height / 2) : null
      return { viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth,
        portWidth: port?.clientWidth, contentWidth: port?.scrollWidth,
        editorVisible: !!box && box.width > 100 && box.height > 10 && box.top >= 0 && box.bottom <= innerHeight + 1,
        editorHit: !!input && (hit === input || !!hit && input.contains(hit)),
        errors: element.querySelectorAll('[data-slot-error],[data-factory-error]').length }
    })
    assert.equal(value.errors, 0, 'official slots must render without failures')
    assert.ok(value.pageWidth <= value.viewportWidth + 1, 'native tool rows must not widen the page')
    assert.ok(value.contentWidth <= value.portWidth + 1, 'native tool rows must stay inside the conversation')
    assert.ok(value.editorVisible && value.editorHit, 'the official editor remains visible and hit-testable')
    return value
  }
  await step('native source enters the official conversation', async () => {
    await page.goto(origin + '/?codex-rendering=1', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__hhpiFailure || (window.__hhpi?.ready && window.__hhpi.snapshot().a.control))
    assert.equal(await page.evaluate(() => window.__hhpiFailure), undefined)
    await pane.getByText('Synthetic Codex rendering completed.', { exact: true }).waitFor({ state: 'visible' })
    result.initialLayout = await layout()
    await page.waitForFunction(async () => (await (await fetch('/api/stats')).json()).followRequests.length === 1)
    initialImageState = await stats()
    assert.equal(initialImageState.codexImages.imagesReleased, false)
    assert.equal(initialImageState.codexImages.pendingFileReads, 2, 'both native image reads remain pending while the first body and editor are usable')
    assert.equal(initialImageState.codexImages.imageRevisions, 0)
    assert.equal(await pane.locator('img').count(), 0, 'the initial body cannot use pre-enriched image fixtures')
    const release = await fetch(origin + '/api/release-images', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hhpi-fixture': '1' }, body: '{}' })
    assert.ok(release.ok, 'the declared source-file IO boundary must release')
  })
  await step('official command row expands native output', async () => {
    const commands = pane.locator('[data-sample="bash"]')
    assert.equal(await commands.count(), 2, 'both native command executions must use the official Bash row')
    const command = commands.filter({ hasText: 'README.md' })
    await command.scrollIntoViewIfNeeded()
    assert.equal(await command.getAttribute('data-state'), 'ok')
    assert.doesNotMatch(await command.innerText(), /codex\.commandExecution|\{"command"/)
    await command.click()
    assert.equal(await command.getAttribute('aria-expanded'), 'true')
    await pane.getByText('Native command output from the source.', { exact: true }).waitFor({ state: 'visible' })
    const failure = commands.filter({ hasText: 'missing-file.txt' })
    await failure.scrollIntoViewIfNeeded()
    assert.equal(await failure.getAttribute('data-state'), 'error', 'nonzero native exits retain failed state')
    await failure.click()
    assert.equal(await failure.getAttribute('aria-expanded'), 'true')
    await pane.getByText('cat: missing-file.txt: No such file or directory', { exact: true }).waitFor({ state: 'visible' })
    await failure.click()
    await command.click()
  })
  await step('official edit row expands the native diff', async () => {
    const edit = pane.locator('[data-tool="edit"]')
    assert.equal(await edit.count(), 1, 'native file changes must use the official Edit row')
    await edit.scrollIntoViewIfNeeded()
    assert.match(await edit.innerText(), /sample\.ts/)
    assert.doesNotMatch(await edit.innerText(), /codex\.fileChange|\{"changes"/)
    const header = edit.locator('[aria-expanded]').first()
    await edit.getByText('Edit', { exact: true }).click()
    assert.equal(await header.getAttribute('aria-expanded'), 'true')
    await edit.getByText('const oldValue = 1;', { exact: true }).waitFor({ state: 'visible' })
    await edit.getByText('const newValue = 2;', { exact: true }).waitFor({ state: 'visible' })
    result.expandedLayout = await layout()
    await edit.getByText('Edit', { exact: true }).click()
  })
  await step('native user and tool images use the official gallery', async () => {
    const user = pane.locator('[data-chat-node-key][data-chat-flow-kind="user"]').first()
    const image = user.locator('img').first()
    await image.scrollIntoViewIfNeeded()
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-lab-pane="a"] [data-chat-flow-kind="user"] img')
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1
    })
    assert.doesNotMatch(await user.innerText(), /Native image attachment|preview unavailable|1700000000000|00000000-1111/)
    const imageTool = pane.locator('[data-tool="read_image"]')
    await imageTool.scrollIntoViewIfNeeded()
    assert.equal(await imageTool.count(), 1, 'native imageView must use the original official image row')
    await imageTool.locator('[data-disclosure-row]').click({ position: { x: 8, y: 10 } })
    await imageTool.locator('img').waitFor({ state: 'visible' })
    assert.ok(await imageTool.locator('img').evaluate(async image => { await image.decode(); return image.complete && image.naturalWidth === 1 }), 'the gallery must decode authorized image bytes')
    const prepared = await stats()
    assert.equal(prepared.codexImages.imageRevisions, 2, 'both accepted native items must publish an image revision')
    assert.ok(prepared.sourceVersion > initialImageState.sourceVersion, 'image content must enter through a later source revision')
    assert.equal(prepared.reads, initialImageState.reads, 'image publication must update the mounted body without another history read')
    result.imagePublication = { pendingReadsAtFirstBody: initialImageState.codexImages.pendingFileReads,
      revisions: prepared.codexImages.imageRevisions, extraBodyReads: prepared.reads - initialImageState.reads }
    result.imageLayout = await layout()
    await imageTool.locator('[data-disclosure-row]').click({ position: { x: 8, y: 10 } })
  })
  await step('native function output exposes readable text without transport fields', async () => {
    const output = pane.locator('[data-tool="lookup"]')
    assert.equal(await output.count(), 1)
    await output.scrollIntoViewIfNeeded()
    await output.locator('[data-disclosure-row]').click({ position: { x: 8, y: 10 } })
    await output.getByText('Readable native function result.', { exact: false }).waitFor({ state: 'visible' })
    const text = await output.innerText()
    assert.match(text, /Audio output/); assert.match(text, /Encrypted output/)
    assert.doesNotMatch(text, /input_text|input_audio|encrypted_content|SYNTHETIC_(?:AUDIO|ENCRYPTED)_TRANSPORT|data:audio/)
    await output.locator('[data-disclosure-row]').click({ position: { x: 8, y: 10 } })
  })
  await step('subagent activity stays structured and source-only', async () => {
    const text = await pane.innerText()
    assert.doesNotMatch(text, /\[Native subAgentActivity item:|codex\.subAgentActivity|codex\.commandExecution|codex\.fileChange/)
    assert.match(text, /render-review/)
    const recorded = await stats()
    assert.equal(recorded.writes.length, 0, 'viewing and expanding recorded calls must not execute native tools')
    result.syntheticWrites = recorded.writes.length
    result.finalLayout = await layout()
  })
  await page.evaluate(async () => { await window.__hhpi.dispose(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) })
  assert.deepEqual(result.errors, [], 'browser errors fail the rendering contract')
  assert.deepEqual(result.unexpectedRequests, [], 'rendering fixtures cannot contact external services')
}
