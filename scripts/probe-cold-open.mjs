// Read-only production navigation probe. Credentials stay in the browser context.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { availableParallelism, loadavg } from 'node:os';
import { probeTouch } from './probe-touch.mjs';
import { installColdOpeningObserver, coldOpeningIssues } from './cold-opening-observer.mjs';
const openingOptions = { expectedTitle: process.env.HAPI_DSH_EXPECTED_TITLE, expectedText: process.env.HAPI_DSH_EXPECTED_TEXT,
  staleText: process.env.HAPI_DSH_STALE_TEXT, paneSelector: process.env.HAPI_DSH_PROBE_PANE_SELECTOR };
const observeMs = Number(process.env.HAPI_DSH_OBSERVE_MS ?? 5000);
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
  '/api/settings/describe',
  '/api/session/modelCatalog', '/api/session/list', '/api/session/page', '/api/session/projections',
  '/api/credentials/describe', '/api/dynamicCordisRunner/inventory', '/api/cotTranslation/limits', '/api/agentPresets/list',
  '/api/permissionPresets/catalog', '/api/hapi/workspaceGet', '/api/hapi/catalog',
  '/api/hapi/sourceNotificationSettings', '/api/hapi/sourceAdministration', '/api/hapi/sourceReadStates',
  '/api/hapi/sourceQueuedEdits', '/api/hapi/nativeSettings', '/api/hapi/sourceSummarySettings',
  '/api/hapi/sourceReadingAnchor',
  '/api/hapi/nativePlan', '/api/commands/list', '/api/skills/list',
  '/api/llm/listProviders', '/api/llm/listConfigurableProviders',
]);
const blockedWrites = new Map();
// rc.3 session/control is a read-only projection stream. Client item frames
// remain forbidden, including on an admitted stream. Resolving an unattached
// source or synchronizing a manifest is a mutation and is never a probe setup.
const streamReads = new Set(['session/follow', 'session/control', 'workspace/follow', '$events']);
const openedStreams = new Map();
await page.routeWebSocket(() => true, route => {
  const url = new URL(route.url());
  const path = url.pathname === '/hapi-dsh/socket'
    ? new URL(url.searchParams.get('path') ?? '/', url.origin).pathname : url.pathname;
  const mux = path === '/api/remote.mux' || path === '/hapi-dsh/remote.mux';
  if (!mux && path !== '/hapi-dsh/plugin-events') {
    blockedWrites.set('WS unlisted socket', (blockedWrites.get('WS unlisted socket') ?? 0) + 1);
    void route.close(); return;
  }
  const upstream = route.connectToServer();
  const active = new Set();
  route.onMessage(message => {
    let frame;
    try { if (typeof message === 'string') frame = JSON.parse(message); } catch {}
    if (mux && typeof frame?.streamId === 'string') {
      if (frame.type === 'open' && streamReads.has(frame.endpoint)) {
        active.add(frame.streamId);
        openedStreams.set(frame.endpoint, (openedStreams.get(frame.endpoint) ?? 0) + 1);
        upstream.send(message); return;
      }
      if (['cancel', 'end'].includes(frame.type) && active.delete(frame.streamId)) {
        upstream.send(message); return;
      }
    }
    const key = `WS ${typeof frame?.endpoint === 'string' ? frame.endpoint : 'client-message'}`;
    blockedWrites.set(key, (blockedWrites.get(key) ?? 0) + 1);
    if (typeof frame?.streamId === 'string') route.send(JSON.stringify({ type: 'error', streamId: frame.streamId,
      error: { code: 'probe/read-only', message: 'Blocked by read-only probe', details: {} } }));
  });
});
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
const report = { environment: 'Chromium mobile emulation; production read-only HTTP and WebSocket admission; CDP HTTP network shaping (not a physical remote network or WebSocket latency guarantee)',
  networkConditions, cpuRate: Number(process.env.HAPI_DSH_CPU_RATE ?? 1), allowedStreams: [...streamReads], runs: [] };
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
    let kind = 'binary', snapshotSizes;
    if (typeof payload === 'string') { try {
      const frame = JSON.parse(payload); kind = [frame.type, frame.value?.type].filter(value => typeof value === 'string').join('/');
      if (frame.value?.type === 'snapshot') {
        const value = frame.value, size = value => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
        // Log only known schema names and aggregate byte counts. Plugin event
        // names use a colon, so grouping only slash-prefixed core events hid
        // repeated source projection values in the former "other" bucket.
        const pluginKinds = new Set([
          'plugin:hapi-dsh/state', 'plugin:hapi-dsh/status', 'plugin:hapi-dsh/notices', 'plugin:hapi-dsh/native-item',
          'plugin:hapi-dsh/session-state', 'plugin:hapi-dsh/execution',
          'plugin:hapi-dsh-observed/state', 'plugin:hapi-dsh-observed/status', 'plugin:hapi-dsh-observed/notices',
          'plugin:hapi-dsh-observed/item', 'plugin:hapi-dsh/tool-progress', 'plugin:hapi-dsh/codex-review',
        ]);
        const fieldNames = ['execution', 'pendingRequests', 'resolvedRequests', 'delivery', 'sidechains', 'sidechain',
          'dshChild', 'team', 'notices', 'usage', 'threadGoal', 'error', 'readOnly', 'readOnlyReason',
          'nativeConnection', 'active', 'thinking', 'model', 'reasoningEffort', 'effort', 'permissionMode', 'serviceTier'];
        const recordKinds = {}, pluginRecords = {}, previousData = new Map();
        for (const record of value.records ?? []) {
          const type = record.event?.type;
          const group = typeof type === 'string' && type.startsWith('plugin:') ? 'plugin'
            : typeof type === 'string' && /^(user|assistant|tool|step|turn)\//.test(type) ? type.split('/')[0] : 'other';
          const row = recordKinds[group] ??= { count: 0, bytes: 0 }; row.count++; row.bytes += size(record);
          if (group === 'plugin') {
            const knownType = pluginKinds.has(type) ? type : 'other-plugin';
            const entry = pluginRecords[knownType] ??= { count: 0, bytes: 0, fields: {} };
            entry.count++; entry.bytes += size(record);
            if (knownType !== 'other-plugin' && /\/(state|status|session-state)$/.test(knownType)) {
              const data = record.event.data, previous = previousData.get(knownType);
              if (data && typeof data === 'object') for (const field of fieldNames) {
                if (!Object.hasOwn(data, field)) continue;
                const current = JSON.stringify(data[field]);
                const stats = entry.fields[field] ??= { count: 0, bytes: 0, changes: 0 };
                stats.count++; stats.bytes += size(data[field]);
                if (!previous || previous[field] !== current) stats.changes++;
              }
              if (data && typeof data === 'object') previousData.set(knownType,
                Object.fromEntries(fieldNames.filter(field => Object.hasOwn(data, field)).map(field => [field, JSON.stringify(data[field])])));
            }
          }
        }
        snapshotSizes = { records: size(value.records), projections: size(value.projections), assistantStream: size(value.assistantStream),
          recordCount: value.records?.length ?? 0, largestRecord: Math.max(0, ...(value.records ?? []).map(size)), recordKinds, pluginRecords };
      }
    } catch { kind = 'text'; } }
    transport.frames.push({ run: runIndex, at: performance.now() - runStarted, kind, decodedBytes: bytes, ...(snapshotSizes ? { snapshotSizes } : {}) });
  }
}); socket.on('socketerror', () => transport.errors++); });
page.on('pageerror', e => errors.push(e.name));
await page.addInitScript(installColdOpeningObserver, openingOptions);

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
    try {
      await page.waitForFunction(() => {
        const probe = window.__hapiColdOpening;
        return probe?.verifiedFreshness ? probe.current?.ready && probe.current.stableForMs >= probe.stableMs
          : probe?.first.body && probe?.first.editor && probe?.first.title;
      }, null, { timeout: 90000 });
      // Do not stop at first success: late metadata/history can regress again.
      await page.waitForTimeout(observeMs);
    } catch { failure = 'Timed out before the latest source body, title and usable editor stabilized'; }
    await page.evaluate(() => window.__hapiColdOpening.stop());
    const result = await page.evaluate(() => ({ ...window.__hapiColdOpening, workspace: window.__hapiColdOpening.first.workspace,
      body: window.__hapiColdOpening.first.body, editor: window.__hapiColdOpening.first.editor,
      latest: window.__hapiColdOpening.first.latest, stable: window.__hapiColdOpening.first.stable, paints: performance.getEntriesByType('paint').map(e => ({ name: e.name, at: e.startTime })), marks: performance.getEntriesByType('mark').filter(e => e.name.startsWith('hapi:')).map(e => ({ name: e.name, at: e.startTime })), resources: performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname.replace(/\/(sessions|machine)\/[^/]+/g, '/$1/[id]'), at: e.startTime, ms: e.duration, bytes: e.transferSize, encodedBytes: e.encodedBodySize, decodedBytes: e.decodedBodySize, responseStart: e.responseStart, responseEnd: e.responseEnd, protocol: e.nextHopProtocol })), nodes: document.querySelectorAll('*').length, views: [...document.querySelectorAll('[data-hapi-session-view]')].map(e => ({ visible: !!e.getBoundingClientRect().width, rows: e.querySelectorAll('[data-chat-node-key]').length })) }));
    const openingFailures = coldOpeningIssues(result);
    if (openingFailures.length) failure = [failure, ...openingFailures].filter(Boolean).join('; ');
    page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed);
    if (process.env.HAPI_DSH_PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      // CPU profiles contain script paths, not request credentials or message bodies.
      await writeFile(`${root}/hapi-cold-${i}.cpuprofile`, JSON.stringify(profile), { mode: 0o600 });
    }
    report.runs.push({ mode: i ? 'repeat navigation with browser cache' : 'fresh browser navigation', ...result, network, failure });
    console.log(JSON.stringify({ run: i, workspace: result.workspace, body: result.body, editor: result.editor, latest: result.latest, stable: result.stable, bytes: result.resources.reduce((sum, r) => sum + r.bytes, 0), failure, longestTasks: result.tasks.sort((a,b) => b.ms-a.ms).slice(0,5) }));
    if (process.env.HAPI_DSH_TOUCH_PROBE && i === 0 && !failure) {
      if (process.env.HAPI_DSH_PROFILE) await cdp.send('Profiler.start');
      report.touch = await probeTouch(page, cdp);
      report.touch.tasks = await page.evaluate(() => window.__hapiColdOpening.tasks);
      if (process.env.HAPI_DSH_PROFILE) {
        const { profile } = await cdp.send('Profiler.stop');
        await writeFile(`${root}/hapi-touch.cpuprofile`, JSON.stringify(profile), { mode: 0o600 });
      }
      console.log(JSON.stringify({ touch: report.touch.runs.map(({ direction, metrics }) => ({ direction, metrics })) }));
    }
  }
} catch (e) { report.failure = e.name; process.exitCode = 1; }
finally {
  report.errors = errors;
  report.transport = transport;
  report.openedStreams = Object.fromEntries(openedStreams);
  report.blockedWrites = Object.fromEntries(blockedWrites);
  report.hostLoad = { availableCpus: availableParallelism(), loadAverage: loadavg() };
  const path = `${root}/hapi-cold-open-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(path);
  await browser.close();
}
if (report.runs.some(r => r.failure)) process.exitCode = 1;
