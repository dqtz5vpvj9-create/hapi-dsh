// Open one existing ordinary DSH session with an isolated browser layout.
// All production writes, including WebSocket commands, are blocked.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const target = process.env.HAPI_DSH_PROBE_SESSION;
if (!target?.startsWith('hapi-remote:')) throw new Error('Set HAPI_DSH_PROBE_SESSION to an existing federated session resource ID');
const output = process.env.HAPI_DSH_TEST_ROOT ?? '/mnt/cache/data-cache/hapi-dsh-federated-cold';
await mkdir(output, { recursive: true });
const latency = Number(process.env.HAPI_DSH_LATENCY_MS ?? 0);
const mbps = Number(process.env.HAPI_DSH_DOWNLOAD_MBPS ?? 0);
const runs = Number(process.env.HAPI_DSH_PROBE_RUNS ?? 2);
const measureMemory = process.env.HAPI_DSH_PROBE_MEMORY === '1';
const reads = new Set([
  'settings/describe', 'session/modelCatalog', 'session/list', 'session/page', 'session/projections',
  'credentials/describe', 'dynamicCordisRunner/inventory', 'cotTranslation/limits', 'agentPresets/list',
  'permissionPresets/catalog', 'hapi/workspaceGet', 'hapi/catalog', 'hapi/sourceAdministration',
  'hapi/sourceReadStates', 'hapi/sourceQueuedEdits', 'hapi/nativeSettings', 'hapi/sourceSummarySettings',
  'hapi/sourceReadingAnchor', 'hapi/nativePlan', 'commands/list', 'skills/list',
  'llm/listProviders', 'llm/listConfigurableProviders',
]);
// In pinned rc.3, session/control only yields projection baselines and updates;
// it accepts no client items or commands. Include it to measure normal startup.
const streamReads = new Set(['session/follow', 'session/control', 'workspace/follow', '$events']);
const state = { schemaVersion: 1, revision: 0, windows: [{ id: 'probe-window', name: 'W1', autoName: true,
  root: { type: 'pane', id: 'probe-pane', resource: { kind: 'chat', sessionId: target } } }],
activeWindowId: 'probe-window', focused: { 'probe-window': 'probe-pane' }, zoomed: {} };
const report = { environment: 'Desktop Chromium, existing production session, isolated local layout, all writes blocked; CDP shapes HTTP only',
  latency, downloadMbps: mbps, allowedStreams: [...streamReads], runs: [], blocked: {}, sockets: {}, errors: [] };
const increment = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await context.newPage();
await page.routeWebSocket(() => true, route => {
  const url = new URL(route.url());
  const path = url.pathname === '/hapi-dsh/socket' ? new URL(url.searchParams.get('path') ?? '/', url.origin).pathname : url.pathname;
  const mux = path === '/api/remote.mux' || path === '/hapi-dsh/remote.mux';
  if (!mux && path !== '/hapi-dsh/plugin-events') { void route.close(); return; }
  const upstream = route.connectToServer();
  const active = new Set();
  route.onMessage(message => {
    let frame;
    try { if (typeof message === 'string') frame = JSON.parse(message); } catch {}
    if (mux && typeof frame?.streamId === 'string') {
      if (frame.type === 'open' && streamReads.has(frame.endpoint)) {
        active.add(frame.streamId); increment(report.sockets, frame.endpoint); upstream.send(message); return;
      }
      if (['cancel', 'end'].includes(frame.type) && active.delete(frame.streamId)) { upstream.send(message); return; }
    }
    increment(report.blocked, `WS ${typeof frame?.endpoint === 'string' ? frame.endpoint : 'client-message'}`);
    if (typeof frame?.streamId === 'string') route.send(JSON.stringify({ type: 'error', streamId: frame.streamId,
      error: { code: 'probe/read-only', message: 'Blocked by read-only probe', details: {} } }));
  });
});
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
const memorySample = async () => ({
  ...await cdp.send('Runtime.getHeapUsage'),
  ...await cdp.send('Memory.getDOMCounters'),
  rendered: await page.evaluate(() => ({
    elements: document.querySelectorAll('*').length,
    panes: document.querySelectorAll('.hapi-pane').length,
    chatNodes: document.querySelectorAll('[data-chat-node-key]').length,
  })),
});
if (latency || mbps) await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency, downloadThroughput: mbps ? mbps * 1_000_000 / 8 : -1, uploadThroughput: -1,
});
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
  const path = new URL(request.url).pathname.replace(/^\/hapi-dsh\/machine\/[^/]+(?=\/api\/)/, '');
  const method = path.replace(/^\/api\//, '');
  try {
    if (method === 'hapi/workspaceGet') {
      const requestBody = JSON.parse(request.postData ?? '{}');
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ type: 'server-response', rpcId: requestBody.rpcId,
          result: { ok: true, value: { revision: 0, state } } })).toString('base64') });
    } else if (reads.has(method)) await cdp.send('Fetch.continueRequest', { requestId });
    else { increment(report.blocked, `HTTP ${path}`); await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
  } catch { /* Browser shutdown may cancel intercepted requests. */ }
});
page.on('pageerror', error => report.errors.push(error.name));
await page.addInitScript(({ target, state }) => {
  performance.setResourceTimingBufferSize(5000);
  localStorage.setItem(`hapi-dsh:workspace:v1:${location.origin}${location.pathname}`, JSON.stringify(state));
  const sample = { workspace: null, title: null, body: null, editor: null, tasks: [] };
  window.__federatedCold = sample;
  new PerformanceObserver(list => { for (const entry of list.getEntries()) sample.tasks.push({ at: entry.startTime, ms: entry.duration }); })
    .observe({ type: 'longtask', buffered: true });
  const visible = e => {
    const r = e?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const tick = () => {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) [...dialog.querySelectorAll('button')].find(b => /^(Continue|继续)$/.test(b.textContent.trim()))?.click();
    const pane = document.querySelector('[data-pane-id="probe-pane"]');
    if (!sample.workspace && pane) sample.workspace = performance.now();
    const label = pane?.getAttribute('aria-label');
    if (!sample.title && label && !label.includes(target)) sample.title = performance.now();
    const editor = pane?.querySelector('[data-composer-input][contenteditable="true"]');
    if (!sample.editor && visible(editor)) sample.editor = performance.now();
    if (!sample.body && [...pane?.querySelectorAll('[data-chat-node-key]') ?? []].some(visible)) sample.body = performance.now();
    if (!sample.body || !sample.editor) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, { target, state });
try {
  const launch = new URL((await readFile(process.env.HAPI_DSH_LAUNCH_FILE ?? '/home/chris/.config/hapi-dsh/launch-url', 'utf8')).trim());
  const auth = await page.request.get(launch.href, { maxRedirects: 0 });
  if (auth.status() !== 303) throw new Error('Admission failed');
  for (let i = 0; i < runs; i++) {
    await page.goto(launch.origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
    let failure;
    try { await page.waitForFunction(() => window.__federatedCold.body && window.__federatedCold.editor, null, { timeout: 90000 }); }
    catch { failure = 'No visible body and editor within 90 seconds'; }
    const result = await page.evaluate(() => ({ ...window.__federatedCold,
      marks: performance.getEntriesByType('mark').filter(e => e.name.startsWith('hapi:')).map(e => ({ name: e.name, at: e.startTime })),
      resources: performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname.replace(/\/machine\/[^/]+/, '/machine/[id]'),
        at: e.startTime, ms: e.duration, bytes: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize, responseStart: e.responseStart })),
    }));
    let memory;
    if (measureMemory && !failure) {
      // Separate from opening timings. GC measures retention, not the normal
      // peak, and must not run in an ordinary performance-only probe.
      await page.waitForTimeout(2_000);
      const natural = await memorySample();
      await cdp.send('HeapProfiler.collectGarbage');
      memory = { natural, afterGc: await memorySample() };
    }
    report.runs.push({ mode: i ? 'cached reload' : 'fresh browser', ...result, failure, memory });
    console.log(JSON.stringify({ run: i, body: result.body, editor: result.editor, title: result.title,
      bytes: result.resources.reduce((sum, r) => sum + r.bytes, 0), failure, memory,
      largest: [...result.resources].sort((a,b) => b.bytes-a.bytes).slice(0, 5),
      longestTasks: [...result.tasks].sort((a,b) => b.ms-a.ms).slice(0, 5) }));
  }
} catch (error) { report.failure = error.name; process.exitCode = 1; }
finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  await browser.close();
}
if (report.runs.some(r => r.failure)) process.exitCode = 1;
