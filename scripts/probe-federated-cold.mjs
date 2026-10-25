// Open one exact existing source through the ordinary DSH client with an
// isolated browser layout. Display-local resolve/lease for the configured
// hub/source are permitted after payload audit; native send/abort/settings/
// rewind/fork and all other client commands are blocked.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { installColdOpeningObserver, coldOpeningIssues } from './cold-opening-observer.mjs';

const numberEnv = (name, fallback, minimum) => {
  if (process.env[name] === undefined || process.env[name] === '') return fallback;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be a finite number >= ${minimum}`);
  return value;
};
const requiredEnv = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for exact-target production acceptance`);
  return value;
};
const expectedTitle = requiredEnv('HAPI_DSH_EXPECTED_TITLE');
const expectedText = requiredEnv('HAPI_DSH_EXPECTED_TEXT');
const expectedView = requiredEnv('HAPI_DSH_EXPECTED_VIEW');
const expectedHub = requiredEnv('HAPI_DSH_EXPECTED_HUB');
const expectedSource = requiredEnv('HAPI_DSH_EXPECTED_SOURCE');
const expectedNavigationText = requiredEnv('HAPI_DSH_EXPECTED_NAVIGATION_TEXT');
const expectedNavigationTurn = Number(requiredEnv('HAPI_DSH_EXPECTED_NAVIGATION_TURN'));
if (!Number.isSafeInteger(expectedNavigationTurn) || expectedNavigationTurn < 1)
  throw new Error('HAPI_DSH_EXPECTED_NAVIGATION_TURN must be a positive integer');
const target = requiredEnv('HAPI_DSH_PROBE_SESSION');
if (!target.startsWith('hapi-remote:')) throw new Error('Set HAPI_DSH_PROBE_SESSION to the exact existing federated session resource ID');
const openingOptions = { paneSelector: '[data-pane-id="probe-pane"]',
  expectedTitle, expectedText, staleText: process.env.HAPI_DSH_STALE_TEXT,
  expectedViewId: expectedView, expectedNavigationText, navigationAction: 'unvisited-target',
  requiresHistory: true, requiresNavigation: 'auto', fullCapabilities: true, requireNavigationAction: true,
  observeAfterReadyMs: numberEnv('HAPI_DSH_OBSERVE_MS', 30000, 30000),
  failureDeadlineMs: numberEnv('HAPI_DSH_FAILURE_DEADLINE_MS', 60000, 60000),
  checkpointsMs: [6000, 20000] };

const output = process.env.HAPI_DSH_TEST_ROOT ?? '/mnt/cache/data-cache/hapi-dsh-federated-cold';
const runRoot = `${output}/federated-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
await mkdir(runRoot, { recursive: true });
const latency = Number(process.env.HAPI_DSH_LATENCY_MS ?? 0);
const mbps = Number(process.env.HAPI_DSH_DOWNLOAD_MBPS ?? 0);
const runs = Number(process.env.HAPI_DSH_PROBE_RUNS ?? 2);
const measureMemory = process.env.HAPI_DSH_PROBE_MEMORY === '1';
const reads = new Set([
  'settings/describe', 'session/modelCatalog', 'session/list', 'session/page', 'session/projections',
  'credentials/describe', 'dynamicCordisRunner/inventory', 'cotTranslation/limits', 'agentPresets/list',
  'permissionPresets/catalog', 'hapi/workspaceGet', 'hapi/catalog', 'hapi/sourceAdministration',
  'hapi/sourceReadStates', 'hapi/sourceQueuedEdits', 'hapi/nativeSettings', 'hapi/sourceSummarySettings',
  'hapi/sourceReadingAnchor', 'hapi/sourceLocateMessage',
  'hapi/nativePlan', 'commands/list', 'skills/list',
  'llm/listProviders', 'llm/listConfigurableProviders',
]);
// In pinned rc.3, session/control only yields projection baselines and updates;
// it accepts no client items or commands. Include it to measure normal startup.
const streamReads = new Set(['session/follow', 'session/control', 'workspace/follow', '$events']);
const state = { schemaVersion: 1, revision: 0, windows: [{ id: 'probe-window', name: 'W1', autoName: true,
  root: { type: 'pane', id: 'probe-pane', resource: { kind: 'chat', sessionId: target } } }],
activeWindowId: 'probe-window', focused: { 'probe-window': 'probe-pane' }, zoomed: {} };
const report = { environment: 'Desktop Chromium, exact existing source, isolated local layout; display-local resolve/lease payload-audited; native commands blocked; CDP shapes HTTP only',
  latency, downloadMbps: mbps, allowedStreams: [...streamReads], runs: [], blocked: {}, sockets: {}, errors: [] };
const increment = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const displayRpcRequest = body => body?.payload?.args?.request ?? body?.payload?.request ?? body?.request ?? body;
const allowedDisplayRpc = (path, body) => {
  const method = path.replace(/^\/api\/hapi\//, '');
  const request = displayRpcRequest(body);
  if (!request || typeof request !== 'object' || request.hubId !== expectedHub
    || request.sourceSessionId !== expectedSource) return false;
  if (method === 'sourceSessionResolve')
    return Object.keys(request).every(key => key === 'hubId' || key === 'sourceSessionId');
  if (method === 'sourceDisplayLease')
    return ['acquire', 'renew', 'release'].includes(request.action)
      && Object.keys(request).every(key => ['hubId', 'sourceSessionId', 'leaseId', 'action', 'ttlMs'].includes(key));
  return false;
};
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
    const displayEndpoint = String(frame?.endpoint ?? '').replace(/^\//, '');
    if (mux && /^hapi\/(sourceSessionResolve|sourceDisplayLease)$/.test(displayEndpoint)) {
      const request = frame?.request ?? frame?.payload?.args?.request ?? frame?.payload?.request ?? frame?.payload;
      if (allowedDisplayRpc(`/api/${displayEndpoint}`, { payload: { args: { request } } })) {
        upstream.send(message); return;
      }
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
    const displayPath = path.replace(/^\/api/, '');
    if (method === 'hapi/workspaceGet') {
      const requestBody = JSON.parse(request.postData ?? '{}');
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ type: 'server-response', rpcId: requestBody.rpcId,
          result: { ok: true, value: { revision: 0, state } } })).toString('base64') });
    } else if (displayPath === '/hapi/sourceSessionResolve' || displayPath === '/hapi/sourceDisplayLease') {
      let body;
      try { body = JSON.parse(request.postData() ?? '{}'); } catch { body = undefined; }
      if (allowedDisplayRpc(`/api${displayPath}`, body)) await cdp.send('Fetch.continueRequest', { requestId });
      else {
        increment(report.blocked, `payload-audit ${displayPath}`);
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    } else if (reads.has(method)) await cdp.send('Fetch.continueRequest', { requestId });
    else {
      increment(report.blocked, `HTTP ${path.replace(/\/(sessions|machine)\/[^/]+/g, '/$1/[id]')}`);
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  } catch { /* Browser shutdown may cancel intercepted requests. */ }
});
page.on('pageerror', error => report.errors.push(error.name));

async function resolveDisplayView(origin, cookie) {
  const request = { hubId: expectedHub, sourceSessionId: expectedSource };
  const response = await page.request.post(`${origin}/api/hapi/sourceSessionResolve`, {
    data: { type: 'client-request', rpcId: `probe-resolve-${randomUUID()}`, method: 'hapi/sourceSessionResolve',
      payload: { args: { request } } },
    ...(cookie ? { headers: { cookie } } : {}),
  });
  if (!response.ok()) throw new Error(`Display resolver HTTP ${response.status()}`);
  const wire = await response.json();
  const value = wire?.result?.ok ? wire.result.value : undefined;
  if (!value || value.hubId !== expectedHub || value.sourceSessionId !== expectedSource
    || typeof value.sessionId !== 'string' || value.sessionId.length === 0)
    throw new Error('Display resolver did not return the exact source view');
  return value.sessionId;
}

async function safeDraftAction(pane, run) {
  const evidence = { accepted: false, retained: false, cleared: false, markerMatched: false, editorStable: false,
    cleanupVerified: false, failure: null };
  const editor = pane.locator('[data-composer-input][contenteditable="true"]:visible');
  if (await editor.count() !== 1) { evidence.failure = 'No unique usable official editor'; return evidence; }
  const handle = await editor.elementHandle();
  if (!handle) { evidence.failure = 'Could not hold editor ElementHandle'; return evidence; }
  const before = await handle.evaluate(node => ({ text: node.textContent ?? '', connected: node.isConnected }));
  if (before.text.length > 0) { evidence.failure = 'Existing nonempty draft; no write or cleanup performed'; return evidence; }
  if (!before.connected) { evidence.failure = 'Editor disconnected before typing'; return evidence; }
  const revision = await page.evaluate(() => window.__hapiColdOpening.current?.editorRevision ?? 0);
  await editor.click();
  if (!await handle.evaluate(node => document.activeElement === node || node.contains(document.activeElement))) {
    evidence.failure = 'Editor did not receive trusted focus'; return evidence;
  }
  const marker = `probe-marker-${run}-${Date.now()}`;
  await page.keyboard.type(marker, { delay: 8 });
  await page.waitForTimeout(700);
  const after = await handle.evaluate(node => ({ text: node.textContent ?? '', connected: node.isConnected,
    focused: document.activeElement === node || node.contains(document.activeElement) }));
  const stateAfter = await page.evaluate(() => ({ revision: window.__hapiColdOpening.current?.editorRevision ?? 0,
    focused: window.__hapiColdOpening.current?.editorFocused ?? false }));
  evidence.markerMatched = after.text === marker;
  evidence.editorStable = after.connected && after.focused && stateAfter.revision === revision && stateAfter.focused;
  evidence.retained = evidence.markerMatched && evidence.editorStable;
  if (!evidence.markerMatched || !evidence.editorStable) {
    evidence.failure = evidence.markerMatched ? 'Editor identity/focus changed while typing'
      : 'Typed marker was not exactly retained; cleanup skipped';
    return evidence;
  }
  const immediately = await handle.evaluate(node => ({ text: node.textContent ?? '', connected: node.isConnected,
    focused: document.activeElement === node || node.contains(document.activeElement) }));
  if (immediately.text !== marker || !immediately.connected || !immediately.focused) {
    evidence.markerMatched = false; evidence.retained = false;
    evidence.failure = 'Marker changed before safe cleanup; no Backspace sent'; return evidence;
  }
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(120);
  const final = await handle.evaluate(node => ({ text: node.textContent ?? '', connected: node.isConnected,
    focused: document.activeElement === node || node.contains(document.activeElement) }));
  const finalState = await page.evaluate(() => window.__hapiColdOpening.current?.editorRevision ?? 0);
  evidence.cleanupVerified = final.text === '' && final.connected && final.focused && finalState === revision;
  evidence.cleared = evidence.cleanupVerified;
  if (!evidence.cleanupVerified) evidence.failure = 'Cleanup failed to restore the same empty editor';
  return evidence;
}

async function findTurnRail(pane) {
  const named = pane.locator('nav[aria-label="Turn navigation"], nav[aria-label="轮次导航"]').first();
  if (await named.count() && await named.isVisible()) return named;
  const navs = pane.locator('nav[aria-label]');
  const count = await navs.count();
  for (let index = 0; index < count; index++) {
    if (!await navs.nth(index).isVisible()) continue;
    const labels = await navs.nth(index).locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? ''));
    if (labels.some(label => /jump to turn|load and jump|跳转到第|加载并跳转/i.test(label))) return navs.nth(index);
  }
  return undefined;
}

async function runOpeningActions() {
  const evidence = { draft: null, history: null, navigation: null, errors: [] };
  const pane = page.locator('[data-pane-id="probe-pane"]').first();
  if (!(await pane.count())) { evidence.errors.push('No visible federated pane for reader actions'); return evidence; }
  try { evidence.draft = await safeDraftAction(pane, 0); }
  catch (error) { evidence.draft = { failure: `Draft action: ${error.name}` }; }
  if (evidence.draft.failure) evidence.errors.push(`Draft action: ${evidence.draft.failure}`);
  const port = pane.locator('[data-conversation-scroll]').first();
  try {
    if (await port.count()) {
      const baseline = await page.evaluate(() => ({ at: performance.now(),
        intents: window.__hapiColdOpening.history?.intents ?? 0,
        requests: window.__hapiColdOpening.history?.requestRevision ?? 0,
        commits: window.__hapiColdOpening.history?.commitRevision ?? 0 }));
      const box = await port.boundingBox();
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4);
      for (let step = 0; step < 60; step++) {
        await page.mouse.wheel(0, -600);
        if (await port.evaluate(element => element.scrollTop) <= 1) break;
        await page.waitForTimeout(16);
      }
      await page.mouse.wheel(0, -140);
      try {
        await page.waitForFunction(base => {
          const h = window.__hapiColdOpening.history;
          return (h?.intents ?? 0) > base.intents && (h?.requestRevision ?? 0) > base.requests
            && (h?.commitRevision ?? 0) > base.commits;
        }, baseline, { timeout: 15000 });
      } catch { evidence.errors.push('History action: no source request plus source commit after the baseline'); }
      evidence.history = await page.evaluate(base => {
        const h = window.__hapiColdOpening.history;
        return { intents: h?.intents ?? 0, requests: h?.requestRevision ?? 0, commits: h?.commitRevision ?? 0,
          requestAt: h?.requestAt ?? null, commitAt: h?.commitAt ?? null,
          anchorRetained: h?.anchorRetained ?? null, anchorDriftPx: h?.anchorDriftPx ?? null };
      }, baseline);
      evidence.history.requested = evidence.history.requests > baseline.requests
        && evidence.history.requestAt >= baseline.at - 100;
      evidence.history.committed = evidence.history.commits > baseline.commits;
      evidence.history.commitAfterRequest = evidence.history.requested && evidence.history.committed
        && evidence.history.commitAt >= evidence.history.requestAt - 50;
      if (!evidence.history.requested) evidence.errors.push('History action: no source page request');
      if (!evidence.history.committed) evidence.errors.push('History action: no source page commit');
      if (!evidence.history.commitAfterRequest) evidence.errors.push('History action: commit did not follow request');
    } else evidence.errors.push('No conversation scrollport for the history action');
  } catch (error) { evidence.errors.push(`History action: ${error.name}`); }
  try {
    const rail = await findTurnRail(pane);
    if (!rail || !await rail.count() || !await rail.isVisible()) evidence.errors.push('Navigation action: no visible official rail');
    else {
      const buttons = rail.locator('button');
      const labels = await buttons.evaluateAll(nodes => nodes.map((node, index) => ({
        index, label: node.getAttribute('aria-label') ?? '', current: node.getAttribute('aria-current') === 'true',
        disabled: node.disabled,
        turn: Number(/(?:turn|第)\s*(\d+)/i.exec(node.getAttribute('aria-label') ?? '')?.[1] ?? Number.NaN),
      })));
      const eligible = labels.filter(row => row.turn === expectedNavigationTurn);
      const selected = eligible.find(row => !row.disabled && /load and jump|加载并跳转/.test(row.label))
        ?? eligible.find(row => !row.disabled && !row.current && /jump to turn|跳转到第/.test(row.label));
      if (!selected) evidence.errors.push('Navigation action: exact target turn not present in rail');
      else if (await pane.getByText(expectedNavigationText, { exact: true }).isVisible().catch(() => false))
        evidence.errors.push('Navigation action: target already visible');
      else {
        const baseline = await page.evaluate(() => window.__hapiColdOpening.navigation?.commitRevision ?? 0);
        await buttons.nth(selected.index).click();
        try {
          await page.waitForFunction(base => {
            const n = window.__hapiColdOpening.navigation;
            return (n?.commitRevision ?? 0) > base && n?.targetVisible === true;
          }, baseline, { timeout: 12000 });
        } catch { evidence.errors.push('Navigation action: exact target did not commit'); }
        evidence.navigation = await page.evaluate(() => ({
          intents: window.__hapiColdOpening.navigation?.intents ?? 0,
          targetIntents: window.__hapiColdOpening.navigation?.targetIntents ?? 0,
          commits: window.__hapiColdOpening.navigation?.commitRevision ?? 0,
          kind: window.__hapiColdOpening.navigation?.clickedKind ?? null,
          targetVisible: window.__hapiColdOpening.navigation?.targetVisible ?? null }));
      }
    }
  } catch (error) { evidence.errors.push(`Navigation action: ${error.name}`); }
  return evidence;
}

try {
  const launch = new URL((await readFile(process.env.HAPI_DSH_LAUNCH_FILE ?? '/home/chris/.config/hapi-dsh/launch-url', 'utf8')).trim());
  const auth = await page.request.get(launch.href, { maxRedirects: 0 });
  if (auth.status() !== 303) throw new Error('Admission failed');
  const admissionCookies = await context.cookies(launch.origin).catch(() => []);
  const admissionCookie = admissionCookies.length
    ? admissionCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    : auth.headers()['set-cookie']?.split(';')[0];
  const resolvedView = await resolveDisplayView(launch.origin, admissionCookie);
  openingOptions.expectedViewId = resolvedView;
  report.target = { resolved: true, viewReselected: resolvedView !== expectedView };
  await page.addInitScript(state => {
    performance.setResourceTimingBufferSize(5000);
    localStorage.setItem(`hapi-dsh:workspace:v1:${location.origin}${location.pathname}`, JSON.stringify(state));
  }, state);
  await page.addInitScript(installColdOpeningObserver, openingOptions);
  for (let i = 0; i < runs; i++) {
    await page.goto(launch.origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
    let failure, actions;
    try {
      const notice = page.getByRole('dialog', { name: /^(Preview Notice|预览版说明)$/ });
      if (await notice.count()) await notice.getByRole('button', { name: /^(Continue|继续)$/ }).click();
      await page.waitForFunction(() => {
        const probe = window.__hapiColdOpening;
        return probe?.verifiedFreshness ? probe.current?.ready && probe.current.stableForMs >= probe.stableMs
          : probe?.first.body && probe?.first.editor && probe?.first.title;
      }, null, { timeout: 90000 });
      actions = await runOpeningActions();
      try {
        await page.waitForFunction(() => window.__hapiColdOpening.observation.complete, null,
          { timeout: openingOptions.failureDeadlineMs + 10000 });
      } catch { failure = 'Observation did not complete within the diagnostic deadline'; }
    } catch { failure = 'Latest source body, usable editor and title did not stabilize within 90 seconds'; }
    await page.evaluate(() => window.__hapiColdOpening.stop());
    const result = await page.evaluate(() => ({ ...window.__hapiColdOpening, workspace: window.__hapiColdOpening.first.workspace,
      title: window.__hapiColdOpening.first.title, body: window.__hapiColdOpening.first.body,
      editor: window.__hapiColdOpening.first.editor, latest: window.__hapiColdOpening.first.latest, stable: window.__hapiColdOpening.first.stable,
      marks: performance.getEntriesByType('mark').filter(e => e.name.startsWith('hapi:')).map(e => ({ name: e.name, at: e.startTime })),
      resources: performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname.replace(/\/(sessions|machine)\/[^/]+/g, '/$1/[id]'),
        at: e.startTime, ms: e.duration, bytes: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize, responseStart: e.responseStart })),
    }));
    if (actions) result.actions = actions;
    const openingFailures = coldOpeningIssues(result);
    if (openingFailures.length) failure = [failure, ...openingFailures].filter(Boolean).join('; ');
    if (actions?.errors?.length) failure = [failure, ...actions.errors].filter(Boolean).join('; ');
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
    console.log(JSON.stringify({ run: i, body: result.body, editor: result.editor, title: result.title, latest: result.latest, stable: result.stable,
      bytes: result.resources.reduce((sum, r) => sum + r.bytes, 0), failure, memory,
      largest: [...result.resources].sort((a,b) => b.bytes-a.bytes).slice(0, 5),
      longestTasks: [...result.tasks].sort((a,b) => b.ms-a.ms).slice(0, 5) }));
  }
} catch (error) { report.failure = error.name; process.exitCode = 1; }
finally {
  await writeFile(`${runRoot}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  await browser.close();
}
if (report.runs.some(r => r.failure)) process.exitCode = 1;
