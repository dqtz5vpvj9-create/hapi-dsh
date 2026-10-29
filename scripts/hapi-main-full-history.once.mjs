#!/usr/bin/env node
/** Bounded release interaction, using webshot's external browser installation.
 * No transcript, credential, source identity, title, or arbitrary exception is logged.
 * This checks real production paging/DOM; workspace and read-state persistence are isolated.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAttachmentNotReferenced } from '../src/source-attachment-types.ts';
import { randomUUID } from 'node:crypto';
import runnerRemote from '@deepseek-ai/dsh-cordis-host-runner/remote';

const configDir = join(homedir(), '.config/hapi-dsh');
const fail = code => { throw Object.assign(new Error(code), { smokeCode: code }); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceId = id => /^hapi-(?:codex|observed)-[0-9a-f]{32}(?:-r[1-9][0-9]*)?$/.test(id ?? '');
const readMethods = new Set([
  'hapi/catalog', 'hapi/workspaceGet', 'hapi/workspaceLegacy', 'hapi/sourceReadStates',
  'hapi/nativeLibrary', 'hapi/sourceSessionTools', 'hapi/sourceQueuedEdits', 'hapi/sourceQueuedEditRead',
  'hapi/sourceHistoryHead', 'hapi/sourceHistoryOutline', 'hapi/sourceHistoryOutlinePage',
  'hapi/sourceHistoryWindowPage', 'hapi/sourceHistoryAttachment', 'hapi/sourceReadingAnchor',
  'hapi/sourceLocateMessage', 'hapi/nativeSettings', 'hapi/observedSettings', 'hapi/nativePlan',
  'hapi/sourceWorkGraph', 'hapi/sourceWorkGraphLinks', 'hapi/sourceDshChild',
  'hapi/nativeCreations', 'hapi/sourceCreations', 'hapi/machineOptions', 'hapi/sourceMachineOptions',
  'session/list', 'session/projections', 'session/modelCatalog', 'session/page', 'session/attachment',
  'session/search', 'session/canOpenWorkspacePath', 'session/workspacePathApplications',
  'skills/list', 'fileReferences/list', 'account/list', 'account/get', 'remotes/list',
  'agentPresets/list', 'pluginManager/list', 'permissionPresets/list',
  'account/getState', 'account/getProfile', 'account/getBalance', 'account/getUnnotifiedBonuses',
  'account/hasRunningAccountTasks',
  'settings/describe', 'permissionPresets/catalog', 'hapi/sourceNotificationSettings',
  'pluginManager/listPlugins', 'pluginManager/listBundles', 'pluginManager/listVersionExemptions',
  'pluginManager/registries', 'agentPresets/read', 'commands/list',
  'llm/listProviders', 'llm/listConfigurableProviders',
  'credentials/describe', 'dynamicCordisRunner/inventory', 'cotTranslation/limits',
  'hapi/sourceAdministration', 'hapi/sourceSummarySettings',
]);
const readStreams = new Set(['$events', 'session/follow', 'hapi/sourceWindowFollow',
  'remoteAccess/follow', 'account/watch', 'account/watchExpiry', 'session/control', 'workspace/follow']);
const manifestInput = runnerRemote.methods['dynamicCordisRunner/syncInspectManifest'].input({ strict: true }).create();

export function sourceTarget(catalog, title) {
  const matches = new Map();
  for (const row of catalog?.sessions ?? []) if (row.title?.trim() === title) {
    const value = { hubId: catalog.hubId, sourceSessionId: row.hapiSessionId };
    matches.set(JSON.stringify(value), value);
  }
  for (const row of catalog?.sourceDiscovery?.sessions ?? []) if (row.title?.trim() === title) {
    const value = { hubId: row.hubId, sourceSessionId: row.sourceSessionId };
    matches.set(JSON.stringify(value), value);
  }
  if (matches.size !== 1) fail(matches.size ? 'target-title-ambiguous' : 'target-title-missing');
  const value = [...matches.values()][0];
  if (!value.hubId || !value.sourceSessionId) fail('target-source-identity-missing');
  return value;
}

const publicMethod = method => typeof method === 'string' && /^[A-Za-z]{1,36}\/[A-Za-z]{1,48}$/.test(method)
  ? method : 'unrecognized-transport-message';

export function isTargetHistoryRpc(method, args, target) {
  const request = args?.request;
  const session = request?.sessionId ?? request?.address?.sessionId ?? args?.sessionId;
  return session === target && (method.startsWith('hapi/sourceHistory') || method === 'hapi/sourceWindowFollow'
    || ['session/page', 'session/follow', 'session/attachment', 'session/projections'].includes(method));
}

export function olderCursor(before, after) {
  return !!before && !!after && Number.isFinite(before.at) && Number.isFinite(after.at)
    && Number.isInteger(before.seq) && Number.isInteger(after.seq)
    && (after.at < before.at || after.at === before.at && after.seq < before.seq);
}

/** A page must be a real successful HTTP page with a new, earlier source cut. */
export function assessOlderPage(request, envelope, previous) {
  const value = envelope?.result?.ok === true ? envelope.result.value : undefined;
  const start = { at: request?.beforeAt, seq: request?.beforeSeq };
  if (!value || !Array.isArray(value.frames) || value.frames.length === 0) return 'empty-or-failed-page';
  if (!olderCursor(start, value.before)) return 'cursor-did-not-advance';
  if (previous && !olderCursor(previous, value.before)) return 'cursor-repeated-or-reversed';
  return null;
}

export function assessCommittedPages(pages, checks, events, minimum = 3) {
  if ((events.failed ?? 0) || (events.suspended ?? 0)) return 'seamless-page-failed';
  const rejected = pages.find(page => page.error);
  if (rejected) return rejected.error;
  if (pages.length < minimum) return 'insufficient-real-pages';
  if (checks.length < pages.length) return 'page-not-committed';
  if (checks.some(check => !check.retained)) return 'page-reading-anchor-lost';
  if (checks.some(check => check.ambiguous)) return 'page-anchor-sample-overlapped-input';
  if (checks.some(check => check.drift > 48)) return 'page-reading-anchor-jumped';
  return null;
}

export function assessReading(reading) {
  if (!reading.retained || !reading.sameOrder) return 'read-window-changed';
  if (!reading.returned) return 'read-anchor-not-revisited';
  if (reading.up < 150 || reading.down < 150) return 'insufficient-continuous-reading';
  if (reading.unpairedFrames) return 'reading-motion-unobservable';
  if (reading.reverse > 48 || reading.jumpRatio > .7 || reading.blankFrames) return 'reading-jump-or-blank';
  if (reading.duplicateReads) return 'loaded-range-read-again';
  return null;
}

/** Only an explicit read allowlist and source display leases may reach the Host. */
export function requestPolicy(method, body) {
  const request = body?.payload?.args?.request;
  if (method === 'hapi/workspacePut') return 'isolate-workspace';
  if (method === 'hapi/sourceReadStateWrite') return 'isolate-read-state';
  if (method === 'dynamicCordisRunner/syncInspectManifest'
    && manifestInput.safeParse(body?.payload?.args).success) return 'isolate-inspect-manifest';
  if (readMethods.has(method)) return 'read';
  if (method === 'hapi/sourceSessionResolve' && request && typeof request.hubId === 'string'
    && typeof request.sourceSessionId === 'string'
    && Object.keys(request).every(key => ['hubId', 'sourceSessionId'].includes(key))) return 'display-lease';
  if (method === 'hapi/sourceDisplayLease' && request && typeof request.hubId === 'string'
    && typeof request.sourceSessionId === 'string' && typeof request.leaseId === 'string'
    && ['acquire', 'renew', 'release'].includes(request.action)
    && Object.keys(request).every(key => ['hubId', 'sourceSessionId', 'leaseId', 'action', 'ttlMs'].includes(key))) return 'display-lease';
  return 'block';
}

export function streamPolicy(path, message) {
  if (path.endsWith('/hapi-dsh/notifications') && message?.type === 'presence'
    && ['visible', 'hidden'].includes(message.visibility)
    && Object.keys(message).length === 2) return 'isolate-presence';
  if (!path.endsWith('/remote.mux')) return 'block';
  if (message?.type === 'open' && readStreams.has(message.endpoint)) return 'read';
  if (['cancel', 'end'].includes(message?.type) && typeof message.streamId === 'string'
    && Object.keys(message).length === 2) return 'read';
  return 'block';
}

async function options(argv) {
  const result = { urlFile: join(configDir, 'launch-url'), title: process.env.HAPI_DSH_SMOKE_SESSION_TITLE,
    scenario: 'both', timeoutMs: 60_000, report: undefined };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index], value = argv[++index];
    if (!value) fail('invalid-arguments');
    if (key === '--session-title') result.title = value;
    else if (key === '--url-file') result.urlFile = value;
    else if (key === '--scenario' && ['both', 'desktop', 'mobile'].includes(value)) result.scenario = value;
    else if (key === '--report') result.report = value;
    else if (key === '--timeout-ms') result.timeoutMs = Number(value);
    else fail('invalid-arguments');
  }
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 60_000) fail('invalid-time-budget');
  result.title ??= await readFile(join(configDir, 'smoke-session-title'), 'utf8').catch(() => '');
  result.title = result.title.trim();
  if (!result.title) fail('target-not-configured');
  const url = new URL((await readFile(result.urlFile, 'utf8')).trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('invalid-launch-url');
  result.url = url.href;
  return result;
}

function installObserver() {
  // All keys remain in this isolated page. Reports contain only counters/geometry.
  const state = window.__historySmoke = { paneId: null, events: {}, pageChecks: [], motion: [], direction: 0,
    pending: null, tracking: new Set(), input: null, active: false, next: 0, ids: new Map(), previous: null, bookmark: null };
  const id = key => { if (!state.ids.has(key)) state.ids.set(key, ++state.next); return state.ids.get(key); };
  const pane = () => [...document.querySelectorAll('.hapi-pane')].find(node => node.dataset.paneId === state.paneId);
  const port = () => pane()?.querySelector('[data-hapi-session-reveal="ready"] [data-conversation-scroll]');
  const sample = () => {
    const element = port(); if (!element) return null;
    const box = element.getBoundingClientRect(), rows = [];
    const composer = pane()?.querySelector('[data-composer-input]')?.getBoundingClientRect();
    const bottom = Math.min(box.bottom, composer?.top ?? box.bottom);
    for (const x of [.35, .65]) for (const y of [.15, .35, .55, .75]) {
      const node = document.elementFromPoint(box.left + box.width * x, box.top + (bottom - box.top) * y)
        ?.closest('[data-chat-anchor-key]');
      if (!node || !element.contains(node)) continue;
      const key = node.getAttribute('data-chat-anchor-key');
      if (rows.some(row => row.key === key)) continue;
      const rect = node.getBoundingClientRect();
      rows.push({ key, id: id(key), top: rect.top - box.top, height: rect.height, node });
    }
    return { element, top: element.scrollTop, height: element.scrollHeight, viewport: bottom - box.top, rows };
  };
  state.sample = sample;
  const anchor = () => {
    const view = sample(), row = view?.rows[0];
    return row ? { key: row.key, offset: row.top } : null;
  };
  state.anchor = anchor;
  state.anchorOffset = saved => {
    const element = port();
    const row = element && [...element.querySelectorAll('[data-chat-anchor-key]')]
      .find(node => node.getAttribute('data-chat-anchor-key') === saved?.key);
    return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
  };
  state.captureBookmark = () => {
    const view = sample(); if (!view?.rows.length) return null;
    const row = view.rows.find(row => row.top <= view.viewport / 2 && row.top + row.height > view.viewport / 2) ?? view.rows[0];
    const keys = [...view.element.querySelectorAll('[data-chat-anchor-key]')].map(node => node.getAttribute('data-chat-anchor-key'));
    const index = keys.indexOf(row.key);
    return { key: row.key, offset: row.top, inside: Math.max(0, Math.min(row.height, view.viewport / 2 - row.top)),
      neighbors: keys.slice(Math.max(0, index - 1), index + 2) };
  };
  state.bookmarkState = () => {
    const view = sample(), bookmark = state.bookmark;
    const offset = state.anchorOffset(bookmark);
    const keys = view ? [...view.element.querySelectorAll('[data-chat-anchor-key]')].map(node => node.getAttribute('data-chat-anchor-key')) : [];
    const positions = bookmark?.neighbors.map(key => keys.indexOf(key)) ?? [];
    const y = offset !== null && bookmark ? offset + bookmark.inside : null;
    return { retained: offset !== null && bookmark !== null,
      sameOrder: positions.length > 0 && positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])),
      returned: y !== null && view !== null && y >= 0 && y <= view.viewport,
      pointY: y, viewport: view?.viewport ?? 0,
      drift: offset !== null && bookmark ? Math.abs(offset - bookmark.offset) : null };
  };
  let touchY;
  const noteInput = (direction, pixels) => {
    if (!direction) return;
    state.input = { at: performance.now(), direction, pixels };
  };
  window.addEventListener('wheel', event => {
    if (port()?.contains(event.target)) noteInput(Math.sign(event.deltaY), Math.abs(event.deltaY));
  }, { capture: true, passive: true });
  window.addEventListener('touchstart', event => { if (port()?.contains(event.target)) touchY = event.touches[0]?.clientY; }, { capture: true, passive: true });
  window.addEventListener('touchmove', event => {
    if (!port()?.contains(event.target)) return;
    const y = event.touches[0]?.clientY;
    if (touchY !== undefined && y !== undefined) noteInput(Math.sign(touchY - y), Math.abs(touchY - y));
    touchY = y;
  }, { capture: true, passive: true });
  const geometry = saved => {
    const element = port(); if (!element || !saved) return null;
    const node = saved.node?.isConnected ? saved.node : [...element.querySelectorAll('[data-chat-anchor-key]')]
      .find(node => node.getAttribute('data-chat-anchor-key') === saved.key);
    if (!node) return null;
    const offset = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
    return { at: performance.now(), top: element.scrollTop, height: element.scrollHeight, offset, documentY: offset + element.scrollTop };
  };
  const samplePending = tracked => {
    const next = geometry(tracked.anchor), previous = tracked.previous;
    if (!next) { tracked.retained = false; return; }
    if (previous) {
      const offsetDelta = next.offset - previous.offset, documentDelta = next.documentY - previous.documentY;
      const input = state.input, fresh = !!input && next.at - input.at < 350;
      // A fixed old node moving only because scrollTop changed follows reader
      // input. A prepend changes its document coordinate; its compensation must
      // preserve the most recent reader position, not the request-time position.
      const reader = fresh && Math.abs(documentDelta) <= 2 && Math.sign(offsetDelta) === -input.direction
        && Math.abs(offsetDelta) <= input.pixels + 2;
      if (reader) tracked.readerDelta += offsetDelta;
      else if (fresh && Math.abs(documentDelta) > 2 && Math.abs(offsetDelta) > 48) tracked.ambiguous = true;
      if (Math.abs(offsetDelta) > .5 || Math.abs(documentDelta) > .5) tracked.samples.push({
        ms: Math.round(next.at - tracked.start.at), top: Math.round(next.top), height: Math.round(next.height),
        offset: Math.round(next.offset), documentDelta: Math.round(documentDelta), reader: !!reader,
      });
    }
    tracked.previous = next;
  };
  window.addEventListener('hapi-dsh:seamless-history', event => {
    const detail = event.detail;
    if (!state.active || detail?.paneId !== state.paneId) return;
    const allowed = ['attached', 'requested', 'observed', 'committed', 'failed', 'deferred', 'recovered', 'reset', 'suspended'];
    if (!allowed.includes(detail.type)) return;
    state.events[detail.type] = (state.events[detail.type] ?? 0) + 1;
    if (detail.type === 'failed') {
      state.events.failureKind = ['timeout', 'no-progress', 'error'].includes(detail.detail) ? detail.detail : 'other';
    }
    if (detail.type === 'committed') {
      const key = detail.detail === 'forward' ? 'committedForward' : 'committedOlder';
      state.events[key] = (state.events[key] ?? 0) + 1;
    }
    if (detail.type === 'requested' || detail.type === 'observed') {
      const view = sample(), saved = view?.rows[0];
      const start = geometry(saved);
      state.pending = { anchor: saved, start, previous: start, readerDelta: 0, retained: !!start, ambiguous: false, samples: [] };
      if (start) state.tracking.add(state.pending);
    }
    if (detail.type === 'committed' && detail.detail !== 'forward') {
      const tracked = state.pending; state.pending = null;
      setTimeout(() => {
        if (!tracked?.start) { state.pageChecks.push({ retained: false }); return; }
        samplePending(tracked); state.tracking.delete(tracked);
        const raw = tracked.previous.offset - tracked.start.offset;
        state.pageChecks.push({ retained: tracked.retained, rawDrift: Math.abs(raw), readerDelta: tracked.readerDelta,
          drift: Math.abs(raw - tracked.readerDelta), ambiguous: tracked.ambiguous,
          start: { top: tracked.start.top, height: tracked.start.height, offset: tracked.start.offset },
          end: { top: tracked.previous.top, height: tracked.previous.height, offset: tracked.previous.offset },
          samples: tracked.samples.length <= 12 ? tracked.samples : [...tracked.samples.slice(0, 2), ...tracked.samples.slice(-10)] });
      }, 250);
    }
  });
  const tick = () => {
    for (const tracked of state.tracking) samplePending(tracked);
    if (state.direction) {
      const view = sample(), old = state.previous;
      if (view && old) {
        const prior = old.rows.find(row => view.rows.some(next => next.key === row.key))
          ?? old.rows.find(row => row.node.isConnected);
        const next = prior && (view.rows.find(row => row.key === prior.key)
          ?? { top: prior.node.getBoundingClientRect().top - view.element.getBoundingClientRect().top });
        state.motion.push({ direction: state.direction, viewport: view.viewport, blank: !view.rows.length,
          paired: !!next, dy: next ? next.top - prior.top : 0 });
      }
      state.previous = view;
    } else state.previous = null;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function runScenario(browser, config, name) {
  const result = { name, status: 'not-run', step: 'context', durationMs: 0, olderPages: 0,
    events: {}, pageErrors: 0, rpcErrors: 0, attachmentFallbacks: 0, blockedWrites: 0, isolatedWorkspaceWrites: 0,
    isolatedReadStateWrites: 0, isolatedPresence: 0, isolatedInspectManifests: 0,
    maxPageAnchorDriftPx: 0, maxRawPageAnchorDriftPx: 0, pageGeometry: [], duplicateRangeReads: 0,
    roundTripDriftPx: null, blockedRpcKinds: [], rpcErrorKinds: [], historyRpcErrors: 0, historyStreamErrors: 0 };
  const started = performance.now(); let context, page, deadline, targetId, previousCursor;
  let timedOut = false, collecting = false, pages = [], pendingResponses = new Set(), oldestReached = false, automaticPageCount = 0;
  const loadedCuts = new Set();
  const blocked = method => {
    result.blockedWrites++;
    // Public method names only. Never retain request arguments or full paths.
    const category = publicMethod(method);
    if (!result.blockedRpcKinds.includes(category)) result.blockedRpcKinds.push(category);
  };
  const check = () => {
    if (result.blockedWrites) fail('unexpected-write-blocked');
    if (result.pageErrors) fail('page-exception');
    if (result.historyRpcErrors || result.historyStreamErrors) fail('target-history-read-failed');
  };
  const rpcError = (method, status, targetHistory) => {
    result.rpcErrors++; if (targetHistory) result.historyRpcErrors++;
    const row = result.rpcErrorKinds.find(row => row.method === publicMethod(method) && row.status === status && row.targetHistory === targetHistory);
    if (row) row.count++;
    else result.rpcErrorKinds.push({ method: publicMethod(method), status, targetHistory, count: 1 });
  };
  try {
    context = await browser.newContext({ viewport: name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: name === 'mobile', hasTouch: name === 'mobile', serviceWorkers: 'block' });
    deadline = setTimeout(() => { timedOut = true; void context.close(); }, config.timeoutMs);
    context.setDefaultTimeout(8_000);
    result.step = 'authenticate-and-resolve-target';
    // APIRequestContext shares only this new context's authenticated cookies. It
    // executes no page JavaScript and these two exact RPCs cannot create execution.
    const admission = await context.request.get(config.url, { timeout: 10_000 });
    if (!admission.ok()) fail('launch-authentication-failed');
    const appUrl = new URL(admission.url());
    const bootstrap = async (method, args) => {
      const response = await context.request.post(new URL(`api/${method}`, appUrl).href, { timeout: 10_000,
        data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } } });
      let envelope; try { envelope = await response.json(); } catch { fail('target-bootstrap-response-invalid'); }
      if (!response.ok() || envelope.result?.ok !== true) {
        rpcError(method, response.status(), true); fail('target-bootstrap-read-failed');
      }
      return envelope.result.value;
    };
    const target = sourceTarget(await bootstrap('hapi/catalog', {}), config.title);
    const resolved = await bootstrap('hapi/sourceSessionResolve', { request: target });
    targetId = resolved?.sessionId;
    if (!sourceId(targetId) || resolved.hubId !== target.hubId || resolved.sourceSessionId !== target.sourceSessionId) fail('target-bootstrap-identity-mismatch');
    await context.addInitScript(({ origin, sessionId }) => {
      if (location.origin === origin) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }));
    }, { origin: appUrl.origin, sessionId: targetId });
    appUrl.searchParams.set('hapiSession', target.sourceSessionId);
    appUrl.searchParams.set('hapiHub', target.hubId);
    result.initialSelection = 'authenticated-real-source';
    await context.addInitScript(installObserver);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      let body; try { body = request.postDataJSON(); } catch {}
      const method = url.pathname.replace(/^.*\/api\//, '');
      const policy = request.method() === 'POST' && url.pathname.includes('/api/') && body?.method === method
        ? requestPolicy(method, body) : 'block';
      if (policy === 'read' || policy === 'display-lease') return route.continue();
      const input = body?.payload?.args?.request;
      let value;
      if (policy === 'isolate-workspace' && Number.isInteger(input?.expectedRevision) && input?.state) {
        result.isolatedWorkspaceWrites++;
        value = { status: 'applied', revision: input.expectedRevision + 1, state: input.state };
      } else if (policy === 'isolate-read-state' && Number.isInteger(input?.expectedVersion)) {
        result.isolatedReadStateWrites++;
        value = { applied: true, state: { version: input.expectedVersion + 1, seenAt: input.seenAt, manualUnreadAt: input.manualUnreadAt } };
      } else if (policy === 'isolate-inspect-manifest') {
        result.isolatedInspectManifests++; value = null;
      } else { blocked(method); return route.abort('blockedbyclient'); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        type: 'server-response', rpcId: body.rpcId, result: { ok: true, value },
      }) });
    });
    await context.routeWebSocket('**/*', socket => {
      const server = socket.connectToServer();
      const streams = new Map();
      socket.onMessage(raw => {
        let message; try { message = JSON.parse(String(raw)); } catch {}
        // cancel closes only a read subscription; operation cancel is never allowed.
        const policy = streamPolicy(new URL(socket.url()).pathname, message);
        if (policy === 'isolate-presence') result.isolatedPresence++;
        else if (policy === 'read') {
          if (message.type === 'open') streams.set(message.streamId, { method: message.endpoint,
            targetHistory: isTargetHistoryRpc(message.endpoint, message.payload?.args, targetId) });
          server.send(raw);
        }
        else { blocked(message?.endpoint); socket.close({ code: 1008, reason: 'Read-only release check' }); }
      });
      server.onMessage(raw => {
        let message; try { message = JSON.parse(String(raw)); } catch {}
        if (message?.type === 'error' && streams.get(message.streamId)?.targetHistory) result.historyStreamErrors++;
        socket.send(raw);
      });
    });
    page = await context.newPage();
    page.on('pageerror', () => result.pageErrors++);
    page.on('response', response => {
      const url = new URL(response.url());
      if (!url.pathname.includes('/api/')) return;
      const task = (async () => {
        const method = url.pathname.replace(/^.*\/api\//, '');
        let args; try { args = response.request().postDataJSON()?.payload?.args; } catch {}
        const targetHistory = isTargetHistoryRpc(method, args, targetId);
        if (response.status() >= 400) { rpcError(method, response.status(), targetHistory); return; }
        if (!response.headers()['content-type']?.includes('application/json')) return;
        let envelope; try { envelope = await response.json(); } catch { return; }
        if (envelope.result?.ok === false) {
          // Source-body images intentionally live outside the operation log.
          // The product retries this exact denial through its authorized
          // sourceHistoryAttachment route; every other denial remains fatal.
          if (method === 'session/attachment' && isAttachmentNotReferenced(envelope.result.error)) result.attachmentFallbacks++;
          else rpcError(method, response.status(), targetHistory);
        }
        if (!collecting || !url.pathname.endsWith('/hapi/sourceHistoryWindowPage')) return;
        const request = response.request().postDataJSON()?.payload?.args?.request;
        if (request?.sessionId !== targetId) return;
        if (envelope.result?.ok === true) {
          const cut = JSON.stringify([request.beforeAt, request.beforeSeq, request.afterAt, request.afterSeq, request.messageId, request.fromOldest]);
          if (loadedCuts.has(cut)) result.duplicateRangeReads++;
          loadedCuts.add(cut);
        }
        if (request?.beforeAt === undefined) return;
        const error = assessOlderPage(request, envelope, previousCursor);
        if (!error) {
          previousCursor = envelope.result.value.before;
          if (envelope.result.value.hasMoreBefore === false) oldestReached = true;
        }
        pages.push({ error, hasMoreBefore: envelope.result?.value?.hasMoreBefore, frames: envelope.result?.value?.frames?.length ?? 0 });
      })().catch(() => { rpcError(url.pathname.replace(/^.*\/api\//, ''), response.status(), false); });
      pendingResponses.add(task); void task.finally(() => pendingResponses.delete(task));
    });
    result.step = 'navigate';
    await page.goto(appUrl.href, { waitUntil: 'domcontentloaded', timeout: Math.min(20_000, config.timeoutMs) });
    result.step = 'select-source';
    await page.locator('[data-hapi-workspace]').waitFor({ state: 'visible' });
    const sidebar = page.locator('.hapi-session-sidebar:visible');
    if (!await sidebar.count()) {
      const opener = name === 'mobile' ? page.locator('.hapi-mobile-back:visible') : page.locator('.hapi-session-rail button:visible');
      await opener.first().click();
    }
    await sidebar.waitFor({ state: 'visible' });
    if (!await sidebar.locator('input[type="search"]').count()) await sidebar.locator('.hapi-search-chip > button').first().click();
    await sidebar.locator('input[type="search"]').fill(config.title);
    const title = config.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = sidebar.locator('.hapi-session-open').filter({ has: page.locator('.hapi-session-title > span').filter({ hasText: new RegExp(`^(?:⌁ )?${title}$`) }) });
    await row.first().waitFor({ state: 'visible' });
    if (await row.count() !== 1) fail('target-title-ambiguous');
    const actualSource = await row.evaluate(button => !!button.closest('[data-hapi-discovered-source]')
      || /^hapi-(?:codex|observed)-/.test(button.closest('[data-session-row]')?.dataset.sessionRow ?? ''));
    if (!actualSource) fail('target-is-not-source');
    await row.click();
    result.step = 'source-ready';
    const pane = page.locator('.hapi-pane-focused[data-hapi-pane-visible="true"]');
    await pane.locator('[data-hapi-session-reveal="ready"]').waitFor({ state: 'visible' });
    const port = pane.locator('[data-hapi-session-reveal="ready"] [data-conversation-scroll]');
    await port.waitFor({ state: 'visible' });
    await pane.locator('[data-hapi-session-reveal="ready"] [data-composer-input]').waitFor({ state: 'visible' });
    if (!await pane.locator('[data-hapi-session-reveal="ready"] [data-composer-input]').isEditable()) fail('editor-not-editable');
    if (await pane.getAttribute('data-session-id') !== targetId) fail('opened-wrong-source');
    await pane.locator('[data-conversation-content] [data-chat-anchor-key]').first().waitFor({ state: 'visible' });
    const paneId = await pane.getAttribute('data-pane-id');
    await page.evaluate(paneId => { window.__historySmoke.paneId = paneId; window.__historySmoke.active = true; }, paneId);
    collecting = true;
    const cdp = name === 'mobile' ? await context.newCDPSession(page) : null;
    const move = async (pixels, traverse = false) => {
      const box = await port.boundingBox(); if (!box) fail('scrollport-disappeared');
      if (!cdp || traverse) { await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4); await page.mouse.wheel(0, pixels); }
      else {
        const distance = Math.min(Math.abs(pixels), Math.min(box.height * .45, 250));
        const x = box.x + box.width * .6, start = box.y + box.height * (pixels < 0 ? .25 : .7);
        const points = y => [{ x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) });
        for (let index = 1; index <= 10; index++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(start - Math.sign(pixels) * distance * index / 10) });
          await pause(20);
        }
        await pause(80);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      await pause(70);
    };
    const collectChecks = async () => {
      const state = await page.evaluate(() => ({ events: window.__historySmoke.events, checks: window.__historySmoke.pageChecks }));
      result.events = state.events; result.pageGeometry = state.checks;
      result.maxPageAnchorDriftPx = Math.max(0, ...state.checks.map(check => check.drift ?? 0));
      result.maxRawPageAnchorDriftPx = Math.max(0, ...state.checks.map(check => check.rawDrift ?? 0));
      result.olderPages = pages.filter(page => !page.error).length;
      return state;
    };
    result.step = 'position-at-bottom';
    await port.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await pause(250);
    const startPosition = await port.evaluate(element => ({ top: element.scrollTop, max: Math.max(0, element.scrollHeight - element.clientHeight) }));
    result.startAtBottom = startPosition.top >= startPosition.max - 4;
    if (!result.startAtBottom) fail('bottom-position-not-established');
    await page.evaluate(() => { window.__historySmoke.direction = 1; });
    result.step = 'continuous-bottom-to-oldest';
    const earlierControl = async () => {
      const handle = await page.evaluateHandle(paneId => {
        const pane = [...document.querySelectorAll('.hapi-pane')].find(node => node.getAttribute('data-pane-id') === paneId);
        const scroller = pane?.querySelector('[data-conversation-content] [data-conversation-scroll]');
        const column = scroller?.querySelector('[data-chat-flow]:not([data-step-process-content])');
        if (!column) return null;
        for (const child of Array.from(column.children)) {
          if (child instanceof HTMLButtonElement) return child;
          if (child.children.length === 1 && child.firstElementChild instanceof HTMLButtonElement) return child.firstElementChild;
        }
        return null;
      }, paneId);
      const element = handle.asElement();
      if (!element) { await handle.dispose(); return null; }
      return element;
    };
    const validatePages = async (priorCount = pages.length, kind = 'automatic', bookmark = null) => {
      const pageDeadline = Date.now() + 8_000;
      while (pages.length <= priorCount && Date.now() < pageDeadline) { await pause(25); check(); }
      if (pages.length <= priorCount) return false;
      await Promise.all([...pendingResponses]); check();
      const added = pages.length - priorCount;
      if (kind === 'automatic') automaticPageCount += added;
      else {
        for (let index = priorCount; index < pages.length; index++) pages[index].manual = true;
        await pause(300);
        const geometry = await page.evaluate(bookmark => {
          const state = window.__historySmoke;
          const offset = state.anchorOffset(bookmark);
          const current = state.bookmarkState();
          return { retained: current.retained, sameOrder: current.sameOrder, returned: current.returned,
            drift: offset === null || !bookmark ? null : Math.abs(offset - bookmark.offset) };
        }, bookmark);
        result.manualPageChecks.push(geometry);
        if (!geometry.retained || !geometry.sameOrder || !geometry.returned || geometry.drift > 48) fail('manual-page-anchor-lost-or-jumped');
      }
      if (kind === 'automatic') {
        const expected = automaticPageCount;
        await page.waitForFunction(count => (window.__historySmoke.events.committedOlder ?? 0) >= count
          || (window.__historySmoke.events.failed ?? 0) > 0, expected, { timeout: 8_000 });
        await pause(280);
        await page.waitForFunction(count => window.__historySmoke.pageChecks.length >= count
          || (window.__historySmoke.events.failed ?? 0) > 0, expected, { timeout: 3_000 });
        const state = await collectChecks();
        const automaticPages = pages.filter(item => !item.manual);
        const error = assessCommittedPages(automaticPages, state.checks, state.events, automaticPageCount);
        if (error) fail(error);
      }
      return true;
    };
    result.manualOlderClicks = 0;
    result.manualPageChecks = [];
    let noProgressGestures = 0;
    while (!oldestReached) {
      check();
      const beforePages = pages.length;
      const beforeRequests = await page.evaluate(() => window.__historySmoke.events.requested ?? 0);
      const top = await port.evaluate(element => element.scrollTop);
      if (top > 2) await move(-Math.min(400, Math.max(70, top - 1)), true);
      else await move(-120, true);
      let requested = await page.evaluate(() => window.__historySmoke.events.requested ?? 0);
      if (pages.length > beforePages) {
        await validatePages(beforePages);
        noProgressGestures = 0;
        continue;
      }
      if (top <= 2 && requested === beforeRequests) {
        await pause(250);
        requested = await page.evaluate(() => window.__historySmoke.events.requested ?? 0);
        if (pages.length > beforePages) {
          await validatePages(beforePages);
          noProgressGestures = 0;
          continue;
        }
        if (requested > beforeRequests) {
          const loaded = await validatePages(beforePages);
          if (!loaded) fail('automatic-older-request-had-no-source-page');
          noProgressGestures = 0;
          continue;
        }
        const button = await earlierControl();
        if (!button) fail('older-control-missing-before-source-oldest');
        let state = await button.evaluate(element => ({ disabled: element.disabled, visible: !!(element.offsetWidth || element.offsetHeight) }));
        if (!state.visible || state.disabled) {
          const until = Date.now() + 4_000;
          while (Date.now() < until && pages.length === beforePages) {
            await pause(100); check();
            state = await button.evaluate(element => ({ disabled: element.disabled, visible: !!(element.offsetWidth || element.offsetHeight) })).catch(() => ({ disabled: true, visible: false }));
            if (state.visible && !state.disabled) break;
          }
          if (pages.length > beforePages) {
            await button.dispose(); await validatePages(beforePages); noProgressGestures = 0; continue;
          }
        }
        if (!state.visible || state.disabled) {
          result.olderControlUnavailable = await button.evaluate(element => ({
            disabled: element.disabled, text: element.textContent?.trim() ?? '',
            ariaLabel: element.getAttribute('aria-label'), title: element.title,
            parentText: element.parentElement?.textContent?.trim() ?? '',
          })).catch(() => null);
          await button.dispose(); fail('older-control-unavailable-before-source-oldest');
        }
        const bookmark = await page.evaluate(() => window.__historySmoke.captureBookmark());
        if (!bookmark) { await button.dispose(); fail('manual-page-anchor-unavailable'); }
        const prior = pages.length;
        await button.click({ timeout: 4_000 });
        await button.dispose();
        result.manualOlderClicks++;
        const loaded = await validatePages(prior, 'manual', bookmark);
        if (!loaded) fail('manual-older-control-did-not-load-page');
        noProgressGestures = 0;
      } else if (requested > beforeRequests) {
        const loaded = await validatePages(beforePages);
        if (!loaded) fail('automatic-older-request-had-no-source-page');
        noProgressGestures = 0;
      } else if (++noProgressGestures > 8) fail('scroll-made-no-history-progress');
    }
    result.step = 'reach-oldest-visible-row';
    for (let step = 0; step < 100; step++) {
      const top = await port.evaluate(element => element.scrollTop);
      if (top <= 2) break;
      await move(-Math.min(260, Math.max(70, top - 1)), true);
      check();
    }
    const endPosition = await port.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
    result.fullHistory = { oldestPageReportedNoMoreBefore: oldestReached, pages: pages.length,
      arrivedAtTop: endPosition.top <= 2, scrollTop: Math.round(endPosition.top), scrollHeight: Math.round(endPosition.height) };
    if (!result.fullHistory.arrivedAtTop) fail('oldest-page-not-at-scroll-top');
    const pageCountAtOldest = pages.length;
    await move(-220, true);
    const noExtraPage = pages.length === pageCountAtOldest;
    if (!noExtraPage) fail('page-requested-after-oldest');
    await page.evaluate(() => { window.__historySmoke.direction = 0; });
    const measured = await page.evaluate(() => {
      const state = window.__historySmoke, motion = state.motion;
      return { events: state.events, blankFrames: motion.filter(frame => frame.blank).length,
        unpairedFrames: motion.filter(frame => !frame.paired).length,
        reverse: Math.max(0, ...motion.map(frame => -frame.dy * frame.direction)),
        jumpRatio: Math.max(0, ...motion.map(frame => Math.abs(frame.dy) / frame.viewport)),
        samples: motion.length, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
        visibleError: !!document.querySelector('.hapi-pane-focused [data-hapi-seamless="error"], .hapi-pane-focused [data-hapi-seamless="suspended"]') };
    });
    result.events = measured.events;
    result.fullHistory.motion = { sampledFrames: measured.samples, blankFrames: measured.blankFrames,
      unpairedFrames: measured.unpairedFrames, maxReversePx: Math.round(measured.reverse),
      maxFrameViewportRatio: measured.jumpRatio };
    if (measured.blankFrames || measured.unpairedFrames || measured.reverse > 48 || measured.jumpRatio > .7) fail('continuous-scroll-jump-or-blank');
    if (measured.horizontalOverflow) fail('horizontal-overflow');
    if (measured.visibleError || (measured.events.failed ?? 0) || (measured.events.suspended ?? 0)) fail('visible-history-error');
    await page.waitForFunction(() => !window.__historySmoke.pending && !window.__historySmoke.tracking.size
      || (window.__historySmoke.events.failed ?? 0) > 0, undefined, { timeout: 3_000 });
    await Promise.all([...pendingResponses]);
    const finalState = await collectChecks();
    const automaticPages = pages.filter(item => !item.manual);
    const finalError = assessCommittedPages(automaticPages, finalState.checks, finalState.events, automaticPageCount);
    if (finalError) fail(finalError);
    check(); result.status = 'passed'; result.step = 'complete';
  } catch (error) {
    result.status = 'failed';
    result.error = timedOut ? 'scene-budget-exhausted' : result.blockedWrites ? 'unexpected-write-blocked' : error.smokeCode ?? (error.name === 'TimeoutError' ? 'step-timeout' : 'interaction-failed');
    result.fullHistory = { oldestPageReportedNoMoreBefore: oldestReached, pages: pages.length,
      lastPageHasMoreBefore: pages.at(-1)?.hasMoreBefore ?? null, manualOlderClicks: result.manualOlderClicks ?? 0 };
    if (page && !page.isClosed()) {
      result.events = await page.evaluate(() => window.__historySmoke?.events ?? {}).catch(() => result.events);
      result.diagnostics = await page.evaluate(() => ({ focusedPanes: document.querySelectorAll('.hapi-pane-focused').length,
        readyPanes: document.querySelectorAll('.hapi-pane-focused [data-hapi-session-reveal="ready"]').length,
        loadingPanes: document.querySelectorAll('.hapi-pane-focused [data-hapi-session-loading]').length,
        failedMarkers: document.querySelectorAll('[data-hapi-seamless="error"], [data-hapi-seamless="suspended"]').length,
        retainedWindowConflicts: performance.getEntriesByName('hapi-dsh:source-window:visible-budget-conflict').length,
        sourceRows: document.querySelectorAll('[data-hapi-discovered-source], [data-session-row^="hapi-"]').length })).catch(() => undefined);
    }
  } finally {
    clearTimeout(deadline);
    await context?.close().catch(() => {});
    result.durationMs = Math.round(performance.now() - started);
  }
  return result;
}

async function main() {
  const report = { version: 1, status: 'failed', scenarios: [],
    persistence: { workspace: 'isolated-not-validated', readState: 'isolated-not-validated', notificationPresence: 'isolated-not-validated', inspectManifest: 'isolated-not-validated' },
    coverage: 'Real source paging and browser layout/gestures; no sends, draft editing, screenshots, physical keyboard or device.' };
  let config, browser;
  try {
    config = await options(process.argv.slice(2));
    const { applyEnv } = await import(pathToFileURL(process.env.HAPI_DSH_WEBSHOT_TOOLCHAIN ?? '/home/chris/.agents/tools/webshot/lib/toolchain.mjs').href);
    applyEnv();
    const { chromium } = await import(pathToFileURL(process.env.HAPI_DSH_PLAYWRIGHT ?? '/home/chris/.agents/tools/webshot/node_modules/playwright/index.mjs').href);
    browser = await chromium.launch({ headless: true, timeout: 10_000 });
    for (const name of config.scenario === 'both' ? ['desktop', 'mobile'] : [config.scenario]) report.scenarios.push(await runScenario(browser, config, name));
    report.status = report.scenarios.every(result => result.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    report.error = error.smokeCode ?? 'configuration-or-browser-unavailable';
    if (!report.scenarios.length) report.scenarios = ['desktop', 'mobile'].map(name => ({ name, status: 'not-run' }));
  } finally { await browser?.close().catch(() => {}); }
  if (config?.report) {
    try { await writeFile(config.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
    catch { report.status = 'failed'; report.error = 'report-write-failed'; }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) process.stdout.write('Usage: node scripts/test-history-smoke.mjs [--session-title TITLE] [--scenario both|desktop|mobile] [--url-file FILE] [--timeout-ms 1..60000] [--report FILE]\nDefault target: HAPI_DSH_SMOKE_SESSION_TITLE or ~/.config/hapi-dsh/smoke-session-title. Requires the external webshot Playwright runtime.\n');
  else await main();
}
