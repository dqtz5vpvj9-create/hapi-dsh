/** Two bounded real-Chromium component journeys, one shared build/browser, no retries. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildLab, root } from './build.mjs'
import { startLab } from './server.ts'

const args = new Set(process.argv.slice(2))
if ([...args].some(value => !['--dom', '--browser', '--serve', '--headed'].includes(value))) throw new Error('Usage: node --import tsx tests/browser/run.mjs [--dom|--browser|--serve] [--headed]')
if (args.has('--dom')) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/contracts/hhpi-reading-occurrences.test.ts', 'tests/contracts/hhpi-reading-dom.test.ts'], { cwd: root, stdio: 'inherit', timeout: 30_000 })
  if (run.error) throw run.error
  process.exit(run.status ?? 1)
}
const out = resolve(root, '.tmp/hhpi-browser/results')
await mkdir(out, { recursive: true })
const report = { schema: 1, commit: process.env.GITHUB_SHA ?? spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  startedAt: new Date().toISOString(), status: 'running', scope: 'official component lab; synthetic source and outer shell',
  geometryMocks: false, physicalKeyboard: 'not-run', physicalPhone: 'not-run', operatingSystemIME: 'not-run', softKeyboard: 'not-run',
  visualReview: 'not-performed', productionDeployment: 'not-run', scenarios: [] }
let server, browser
try {
  report.identity = await buildLab()
  server = await startLab()
  if (args.has('--serve')) {
    console.log(`Synthetic official-component lab: ${server.origin}`)
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  } else {
    const modulePath = process.env.HHPI_PLAYWRIGHT_MODULE ?? resolve(root, '.tmp/hhpi-browser-tools/node_modules/playwright/index.mjs')
    const { chromium } = await import(pathToFileURL(modulePath).href)
    browser = await chromium.launch({ headless: !args.has('--headed') })
    report.browser = { engine: 'chromium', version: browser.version() }
    for (const mode of ['desktop', 'mobile']) {
      const mobile = mode === 'mobile'
      await fetch(server.origin + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hhpi-fixture': '1' }, body: '{}' })
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1, locale: 'en-US' })
      const result = { mode, status: 'running', budgetMs: 60_000, steps: [], errors: [], unexpectedRequests: [] }
      report.scenarios.push(result)
      const started = performance.now()
      let deadline
      try {
        await context.route('**/*', route => {
          const url = new URL(route.request().url())
          if (url.origin === server.origin || url.protocol === 'data:') return route.continue()
          result.unexpectedRequests.push(url.origin + url.pathname); return route.abort()
        })
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
        const page = await context.newPage()
        page.setDefaultTimeout(8_000)
        page.on('pageerror', error => result.errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()) })
        const cdp = mobile ? await context.newCDPSession(page) : undefined
        async function step(name, action) {
          const start = performance.now(); await action(); result.steps.push({ name, ms: Math.round(performance.now() - start) })
        }
        const state = () => page.evaluate(() => window.__hhpi.snapshot())
        const stats = () => fetch(server.origin + '/api/stats').then(response => response.json())
        const pane = key => page.locator(`[data-lab-pane="${key}"]`)
        const editor = key => pane(key).locator('[contenteditable="true"]')
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
        async function visible() {
          return pane('a').evaluate(element => {
            const port = element.querySelector('[data-conversation-scroll]'), box = port.getBoundingClientRect()
            const rows = [...port.querySelectorAll('[data-chat-anchor-key]')].filter(node => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > box.top + 2 && rect.top < box.bottom - 100 })
            const numbers = rows.flatMap(node => [...node.textContent.matchAll(/body-(\d+)/g)].map(value => Number(value[1])))
            return { min: numbers.length ? Math.min(...numbers) : null, keys: rows.map(node => node.getAttribute('data-chat-anchor-key')), top: port.scrollTop, height: port.clientHeight, total: port.scrollHeight }
          })
        }
        async function gesture(delta) {
          const port = pane('a').locator('[data-conversation-scroll]'), box = await port.boundingBox()
          assert.ok(box && box.height > 100 && box.width > 100, 'official scrollport must have real geometry')
          const x = box.x + box.width / 2, y = box.y + Math.min(150, box.height / 2)
          if (mobile) await cdp.send('Input.synthesizeScrollGesture', { x, y, yDistance: -delta, speed: 100000, preventFling: true, gestureSourceType: 'touch' })
          else { await page.mouse.move(x, y); await page.mouse.wheel(0, delta) }
          await settle()
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
          assert.equal(layout.failures, 0, 'official slot/factory errors are not a usable first view')
          assert.ok(layout.pageWidth <= layout.viewport.width + 1, 'page must not overflow horizontally')
          assert.ok(layout.contentWidth <= layout.portWidth + 1, 'long source lines must not overflow the official scrollport')
          assert.ok(layout.editor.width > 100 && layout.editor.height > 10 && layout.editor.y >= 0 && layout.editor.y + layout.editor.height <= layout.viewport.height + 1, 'official editable input must be inside viewport')
          assert.ok(layout.editorHit, 'official editor must be hit-testable, not covered')
          return layout
        }
        const journey = async () => {
          await step('first usable official view', async () => {
            await page.goto(server.origin, { waitUntil: 'domcontentloaded' })
            await page.waitForFunction(() => window.__hhpiFailure || (window.__hhpi?.ready && window.__hhpi.snapshot().a.control && window.__hhpi.snapshot().b.control))
            const failure = await page.evaluate(() => window.__hhpiFailure)
            assert.equal(failure, undefined)
            await settle(); result.initialLayout = await assertLayout()
            assert.ok((await visible()).min !== null, 'first target frame must contain visible source bodies')
          })
          await step('browser keyboard and independent drafts', async () => {
            await editor('a').click(); await page.keyboard.type('Draft A'); await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('第二行')
            await page.waitForFunction(() => window.__hhpi.snapshot().a.draft.includes('第二行'))
            assert.match((await state()).a.draft, /Draft A\n第二行/)
            if (mobile) await page.locator('[data-select-pane="b"]').tap()
            await editor('b').click(); await page.keyboard.type('Draft B')
            await page.waitForFunction(() => window.__hhpi.snapshot().b.draft === 'Draft B')
            if (mobile) await page.locator('[data-select-pane="a"]').tap()
            assert.equal((await stats()).writes.length, 0, 'typing and newline must never send')
          })
          const baseline = await state(); let previousVisible = (await visible()).min
          await step('six continuous older visible body segments', async () => {
            result.segments = []
            for (let segment = 1; segment <= 6; segment++) {
              const before = await state()
              await gesture(-100000)
              await page.waitForFunction(rows => { const value = window.__hhpi.snapshot(); return value.a.rows > rows && !value.a.busy }, before.a.rows)
              await settle(); await gesture(-300)
              const current = await state(), body = await visible()
              assert.ok(body.min !== null && body.min < previousVisible, 'each upward segment must expose earlier real body text')
              assert.equal(current.a.rows, before.a.rows + 160, 'one source segment must be committed exactly once')
              assert.equal(current.b.rows, baseline.b.rows, 'other occurrence must retain its window')
              assert.equal(JSON.stringify(current.b.before), JSON.stringify(baseline.b.before))
              assert.equal(current.a.draft, baseline.a.draft); assert.equal(current.b.draft, baseline.b.draft)
              assert.deepEqual(current.errors, [], 'failed/suspended automatic paging is not acceptance')
              previousVisible = body.min; result.segments.push({ segment, rows: current.a.rows, firstVisible: body.min })
            }
            const current = await state()
            assert.equal(current.corrections.length, 6, 'all six mounted commits must be measured')
            assert.ok(current.corrections.every(value => value.delta !== null && Math.abs(value.delta) <= 2), `reader anchor drift exceeds 2 CSS pixels: ${JSON.stringify(current.corrections)}`)
          })
          await step('cached round trip and latest navigation', async () => {
            const before = await stats(), reading = await visible()
            await gesture(500); await gesture(-500)
            const after = await visible()
            assert.ok(Math.abs(after.top - reading.top) <= 2, 'cached round trip must preserve the reading offset')
            assert.equal((await stats()).reads, before.reads, 'cached reading must not request another source page')
            await page.evaluate(() => window.__hhpi.latest('a')); await settle()
            const tail = await visible(), latest = await stats()
            assert.ok(tail.total - tail.top - tail.height < 120, 'mounted toLatest must land at real scroll tail')
            for (let i = 0; i < 3; i++) { await gesture(-180); assert.ok((await visible()).min !== null, 'cached tail scroll must contain actual text') }
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
          result.measurements = await state()
          assert.deepEqual(result.errors, [], 'uncaught errors and error-level browser logs fail acceptance')
          assert.deepEqual(result.unexpectedRequests, [], 'fixture must not contact external services')
          await page.evaluate(() => window.__hhpi.dispose())
        }
        await Promise.race([journey(), new Promise((_, reject) => { deadline = setTimeout(() => { reject(new Error('Scenario exceeded its 60 second budget')); void context.close() }, 60_000) })])
        result.status = 'passed'
      } catch (error) { result.status = 'failed'; result.failure = error instanceof Error ? error.stack : String(error) }
      finally {
        clearTimeout(deadline); result.durationMs = Math.round(performance.now() - started)
        await context.tracing.stop({ path: resolve(out, `${mode}-trace.zip`) }).catch(error => { result.traceError = String(error) })
        await context.close()
        await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2))
        console.log(JSON.stringify(result))
      }
      if (result.status !== 'passed') break
    }
    report.status = report.scenarios.length === 2 && report.scenarios.every(item => item.status === 'passed') ? 'passed' : 'failed'
    if (report.status !== 'passed') process.exitCode = 1
  }
} catch (error) { report.status = 'failed'; report.failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; console.error(error) }
finally {
  await browser?.close(); await server?.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2))
}
