// Read-only production navigation probe. Credentials stay in the browser context.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { availableParallelism, loadavg } from 'node:os';
const root = process.env.HAPI_DSH_TEST_ROOT ?? '/mnt/cache/data-cache';
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
if (process.env.HAPI_DSH_PROFILE) await cdp.send('Profiler.enable');
if (process.env.HAPI_DSH_CPU_RATE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.HAPI_DSH_CPU_RATE) });
const report = { environment: 'Chromium mobile emulation; production read-only; unthrottled network', cpuRate: Number(process.env.HAPI_DSH_CPU_RATE ?? 1), runs: [] };
const errors = [];
const transport = { webSockets: 0, receivedFrames: 0, errors: 0 };
page.on('websocket', socket => { transport.webSockets++; socket.on('framereceived', () => transport.receivedFrames++); socket.on('socketerror', () => transport.errors++); });
page.on('pageerror', e => errors.push(e.name));
await page.addInitScript(() => {
  const marks = { workspace: null, body: null, editor: null, tasks: [] };
  window.__coldOpen = marks;
  new PerformanceObserver(list => { for (const e of list.getEntries()) marks.tasks.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
  function tick() {
    const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    if (!marks.workspace && document.querySelector('[data-hapi-workspace]')) marks.workspace = performance.now();
    const pane = document.querySelector('.hapi-pane-focused') ?? document.querySelector('.hapi-pane:not([aria-hidden="true"])');
    const editor = pane?.querySelector('[data-composer-input][contenteditable="true"]');
    if (!marks.editor && visible(editor) && editor.getAttribute('aria-disabled') !== 'true') marks.editor = performance.now();
    const rows = pane?.querySelectorAll('[data-chat-node-key]') ?? [];
    if (!marks.body && [...rows].some(e => visible(e) && e.textContent.trim().length > 5)) marks.body = performance.now();
    if (!marks.body || !marks.editor) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
});
try {
  const launch = new URL((await readFile(process.env.HAPI_DSH_LAUNCH_FILE ?? '/home/chris/.config/hapi-dsh/launch-url', 'utf8')).trim());
  const auth = await page.request.get(launch.href, { maxRedirects: 0 });
  if (auth.status() !== 303) throw new Error(`Admission HTTP ${auth.status()}`);
  for (let i = 0; i < Number(process.env.HAPI_DSH_PROBE_RUNS ?? 2); i++) {
    const network = [];
    const pending = new Map();
    const started = performance.now();
    const request = r => pending.set(r, performance.now());
    const finished = r => {
      const u = new URL(r.url());
      // Only public asset/RPC paths. Never persist credentials, query strings, or payloads.
      network.push({ path: u.pathname.replace(/\/(sessions?|machine)\/[^/]+/g, '/$1/[id]'), type: r.resourceType(), at: (pending.get(r) ?? started) - started, ms: performance.now() - (pending.get(r) ?? started) });
      pending.delete(r);
    };
    page.on('request', request); page.on('requestfinished', finished);
    let failure;
    if (process.env.HAPI_DSH_PROFILE) await cdp.send('Profiler.start');
    await page.goto(launch.origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const notice = page.getByRole('dialog', { name: /^(Preview Notice|预览版说明)$/ });
    if (await notice.count()) await notice.getByRole('button', { name: /^(Continue|继续)$/ }).click();
    try { await page.waitForFunction(() => window.__coldOpen.body && window.__coldOpen.editor, null, { timeout: 90000 }); }
    catch { failure = 'Timed out before real transcript and usable editor'; }
    const result = await page.evaluate(() => ({ ...window.__coldOpen, paints: performance.getEntriesByType('paint').map(e => ({ name: e.name, at: e.startTime })), resources: performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname.replace(/\/(sessions?|machine)\/[^/]+/g, '/$1/[id]'), at: e.startTime, ms: e.duration, bytes: e.transferSize })), nodes: document.querySelectorAll('*').length, views: [...document.querySelectorAll('[data-hapi-session-view]')].map(e => ({ visible: !!e.getBoundingClientRect().width, rows: e.querySelectorAll('[data-chat-node-key]').length })) }));
    page.off('request', request); page.off('requestfinished', finished);
    if (process.env.HAPI_DSH_PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      // CPU profiles contain script paths, not request credentials or message bodies.
      await writeFile(`${root}/hapi-cold-${i}.cpuprofile`, JSON.stringify(profile), { mode: 0o600 });
    }
    report.runs.push({ mode: i ? 'repeat navigation with browser cache' : 'fresh browser navigation', ...result, network, failure });
    console.log(JSON.stringify({ run: i, workspace: result.workspace, body: result.body, editor: result.editor, failure, longestTasks: result.tasks.sort((a,b) => b.ms-a.ms).slice(0,5) }));
  }
} catch (e) { report.failure = e.name; process.exitCode = 1; }
finally {
  report.errors = errors;
  report.transport = transport;
  report.hostLoad = { availableCpus: availableParallelism(), loadAverage: loadavg() };
  const path = `${root}/hapi-cold-open-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(path);
  await browser.close();
}
if (report.runs.some(r => r.failure)) process.exitCode = 1;
