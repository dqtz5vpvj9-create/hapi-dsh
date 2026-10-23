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
// A real page can automatically create an empty Session or persist a layout.
// Do not let a production measurement perform those writes. CDP intercepts
// only RPC requests, leaving asset caching intact for repeat navigation.
const readRpcs = new Set([
  '/api/dynamicCordisRunner/syncInspectManifest', '/api/settings/describe',
  '/api/session/modelCatalog', '/api/session/list', '/api/session/page', '/api/session/projections',
  '/api/credentials/describe', '/api/dynamicCordisRunner/inventory', '/api/cotTranslation/limits', '/api/agentPresets/list',
  '/api/permissionPresets/catalog', '/api/hapi/workspaceGet', '/api/hapi/catalog',
  '/api/hapi/sourceNotificationSettings', '/api/hapi/sourceAdministration', '/api/hapi/sourceReadStates',
  '/api/hapi/sourceQueuedEdits', '/api/hapi/nativeSettings', '/api/hapi/sourceSummarySettings',
  '/api/hapi/sourceSessionResolve',
  '/api/hapi/nativePlan', '/api/commands/list', '/api/skills/list',
  '/api/llm/listProviders', '/api/llm/listConfigurableProviders',
]);
const blockedWrites = new Map();
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
  const path = new URL(request.url).pathname;
  const rpcPath = path.replace(/^\/hapi-dsh\/machine\/[^/]+(?=\/api\/)/, '');
  try {
    if (request.method === 'GET' || request.method === 'HEAD' || readRpcs.has(rpcPath)) {
      await cdp.send('Fetch.continueRequest', { requestId });
    } else {
      const safePath = path.replace(/\/machine\/[^/]+/, '/machine/[id]');
      blockedWrites.set(safePath, (blockedWrites.get(safePath) ?? 0) + 1);
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  } catch { /* The context may have closed with a paused request. */ }
});
const networkConditions = {
  latency: Number(process.env.HAPI_DSH_LATENCY_MS ?? 0),
  downloadMbps: Number(process.env.HAPI_DSH_DOWNLOAD_MBPS ?? 0),
  uploadMbps: Number(process.env.HAPI_DSH_UPLOAD_MBPS ?? 0),
};
if (Object.values(networkConditions).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid network conditions');
await cdp.send('Network.enable');
if (Object.values(networkConditions).some(Boolean)) await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: networkConditions.latency,
  downloadThroughput: networkConditions.downloadMbps ? networkConditions.downloadMbps * 1_000_000 / 8 : -1,
  uploadThroughput: networkConditions.uploadMbps ? networkConditions.uploadMbps * 1_000_000 / 8 : -1,
});
if (process.env.HAPI_DSH_PROFILE) await cdp.send('Profiler.enable');
if (process.env.HAPI_DSH_CPU_RATE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.HAPI_DSH_CPU_RATE) });
const report = { environment: 'Chromium mobile emulation; production read-only; CDP HTTP network shaping (not a physical remote network or WebSocket latency guarantee)', networkConditions, cpuRate: Number(process.env.HAPI_DSH_CPU_RATE ?? 1), runs: [] };
const errors = [];
let runStarted = performance.now(), runIndex = -1;
const transport = { webSockets: 0, receivedFrames: 0, decodedBytes: 0, maxDecodedFrame: 0, errors: 0, negotiatedCompression: [], frames: [] };
cdp.on('Network.webSocketHandshakeResponseReceived', ({ response }) => {
  const extension = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'sec-websocket-extensions')?.[1];
  if (extension) transport.negotiatedCompression.push(extension);
});
page.on('websocket', socket => { transport.webSockets++; socket.on('framereceived', ({ payload }) => {
  transport.receivedFrames++; const bytes = Buffer.byteLength(payload); transport.decodedBytes += bytes;
  transport.maxDecodedFrame = Math.max(transport.maxDecodedFrame, bytes);
  if (bytes > 16_384 && transport.frames.length < 300) {
    let kind = 'binary';
    if (typeof payload === 'string') { try { const frame = JSON.parse(payload); kind = [frame.type, frame.value?.type].filter(value => typeof value === 'string').join('/'); } catch { kind = 'text'; } }
    transport.frames.push({ run: runIndex, at: performance.now() - runStarted, kind, decodedBytes: bytes });
  }
}); socket.on('socketerror', () => transport.errors++); });
page.on('pageerror', e => errors.push(e.name));
await page.addInitScript(() => {
  const marks = { workspace: null, body: null, editor: null, tasks: [] };
  window.__coldOpen = marks;
  new PerformanceObserver(list => { for (const e of list.getEntries()) marks.tasks.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
  function tick() {
    const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    if (!marks.workspace && document.querySelector('[data-hapi-workspace]')) marks.workspace = performance.now();
    const pane = [...document.querySelectorAll('.hapi-pane-focused')].find(visible) ?? [...document.querySelectorAll('.hapi-pane')].find(visible);
    const editor = pane?.querySelector('[data-composer-input][contenteditable="true"]');
    if (!marks.editor && visible(editor) && editor.getAttribute('aria-disabled') !== 'true') marks.editor = performance.now();
    const rows = pane?.querySelectorAll('[data-chat-node-key]') ?? [];
    const viewport = pane?.querySelector('[data-conversation-scroll]')?.getBoundingClientRect();
    if (!marks.body && viewport && [...rows].some(e => {
      const box = e.getBoundingClientRect();
      return visible(e) && box.bottom > viewport.top && box.top < viewport.bottom
        && box.right > viewport.left && box.left < viewport.right && e.textContent.trim().length > 5;
    })) marks.body = performance.now();
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
    runStarted = started; runIndex = i;
    const request = r => pending.set(r, performance.now());
    const finished = r => {
      const u = new URL(r.url());
      // Only public asset/RPC paths. Never persist credentials, query strings, or payloads.
      network.push({ path: u.pathname.replace(/\/(sessions|machine)\/[^/]+/g, '/$1/[id]'), type: r.resourceType(), at: (pending.get(r) ?? started) - started, ms: performance.now() - (pending.get(r) ?? started) });
      pending.delete(r);
    };
    const failed = r => { finished(r); network.at(-1).failed = r.failure()?.errorText; };
    page.on('request', request); page.on('requestfinished', finished); page.on('requestfailed', failed);
    let failure;
    if (process.env.HAPI_DSH_PROFILE) await cdp.send('Profiler.start');
    await page.goto(launch.origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const notice = page.getByRole('dialog', { name: /^(Preview Notice|预览版说明)$/ });
    if (await notice.count()) await notice.getByRole('button', { name: /^(Continue|继续)$/ }).click();
    try { await page.waitForFunction(() => window.__coldOpen.body && window.__coldOpen.editor, null, { timeout: 90000 }); }
    catch { failure = 'Timed out before real transcript and usable editor'; }
    const result = await page.evaluate(() => ({ ...window.__coldOpen, paints: performance.getEntriesByType('paint').map(e => ({ name: e.name, at: e.startTime })), marks: performance.getEntriesByType('mark').filter(e => e.name.startsWith('hapi:')).map(e => ({ name: e.name, at: e.startTime })), resources: performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname.replace(/\/(sessions|machine)\/[^/]+/g, '/$1/[id]'), at: e.startTime, ms: e.duration, bytes: e.transferSize, encodedBytes: e.encodedBodySize, decodedBytes: e.decodedBodySize, responseStart: e.responseStart, responseEnd: e.responseEnd, protocol: e.nextHopProtocol })), nodes: document.querySelectorAll('*').length, views: [...document.querySelectorAll('[data-hapi-session-view]')].map(e => ({ visible: !!e.getBoundingClientRect().width, rows: e.querySelectorAll('[data-chat-node-key]').length })) }));
    page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed);
    if (process.env.HAPI_DSH_PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      // CPU profiles contain script paths, not request credentials or message bodies.
      await writeFile(`${root}/hapi-cold-${i}.cpuprofile`, JSON.stringify(profile), { mode: 0o600 });
    }
    report.runs.push({ mode: i ? 'repeat navigation with browser cache' : 'fresh browser navigation', ...result, network, failure });
    console.log(JSON.stringify({ run: i, workspace: result.workspace, body: result.body, editor: result.editor, bytes: result.resources.reduce((sum, r) => sum + r.bytes, 0), failure, longestTasks: result.tasks.sort((a,b) => b.ms-a.ms).slice(0,5) }));
  }
} catch (e) { report.failure = e.name; process.exitCode = 1; }
finally {
  report.errors = errors;
  report.transport = transport;
  report.blockedWrites = Object.fromEntries(blockedWrites);
  report.hostLoad = { availableCpus: availableParallelism(), loadAverage: loadavg() };
  const path = `${root}/hapi-cold-open-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(path);
  await browser.close();
}
if (report.runs.some(r => r.failure)) process.exitCode = 1;
