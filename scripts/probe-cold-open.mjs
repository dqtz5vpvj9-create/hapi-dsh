// Read-only production navigation probe. Credentials stay in the browser context.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { availableParallelism, loadavg } from 'node:os';
import { probeTouch } from './probe-touch.mjs';
import { installColdOpeningObserver, coldOpeningIssues } from './cold-opening-observer.mjs';
import { allowedDisplayRpc as auditDisplayRpc, parseCdpRpcBody } from './probe-display-rpc.mjs';
import { exerciseOpeningUnvisitedTarget, textInConversationViewport } from './probe-navigation.mjs';
import { selectSourceNavigationTarget, sourceNavigationText, sourceOpeningTarget } from './probe-navigation-target.mjs';
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
const sourceOpeningProof = process.env.HAPI_DSH_EXPECTED_SOURCE_TARGET
  ? JSON.parse(process.env.HAPI_DSH_EXPECTED_SOURCE_TARGET) : undefined;
const expectedSourceTarget = sourceOpeningProof?.marker ?? sourceOpeningProof;
const expectedText = expectedSourceTarget?.kind === 'tool-result' ? undefined : requiredEnv('HAPI_DSH_EXPECTED_TEXT');
const expectedView = requiredEnv('HAPI_DSH_EXPECTED_VIEW');
const expectedHub = requiredEnv('HAPI_DSH_EXPECTED_HUB');
const expectedSource = requiredEnv('HAPI_DSH_EXPECTED_SOURCE');
const probeWidth = numberEnv('HAPI_DSH_PROBE_WIDTH', 390, 1);
const mobile = probeWidth < 900;
const viewport = { width: probeWidth, height: mobile ? 844 : 900 };
// Product acceptance is always full and never stops five seconds after first
// success. The mobile action is explicitly return-latest; old-content proof is
// the trusted touch history action.
const openingOptions = {
  expectedTitle, expectedText, expectedSourceTarget, staleText: process.env.HAPI_DSH_STALE_TEXT,
  expectedViewId: expectedView,
  ...(mobile ? { expectedNavigationTarget: expectedSourceTarget ?? { kind: 'text', text: expectedText } } : {}),
  navigationAction: mobile ? 'return-latest' : 'unvisited-target',
  paneSelector: process.env.HAPI_DSH_PROBE_PANE_SELECTOR,
  requiresHistory: true, requiresNavigation: 'auto', fullCapabilities: true, requireNavigationAction: true,
  observeAfterReadyMs: numberEnv('HAPI_DSH_OBSERVE_MS', 30000, 30000),
  failureDeadlineMs: numberEnv('HAPI_DSH_FAILURE_DEADLINE_MS', 60000, 60000),
  checkpointsMs: [6000, 20000],
};
const allowedDisplayRpc = (path, body) => auditDisplayRpc(path, body, expectedHub, expectedSource);
const root = process.env.HAPI_DSH_TEST_ROOT ?? '/mnt/cache/data-cache';
const runRoot = `${root}/hapi-cold-open-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
await mkdir(runRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN' });
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
  '/api/hapi/sourceReadingAnchor', '/api/hapi/sourceLocateMessage',
  '/api/hapi/sourceHistoryOutline', '/api/hapi/sourceHistoryWindowPage',
  '/api/hapi/nativePlan', '/api/commands/list', '/api/skills/list',
  '/api/llm/listProviders', '/api/llm/listConfigurableProviders',
]);
const blockedWrites = new Map();
// rc.3 session/control is a read-only projection stream. Display-local source
// resolve/lease for the exact configured hub/source are user-permitted display
// operations and may proceed after payload audit; native send/abort/settings/
// rewind/fork and all other client item frames remain blocked.
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
    const displayEndpoint = String(frame?.endpoint ?? '').replace(/^\//, '');
    if (mux && /^hapi\/(sourceSessionResolve|sourceDisplayLease)$/.test(displayEndpoint)) {
      const request = frame?.request ?? frame?.payload?.args?.request ?? frame?.payload?.request ?? frame?.payload;
      if (allowedDisplayRpc(`/api/${displayEndpoint}`, { payload: { args: { request } } })) {
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
    const displayPath = rpcPath.replace(/^\/api/, '');
    if (displayPath === '/hapi/sourceSessionResolve' || displayPath === '/hapi/sourceDisplayLease') {
      const body = parseCdpRpcBody(request);
      if (allowedDisplayRpc(`/api${displayPath}`, body)) {
        await cdp.send('Fetch.continueRequest', { requestId });
      } else {
        blockedWrites.set(`payload-audit ${displayPath}`, (blockedWrites.get(`payload-audit ${displayPath}`) ?? 0) + 1);
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    } else if (request.method === 'GET' || request.method === 'HEAD' || readRpcs.has(rpcPath)) {
      await cdp.send('Fetch.continueRequest', { requestId });
    } else {
      const safePath = path.replace(/\/(sessions|machine)\/[^/]+/g, '/$1/[id]');
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
const report = { environment: `Chromium ${mobile ? 'mobile emulation' : 'desktop'}; read-only source admission plus payload-audited display-local resolve/lease; native commands blocked; CDP HTTP network shaping (not a physical remote network or WebSocket latency guarantee)`,
  viewport, historyGesture: mobile ? 'touch' : 'wheel', desktopMinimapExercised: false,
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
page.on('console', message => {
  // The official feed catches assembler exceptions instead of raising a
  // pageerror. Retain only the error category, never its source text or stack.
  if (message.text().includes('event feed subscriber failed')) errors.push('SessionEventFeedSubscriberError');
});

const activePane = () => page.locator(process.env.HAPI_DSH_PROBE_PANE_SELECTOR ?? '.hapi-pane-focused:visible, .hapi-pane:visible');
async function touchSwipe(port, direction) {
  const box = await port.boundingBox();
  if (!box) throw new Error('No conversation scrollport');
  const x = box.x + box.width * 0.55;
  const start = box.y + box.height * (direction === 'older' ? 0.25 : 0.75);
  const end = box.y + box.height * (direction === 'older' ? 0.75 : 0.25);
  const points = y => [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(start + (end - start) * step / 8) });
    await page.waitForTimeout(18);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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
  const state = await page.evaluate(() => ({ revision: window.__hapiColdOpening.current?.editorRevision ?? 0,
    focused: window.__hapiColdOpening.current?.editorFocused ?? false }));
  evidence.markerMatched = after.text === marker;
  evidence.editorStable = after.connected && after.focused && state.revision === revision && state.focused;
  evidence.accepted = evidence.markerMatched && evidence.editorStable;
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

async function runOpeningActions(run, readSource) {
  const evidence = { draft: null, history: null, navigation: null, returnLatest: null, errors: [] };
  const pane = activePane();
  if (await pane.count() !== 1) { evidence.errors.push('No unique exact pane for opening actions'); return evidence; }
  if (!(await pane.count())) { evidence.errors.push('No visible pane for reader actions'); return evidence; }
  try { evidence.draft = await safeDraftAction(pane, run); }
  catch (error) { evidence.draft = { failure: `Draft action: ${error.name}` }; }
  if (evidence.draft.failure) evidence.errors.push(`Draft action: ${evidence.draft.failure}`);
  const port = pane.locator('[data-conversation-scroll]').first();
  try {
    if (await port.count()) {
      const baseline = await page.evaluate(() => ({ at: performance.now(),
        intents: window.__hapiColdOpening.history?.intents ?? 0,
        requests: window.__hapiColdOpening.history?.requestRevision ?? 0,
        commits: window.__hapiColdOpening.history?.commitRevision ?? 0,
        operationId: window.__hapiColdOpening.history?.operationRevision ?? 0 }));
      if (mobile) {
        for (let gesture = 0; gesture < 48; gesture++) {
          await touchSwipe(port, 'older');
          if (await port.evaluate(element => element.scrollTop) <= 1) break;
          await page.waitForTimeout(80);
        }
        await touchSwipe(port, 'older');
      } else {
        const box = await port.boundingBox();
        if (!box) throw new Error('No conversation scrollport');
        await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4);
        for (let gesture = 0; gesture < 60; gesture++) {
          await page.mouse.wheel(0, -600);
          if (await port.evaluate(element => element.scrollTop) <= 1) break;
          await page.waitForTimeout(16);
        }
        await page.mouse.wheel(0, -140);
      }
      try {
        await page.waitForFunction(base => {
          const h = window.__hapiColdOpening.history;
          const operations = h.operations.filter(operation => operation.id > base.operationId
            && operation.intentAt !== null && operation.requestAt >= base.at);
          return operations.some(operation => operation.status === 'committed')
            && operations.every(operation => operation.status !== 'pending');
        }, baseline, { timeout: 15000 });
      } catch { evidence.errors.push('History action: no source request plus source commit after the baseline'); }
      evidence.history = await page.evaluate(base => {
        const h = window.__hapiColdOpening.history;
        const operations = h.operations.filter(operation => operation.id > base.operationId
          && operation.intentAt !== null && operation.requestAt >= base.at);
        const drifts = operations.flatMap(operation => operation.anchorDriftPx === null ? [] : [operation.anchorDriftPx]);
        return { intents: h?.intents ?? 0, requests: h?.requestRevision ?? 0, commits: h?.commitRevision ?? 0,
          operationIds: operations.map(operation => operation.id),
          requested: operations.length > 0,
          committed: operations.length > 0 && operations.every(operation => operation.status === 'committed'),
          commitAfterRequest: operations.length > 0 && operations.every(operation => operation.commitAt !== null
            && operation.commitAt >= operation.requestAt),
          anchorRetained: operations.length > 0 && operations.every(operation => operation.domPrepend && operation.anchorRetained === true),
          anchorDriftPx: drifts.length ? drifts.reduce((worst, drift) => Math.abs(drift) > Math.abs(worst) ? drift : worst) : null };
      }, baseline);
      if (!evidence.history.requested) evidence.errors.push('History action: no source page request');
      if (!evidence.history.committed) evidence.errors.push('History action: no source page commit');
      if (!evidence.history.commitAfterRequest) evidence.errors.push('History action: commit did not follow request');
    } else evidence.errors.push('No conversation scrollport for the history action');
  } catch (error) { evidence.errors.push(`History action: ${error.name}`); }
  if (!mobile) {
    try {
      const firstFullAt = await page.evaluate(() => window.__hapiColdOpening.first.full);
      if (firstFullAt === null) throw new Error('Navigation baseline cannot precede the first full opening');
      const startedAt = await page.evaluate(() => performance.now());
      const outline = await readSource('sourceHistoryOutline');
      const target = selectSourceNavigationTarget(outline);
      const contextPage = await readSource('sourceHistoryWindowPage', { messageId: target.messageId, radius: 1 });
      const text = sourceNavigationText(contextPage.records, target);
      if (!await page.evaluate(text => window.__hapiColdOpening.setNavigationTarget(text), text))
        throw new Error('Navigation target could not be pinned before the action');
      evidence.navigation = { ...await exerciseOpeningUnvisitedTarget(page, pane, text, target.turn),
        provenance: { source: 'exact resolved view outline plus exact source user message',
          firstFullAt, baselineReadStartedAt: startedAt, targetTurn: target.turn,
          contextRecords: contextPage.records.length, textCharacters: text.length,
          cacheEffect: 'one radius-1 target context read after measured opening, before navigation' } };
      if (evidence.navigation.failure) evidence.errors.push(`Navigation action: ${evidence.navigation.failure}`);
    } catch (error) { evidence.errors.push(`Navigation target verification: ${error.name}`); }
  }
  try {
    let returnTarget = expectedSourceTarget ?? expectedText;
    let provenance;
    if (!mobile) {
      const outline = await readSource('sourceHistoryOutline');
      if (outline.complete === false || !outline.head?.messageId) throw new Error('No complete current source head');
      const contextPage = await readSource('sourceHistoryWindowPage', { messageId: outline.head.messageId, radius: 99 });
      const target = sourceOpeningTarget(contextPage.records, outline.head);
      returnTarget = target.marker;
      provenance = { source: 'frozen source text or completed tool at or before the exact head',
        contextRecords: contextPage.records.length, markerKind: target.marker.kind,
        sourceHead: target.sourceHead, visibleItem: { messageId: target.messageId, at: target.at, seq: target.seq },
        targetAtHead: target.targetAtHead, targetEventType: target.eventType,
        cacheEffect: 'one radius-99 head context read after measured opening, before return-latest' };
      if (!await page.evaluate(target => window.__hapiColdOpening.setReturnLatestTarget(target), returnTarget))
        throw new Error('Return-latest target could not be pinned before the action');
    }
    const labels = await pane.locator('button[aria-label]').evaluateAll(nodes => nodes.map((node, index) => ({
      index, label: node.getAttribute('aria-label') ?? '', visible: Boolean(node.getClientRects().length) })));
    const toBottom = labels.find(row => row.visible && /to bottom|回到(?:底部|最新)/i.test(row.label));
    if (!toBottom) evidence.errors.push('Navigation action: no visible return-latest control');
    else if (await page.evaluate(target => window.__hapiColdOpening.sourceTargetVisible(target), returnTarget))
      evidence.errors.push('Navigation action: latest marker already visible; return-latest not exercised');
    else {
      const baseline = await page.evaluate(() => window.__hapiColdOpening.navigation?.commitRevision ?? 0);
      await pane.getByRole('button', { name: toBottom.label, exact: true }).click();
      try {
        await page.waitForFunction(({ base, text }) => {
          const n = window.__hapiColdOpening.navigation;
          return (n?.commitRevision ?? 0) > base && n?.targetVisible === true;
        }, { base: baseline }, { timeout: 12000 });
      } catch { evidence.errors.push('Navigation action: return-latest did not commit'); }
      const returnEvidence = await page.evaluate(() => ({
        intents: window.__hapiColdOpening.navigation?.intents ?? 0,
        returnLatestIntents: window.__hapiColdOpening.navigation?.returnLatestIntents ?? 0,
        commits: window.__hapiColdOpening.navigation?.commitRevision ?? 0,
        kind: window.__hapiColdOpening.navigation?.clickedKind ?? null,
        targetVisible: window.__hapiColdOpening.navigation?.targetVisible ?? null }));
      evidence.returnLatest = { ...returnEvidence, ...(provenance ? { provenance } : {}) };
      if (mobile) evidence.navigation = returnEvidence;
      if (!await page.evaluate(target => window.__hapiColdOpening.sourceTargetVisible(target), returnTarget))
        evidence.errors.push('Navigation action: latest marker did not intersect the conversation viewport');
    }
  } catch (error) { evidence.errors.push(`Navigation action: ${error.name}`); }
  return evidence;
}

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

async function readExactSource(origin, cookie, sessionId, method, details = {}) {
  if (!['sourceHistoryOutline', 'sourceHistoryWindowPage'].includes(method))
    throw new Error('Unsupported read-only navigation baseline method');
  const response = await page.request.post(`${origin}/api/hapi/${method}`, {
    data: { type: 'client-request', rpcId: `probe-navigation-${randomUUID()}`, method: `hapi/${method}`,
      payload: { args: { request: { ...details, sessionId } } } },
    ...(cookie ? { headers: { cookie } } : {}),
  });
  if (!response.ok()) throw new Error('Source navigation baseline HTTP failed');
  const wire = await response.json();
  if (wire?.result?.ok !== true) throw new Error('Source navigation baseline RPC failed');
  return wire.result.value;
}

try {
  const launch = new URL((await readFile(process.env.HAPI_DSH_LAUNCH_FILE ?? '/home/chris/.config/hapi-dsh/launch-url', 'utf8')).trim());
  const auth = await page.request.get(launch.href, { maxRedirects: 0 });
  if (auth.status() !== 303) throw new Error(`Admission HTTP ${auth.status()}`);
  const admissionCookies = await context.cookies(launch.origin).catch(() => []);
  const admissionCookie = admissionCookies.length
    ? admissionCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    : auth.headers()['set-cookie']?.split(';')[0];
  const resolvedView = await resolveDisplayView(launch.origin, admissionCookie);
  // The resolver is the real display-local target authority. A changed display
  // view is re-selected here, not accepted by title or older layout identity.
  openingOptions.expectedViewId = resolvedView;
  report.target = { resolved: true, viewReselected: resolvedView !== expectedView,
    ...(sourceOpeningProof?.marker ? { watermark: { kind: sourceOpeningProof.marker.kind,
      sourceHead: sourceOpeningProof.sourceHead,
      visibleItem: { messageId: sourceOpeningProof.messageId, at: sourceOpeningProof.at, seq: sourceOpeningProof.seq },
      targetAtHead: sourceOpeningProof.targetAtHead, eventType: sourceOpeningProof.eventType } } : {}) };
  await page.addInitScript(installColdOpeningObserver, openingOptions);
  for (let i = 0; i < Number(process.env.HAPI_DSH_PROBE_RUNS ?? 2); i++) {
    const errorsAtStart = errors.length;
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
    let actions;
    try {
      await page.waitForFunction(() => {
        const probe = window.__hapiColdOpening;
        return probe?.verifiedFreshness ? probe.current?.ready && probe.current.stableForMs >= probe.stableMs
          : probe?.first.body && probe?.first.editor && probe?.first.title;
      }, null, { timeout: 90000 });
      actions = await runOpeningActions(i, (method, details) =>
        readExactSource(launch.origin, admissionCookie, resolvedView, method, details));
      // Do not stop at first success. Wait for the observer's post-sync window;
      // its 6 s and 20 s checkpoints are retained even after a final recovery.
      try {
        await page.waitForFunction(() => window.__hapiColdOpening.observation.complete, null,
          { timeout: openingOptions.failureDeadlineMs + 10000 });
      } catch { failure = 'Observation did not complete within the diagnostic deadline'; }
    } catch { failure = 'Timed out before the exact source item, title and usable editor stabilized'; }
    await page.evaluate(() => window.__hapiColdOpening.stop());
    const result = await page.evaluate(() => ({ ...window.__hapiColdOpening, workspace: window.__hapiColdOpening.first.workspace,
      body: window.__hapiColdOpening.first.body, editor: window.__hapiColdOpening.first.editor,
      latest: window.__hapiColdOpening.first.latest, stable: window.__hapiColdOpening.first.stable, actions: null,
      paints: performance.getEntriesByType('paint').map(e => ({ name: e.name, at: e.startTime })), marks: performance.getEntriesByType('mark').filter(e => e.name.startsWith('hapi:') || e.name.startsWith('hapi-dsh:')).map(e => ({ name: e.name, at: e.startTime })), resources: performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname.replace(/\/(sessions|machine)\/[^/]+/g, '/$1/[id]'), at: e.startTime, ms: e.duration, bytes: e.transferSize, encodedBytes: e.encodedBodySize, decodedBytes: e.decodedBodySize, responseStart: e.responseStart, responseEnd: e.responseEnd, protocol: e.nextHopProtocol })), nodes: document.querySelectorAll('*').length, views: [...document.querySelectorAll('[data-hapi-session-view]')].map(e => ({ visible: !!e.getBoundingClientRect().width, rows: e.querySelectorAll('[data-chat-node-key]').length })) }));
    if (actions) result.actions = actions;
    result.errors = errors.slice(errorsAtStart);
    const openingFailures = coldOpeningIssues(result);
    if (openingFailures.length) failure = [failure, ...openingFailures].filter(Boolean).join('; ');
    if (actions?.errors?.length) failure = [failure, ...actions.errors].filter(Boolean).join('; ');
    if (result.errors.length) failure = [failure, `Renderer failure: ${[...new Set(result.errors)].join(', ')}`].filter(Boolean).join('; ');
    page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed);
    if (process.env.HAPI_DSH_PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      // CPU profiles contain script paths, not request credentials or message bodies.
      await writeFile(`${runRoot}/hapi-cold-${i}.cpuprofile`, JSON.stringify(profile), { mode: 0o600 });
    }
    report.runs.push({ mode: i ? 'repeat navigation with browser cache' : 'fresh browser navigation', ...result, network, failure });
    console.log(JSON.stringify({ run: i, workspace: result.workspace, body: result.body, editor: result.editor, latest: result.latest, stable: result.stable, bytes: result.resources.reduce((sum, r) => sum + r.bytes, 0), failure, longestTasks: result.tasks.sort((a,b) => b.ms-a.ms).slice(0,5) }));
    if (process.env.HAPI_DSH_TOUCH_PROBE && i === 0 && !failure) {
      if (process.env.HAPI_DSH_PROFILE) await cdp.send('Profiler.start');
      report.touch = await probeTouch(page, cdp);
      report.touch.tasks = await page.evaluate(() => window.__hapiColdOpening.tasks);
      if (process.env.HAPI_DSH_PROFILE) {
        const { profile } = await cdp.send('Profiler.stop');
        await writeFile(`${runRoot}/hapi-touch.cpuprofile`, JSON.stringify(profile), { mode: 0o600 });
      }
      console.log(JSON.stringify({ touch: report.touch.runs.map(({ direction, metrics }) => ({ direction, metrics })) }));
    }
  }
} catch (e) { report.failure = e.name; process.exitCode = 1; }
finally {
  report.desktopMinimapExercised = !mobile && report.runs.length > 0 && report.runs.every(run =>
    run.actions?.navigation?.attempted === true && run.actions.navigation.committed === true
      && run.actions.navigation.targetVisible === true && !run.actions.navigation.failure);
  report.errors = errors;
  report.transport = transport;
  report.openedStreams = Object.fromEntries(openedStreams);
  report.blockedWrites = Object.fromEntries(blockedWrites);
  report.hostLoad = { availableCpus: availableParallelism(), loadAverage: loadavg() };
  const path = `${runRoot}/report.json`;
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(path);
  await browser.close();
}
if (report.runs.some(r => r.failure) || report.errors.length) process.exitCode = 1;
