import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const launchPath = process.env.HAPI_DSH_LAUNCH_URL_FILE ?? '/home/chris/.config/hapi-dsh/launch-url'
const launch = readFileSync(launchPath, 'utf8').trim()
const TARGET = process.env.G1_TARGET ?? 'DSH 扩展架构与补丁部署排查'
const SAMPLES = Number(process.env.G1_SAMPLES ?? 20)
const cacheRoot = process.env.HAPI_DSH_OPENING_CACHE_ROOT ?? '/mnt/cache/hapi-dsh-runtime/dsh-home/profiles/hapi/data/hapi-dsh'
// Caches live under identities/<id>/<hash>/ and the observed/native roots.
function clearOpeningCaches(dir = cacheRoot, depth = 0) {
  let removed = 0
  if (depth > 6) return removed
  let names = []
  try { names = readdirSync(dir) } catch { return removed }
  for (const name of names) {
    const path = join(dir, name)
    if (name.endsWith('.opening.json')) { rmSync(path, { force: true }); removed++; continue }
    let info
    try { info = statSync(path) } catch { continue }
    if (info.isDirectory()) removed += clearOpeningCaches(path, depth + 1)
  }
  return removed
}
function hostProcessInfo() {
  try {
    const pid = Number(execFileSync('/usr/bin/pgrep', ['-f', 'dist/cli.js start --config /home/chris/.config/hapi-dsh/config.json'],
      { encoding: 'utf8' }).trim().split('\n')[0])
    if (!Number.isInteger(pid) || pid <= 0) return { pid: null }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(fields[19])
    const btime = Number(/btime (\d+)/.exec(readFileSync('/proc/stat', 'utf8'))?.[1])
    const startedAt = btime ? new Date((btime + startTicks / 100) * 1000).toISOString() : null
    return { pid, startedAt }
  } catch { return { pid: null } }
}
async function loadedAssets(page) {
  const urls = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource')
    .map(entry => entry.name)
    .filter(name => name.includes('/plugins/') && (/hapi-dsh/.test(name) || /session-provider/.test(name))))])
  const assets = []
  for (const url of urls.slice(0, 6)) {
    try {
      const response = await page.request.get(url)
      const body = await response.body()
      assets.push({ url: url.slice(0, 240), bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })
    } catch { /* asset may be CORS-blocked */ }
  }
  return assets
}
const host = hostProcessInfo()
const browser = await chromium.launch({ headless: true })
const results = []
const assets = []
for (let i = 0; i < SAMPLES; i++) {
  const cleared = clearOpeningCaches()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
  try {
    await page.goto(launch, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await page.locator('button.hapi-session-open').first().waitFor({ timeout: 60000 })
    await page.waitForTimeout(600)
    if (assets.length === 0) assets.push(...await loadedAssets(page))
    // Close any restored pane so every sample starts from a cold admission.
    const close = page.getByRole('button', { name: /Close pane/i }).first()
    if (await close.count()) {
      await close.click({ timeout: 5000 }).catch(() => {})
      await page.waitForFunction(() => document.querySelectorAll('[data-chat-flow]').length === 0, { timeout: 20000 }).catch(() => {})
    }
    const openPanes = await page.locator('[data-chat-flow]').count()
    if (openPanes > 0) {
      results.push({ sample: i + 1, cleared, complete: false, error: 'a pane stayed open; cold admission not measurable', at: {} })
      await context.close().catch(() => {})
      continue
    }
    // Closing the pane and clearing the opening caches makes the next click a
    // real cold admission while keeping the workspace layout.
    clearOpeningCaches()
    const sample = await page.evaluate(async targetTitle => {
      const row = [...document.querySelectorAll('button.hapi-session-open')]
        .find(b => (b.getAttribute('title') ?? '').split('\n')[0] === targetTitle)
        ?? [...document.querySelectorAll('button.hapi-session-open')]
          .find(b => (b.getAttribute('title') ?? '').includes('DSH'))
      if (!row) return { error: 'target row missing', complete: false, at: {} }
      row.click()
      const start = performance.now()
      const pane = () => document.querySelector('.hapi-pane-focused') ?? document
      const at = {}
      const deadline = start + 15000
      while (performance.now() < deadline) {
        const flow = pane().querySelector('[data-chat-flow]')
        const port = pane().querySelector('[data-conversation-scroll]')
        if (at.body === undefined && flow && (flow.innerText ?? '').trim().length > 0) at.body = Math.round(performance.now() - start)
        const input = pane().querySelector('[data-composer-input][contenteditable="true"]')
        if (at.composer === undefined && input && input.getBoundingClientRect().height > 0 && input.getAttribute('aria-disabled') !== 'true') at.composer = Math.round(performance.now() - start)
        if (at.history === undefined && port && port.scrollHeight > port.clientHeight + 300) at.history = Math.round(performance.now() - start)
        if (Object.keys(at).length === 3) break
        await new Promise(resolve => setTimeout(resolve, 8))
      }
      return { at, complete: Object.keys(at).length === 3, firstScreenMs: Math.max(...Object.values(at)) }
    }, TARGET)
    results.push({ sample: i + 1, cleared, ...sample, errors: errors.slice(0, 2) })
  } catch (error) {
    results.push({ sample: i + 1, cleared, complete: false, error: String(error).slice(0, 200), at: {} })
  }
  await context.close().catch(() => {})
}
await browser.close()
const times = results.map(r => r.complete ? r.firstScreenMs : 15000)
const passed = times.filter(t => t <= 1500).length
const sorted = [...times].sort((a, b) => a - b)
const reportPath = process.env.HAPI_DSH_G1_REPORT ?? '/mnt/cache/src/hapi-dsh/.tmp/gates/prod-g1-cold20.json'
const report = { schema: 1, gate: 'G1', target: TARGET, passed: passed === SAMPLES, passCount: passed, samples: SAMPLES, host, loadedAssets: assets,
  times, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], complete: results.filter(r => r.complete).length,
  clearedCaches: results.map(r => r.cleared), details: results }
writeFileSync(reportPath, JSON.stringify(report, null, 1))
console.log(JSON.stringify({ passCount: passed, samples: SAMPLES, times, p95: report.p95, complete: report.complete }, null, 1))
