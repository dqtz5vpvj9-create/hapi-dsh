#!/usr/bin/env node
/** Read-only live HHPI history acceptance. Uses webshot's external Chromium, never screenshots. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStreams, requestPolicy, streamPolicy } from './test-history-smoke.mjs';

const configDir = join(homedir(), '.config/hapi-dsh');
const fail = code => { throw Object.assign(new Error(code), { smokeCode: code }); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanMethod = method => typeof method === 'string' && /^[A-Za-z$][A-Za-z0-9$]{0,60}\/[A-Za-z0-9$]{1,64}$/.test(method) ? method : 'unknown';
const diagnosticModules = Object.freeze([
  '@deepseek-ai/dsh-brand', '@deepseek-ai/cosmokit', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-util-crypto',
]);
const staticDiagnosticMarks = new Set([
  'hapi-dsh:target:boot-start', 'hapi-dsh:target:catalog-ready', 'hapi-dsh:target:retain-start', 'hapi-dsh:target:ready',
  'hapi-dsh:provider:start', 'hapi-dsh:provider:entries', 'hapi-dsh:provider:isolated', 'hapi-dsh:provider:ready',
  'hapi-dsh:workspace:federation-start', 'hapi-dsh:sidebar:start', 'hapi-dsh:sidebar:ready', 'hapi-dsh:sidebar:failed',
  'hapi-dsh:facade:original-ready', 'hapi-dsh:facade:ready', 'hapi-dsh:facade:outline-start',
  'hapi-dsh:facade:latest-head-failed', 'hapi-dsh:facade:latest-refresh-failed', 'hapi-dsh:source-window:reconnecting',
  'hapi-dsh:live:change', 'hapi-dsh:pane:consumer-install', 'hapi-dsh:pane:native-install',
  'hapi-dsh:workspace:load-remote-start', 'hapi-dsh:workspace:load-remote-end',
]);

export function publicConsoleCategory(value) {
  const text = String(value ?? '');
  if (text.includes('web boot:') && text.includes('entries did not activate')) return 'web-boot-activation';
  if (/require\(["'][^"']+["']\) missed the module table/u.test(text)) return 'client-module-resolution';
  if (text.includes('[hapi-dsh] source event subscriber failed:')) return 'source-subscriber';
  return 'browser-console-error';
}

export function allowedMissingModuleNames(value) {
  const text = String(value ?? '');
  return diagnosticModules.filter(name => text.includes(name));
}

export function safeHhpiDiagnosticMarks(values) {
  const safe = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith('hapi-dsh:')) continue;
    if (staticDiagnosticMarks.has(value)) { safe.add(value); continue; }
    if (/^hapi-dsh:rpc:outline:\d+$/u.test(value)) safe.add('hapi-dsh:rpc:outline:<elapsed-ms>');
    else if (/^hapi-dsh:pane-native:(?:with-pane|no-pane)$/u.test(value)) safe.add(value);
    else if (/^hapi-dsh:mounted-chat:(?:control|unmounted|provided)$/u.test(value)) safe.add(value);
    else if (/^hapi-dsh:pane:boot:[^:]+$/u.test(value)) safe.add('hapi-dsh:pane:boot:<host>');
    else if (/^hapi-dsh:pane:native-check:[^:]+:(has|none)$/u.test(value)) {
      safe.add(`hapi-dsh:pane:native-check:<host>:${value.slice(value.lastIndexOf(':') + 1)}`);
    }
  }
  return [...safe].sort();
}

function recordConsoleError(result, value) {
  result.consoleErrors = (result.consoleErrors ?? 0) + 1;
  const category = publicConsoleCategory(value);
  result.consoleErrorCategories ??= {};
  result.consoleErrorCategories[category] = (result.consoleErrorCategories[category] ?? 0) + 1;
  result.missingModules = [...new Set([...(result.missingModules ?? []), ...allowedMissingModuleNames(value)])].sort();
}

async function collectFailureDiagnostics(page, result) {
  if (result.diagnostics) return;
  result.diagnostics = { available: false, workspaceCount: 0, paneCount: 0, scrollportCount: 0, editorCount: 0, performanceMarks: [] };
  if (!page || page.isClosed()) return;
  try {
    const value = await page.evaluate(() => ({
      workspaceCount: document.querySelectorAll('[data-hapi-workspace]').length,
      paneCount: document.querySelectorAll('.hapi-pane[data-session-id]').length,
      scrollportCount: document.querySelectorAll('[data-conversation-scroll]').length,
      editorCount: document.querySelectorAll('[data-composer-input]').length,
      performanceMarks: performance.getEntriesByType('mark').map(entry => entry.name),
    }));
    result.diagnostics = { available: true, workspaceCount: value.workspaceCount, paneCount: value.paneCount,
      scrollportCount: value.scrollportCount, editorCount: value.editorCount,
      performanceMarks: safeHhpiDiagnosticMarks(value.performanceMarks) };
  } catch { /* Keep only the non-sensitive unavailable/count skeleton. */ }
}

export function canonicalHhpiSessionId(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 5 || parts[0] !== 'hhpi') return false;
  try {
    const decoded = parts.slice(1).map(decodeURIComponent);
    return decoded.every(part => part.length > 0 && !part.includes('\0'))
      && `hhpi:${decoded.map(encodeURIComponent).join(':')}` === value;
  } catch { return false; }
}

export function hhpiRequestPolicy(method, body, targetId) {
  const args = body?.payload?.args ?? {};
  if (method === 'hhpi/catalog') return requestPolicy(method, body) === 'read' && args.request === undefined ? 'read' : 'block';
  if (method === 'hhpi/read' || method === 'hhpi/resource') {
    return requestPolicy(method, body) === 'read' && args.request?.sessionId === targetId ? 'read' : 'block';
  }
  if (method.startsWith('hapi/sourceHistory') || method === 'hapi/sourceWindowFollow') return 'block';
  return requestPolicy(method, body);
}

function normalizeText(value) { return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim(); }
function compactText(value) { return normalizeText(value).replace(/\s/gu, ''); }
function bodyText(entry) {
  const event = entry?.event, data = event?.data;
  if (event?.type === 'user/message' && Array.isArray(data?.content)) {
    return data.content.flatMap(block => typeof block?.text === 'string' ? [block.text] : []).join('\n');
  }
  if (event?.type === 'assistant/message' && Array.isArray(data?.message?.content)) {
    return data.message.content.flatMap(block => typeof block?.text === 'string' ? [block.text] : []).join('\n');
  }
  return '';
}
function textMarks(value) {
  const compact = compactText(value), chars = [...compact];
  if (chars.length < 4) return [];
  const width = Math.min(24, chars.length);
  const starts = chars.length <= width ? [0] : [0, Math.floor((chars.length - width) / 2), chars.length - width];
  return [...new Set(starts)].map(start => chars.slice(start, start + width).join('')).filter(text => text.length >= 4);
}
function pageBodies(record) {
  const context = new Set(record.page?.context ?? []);
  return (record.page?.entries ?? []).flatMap(entry => {
    const seq = entry?.event?.seq, text = bodyText(entry);
    return Number.isSafeInteger(seq) && seq >= 0 && !context.has(seq) && text ? [{ seq, marks: textMarks(text) }] : [];
  });
}
function rowContains(row, marks) {
  const text = compactText(row.text);
  return marks.some(mark => text.includes(mark));
}

/** A cursor is insufficient: a new source seq must render as a new visible keyed body row. */
export function matchVisibleSourcePage(record, rows, previousKeys, previousSeqs, priorHeadSeq) {
  const request = record.request, page = record.page;
  if (!Number.isSafeInteger(request?.before) || request.before < 1 || !page || page.session?.id !== request.sessionId
    || !Array.isArray(page.entries) || page.entries.length === 0
    || !(page.before === null || Number.isSafeInteger(page.before) && page.before < request.before)) return null;
  const bodies = pageBodies(record).filter(body => body.seq < request.before && body.seq < priorHeadSeq && !previousSeqs.has(body.seq));
  for (const body of bodies) for (const row of rows) {
    if (!row.visible || !row.key || !row.anchor || previousKeys.has(row.key) || !rowContains(row, body.marks)) continue;
    return { seq: body.seq, key: row.key, anchor: row.anchor, textMark: body.marks.find(mark => compactText(row.text).includes(mark)) };
  }
  return null;
}

export function syntheticWorkspace(sessionId) {
  return { schemaVersion: 1, revision: 0,
    windows: [{ id: 'hhpi-smoke-window', name: 'Smoke', autoName: true,
      root: { type: 'pane', id: 'hhpi-smoke-pane', resource: { kind: 'chat', sessionId } } }],
    activeWindowId: 'hhpi-smoke-window', focused: { 'hhpi-smoke-window': 'hhpi-smoke-pane' }, zoomed: {} };
}

export function installObserver({ sessionId, allowedReadStreams }) {
  const state = window.__hhpiSmoke = { sessionId, blocked: 0, isolatedWorkspace: 0, isolatedReadState: 0,
    isolatedPresence: 0, changesStreams: 0, changeErrors: 0, frameGaps: [], monitor: false, lastFrame: null };
  const streams = new Set();
  const readStreamNames = new Set(allowedReadStreams);
  const compact = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').trim();
  const originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    let message, path = '';
    try { message = typeof data === 'string' ? JSON.parse(data) : null; path = new URL(this.url).pathname; } catch {}
    if (path.endsWith('/hapi-dsh/notifications') && message?.type === 'presence'
      && ['visible', 'hidden'].includes(message.visibility) && Object.keys(message).length === 2) {
      state.isolatedPresence++; return;
    }
    const endpoint = message?.endpoint;
    const targetChanges = endpoint === 'hhpi/changes' && message?.payload?.args?.request?.sessionId === sessionId;
    const legacyHistory = endpoint?.startsWith('hapi/sourceHistory') || endpoint === 'hapi/sourceWindowFollow';
    const opened = path.endsWith('/remote.mux') && message?.type === 'open' && !legacyHistory
      && readStreamNames.has(endpoint)
      && (endpoint !== 'hhpi/changes' || targetChanges);
    const closeStream = ['cancel', 'end'].includes(message?.type) && typeof message.streamId === 'string'
      && Object.keys(message).length === 2 && path.endsWith('/remote.mux') && streams.has(message.streamId);
    if (!opened && !closeStream) { state.blocked++; void window.hhpiSmokeBlocked?.(); return; }
    if (opened) { streams.add(message.streamId); state.changesStreams++; }
    if (closeStream) streams.delete(message.streamId);
    return originalSend.call(this, data);
  };
  window.addEventListener('wheel', event => {
    if (event.target instanceof Element && event.target.closest('[data-conversation-scroll]')) state.lastInput = performance.now();
  }, { capture: true, passive: true });
  const frame = timestamp => {
    if (state.monitor && state.lastFrame !== null) state.frameGaps.push(timestamp - state.lastFrame);
    state.lastFrame = state.monitor ? timestamp : null;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  state.rows = () => {
    const pane = [...document.querySelectorAll('.hapi-pane[data-session-id]')]
      .find(element => element.getAttribute('data-session-id') === sessionId && element.dataset.hapiPaneVisible === 'true');
    const scroll = pane?.querySelector('[data-conversation-scroll]');
    if (!scroll) return { exists: false, rows: [], top: 0, max: 0 };
    const box = scroll.getBoundingClientRect();
    const rows = [...scroll.querySelectorAll('[data-chat-node-key][data-chat-anchor-key]')]
      .filter(row => ['user', 'assistant-step'].includes(row.getAttribute('data-chat-flow-kind')))
      .map(row => {
        const rect = row.getBoundingClientRect(), text = row.innerText ?? '';
        return { key: row.getAttribute('data-chat-node-key'), anchor: row.getAttribute('data-chat-anchor-key'),
          kind: row.getAttribute('data-chat-flow-kind'), text, normalizedText: compact(text),
          top: rect.top, bottom: rect.bottom, visible: rect.bottom > box.top && rect.top < box.bottom
            && row.getClientRects().length > 0 && row.closest('[hidden]') === null };
      });
    return { exists: true, rows, top: scroll.scrollTop, max: Math.max(0, scroll.scrollHeight - scroll.clientHeight),
      viewport: scroll.clientHeight };
  };
}

async function parseOptions(argv) {
  const config = { urlFile: join(configDir, 'launch-url'), sessionId: undefined, scenario: 'both', timeoutMs: 60_000, report: undefined };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--help') { config.help = true; continue; }
    const value = argv[++index]; if (!value) fail('invalid-arguments');
    if (key === '--session-id') config.sessionId = value;
    else if (key === '--url-file') config.urlFile = value;
    else if (key === '--scenario' && ['both', 'desktop', 'mobile'].includes(value)) config.scenario = value;
    else if (key === '--timeout-ms') config.timeoutMs = Number(value);
    else if (key === '--report') config.report = value;
    else fail('invalid-arguments');
  }
  if (config.help) return config;
  if (!canonicalHhpiSessionId(config.sessionId)) fail('canonical-hhpi-session-id-required');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000) fail('invalid-time-budget');
  const url = new URL((await readFile(config.urlFile, 'utf8')).trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('invalid-launch-url');
  config.url = url.href;
  return config;
}

function unwrap(value) { return value?.ok === true && 'value' in value ? value.value : value; }
function hapiPath(appUrl, method) { return new URL(`api/${method}`, appUrl).href; }

async function runScenario(browser, config, name) {
  const result = { name, status: 'not-run', durationMs: 0, earlierPagesVisible: 0, targetReads: 0,
    cachedTailReadDelta: null, changesStreams: 0, maxFrameGapMs: 0, blockedWrites: 0, blockedStreams: 0 };
  const start = performance.now(); let context, page, cdp, deadline, timedOut = false;
  let diagnosticCapture;
  const sourcePages = [], pending = new Set(), socketPages = new Map(), openedReadStreams = new Map();
  const awaiting = async (step, promise) => { result.step = step; return await promise; };
  const blocked = method => { result.blockedWrites++; result.blockedMethod ??= cleanMethod(method); };
  const timeoutMs = config.timeoutMs;
  try {
    result.step = 'create-isolated-browser-context';
    context = await browser.newContext({ viewport: name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: name === 'mobile', hasTouch: name === 'mobile', serviceWorkers: 'block' });
    context.setDefaultTimeout(8_000);
    deadline = setTimeout(() => {
      timedOut = true;
      diagnosticCapture = collectFailureDiagnostics(page, result);
      void diagnosticCapture.finally(() => context?.close().catch(() => {})).catch(() => {});
    }, timeoutMs);
    const admission = await awaiting('authenticate-launch-page', context.request.get(config.url, { timeout: 10_000 }));
    if (!admission.ok()) fail('launch-authentication-failed');
    const appUrl = new URL(admission.url());
    const bootstrap = async (method, args = {}) => {
      const response = await awaiting('read-hhpi-catalog', context.request.post(hapiPath(appUrl, method), { timeout: 10_000,
        data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } } }));
      let envelope; try { envelope = await awaiting('decode-hhpi-catalog', response.json()); } catch { fail('catalog-response-invalid'); }
      if (!response.ok() || envelope.result?.ok !== true) fail('hhpi-catalog-read-failed');
      return unwrap(envelope.result.value);
    };
    const catalog = await awaiting('resolve-canonical-session', bootstrap('hhpi/catalog'));
    if (!Array.isArray(catalog?.sessions) || !catalog.sessions.some(session => session.id === config.sessionId
      && canonicalHhpiSessionId(session.id))) fail('canonical-session-not-in-hhpi-catalog');
    appUrl.searchParams.delete('hapiSession'); appUrl.searchParams.delete('hapiHub');
    appUrl.searchParams.delete('hapiMessage'); appUrl.searchParams.delete('hapiRequest');
    await awaiting('install-synthetic-workspace-bootstrap', context.addInitScript(({ origin, sessionId }) => {
      if (location.origin === origin) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }));
    }, { origin: appUrl.origin, sessionId: config.sessionId }));
    await awaiting('install-read-only-browser-observer', context.addInitScript(installObserver, { sessionId: config.sessionId, allowedReadStreams: [...readStreams] }));
    await awaiting('install-write-isolation-routes', context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      let body; try { body = request.postDataJSON(); } catch {}
      const method = url.pathname.replace(/^.*\/api\//, '');
      const validApi = request.method() === 'POST' && url.pathname.includes('/api/') && body?.method === method;
      const policy = validApi ? hhpiRequestPolicy(method, body, config.sessionId) : 'block';
      if (policy === 'read' && method === 'hapi/workspaceGet') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId,
          result: { ok: true, value: { revision: 0, state: syntheticWorkspace(config.sessionId) } } }) });
      }
      if (policy === 'read') return route.continue();
      const input = body?.payload?.args?.request;
      let value;
      if (policy === 'isolate-workspace' && Number.isInteger(input?.expectedRevision) && input?.state) {
        result.isolatedWorkspaceWrites = (result.isolatedWorkspaceWrites ?? 0) + 1;
        value = { status: 'applied', revision: input.expectedRevision + 1, state: input.state };
      } else if (policy === 'isolate-read-state' && Number.isInteger(input?.expectedVersion)) {
        result.isolatedReadStateWrites = (result.isolatedReadStateWrites ?? 0) + 1;
        value = { applied: true, state: { version: input.expectedVersion + 1, seenAt: input.seenAt, manualUnreadAt: input.manualUnreadAt } };
      } else if (policy === 'isolate-inspect-manifest') {
        result.isolatedInspectManifests = (result.isolatedInspectManifests ?? 0) + 1; value = null;
      } else { blocked(method); return route.abort('blockedbyclient'); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'server-response',
        rpcId: body.rpcId, result: { ok: true, value } }) });
    }));

    page = await awaiting('create-browser-page', context.newPage());
    page.on('pageerror', () => { result.pageErrors = (result.pageErrors ?? 0) + 1; });
    page.on('console', message => { if (message.type() === 'error') recordConsoleError(result, message.text()); });
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.endsWith('/api/hhpi/read')) return;
      let sourceRequest; try { sourceRequest = request.postDataJSON()?.payload?.args?.request; } catch {}
      if (sourceRequest?.sessionId !== config.sessionId) { blocked('hhpi/read'); return; }
      result.targetReads++;
    });
    page.on('requestfailed', request => {
      if (new URL(request.url()).pathname.endsWith('/api/hhpi/read')) sourcePages.push({ request: {}, error: 'read-transport-failed' });
    });
    page.on('response', response => {
      const url = new URL(response.url()); if (!url.pathname.includes('/api/')) return;
      const task = (async () => {
        const method = url.pathname.replace(/^.*\/api\//, '');
        let args; try { args = response.request().postDataJSON()?.payload?.args; } catch {}
        const request = args?.request;
        if (method !== 'hhpi/read') return;
        if (request?.sessionId !== config.sessionId) { blocked(method); return; }
        let envelope; try { envelope = await response.json(); } catch { sourcePages.push({ request, error: 'invalid-json' }); return; }
        const pageValue = unwrap(envelope.result?.value);
        if (response.status() >= 400 || envelope.result?.ok !== true || envelope.result?.value?.ok === false) {
          sourcePages.push({ request, error: 'read-failed' }); return;
        }
        if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500)) {
          sourcePages.push({ request, error: 'invalid-limit' }); return;
        }
        if (pageValue?.session?.id !== config.sessionId || !Array.isArray(pageValue.entries)) {
          sourcePages.push({ request, error: 'wrong-source-or-invalid-page' }); return;
        }
        sourcePages.push({ request, page: pageValue, receivedAt: performance.now(), used: false });
      })().catch(() => { sourcePages.push({ request: {}, error: 'read-capture-failed' }); });
      pending.add(task); void task.finally(() => pending.delete(task));
    });
    await awaiting('install-blocked-stream-counter', page.exposeBinding('hhpiSmokeBlocked', () => { result.blockedStreams++; }));
    cdp = await awaiting('attach-browser-network-inspector', context.newCDPSession(page));
    await awaiting('enable-browser-network-inspector', cdp.send('Network.enable'));
    const socketUrls = new Map();
    cdp.on('Network.webSocketCreated', event => socketUrls.set(event.requestId, event.url));
    cdp.on('Network.webSocketFrameSent', event => {
      const pathname = socketUrls.get(event.requestId);
      let message; try { message = JSON.parse(event.response?.payloadData ?? ''); } catch {}
      if (message?.type === 'open' && message.endpoint === 'hhpi/changes'
        && message.payload?.args?.request?.sessionId === config.sessionId) {
        result.changesStreams++; openedReadStreams.set(`${event.requestId}:${message.streamId}`, true);
      }
      if (message?.type === 'open' && message.endpoint?.startsWith('hapi/sourceHistory')) result.legacyHistoryStreams = (result.legacyHistoryStreams ?? 0) + 1;
      if (pathname && streamPolicy(pathname, message) === 'read' && message?.type === 'open'
        && (message.endpoint !== 'hhpi/changes' || message.payload?.args?.request?.sessionId !== config.sessionId)) {
        // Other read-only DSH services may support the workspace shell. The
        // source history under test must still be the exact HHPI identity.
      }
    });
    cdp.on('Network.webSocketFrameReceived', event => {
      let message; try { message = JSON.parse(event.response?.payloadData ?? ''); } catch {}
      if (message?.type === 'error' && openedReadStreams.has(`${event.requestId}:${message.streamId}`)) result.changesErrors = (result.changesErrors ?? 0) + 1;
      if (message?.type === 'end') openedReadStreams.delete(`${event.requestId}:${message.streamId}`);
    });
    await awaiting('load-app-document', page.goto(appUrl.href, { waitUntil: 'domcontentloaded', timeout: Math.min(20_000, timeoutMs) }));
    await awaiting('wait-for-workspace-shell', page.locator('[data-hapi-workspace]').waitFor({ state: 'visible' }));
    const pane = page.locator(`.hapi-pane[data-session-id="${config.sessionId}"][data-hapi-pane-visible="true"]`);
    await awaiting('wait-for-target-pane', pane.waitFor({ state: 'visible' }));
    const scroll = pane.locator('[data-conversation-scroll]');
    await awaiting('wait-for-conversation-scrollport', scroll.waitFor({ state: 'visible' }));
    const editor = pane.locator('[data-composer-input]');
    await awaiting('wait-for-composer', editor.waitFor({ state: 'visible' }));
    if (!await awaiting('check-composer-editability', editor.isEditable())) fail('composer-not-usable');
    await awaiting('wait-for-first-mounted-chat-row', page.waitForFunction(sessionId => {
      const pane = [...document.querySelectorAll('.hapi-pane[data-session-id]')].find(node => node.getAttribute('data-session-id') === sessionId);
      return !!pane?.querySelector('[data-conversation-scroll] [data-chat-node-key][data-chat-anchor-key]');
    }, config.sessionId, { timeout: 10_000 }));
    await awaiting('wait-for-initial-source-read', Promise.all([...pending]));
    result.step = 'validate-initial-source-read';
    if (!result.targetReads || sourcePages.some(item => item.error)) fail('initial-source-page-unavailable');
    if (result.legacyHistoryStreams) fail('legacy-source-history-path-used');
    if (result.changesErrors) fail('hhpi-change-stream-failed');
    await awaiting('wait-for-hhpi-change-stream', page.waitForFunction(() => window.__hhpiSmoke.changesStreams > 0, undefined, { timeout: 5_000 }));
    await awaiting('start-frame-monitor', page.evaluate(() => { window.__hhpiSmoke.monitor = true; window.__hhpiSmoke.frameGaps = []; }));

    const readRows = step => awaiting(step, page.evaluate(() => window.__hhpiSmoke.rows()));
    const allSourceMatches = rows => {
      const matches = [];
      for (const row of rows) for (const record of sourcePages) for (const body of pageBodies(record)) {
        if (rowContains(row, body.marks)) matches.push({ seq: body.seq, key: row.key, row });
      }
      return matches;
    };
    const initialRows = await readRows('read-initial-source-rows');
    if (!initialRows.exists) fail('conversation-scrollport-missing');
    let visibleMatches = allSourceMatches(initialRows.rows.filter(row => row.visible));
    let knownMatches = allSourceMatches(initialRows.rows);
    if (!visibleMatches.length) fail('initial-source-body-not-correlated');
    let headSeq = Math.max(...visibleMatches.map(item => item.seq));
    const latestSeq = Math.max(...knownMatches.map(item => item.seq));
    const moveEarlier = async step => {
      const box = await awaiting(`${step}-locate-scrollport`, scroll.boundingBox()); if (!box) fail('conversation-scrollport-disappeared');
      if (name === 'mobile') {
        const x = box.x + box.width * .6, startY = box.y + box.height * .24, distance = Math.min(260, box.height * .42);
        const points = y => [{ x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 }];
        await awaiting(`${step}-touch-start`, cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(startY) }));
        for (let index = 1; index <= 8; index++) {
          await awaiting(`${step}-touch-move`, cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(startY + distance * index / 8) }));
          await awaiting(`${step}-touch-pause`, pause(12));
        }
        await awaiting(`${step}-touch-end`, cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
      } else {
        await awaiting(`${step}-position-pointer`, page.mouse.move(box.x + box.width * .6, box.y + box.height * .35));
        await awaiting(`${step}-wheel-up`, page.mouse.wheel(0, -220));
      }
      await awaiting(`${step}-allow-scroll-and-fetch`, pause(90));
      await awaiting(`${step}-wait-for-source-read`, Promise.all([...pending]));
    };
    const matchesForPage = (rows, previousKeys, previousSeqs, priorHead) => {
      for (const record of sourcePages) {
        if (record.used || !record.page || record.error) continue;
        const match = matchVisibleSourcePage(record, rows.filter(row => row.visible), previousKeys, previousSeqs, priorHead);
        if (match) { record.used = true; return { record, match }; }
      }
      return null;
    };
    for (let iteration = 0; iteration < 6; iteration++) {
      result.step = `read-earlier-page-${iteration + 1}-baseline`;
      const before = await readRows(`read-earlier-page-${iteration + 1}-baseline-dom`);
      const previousKeys = new Set(before.rows.map(row => row.key));
      const previousSeqs = new Set(allSourceMatches(before.rows).map(item => item.seq));
      const priorHead = Math.min(...previousSeqs);
      if (!Number.isFinite(priorHead)) fail('source-page-sequence-not-correlated');
      const oldAnchor = before.rows.find(row => row.visible);
      if (!oldAnchor) fail('reading-anchor-missing');
      let committed;
      for (let gesture = 0; gesture < 24 && performance.now() - start < timeoutMs - 3_000; gesture++) {
        await moveEarlier(`earlier-page-${iteration + 1}-gesture-${gesture + 1}`);
        if (sourcePages.some(record => record.error)) fail('source-page-read-failed');
        const after = await readRows(`read-earlier-page-${iteration + 1}-dom-after-gesture`);
        committed = matchesForPage(after.rows, previousKeys, previousSeqs, priorHead);
        if (committed) {
          const retained = after.rows.find(row => row.key === oldAnchor.key && row.anchor === oldAnchor.anchor
            && row.normalizedText === oldAnchor.normalizedText);
          if (!retained) fail('reading-anchor-or-text-changed-during-prepend');
          visibleMatches = allSourceMatches(after.rows.filter(row => row.visible));
          knownMatches = allSourceMatches(after.rows);
          if (!visibleMatches.some(item => item.seq === committed.match.seq && item.key === committed.match.key)) fail('new-source-body-not-visible');
          headSeq = Math.min(...knownMatches.map(item => item.seq));
          break;
        }
      }
      if (!committed) fail(`earlier-body-not-visible-${iteration + 1}`);
      result.earlierPagesVisible++;
      // All six, including pages two and three, use the same real DOM/source-seq check.
      if (result.earlierPagesVisible !== iteration + 1) fail('nonconsecutive-earlier-page');
    }

    await awaiting('wait-for-final-source-reads', Promise.all([...pending]));
    const maxFrameGap = await awaiting('read-frame-gap-verdict', page.evaluate(() => Math.max(0, ...window.__hhpiSmoke.frameGaps)));
    result.maxFrameGapMs = Math.round(maxFrameGap);
    if (maxFrameGap > 80) fail('history-scroll-frame-hitch');
    if (result.legacyHistoryStreams) fail('legacy-source-history-path-used');
    if (result.changesErrors) fail('hhpi-change-stream-failed');
    if (result.blockedWrites || result.blockedStreams) fail('unexpected-production-write-blocked');

    result.step = 'return-latest-and-read-cached-tail';
    const latest = pane.getByRole('button', { name: /^(回到底部|Back to bottom)$/ }).first();
    await awaiting('wait-for-return-to-latest-control', latest.waitFor({ state: 'visible' }));
    await awaiting('activate-return-to-latest', latest.click());
    await awaiting('wait-for-latest-scroll-position', page.waitForFunction(sessionId => {
      const pane = [...document.querySelectorAll('.hapi-pane[data-session-id]')].find(node => node.getAttribute('data-session-id') === sessionId);
      const scroll = pane?.querySelector('[data-conversation-scroll]');
      return !!scroll && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4;
    }, config.sessionId, { timeout: 5_000 }));
    const readCount = result.targetReads, latestRows = await readRows('read-latest-position');
    for (let index = 0; index < 3; index++) await moveEarlier(`cached-tail-gesture-${index + 1}`);
    const residentRows = await readRows('read-resident-tail-after-scroll');
    const cachedEarlier = allSourceMatches(residentRows.rows.filter(row => row.visible)).some(item => item.seq < latestSeq);
    result.cachedTailReadDelta = result.targetReads - readCount;
    result.cachedTailMovedPx = Math.round(latestRows.top - residentRows.top);
    if (result.cachedTailReadDelta !== 0) fail('resident-tail-triggered-extra-source-read');
    if (result.cachedTailMovedPx < 150 || !cachedEarlier) fail('resident-tail-content-not-readable');
    if (result.blockedWrites || result.blockedStreams) fail('unexpected-production-write-blocked');
    if (result.pageErrors || result.consoleErrors) fail('browser-page-error');
    result.status = 'passed'; result.step = 'complete';
  } catch (error) {
    await collectFailureDiagnostics(page, result);
    result.status = 'failed';
    result.error = timedOut ? 'scenario-budget-exhausted' : error.smokeCode ?? (error.name === 'TimeoutError' ? 'step-timeout' : 'interaction-failed');
  } finally {
    clearTimeout(deadline);
    await diagnosticCapture?.catch(() => {});
    await context?.close().catch(() => {});
    result.durationMs = Math.round(performance.now() - start);
  }
  return result;
}

export async function main() {
  let config, browser;
  const report = { version: 1, mode: 'hhpi-read-only-live', status: 'failed', scenarios: [],
    sourceIdentity: 'omitted', transcript: 'kept-in-process-only', workspaceWrites: 'isolated', screenshots: 'not-captured',
    coverage: 'Canonical HHPI source catalog/read/changes, six visible earlier body pages, anchor continuity, latest return and cached-tail reads.' };
  try {
    config = await parseOptions(process.argv.slice(2));
    if (config.help) {
      process.stdout.write('Usage: node scripts/test-hhpi-smoke.mjs --session-id hhpi:<machine>:<source>:<engine>:<native> [--url-file FILE] [--scenario both|desktop|mobile] [--timeout-ms 1..60000] [--report FILE]\nRequires the external webshot Chromium runtime. Each live scenario is read-only and runs for at most 60 seconds. Workspace persistence is synthetic; no screenshot is captured.\n');
      return;
    }
    const { applyEnv } = await import(pathToFileURL(process.env.HAPI_DSH_WEBSHOT_TOOLCHAIN ?? '/home/chris/.agents/tools/webshot/lib/toolchain.mjs').href);
    applyEnv();
    const { chromium } = await import(pathToFileURL(process.env.HAPI_DSH_PLAYWRIGHT ?? '/home/chris/.agents/tools/webshot/node_modules/playwright/index.mjs').href);
    browser = await chromium.launch({ headless: true, timeout: 10_000 });
    const scenes = config.scenario === 'both' ? ['desktop', 'mobile'] : [config.scenario];
    for (const scene of scenes) report.scenarios.push(await runScenario(browser, config, scene));
    report.status = report.scenarios.every(scene => scene.status === 'passed') ? 'passed' : 'failed';
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
