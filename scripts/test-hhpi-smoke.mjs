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
      reading: window.__hhpiSmoke?.rows ? (() => { const r = window.__hhpiSmoke.rows(); return {
        exists: r.exists, top: Math.round(r.top), max: Math.round(r.max), viewport: Math.round(r.viewport ?? 0),
        mountedRows: r.rows.length, visibleRows: r.rows.filter(row => row.visible).length,
      }; })() : null,
    }));
    result.diagnostics = { available: true, workspaceCount: value.workspaceCount, paneCount: value.paneCount,
      scrollportCount: value.scrollportCount, editorCount: value.editorCount,
      performanceMarks: safeHhpiDiagnosticMarks(value.performanceMarks), reading: value.reading };
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
  if (event?.type === 'tool/call' && typeof data?.name === 'string') return data.name;
  if (event?.type === 'user/message' && Array.isArray(data?.content)) {
    return data.content.flatMap(block => typeof block?.text === 'string' ? [block.text] : []).join('\n');
  }
  if (event?.type === 'assistant/message' && Array.isArray(data?.message?.content)) {
    return data.message.content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
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
    const callId = entry?.event?.type === 'tool/call' && entry.event.data?.callId;
    const event = entry?.event, data = event?.data;
    // Pinned Conversation context identities survive Markdown rendering. Text
    // still has to be visibly correlated; identity alone is not reading evidence.
    const contextKind = event?.type === 'assistant/message' ? 'assistant-step' : event?.type === 'user/message' ? 'input-message' : null;
    const contextId = contextKind === 'assistant-step' && Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step)
      ? `${data.turn}:${data.step}` : contextKind === 'input-message' && typeof data?.id === 'string' ? data.id : null;
    return Number.isSafeInteger(seq) && seq >= 0 && !context.has(seq) && text ? [{ seq, text: normalizeText(text), marks: textMarks(text),
      ...(contextKind && contextId !== null ? { nodeKey: `${contextKind.length}:${contextKind}${contextId}` } : {}),
      ...(typeof callId === 'string' ? { anchor: `call:${callId}` } : {}) }] : [];
  });
}
function sourceRowText(row) { return normalizeText(row?.bodyText ?? row?.text ?? ''); }
function rowContains(row, marks) {
  const text = compactText(sourceRowText(row));
  return marks.some(mark => text.includes(mark));
}
function rowContainsBody(row, marks) {
  const text = compactText(sourceRowText(row));
  return marks.length > 0 && marks.every(mark => text.includes(mark));
}
function rowMatchesSource(row, body, complete = false) {
  return (!body.anchor || row.anchor === body.anchor) && (!body.nodeKey || row.key === body.nodeKey)
    && (complete && !body.nodeKey ? rowContainsBody(row, body.marks) : rowContains(row, body.marks));
}

/** Capture a visible source-message identity and its body at the network response boundary. */
export function captureVisibleSourceAnchor(rows, records, fallbackAnchor = null) {
  for (const row of rows) {
    if (!row.visible || !row.key || !row.anchor) continue;
    const body = sourceRowText(row);
    if (!body) continue;
    for (const record of records) for (const sourceBody of pageBodies(record)) {
      if (!rowMatchesSource(row, sourceBody, true)) continue;
      return { key: row.key, anchor: row.anchor, seq: sourceBody.seq, sourceText: body };
    }
    if (fallbackAnchor?.key === row.key && fallbackAnchor.anchor === row.anchor) {
      return { key: row.key, anchor: row.anchor, seq: fallbackAnchor.seq, sourceText: body };
    }
  }
  return null;
}

/** Categorize identity/body continuity without exposing source keys or text in reports. */
export function sourceAnchorVerdict(anchor, rows) {
  if (!anchor?.key || !anchor.anchor || typeof anchor.sourceText !== 'string') return 'pre-response-anchor-unavailable';
  const sameKey = rows.filter(row => row.key === anchor.key);
  if (!sameKey.length) {
    const sameBodyElsewhere = rows.some(row => sourceRowText(row) === anchor.sourceText);
    return sameBodyElsewhere ? 'key-missing' : 'old-row-outside-virtual-range';
  }
  const sameAnchor = sameKey.find(row => row.anchor === anchor.anchor);
  if (!sameAnchor) return 'anchor-changed';
  if (sourceRowText(sameAnchor) !== anchor.sourceText) return 'source-text-changed';
  if (!sameAnchor.visible) return 'old-row-outside-visible-range';
  return 'retained';
}

function recordAnchorVerdict(result, phase, verdict) {
  if (!verdict) return;
  result.anchorDiagnostics ??= { baselineAtResponse: {}, committed: {} };
  const counts = result.anchorDiagnostics[phase];
  counts[verdict] = (counts[verdict] ?? 0) + 1;
}

/** A cursor is insufficient: a new source seq must render as a new visible keyed body row. */
export function matchVisibleSourcePage(record, rows, previousKeys, previousSeqs, priorHeadSeq) {
  const request = record.request, page = record.page;
  if (!Number.isSafeInteger(request?.before) || request.before < 1 || !page || page.session?.id !== request.sessionId
    || !Array.isArray(page.entries) || page.entries.length === 0
    || !(page.before === null || Number.isSafeInteger(page.before) && page.before < request.before)) return null;
  const bodies = pageBodies(record).filter(body => body.seq < request.before && body.seq < priorHeadSeq && !previousSeqs.has(body.seq));
  for (const body of bodies) for (const row of rows) {
    if (!row.visible || !row.key || !row.anchor || previousKeys.has(row.key) || !rowMatchesSource(row, body)) continue;
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
  const trackScroll = port => {
    if (state.scrollTracking?.port === port) return state.scrollTracking;
    const tracker = state.scrollTracking = { port, scrolls: 0, ended: 0, supportsScrollEnd: 'onscrollend' in port };
    port.addEventListener('scroll', () => { tracker.scrolls++; }, { passive: true });
    port.addEventListener('scrollend', () => { tracker.ended = tracker.scrolls; }, { passive: true });
    return tracker;
  };
  state.rows = () => {
    const pane = [...document.querySelectorAll('.hapi-pane[data-session-id]')]
      .find(element => element.getAttribute('data-session-id') === sessionId && element.dataset.hapiPaneVisible === 'true');
    const scroll = pane?.querySelector('[data-conversation-scroll]');
    if (!scroll) return { exists: false, rows: [], top: 0, max: 0 };
    trackScroll(scroll);
    const box = scroll.getBoundingClientRect();
    const ownerOf = row => row.closest('[data-chat-node-key]');
    const rows = [...scroll.querySelectorAll('[data-chat-anchor-key]')]
      .filter(row => {
        const owner = ownerOf(row), kind = owner?.getAttribute('data-chat-flow-kind');
        return kind === 'tool-call' ? row.getAttribute('data-chat-anchor-key')?.startsWith('call:')
          : row === owner && ['user', 'assistant-step'].includes(kind);
      })
      .map(row => {
        const owner = ownerOf(row), kind = owner.getAttribute('data-chat-flow-kind');
        const rect = row.getBoundingClientRect(), text = row.textContent ?? '';
        const bodyRoot = row.querySelector(':scope > [data-slot="conversation.chat.node"]') ?? row;
        const excluded = 'script,iframe,object,embed,audio,video,source,input,textarea,select,button,[role="button"],[data-hapi-share-exclude],[data-hapi-share-dialog],[data-chat-group-part="reasoning"],[data-variant="think"],[data-clock],[data-chat-flow-kind="turn-process"],.hapi-native-user-actions,[data-slot="conversation.chat.assistant-actions"]';
        const walker = document.createTreeWalker(bodyRoot, NodeFilter.SHOW_TEXT);
        const parts = [];
        while (walker.nextNode()) {
          const excludedNode = walker.currentNode.parentElement?.closest(excluded);
          if (!excludedNode || !bodyRoot.contains(excludedNode)) parts.push(walker.currentNode.textContent);
        }
        const bodyText = kind === 'tool-call' ? text : parts.join(' ');
        return { key: owner.getAttribute('data-chat-node-key'), anchor: row.getAttribute('data-chat-anchor-key'),
          kind, text, bodyText, normalizedText: compact(text),
          top: rect.top, bottom: rect.bottom, visible: rect.bottom > box.top && rect.top < box.bottom
            && rect.height > 0 && row.closest('[hidden]') === null };
      });
    return { exists: true, rows, top: scroll.scrollTop, max: Math.max(0, scroll.scrollHeight - scroll.clientHeight),
      viewport: scroll.clientHeight };
  };
  // Observe a real DOM publication while input is at rest. Continuing to scroll
  // after publication can legitimately recycle the old row; that is a separate check.
  state.layoutCommits = [];
  const waitForInputIdle = async port => {
    const tracker = trackScroll(port), deadline = performance.now() + 3000;
    let last = port.scrollTop, priorScrolls = tracker.scrolls, stable = 0, quietSince = performance.now(), inputSettled = false;
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
      const current = port.scrollTop;
      if (current !== last || tracker.scrolls !== priorScrolls || state.touchActive) { stable = 0; quietSince = performance.now(); }
      else stable++;
      const nativePending = tracker.supportsScrollEnd && tracker.ended < tracker.scrolls;
      if (!state.touchActive && !nativePending && stable >= 6 && performance.now() - quietSince >= 250) { inputSettled = true; break; }
      last = current; priorScrolls = tracker.scrolls;
    }
    if (!inputSettled) throw new Error('Input did not settle before publication.');
  };
  state.waitForGestureSettled = async () => {
    const port = state.scrollTracking?.port;
    if (port) await waitForInputIdle(port);
  };
  state.armLayoutCommit = async () => {
    const pane = [...document.querySelectorAll('.hapi-pane[data-session-id]')]
      .find(element => element.getAttribute('data-session-id') === sessionId && element.dataset.hapiPaneVisible === 'true');
    const port = pane?.querySelector('[data-conversation-scroll]');
    if (!port) throw new Error('No mounted reading port at publication.');
    await waitForInputIdle(port);
    const bounds = port.getBoundingClientRect();
    const hit = document.elementsFromPoint(bounds.left + bounds.width / 2, bounds.top + 1)
      .map(node => node.closest('[data-chat-anchor-key]'))
      .find(node => node && port.contains(node) && node.dataset.chatFlowKind !== 'turn-process');
    const visible = hit ?? [...port.querySelectorAll('[data-chat-anchor-key]')].find(node => {
      const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    const anchor = visible?.dataset.chatGroupKey === undefined ? visible
      : [...visible.querySelectorAll('[data-step-process-content] > [data-chat-anchor-key]:not(:empty):not([hidden]):not([hidden] *)')].find(node => {
        const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
      }) ?? visible;
    const row = anchor?.closest('[data-chat-virtual-row]');
    if (!anchor || !row) throw new Error('No physical reading anchor at publication.');
    const key = anchor.dataset.chatAnchorKey, oldIndex = row.dataset.index;
    const loadButton = port.querySelector('[data-chat-flow] > div > button:disabled');
    const top = anchor.getBoundingClientRect().top - bounds.top;
    const semanticOwner = anchor.closest('[data-chat-node-key]')?.dataset.chatNodeKey;
    const record = { done: false, retained: false, delta: null, kind: key?.startsWith('call:') ? 'tool' : key?.startsWith('group:') ? 'group' : key?.startsWith('[') ? 'segmented' : 'node',
      visibleBefore: anchor.getBoundingClientRect().bottom > bounds.top && anchor.getBoundingClientRect().top < bounds.bottom };
    const token = state.layoutCommits.push(record) - 1;
    const observer = new MutationObserver(() => {
      const current = [...port.querySelectorAll('[data-chat-anchor-key]')].find(node => node.dataset.chatAnchorKey === key);
      const currentRow = current?.closest('[data-chat-virtual-row]');
      // A prepend inside one large process group can retain its physical row
      // index. The official paging button leaves busy only after the same
      // reader's commit/correction, so it is also a publication checkpoint.
      const rangeMoved = currentRow && currentRow.dataset.index !== oldIndex;
      const readCompleted = loadButton && (!loadButton.isConnected || !loadButton.disabled);
      if (!rangeMoved && !readCompleted) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const settled = [...port.querySelectorAll('[data-chat-anchor-key]')].find(node => node.dataset.chatAnchorKey === key);
        record.retained = !!settled;
        record.ownerRetained = semanticOwner === undefined ? null : [...port.querySelectorAll('[data-chat-node-key]')].some(node => node.dataset.chatNodeKey === semanticOwner);
        record.delta = settled ? settled.getBoundingClientRect().top - port.getBoundingClientRect().top - top : null;
        record.done = true;
      }));
    });
    observer.observe(port, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-index', 'disabled'] });
    return token;
  };
  window.addEventListener('touchstart', () => { state.touchActive = true; }, { capture: true, passive: true });
  for (const type of ['touchend', 'touchcancel']) window.addEventListener(type, () => { state.touchActive = false; }, { capture: true, passive: true });
}

async function parseOptions(argv) {
  const config = { urlFile: join(configDir, 'launch-url'), sessionId: undefined, scenario: 'both', timeoutMs: 60_000, pages: 6, report: undefined };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--help') { config.help = true; continue; }
    const value = argv[++index]; if (!value) fail('invalid-arguments');
    if (key === '--session-id') config.sessionId = value;
    else if (key === '--url-file') config.urlFile = value;
    else if (key === '--scenario' && ['both', 'desktop', 'mobile'].includes(value)) config.scenario = value;
    else if (key === '--timeout-ms') config.timeoutMs = Number(value);
    else if (key === '--pages') config.pages = Number(value);
    else if (key === '--report') config.report = value;
    else fail('invalid-arguments');
  }
  if (config.help) return config;
  if (!canonicalHhpiSessionId(config.sessionId)) fail('canonical-hhpi-session-id-required');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000) fail('invalid-time-budget');
  if (!Number.isSafeInteger(config.pages) || config.pages < 6) fail('invalid-page-count');
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
  const sourcePages = [], pending = new Set(), layoutCommits = [], socketPages = new Map(), openedReadStreams = new Map(), anchorSnapshots = new Map();
  let activePageProbe = null;
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
    const workspace = syntheticWorkspace(config.sessionId);
    let legacyResource, migratedSource;
    if (catalog.legacyHapi === false) {
      const saved = await awaiting('read-saved-reference-for-terminal-state-check', bootstrap('hapi/workspaceGet'));
      const findLegacy = value => {
        if (!value || typeof value !== 'object') return undefined;
        if (value.type === 'pane' && value.resource?.sourceSessionId) return value.resource;
        if (value.type === 'pane' && value.resource?.kind === 'chat' && value.resource.draftOrigin?.sourceSessionId
          && value.resource.draftOrigin?.sourceHubId) return { kind: 'chat', ...value.resource.draftOrigin };
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') { const found = findLegacy(child); if (found) return found; }
        }
      };
      legacyResource = findLegacy(saved.state);
      if (legacyResource) {
        const matches = catalog.sessions.filter(session => session.legacyOrigin?.hubId === legacyResource.sourceHubId
          && session.legacyOrigin?.sessionId === legacyResource.sourceSessionId && canonicalHhpiSessionId(session.id));
        if (matches.length === 1) migratedSource = matches[0];
        if (migratedSource?.id === config.sessionId) workspace.windows[0].root.resource = legacyResource;
        workspace.windows.push({ id: 'saved-source-window', name: 'Saved source', autoName: false,
          root: { type: 'pane', id: 'saved-source-pane', resource: legacyResource } });
        workspace.focused['saved-source-window'] = 'saved-source-pane';
      }
    }
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
      const savedRequest = body?.payload?.args?.request;
      if (catalog.legacyHapi === false && legacyResource && policy === 'display-lease' && method === 'hapi/sourceSessionResolve'
        && savedRequest.hubId === legacyResource.sourceHubId && savedRequest.sourceSessionId === legacyResource.sourceSessionId) {
        // The verified HAPI-free shell only returns source_not_connected here;
        // unlike a legacy resolver, it cannot materialize a display or execution.
        result.savedLegacyResolutionReads = (result.savedLegacyResolutionReads ?? 0) + 1;
        return route.continue();
      }
      if (policy === 'read' && method === 'hapi/workspaceGet') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId,
          result: { ok: true, value: { revision: 0, state: workspace } } }) });
      }
      if (policy === 'read' && method === 'hhpi/read') {
        const task = (async () => {
          let upstream;
          try { upstream = await route.fetch(); } catch { return route.continue(); }
          let snapshot = { anchor: null, baselineVerdict: 'pre-response-anchor-unavailable', mountedRows: 0, visibleRows: 0 };
          try {
            const state = await page?.evaluate(() => window.__hhpiSmoke?.rows?.() ?? null);
            if (state?.exists) {
              const baselineVerdict = activePageProbe
                ? sourceAnchorVerdict(activePageProbe.anchor, state.rows) : null;
              recordAnchorVerdict(result, 'baselineAtResponse', baselineVerdict);
              snapshot = {
                anchor: captureVisibleSourceAnchor(state.rows, sourcePages, activePageProbe?.anchor),
                baselineVerdict: baselineVerdict ?? 'no-page-baseline',
                mountedRows: state.rows.length,
                visibleRows: state.rows.filter(row => row.visible).length,
              };
            }
          } catch { /* Keep only the anonymous unavailable snapshot. */ }
          if (typeof body.rpcId === 'string') anchorSnapshots.set(body.rpcId, snapshot);
          const older = Number.isFinite(body.payload?.args?.request?.before);
          const token = older ? await page.evaluate(() => window.__hhpiSmoke.armLayoutCommit()) : null;
          await route.fulfill({ response: upstream });
          if (token !== null) await page.waitForFunction(index => window.__hhpiSmoke.layoutCommits[index]?.done || document.querySelector('[data-history-page-error]'),
            token, { timeout: 5000 });
          return;
        })();
        layoutCommits.push(task);
        // Attach a handler immediately; the gesture awaits the same task below
        // so a rejected layout wait is retained in the scenario report.
        void task.catch(() => {});
        return task.catch(() => {});
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
      if (new URL(request.url()).pathname.endsWith('/api/hhpi/read')) {
        let rpcId; try { rpcId = request.postDataJSON()?.rpcId; } catch {}
        if (typeof rpcId === 'string') anchorSnapshots.delete(rpcId);
        sourcePages.push({ request: {}, error: 'read-transport-failed' });
      }
    });
    page.on('response', response => {
      const url = new URL(response.url()); if (!url.pathname.includes('/api/')) return;
      const task = (async () => {
        const method = url.pathname.replace(/^.*\/api\//, '');
        let requestBody; try { requestBody = response.request().postDataJSON(); } catch {}
        const args = requestBody?.payload?.args;
        const request = args?.request;
        if (method !== 'hhpi/read') return;
        const anchorSnapshot = typeof requestBody?.rpcId === 'string' ? anchorSnapshots.get(requestBody.rpcId) : undefined;
        if (typeof requestBody?.rpcId === 'string') anchorSnapshots.delete(requestBody.rpcId);
        if (request?.sessionId !== config.sessionId) { blocked(method); return; }
        let envelope; try { envelope = await response.json(); } catch { sourcePages.push({ request, anchorSnapshot, error: 'invalid-json' }); return; }
        const pageValue = unwrap(envelope.result?.value);
        if (response.status() >= 400 || envelope.result?.ok !== true || envelope.result?.value?.ok === false) {
          sourcePages.push({ request, anchorSnapshot, error: 'read-failed' }); return;
        }
        if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500)) {
          sourcePages.push({ request, anchorSnapshot, error: 'invalid-limit' }); return;
        }
        if (pageValue?.session?.id !== config.sessionId || !Array.isArray(pageValue.entries)) {
          sourcePages.push({ request, anchorSnapshot, error: 'wrong-source-or-invalid-page' }); return;
        }
        sourcePages.push({ request, page: pageValue, anchorSnapshot, receivedAt: performance.now(), used: false });
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
    if (migratedSource?.id === config.sessionId) result.savedLegacyReference = 'native-body-and-editor-restored';
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
        if (rowMatchesSource(row, body)) matches.push({ seq: body.seq, key: row.key, row });
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
        const input = await awaiting(`${step}-locate-input-boundary`, editor.boundingBox());
        const readingHeight = Math.min(box.y + box.height, input?.y ?? box.y + box.height) - box.y;
        if (readingHeight <= 0) fail('reading-area-covered-by-input');
        const x = box.x + box.width * .6, startY = box.y + readingHeight * .1, distance = readingHeight * .8;
        const points = y => [{ x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 }];
        await awaiting(`${step}-touch-start`, cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(startY) }));
        for (let index = 1; index <= 8; index++) {
          await awaiting(`${step}-touch-move`, cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(startY + distance * index / 8) }));
          await awaiting(`${step}-touch-pause`, pause(12));
        }
        // Let Chromium finish the real gesture, including inertia. The shared
        // input-idle checkpoint still holds publication until scrolling ends.
        await awaiting(`${step}-touch-end`, cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
        await awaiting(`${step}-wait-for-native-scroll-end`, page.evaluate(() => window.__hhpiSmoke.waitForGestureSettled()));
      } else {
        await awaiting(`${step}-position-pointer`, page.mouse.move(box.x + box.width * .6, box.y + box.height * .35));
        await awaiting(`${step}-wheel-up`, page.mouse.wheel(0, -220));
      }
      await awaiting(`${step}-allow-scroll-and-fetch`, pause(90));
      await awaiting(`${step}-wait-for-source-read`, Promise.all([...pending]));
      await awaiting(`${step}-wait-for-dom-publication`, Promise.all(layoutCommits));
    };
    const matchesForPage = (rows, previousKeys, previousSeqs, priorHead) => {
      for (const record of sourcePages) {
        if (record.used || !record.page || record.error) continue;
        const match = matchVisibleSourcePage(record, rows.filter(row => row.visible), previousKeys, previousSeqs, priorHead);
        if (match) { record.used = true; return { record, match }; }
      }
      return null;
    };
    for (let iteration = 0; iteration < config.pages; iteration++) {
      result.step = `read-earlier-page-${iteration + 1}-baseline`;
      const before = await readRows(`read-earlier-page-${iteration + 1}-baseline-dom`);
      const previousKeys = new Set(before.rows.map(row => row.key));
      const previousSeqs = new Set(allSourceMatches(before.rows).map(item => item.seq));
      const priorHead = Math.min(...previousSeqs);
      if (!Number.isFinite(priorHead)) fail('source-page-sequence-not-correlated');
      const oldAnchor = captureVisibleSourceAnchor(before.rows, sourcePages);
      if (!oldAnchor) {
        result.anchorDiagnostic = before.rows.filter(row => row.visible).slice(0, 8).map(row => ({
          kind: row.kind, chars: sourceRowText(row).length,
          sourceMatches: sourcePages.flatMap(record => pageBodies(record)).filter(body => rowMatchesSource(row, body)).map(body => ({
            sourceChars: body.text.length, exactAnchor: !!body.anchor, marks: body.marks.map(mark => rowContainsBody(row, [mark])),
          })).slice(0, 8),
        }));
        fail('reading-anchor-missing');
      }
      activePageProbe = { anchor: oldAnchor, iteration: iteration + 1 };
      let committed;
      for (let gesture = 0; performance.now() - start < timeoutMs - 3_000; gesture++) {
        await moveEarlier(`earlier-page-${iteration + 1}-gesture-${gesture + 1}`);
        const historyError = page.locator('[data-history-page-error]');
        const historyFailure = await historyError.count() ? await historyError.first().textContent() : null;
        if (historyFailure) fail(historyFailure.includes('CAPACITY_EXCEEDED') ? 'capacity-exceeded-visible' : 'history-page-error-visible');
        if (sourcePages.some(record => record.error)) fail('source-page-read-failed');
        const after = await readRows(`read-earlier-page-${iteration + 1}-dom-after-gesture`);
        committed = matchesForPage(after.rows, previousKeys, previousSeqs, priorHead);
        if (committed) {
          const anchorVerdict = sourceAnchorVerdict(committed.record.anchorSnapshot?.anchor, after.rows);
          recordAnchorVerdict(result, 'committed', anchorVerdict);
          // The exact pixel check runs at publication, before later gestures can
          // legitimately move this source body outside the virtual range.
          visibleMatches = allSourceMatches(after.rows.filter(row => row.visible));
          knownMatches = allSourceMatches(after.rows);
          if (!visibleMatches.some(item => item.seq === committed.match.seq && item.key === committed.match.key)) fail('new-source-body-not-visible');
          headSeq = Math.min(...knownMatches.map(item => item.seq));
          activePageProbe = null;
          break;
        }
      }
      if (!committed) fail(`earlier-body-not-visible-${iteration + 1}`);
      result.earlierPagesVisible++;
      // All six, including pages two and three, use the same real DOM/source-seq check.
      if (result.earlierPagesVisible !== iteration + 1) fail('nonconsecutive-earlier-page');
    }

    await awaiting('wait-for-final-source-reads', Promise.all([...pending]));
    const corrections = await page.evaluate(() => window.__hhpiSmoke.layoutCommits);
    result.layoutCommits = corrections;
    if (corrections.length < config.pages || corrections.some(item => !item.done || !item.retained || item.delta === null || Math.abs(item.delta) > 2)) fail('reading-anchor-publication-jump');
    const maxFrameGap = await awaiting('read-frame-gap-verdict', page.evaluate(() => Math.max(0, ...window.__hhpiSmoke.frameGaps)));
    result.maxFrameGapMs = Math.round(maxFrameGap);
    const frameHitch = maxFrameGap > 80;
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
    if (legacyResource) {
      await awaiting('select-preserved-legacy-reference', page.locator('.hapi-window-tabs').getByRole('tab').nth(1).click());
      if (migratedSource) {
        const pane = page.locator('.hapi-window-active .hapi-pane').filter({ has: page.locator('[data-composer-input]') });
        await awaiting('wait-for-migrated-native-source-body', pane.locator('[data-conversation-scroll] [data-chat-anchor-key]').first().waitFor({ state: 'visible', timeout: 5000 }));
        await awaiting('wait-for-migrated-native-source-editor', pane.locator('[data-composer-input]').waitFor({ state: 'visible', timeout: 5000 }));
        if (await pane.locator('.hapi-lease-error').count()) fail('migrated-native-source-still-unavailable');
        result.savedLegacyReference = 'native-body-and-editor-restored';
      } else {
        const unavailable = page.locator('.hapi-window-active .hapi-lease-error');
        await awaiting('wait-for-terminal-legacy-source-state', unavailable.waitFor({ state: 'visible', timeout: 5000 }));
        const message = await awaiting('read-terminal-legacy-source-state', unavailable.innerText());
        if (!/source that is not connected to this HHPI Host|来源尚未接入当前 HHPI Host/u.test(message)) fail('legacy-source-state-not-explicit');
        result.savedLegacyReference = 'source-not-connected';
      }
    }
    if (frameHitch) fail('history-scroll-frame-hitch');
    if (result.blockedWrites || result.blockedStreams) fail('unexpected-production-write-blocked');
    if (result.pageErrors || result.consoleErrors) fail('browser-page-error');
    result.status = 'passed'; result.step = 'complete';
  } catch (error) {
    if (page && !page.isClosed()) {
      result.layoutCommits ??= await page.evaluate(() => window.__hhpiSmoke?.layoutCommits ?? []).catch(() => []);
    }
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
    report.coverage = `Canonical HHPI source catalog/read/changes, ${config.pages} visible earlier source-content pages, anchor continuity, latest return, cached-tail reads, and any preserved legacy reference's terminal source state.`;
    if (config.help) {
      process.stdout.write('Usage: node scripts/test-hhpi-smoke.mjs --session-id hhpi:<machine>:<source>:<engine>:<native> [--url-file FILE] [--scenario both|desktop|mobile] [--pages 6..N] [--timeout-ms 1..60000] [--report FILE]\nRequires the external webshot Chromium runtime. Each live scenario is read-only and runs for at most 60 seconds. Workspace persistence is synthetic; no screenshot is captured.\n');
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
