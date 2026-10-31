/** Exactly two isolated real-browser scenarios; one build/process, bounded time, no retries. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildLab, root } from './build.mjs'
import { startLab } from './server.ts'
import { runJourney } from './journey.mjs'
import { runCodexRenderingJourney } from './codex-rendering-journey.mjs'

const args = new Set(process.argv.slice(2))
if ([...args].some(value => !['--dom', '--browser', '--serve', '--headed', '--codex-rendering'].includes(value))) throw new Error('Usage: node --import tsx tests/browser/run.mjs [--dom|--browser|--serve] [--headed] [--codex-rendering]')
if (args.has('--dom')) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/contracts/hhpi-reading-occurrences.test.ts', 'tests/contracts/hhpi-reading-dom.test.ts'], { cwd: root, stdio: 'inherit', timeout: 30_000 })
  if (run.error) throw run.error
  process.exit(run.status ?? 1)
}
const codexRendering = args.has('--codex-rendering')
const out = resolve(root, '.tmp/hhpi-browser/results', codexRendering ? 'codex-rendering' : '.')
await mkdir(out, { recursive: true })
const report = { schema: 1, commit: process.env.GITHUB_SHA ?? spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  startedAt: new Date().toISOString(), status: 'running', scope: `${codexRendering ? 'native Codex source projection and ' : ''}official component lab; synthetic source and outer shell`,
  geometryMocks: false, physicalKeyboard: 'not-run', physicalPhone: 'not-run', operatingSystemIME: 'not-run', softKeyboard: 'not-run',
  visualReview: 'not-performed', productionDeployment: 'not-run', scenarios: [] }
let server, browser
try {
  report.identity = await buildLab(); server = await startLab({ codexRendering })
  if (args.has('--serve')) {
    console.log(`Synthetic official-component lab: ${server.origin}`)
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    report.status = 'interactive-only'
  } else {
    const modulePath = process.env.HHPI_PLAYWRIGHT_MODULE ?? resolve(root, '.tmp/hhpi-browser-tools/node_modules/playwright/index.mjs')
    const { chromium } = await import(pathToFileURL(modulePath).href)
    browser = await chromium.launch({ headless: !args.has('--headed'), ...(process.env.HHPI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.HHPI_CHROMIUM_EXECUTABLE } : {}) })
    report.browser = { engine: 'chromium', version: browser.version() }
    for (const mode of ['desktop', 'mobile']) {
      const mobile = mode === 'mobile'
      await fetch(server.origin + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hhpi-fixture': '1' }, body: '{}' })
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1, locale: 'en-US' })
      const result = { mode, status: 'running', budgetMs: 60_000, steps: [], errors: [], unexpectedRequests: [] }
      report.scenarios.push(result)
      const started = performance.now(); let deadline, page
      try {
        await context.route('**/*', route => {
          const url = new URL(route.request().url())
          if (url.origin === server.origin || url.protocol === 'data:') return route.continue()
          result.unexpectedRequests.push(url.origin + url.pathname); return route.abort()
        })
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
        page = await context.newPage(); page.setDefaultTimeout(8_000)
        page.on('pageerror', error => result.errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()) })
        const journey = codexRendering ? runCodexRenderingJourney : runJourney
        await Promise.race([journey(page, context, server.origin, mode, result), new Promise((_, reject) => {
          deadline = setTimeout(() => { reject(new Error('Scenario exceeded its 60 second budget')); void context.close() }, 60_000)
        })])
        result.status = 'passed'
      } catch (error) {
        result.status = 'failed'; result.failure = error instanceof Error ? error.stack : String(error)
        if (page && !page.isClosed()) result.diagnostics = await page.evaluate(() => ({ state: window.__hhpi?.snapshot(), inputs: window.__labInputs,
          ports: [...document.querySelectorAll('[data-conversation-scroll]')].map(element => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight, rect: element.getBoundingClientRect().toJSON(), touchAction: getComputedStyle(element).touchAction })),
          failures: [...document.querySelectorAll('[data-slot-error],[data-factory-error]')].map(element => element.outerHTML), visibleText: document.body.innerText.slice(0, 1200) })).catch(error => ({ unavailable: String(error) }))
      } finally {
        clearTimeout(deadline); result.durationMs = Math.round(performance.now() - started)
        await context.tracing.stop({ path: resolve(out, `${mode}-trace.zip`) }).catch(error => { result.traceError = String(error) })
        await context.close()
        await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(result))
      }
    }
    report.status = report.scenarios.length === 2 && report.scenarios.every(item => item.status === 'passed') ? 'passed' : 'failed'
    if (report.status !== 'passed') process.exitCode = 1
  }
} catch (error) { report.status = 'failed'; report.failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; console.error(error) }
finally {
  await browser?.close(); await server?.close(); report.finishedAt = new Date().toISOString()
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2))
}
