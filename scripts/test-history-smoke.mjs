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
const parseSocketMessage = value => { try { return JSON.parse(value); } catch { return undefined; } };
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
const readStreams = new Set(['$events', 'session/follow', 'hapi/sourceWindowFollow', 'hapi/sourceHistoryWindowPageStream',
  'remoteAccess/follow', 'account/watch', 'account/watchExpiry', 'session/control', 'workspace/follow']);
const manifestInput = runnerRemote.methods['dynamicCordisRunner/syncInspectManifest'].input({ strict: true }).create();

export function sourceTarget(catalog, title, occurrence) {
  const matches = new Map();
  for (const row of catalog?.sessions ?? []) if (row.title?.trim() === title) {
    const value = { hubId: catalog.hubId, sourceSessionId: row.hapiSessionId };
    matches.set(JSON.stringify(value), value);
  }
  for (const row of catalog?.sourceDiscovery?.sessions ?? []) if (row.title?.trim() === title) {
    const value = { hubId: row.hubId, sourceSessionId: row.sourceSessionId };
    matches.set(JSON.stringify(value), value);
  }
  if (matches.size === 0) fail('target-title-missing');
  if (occurrence === undefined && matches.size !== 1) fail('target-title-ambiguous');
  const candidates = [...matches.values()];
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= candidates.length)) {
    fail('target-occurrence-out-of-range');
  }
  const value = candidates[occurrence ?? 0];
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
  if (checks.length < minimum) return 'page-not-committed';
  if (checks.some(check => !check.retained)) return 'page-reading-anchor-lost';
  if (checks.some(check => check.ambiguous)) return 'page-anchor-sample-overlapped-input';
  if (checks.some(check => check.drift > 48)) return 'page-reading-anchor-jumped';
  return null;
}

export function assessPageLimits(requests, maximum = 50) {
  return requests.some(request => !Number.isInteger(request.limit) || request.limit < 1 || request.limit > maximum)
    ? 'source-page-limit-exceeded' : null;
}

export function assessReading(reading) {
  if (!reading.retained || !reading.sameOrder) return 'read-window-changed';
  if (!reading.returned) return 'read-anchor-not-revisited';
  if (reading.up < 150 || reading.down < 150) return 'insufficient-continuous-reading';
  if (reading.unpairedFrames) return 'reading-motion-unobservable';
  if (reading.reverse > 48 || reading.jumpRatio > .7 || reading.blankFrames) return 'reading-jump-or-blank';
  if (reading.maxFrameGapMs > 80) return 'reading-frame-hitch';
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
    scenario: 'both', timeoutMs: 60_000, report: undefined, sessionOccurrence: undefined, cpuProfile: false };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--cpu-profile') { result.cpuProfile = true; continue; }
    const value = argv[++index];
    if (!value) fail('invalid-arguments');
    if (key === '--session-title') result.title = value;
    else if (key === '--session-occurrence') result.sessionOccurrence = Number(value);
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

function installObserver({ readStreams }) {
  // All keys remain in this isolated page. Reports contain only counters/geometry.
  const state = window.__historySmoke = { paneId: null, events: {}, pageChecks: [], anchorCommits: [], motion: [], direction: 0,
    pending: null, tracking: new Set(), input: null, active: false, olderCommittedPages: 0, next: 0, ids: new Map(), previous: null,
    previousFrameAt: null, frameIntervals: [], longTasks: [], monitorFrames: false, bookmark: null,
    sourceFeedChanges: { replace: 0, prepend: 0, append: 0, unchanged: 0 }, sourceFeedSamples: [],
    blockedWebSocketSends: 0, isolatedPresence: 0 };
  const allowedStreams = new Set(readStreams);
  const nativeWebSocketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    let allowed = false;
    try {
      if (typeof data === 'string') {
        const pathname = new URL(this.url).pathname;
        const message = JSON.parse(data);
        if (pathname.endsWith('/hapi-dsh/notifications') && message?.type === 'presence'
          && ['visible', 'hidden'].includes(message.visibility) && Object.keys(message).length === 2) {
          state.isolatedPresence++;
          return;
        }
        allowed = pathname.endsWith('/remote.mux') && (message?.type === 'open' && allowedStreams.has(message.endpoint)
          || ['cancel', 'end'].includes(message?.type) && typeof message.streamId === 'string'
            && Object.keys(message).length === 2);
      }
    } catch { /* Malformed and binary messages stay blocked. */ }
    if (!allowed) {
      state.blockedWebSocketSends++;
      void window.historySmokeBlockedWebSocket?.();
      return;
    }
    return nativeWebSocketSend.call(this, data);
  };
  state.coordinateRebases = [];
  window.__hapiDshSourceFeedTrace = (change, metrics) => {
    if (Object.prototype.hasOwnProperty.call(state.sourceFeedChanges, change)) state.sourceFeedChanges[change]++;
    if (change === 'replace' && metrics) state.sourceFeedSamples.push(metrics);
    if (state.sourceFeedSamples.length > 12) state.sourceFeedSamples.shift();
  };
  window.__hapiDshCoordinateRebaseTrace = (name, reason, index, previous, next, value) => {
    state.coordinateRebases.push({ name, reason, index, previous, next, value });
    if (state.coordinateRebases.length > 12) state.coordinateRebases.shift();
  };
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration),
        attribution: (entry.attribution ?? []).map(item => ({ name: item.name, containerType: item.containerType,
          containerName: item.containerName, containerId: item.containerId, containerSrc: item.containerSrc })) });
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch { /* The release browser may not expose Long Tasks. */ }
  const id = key => { if (!state.ids.has(key)) state.ids.set(key, ++state.next); return state.ids.get(key); };
  const pane = () => [...document.querySelectorAll('.hapi-pane')].find(node => node.dataset.paneId === state.paneId);
  const port = () => pane()?.querySelector('[data-hapi-session-reveal="ready"] [data-conversation-scroll]');
  const rowKey = node => node?.getAttribute('data-chat-anchor-key') ?? node?.getAttribute('data-chat-node-key');
  const sample = () => {
    const element = port(); if (!element) return null;
    const box = element.getBoundingClientRect(), rows = [];
    const composer = pane()?.querySelector('[data-composer-input]')?.getBoundingClientRect();
    const bottom = Math.min(box.bottom, composer?.top ?? box.bottom);
    const style = getComputedStyle(element);
    const readableTop = box.top + (Number.parseFloat(style.scrollPaddingTop) || 0);
    const readableBottom = Math.min(bottom, box.bottom - (Number.parseFloat(style.scrollPaddingBottom) || 0));
    const visibleRows = [...element.querySelectorAll('[data-chat-node-key], [data-chat-anchor-key]')]
      .filter(row => row.getClientRects().length && row.closest('[hidden]') === null
        && row.getAttribute('data-chat-flow-kind') !== 'turn-process')
      .map(row => ({ row, rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > readableTop && rect.top < readableBottom);
    const readingLine = readableTop + Math.min(48, Math.max(0, (readableBottom - readableTop) / 3));
    const node = visibleRows.findLast(({ rect }) => rect.top <= readingLine && rect.bottom > readingLine)?.row
      ?? visibleRows[0]?.row ?? null;
    if (node) {
      const key = rowKey(node), rect = node.getBoundingClientRect();
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
    const row = element && [...element.querySelectorAll('[data-chat-node-key], [data-chat-anchor-key]')]
      .find(node => rowKey(node) === saved?.key);
    return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
  };
  state.captureBookmark = () => {
    const view = sample(); if (!view?.rows.length) return null;
    const row = view.rows.find(row => row.top <= view.viewport / 2 && row.top + row.height > view.viewport / 2) ?? view.rows[0];
    const keys = [...view.element.querySelectorAll('[data-chat-node-key], [data-chat-anchor-key]')].map(rowKey);
    const index = keys.indexOf(row.key);
    return { key: row.key, offset: row.top, inside: Math.max(0, Math.min(row.height, view.viewport / 2 - row.top)),
      neighbors: keys.slice(Math.max(0, index - 1), index + 2) };
  };
  state.bookmarkState = () => {
    const view = sample(), bookmark = state.bookmark;
    const offset = state.anchorOffset(bookmark);
    const keys = view ? [...view.element.querySelectorAll('[data-chat-node-key], [data-chat-anchor-key]')].map(rowKey) : [];
    const positions = bookmark?.neighbors.map(key => keys.indexOf(key)) ?? [];
    const y = offset !== null && bookmark ? offset + bookmark.inside : null;
    return { retained: offset !== null && bookmark !== null,
      sameOrder: positions.length > 0 && positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])),
      returned: y !== null && view !== null && y >= 0 && y <= view.viewport,
      pointY: y, viewport: view?.viewport ?? 0,
      drift: offset !== null && bookmark ? Math.abs(offset - bookmark.offset) : null };
  };
  let touchY;
  let touchStartY;
  let touchDirection = 0;
  let touchDistance = 0;
  const noteInput = (direction, pixels) => {
    if (!direction) return;
    state.input = { at: performance.now(), direction, pixels };
  };
  window.addEventListener('wheel', event => {
    if (port()?.contains(event.target)) noteInput(Math.sign(event.deltaY), Math.abs(event.deltaY));
  }, { capture: true, passive: true });
  window.addEventListener('touchstart', event => {
    if (!port()?.contains(event.target)) return;
    touchY = touchStartY = event.touches[0]?.clientY;
    touchDirection = 0; touchDistance = 0;
  }, { capture: true, passive: true });
  window.addEventListener('touchmove', event => {
    if (!port()?.contains(event.target)) return;
    const y = event.touches[0]?.clientY;
    if (touchStartY !== undefined && y !== undefined) {
      touchDirection = Math.sign(touchStartY - y);
      touchDistance = Math.abs(touchStartY - y);
      noteInput(touchDirection, touchDistance);
    }
    touchY = y;
  }, { capture: true, passive: true });
  window.addEventListener('touchend', () => {
    if (touchDirection) noteInput(touchDirection, touchDistance);
    touchY = touchStartY = undefined;
  }, { capture: true, passive: true });
  const geometry = saved => {
    const element = port(); if (!element || !saved) return null;
    const node = saved.node?.isConnected ? saved.node : [...element.querySelectorAll('[data-chat-node-key], [data-chat-anchor-key]')]
      .find(node => rowKey(node) === saved.key);
    if (!node) return null;
    const offset = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
    return { at: performance.now(), top: element.scrollTop, height: element.scrollHeight, offset, documentY: offset + element.scrollTop };
  };
  const rebasePendingToReader = tracked => {
    const view = sample(), saved = view?.rows[0], start = geometry(saved);
    if (!view || view.element !== tracked.port || !start) return false;
    tracked.anchor = saved; tracked.start = start; tracked.previous = start;
    tracked.readerDelta = 0; tracked.ambiguous = false; tracked.retained = true; tracked.samples = [];
    return true;
  };
  const samplePending = tracked => {
    const next = geometry(tracked.anchor), previous = tracked.previous;
    tracked.sameScroller = tracked.port === port();
    if (!next) {
      tracked.retained = false;
      const alias = [...(tracked.port?.querySelectorAll('[data-chat-node-key]') ?? [])]
        .find(node => node.dataset.chatNodeKey === tracked.anchor?.node?.dataset.chatNodeKey);
      tracked.loss = { connected: tracked.anchor?.node?.isConnected ?? false,
        sameNodeDifferentPart: !!alias, aliasHidden: alias?.closest('[hidden]') !== null,
        top: tracked.port?.scrollTop ?? null, previousTop: previous?.top ?? null,
        visibleAnchor: !!sample()?.rows.length,
        mountedRows: tracked.port?.querySelectorAll('[data-chat-virtual-row]').length ?? null,
        originalPart: tracked.anchor?.node?.dataset.chatGroupPart ?? null,
        replacementPart: alias?.dataset.chatGroupPart ?? null };
      const input = state.input, element = tracked.port;
      const fresh = !!input && performance.now() - input.at < 1_000;
      const scrollDelta = element?.scrollTop - (previous?.top ?? element?.scrollTop);
      const reader = fresh && Number.isFinite(scrollDelta) && Math.sign(scrollDelta) === input.direction
        && Math.abs(scrollDelta) <= input.pixels + 2;
      return reader && rebasePendingToReader(tracked);
    }
    let reader = false;
    if (previous) {
      const offsetDelta = next.offset - previous.offset, documentDelta = next.documentY - previous.documentY;
      const input = state.input, fresh = !!input && next.at - input.at < 1_000;
      // A fixed old node moving only because scrollTop changed follows reader
      // input. A prepend changes its document coordinate; its compensation must
      // preserve the most recent reader position, not the request-time position.
      reader = fresh && Math.abs(documentDelta) <= 2 && Math.sign(offsetDelta) === -input.direction
        && Math.abs(offsetDelta) <= input.pixels + 2;
      if (reader) tracked.readerDelta += offsetDelta;
      else if (fresh && Math.abs(documentDelta) > 2 && Math.abs(offsetDelta) > 48) tracked.ambiguous = true;
      if (Math.abs(offsetDelta) > .5 || Math.abs(documentDelta) > .5) tracked.samples.push({
        ms: Math.round(next.at - tracked.start.at), top: Math.round(next.top), height: Math.round(next.height),
        offset: Math.round(next.offset), documentDelta: Math.round(documentDelta), reader: !!reader,
      });
    }
    tracked.previous = next;
    return reader;
  };
  window.addEventListener('scroll', event => {
    for (const tracked of state.tracking) {
      if (event.target === tracked.port && samplePending(tracked)) rebasePendingToReader(tracked);
    }
  }, true);
  window.addEventListener('hapi-dsh:seamless-history', event => {
    const detail = event.detail;
    if (!state.active || detail?.paneId !== state.paneId) return;
    const allowed = ['attached', 'requested', 'observed', 'committed', 'failed', 'deferred', 'recovered', 'reset', 'suspended'];
    if (!allowed.includes(detail.type)) return;
    state.events[detail.type] = (state.events[detail.type] ?? 0) + 1;
    const reasons = ['mounted-reader-unavailable', 'mounted-reader-failed', 'timeout', 'no-progress', 'error'];
    if (detail.type === 'failed' && reasons.includes(detail.detail)) {
      state.failureReasons ??= {};
      state.failureReasons[detail.detail] = (state.failureReasons[detail.detail] ?? 0) + 1;
    }
    if (detail.type === 'requested' || detail.type === 'observed') {
      const view = sample(), saved = view?.rows[0];
      const start = geometry(saved);
      state.pending = { anchor: saved, port: view?.element, start, previous: start,
        readerDelta: 0, retained: !!start, sameScroller: true, ambiguous: false, samples: [] };
      if (start) state.tracking.add(state.pending);
    }
    if (detail.type === 'committed' && detail.detail !== 'forward') {
      state.olderCommittedPages++;
      const tracked = state.pending; state.pending = null;
      setTimeout(() => {
        if (!tracked?.start) { state.pageChecks.push({ retained: false, noAnchorAtRequest: true }); return; }
        samplePending(tracked); state.tracking.delete(tracked);
        const raw = tracked.previous.offset - tracked.start.offset;
        const virtualList = tracked.port?.querySelector('[data-chat-virtual-rows]');
        const rowSizes = [...(virtualList?.querySelectorAll('[data-chat-virtual-row]') ?? [])]
          .map(row => row.querySelectorAll('[data-chat-node-key]').length);
        state.pageChecks.push({ retained: tracked.retained, sameScroller: tracked.sameScroller,
          loss: tracked.loss,
          anchorKind: ['turn-process', 'assistant-step', 'user', 'tool-call'].includes(tracked.anchor?.node?.dataset.chatFlowKind)
            ? tracked.anchor.node.dataset.chatFlowKind : tracked.anchor?.node?.hasAttribute('data-chat-group-key') ? 'group' : 'other',
          rawDrift: Math.abs(raw), readerDelta: tracked.readerDelta,
          drift: Math.abs(raw - tracked.readerDelta), ambiguous: tracked.ambiguous,
          mountedVirtualRows: virtualList?.querySelectorAll('[data-chat-virtual-row]').length ?? null,
          mountedChatNodes: tracked.port?.querySelectorAll('[data-chat-node-key]').length ?? null,
          maxChatNodesInOneVirtualRow: Math.max(0, ...rowSizes),
          start: { top: tracked.start.top, height: tracked.start.height, offset: tracked.start.offset },
          end: { top: tracked.previous.top, height: tracked.previous.height, offset: tracked.previous.offset },
          samples: tracked.samples.length <= 12 ? tracked.samples : [...tracked.samples.slice(0, 2), ...tracked.samples.slice(-10)] });
      }, 250);
    }
  });
  window.addEventListener('hapi-dsh:interrupted-prepend-commit', event => {
    if (!state.active || !(event.target instanceof Element)
      || event.target.closest('.hapi-pane')?.dataset.paneId !== state.paneId) return;
    state.anchorCommits.push(event.detail);
  });
  const tick = timestamp => {
    for (const tracked of state.tracking) samplePending(tracked);
    if (state.monitorFrames || state.direction) {
      if (state.previousFrameAt !== null) state.frameIntervals.push(timestamp - state.previousFrameAt);
      state.previousFrameAt = timestamp;
    } else state.previousFrameAt = null;
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
    events: {}, pageErrors: 0, conversationErrors: 0, rpcErrors: 0, attachmentFallbacks: 0, blockedWrites: 0, blockedWebSocketSends: 0, isolatedWorkspaceWrites: 0,
    isolatedReadStateWrites: 0, isolatedPresence: 0, isolatedInspectManifests: 0,
    maxPageAnchorDriftPx: 0, maxRawPageAnchorDriftPx: 0, pageGeometry: [], duplicateRangeReads: 0,
    roundTripDriftPx: null, blockedRpcKinds: [], rpcErrorKinds: [], historyRpcErrors: 0, historyStreamErrors: 0 };
  const started = performance.now(); let context, page, deadline, targetId, previousRequestCursor, profileSession, profileActive = false;
  let timedOut = false, collecting = false, pages = [], pendingResponses = new Set(), cdp, prefetchedBeforeReading;
  const websocketStreams = new Map();
  const loadedCuts = new Set();
  const blocked = method => {
    result.blockedWrites++;
    // Public method names only. Never retain request arguments or full paths.
    const category = publicMethod(method);
    if (!result.blockedRpcKinds.includes(category)) result.blockedRpcKinds.push(category);
  };
  const check = () => {
    if (result.blockedWrites || result.blockedWebSocketSends) fail('unexpected-write-blocked');
    if (result.pageErrors) fail('page-exception');
    if (result.conversationErrors) fail('conversation-publication-failed');
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
    const target = sourceTarget(await bootstrap('hapi/catalog', {}), config.title, config.sessionOccurrence);
    const resolved = await bootstrap('hapi/sourceSessionResolve', { request: target });
    targetId = resolved?.sessionId;
    if (!sourceId(targetId) || resolved.hubId !== target.hubId || resolved.sourceSessionId !== target.sourceSessionId) fail('target-bootstrap-identity-mismatch');
    await context.addInitScript(({ origin, sessionId }) => {
      if (location.origin === origin) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }));
    }, { origin: appUrl.origin, sessionId: targetId });
    appUrl.searchParams.set('hapiSession', target.sourceSessionId);
    appUrl.searchParams.set('hapiHub', target.hubId);
    result.initialSelection = 'authenticated-real-source';
    await context.addInitScript(installObserver, { readStreams: [...readStreams] });
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
    page = await context.newPage();
    await page.exposeBinding('historySmokeBlockedWebSocket', () => { result.blockedWebSocketSends++; });
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const socketUrls = new Map();
    cdp.on('Network.webSocketCreated', event => socketUrls.set(event.requestId, event.url));
    cdp.on('Network.webSocketFrameSent', event => {
      const url = socketUrls.get(event.requestId), message = parseSocketMessage(event.response?.payloadData);
      if (!url || !message) return;
      const policy = streamPolicy(new URL(url).pathname, message);
      if (policy === 'isolate-presence') result.isolatedPresence++;
      if (policy !== 'read' || message.type !== 'open') return;
      const args = message.payload?.args, targetHistory = isTargetHistoryRpc(message.endpoint, args, targetId);
      const request = args?.request;
      const historyPage = targetHistory && message.endpoint === 'hapi/sourceHistoryWindowPageStream'
        && request?.sessionId === targetId ? { request, frameCount: 0, types: {}, completed: false, startedAt: performance.now() } : undefined;
      if (historyPage && collecting) (result.targetReadRequests ??= []).push({ method: message.endpoint, status: 'stream-open',
        cursor: request.beforeAt !== undefined ? 'before' : 'other', requestSessionMatch: true,
        argSessionMatch: args?.sessionId === targetId, limit: request.limit, contentType: 'websocket' });
      const streams = websocketStreams.get(event.requestId) ?? new Map();
      streams.set(message.streamId, { method: message.endpoint, targetHistory, historyPage });
      websocketStreams.set(event.requestId, streams);
    });
    cdp.on('Network.webSocketFrameReceived', event => {
      const message = parseSocketMessage(event.response?.payloadData);
      if (!message) return;
      const active = websocketStreams.get(event.requestId)?.get(message.streamId), historyPage = active?.historyPage;
      if (historyPage && message.type === 'item') {
        const item = message.value;
        if (item?.kind === 'frames' && Array.isArray(item.frames)) {
          historyPage.frameCount += item.frames.length;
          for (const frame of item.frames) {
            const type = ['user/message', 'assistant/message', 'turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result'].includes(frame.event?.type)
              ? frame.event.type : 'other';
            historyPage.types[type] = (historyPage.types[type] ?? 0) + 1;
          }
        }
        else if (item?.kind === 'complete' && item.value) {
          const request = historyPage.request, cursor = { at: request.beforeAt, seq: request.beforeSeq };
          const next = item.value.before;
          const error = !Number.isFinite(cursor.at) || !Number.isInteger(cursor.seq) || !olderCursor(cursor, next)
            ? 'cursor-did-not-advance' : collecting && previousRequestCursor && !olderCursor(previousRequestCursor, cursor)
              ? 'request-cursor-did-not-advance' : historyPage.frameCount === 0 ? 'empty-source-page' : undefined;
          if (error === 'request-cursor-did-not-advance') result.duplicateRangeReads++;
          const record = { error, status: 200, limit: request.limit, frameCount: historyPage.frameCount, types: historyPage.types,
            durationMs: Math.round(performance.now() - historyPage.startedAt) };
          if (collecting) {
            if (!error) previousRequestCursor = cursor;
            pages.push(record);
          } else prefetchedBeforeReading = { cursor, record };
          historyPage.completed = true;
          result.pageTypes = pages.map(page => page.types);
        }
      }
      if (message.type === 'error' && active?.targetHistory) {
        result.historyStreamErrors++;
        if (historyPage && !historyPage.completed) pages.push({ error: 'stream-error', status: 0, frameCount: historyPage.frameCount,
          durationMs: Math.round(performance.now() - historyPage.startedAt) });
      }
      if (collecting && message.type === 'end' && historyPage && !historyPage.completed) {
        pages.push({ error: 'stream-ended-before-cursor', status: 200, frameCount: historyPage.frameCount,
          durationMs: Math.round(performance.now() - historyPage.startedAt) });
      }
    });
    page.on('pageerror', () => result.pageErrors++);
    // Publication listeners catch assembler failures, so pageerror alone does
    // not observe a frozen Conversation. Count this known boundary without
    // copying the error text, which may contain private source identities.
    page.on('console', message => {
      if (message.type() === 'error' && message.text().includes('[hapi-dsh] source event subscriber failed:')) result.conversationErrors++;
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (!url.pathname.includes('/api/')) return;
      const task = (async () => {
        const method = url.pathname.replace(/^.*\/api\//, '');
        let args; try { args = response.request().postDataJSON()?.payload?.args; } catch {}
        const targetHistory = isTargetHistoryRpc(method, args, targetId);
        if (collecting && targetHistory) {
          const request = args?.request;
          (result.targetReadRequests ??= []).push({ method, status: response.status(),
            cursor: request?.beforeAt !== undefined ? 'before' : request?.afterAt !== undefined ? 'after'
              : request?.messageId !== undefined ? 'context' : 'head',
            requestSessionMatch: request?.sessionId === targetId, argSessionMatch: args?.sessionId === targetId,
            limit: request?.limit,
            contentType: response.headers()['content-type']?.split(';', 1)[0] ?? 'missing' });
        }
        if (collecting && targetHistory && method === 'hapi/sourceHistoryWindowPage'
          && args?.request?.sessionId === targetId) {
          const request = args.request;
          const cursor = { at: request.beforeAt, seq: request.beforeSeq };
          const validCursor = Number.isFinite(cursor.at) && Number.isInteger(cursor.seq);
          const cut = JSON.stringify([request.beforeAt, request.beforeSeq, request.afterAt, request.afterSeq,
            request.messageId, request.fromOldest]);
          let error = response.status() >= 400 ? `http-${response.status()}` : !validCursor ? 'invalid-source-cursor'
            : previousRequestCursor && !olderCursor(previousRequestCursor, cursor) ? 'request-cursor-did-not-advance'
              : loadedCuts.has(cut) ? 'duplicate-source-range' : undefined;
          if (loadedCuts.has(cut)) result.duplicateRangeReads++;
          loadedCuts.add(cut);
          if (validCursor && (!previousRequestCursor || !error)) previousRequestCursor = cursor;
          let frameCount = null;
          try {
            const payload = await response.json();
            frameCount = Array.isArray(payload.result?.value?.frames) ? payload.result.value.frames.length : null;
          } catch { /* The status and cursor remain the acceptance evidence. */ }
          pages.push({ error, status: response.status(), frameCount });
          if (response.status() >= 400) rpcError(method, response.status(), true);
          return;
        }
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
      })().catch(() => { rpcError(url.pathname.replace(/^.*\/api\//, ''), response.status(), false); });
      pendingResponses.add(task); void task.finally(() => pendingResponses.delete(task));
    });
    result.step = 'navigate';
    await page.goto(appUrl.href, { waitUntil: 'domcontentloaded', timeout: Math.min(20_000, config.timeoutMs) });
    result.step = 'select-source';
    await page.locator('[data-hapi-workspace]').waitFor({ state: 'visible' });
    const selectedTarget = page.locator(`.hapi-pane-focused[data-session-id="${targetId}"]`);
    const selectedByLink = await selectedTarget.waitFor({ state: 'attached', timeout: 3_000 }).then(() => true, () => false);
    if (!selectedByLink) {
    const sidebar = page.locator('.hapi-session-sidebar:visible');
    if (!await sidebar.count()) {
      const opener = name === 'mobile' ? page.locator('.hapi-mobile-back:visible') : page.locator('.hapi-session-rail button:visible');
      await opener.first().click();
    }
    await sidebar.waitFor({ state: 'visible' });
    if (!await sidebar.locator('input[type="search"]').count()) await sidebar.locator('.hapi-search-chip > button').first().click();
    await sidebar.locator('input[type="search"]').fill(config.title);
    const row = sidebar.locator(`[data-session-row="${targetId}"] .hapi-session-open`);
    await row.first().waitFor({ state: 'visible' });
    if (await row.count() !== 1) fail('target-title-ambiguous');
    const actualSource = await row.evaluate(button => !!button.closest('[data-hapi-discovered-source]')
      || /^hapi-(?:codex|observed)-/.test(button.closest('[data-session-row]')?.dataset.sessionRow ?? ''));
    if (!actualSource) fail('target-is-not-source');
    await row.click();
    }
    result.step = 'source-ready';
    const pane = page.locator('.hapi-pane-focused[data-hapi-pane-visible="true"]');
    await pane.locator('[data-hapi-session-reveal="ready"]').waitFor({ state: 'visible' });
    const port = pane.locator('[data-hapi-session-reveal="ready"] [data-conversation-scroll]');
    await port.waitFor({ state: 'visible' });
    await pane.locator('[data-hapi-session-reveal="ready"] [data-composer-input]').waitFor({ state: 'visible' });
    if (!await pane.locator('[data-hapi-session-reveal="ready"] [data-composer-input]').isEditable()) fail('editor-not-editable');
    if (await pane.getAttribute('data-session-id') !== targetId) fail('opened-wrong-source');
    await pane.locator('[data-conversation-content] [data-chat-node-key]:visible, [data-conversation-content] [data-chat-anchor-key]:visible')
      .first().waitFor({ state: 'visible' });
    if (!await pane.locator('[data-hapi-mounted-chat]').count()) fail('mounted-reader-not-registered');
    const paneId = await pane.getAttribute('data-pane-id');
    await page.evaluate(paneId => { window.__historySmoke.paneId = paneId; window.__historySmoke.active = true; }, paneId);
    if (prefetchedBeforeReading) {
      pages.push(prefetchedBeforeReading.record);
      previousRequestCursor = prefetchedBeforeReading.cursor;
    }
    collecting = true;
    if (config.cpuProfile) {
      try {
        profileSession = cdp;
        await profileSession.send('Profiler.enable');
        await profileSession.send('Profiler.start');
        profileActive = true;
      } catch { profileSession = undefined; }
    }
    const move = async (pixels, quick = false) => {
      const box = await port.boundingBox(); if (!box) fail('scrollport-disappeared');
      if (name !== 'mobile') {
        await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4);
        await page.mouse.wheel(0, pixels);
      } else {
        const distance = Math.min(Math.abs(pixels), Math.min(box.height * .45, 250));
        const x = box.x + box.width * .6, start = box.y + box.height * (pixels < 0 ? .25 : .7);
        const points = y => [{ x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) });
        const steps = quick ? 5 : 10;
        for (let index = 1; index <= steps; index++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(start - Math.sign(pixels) * distance * index / steps) });
          await pause(quick ? 12 : 20);
        }
        await pause(quick ? 60 : 80);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      await pause(quick ? 80 : 180);
    };
    const collectChecks = async () => {
      const state = await page.evaluate(() => ({ events: window.__historySmoke.events,
        checks: window.__historySmoke.pageChecks, anchorCommits: window.__historySmoke.anchorCommits,
        sourceFeedChanges: window.__historySmoke.sourceFeedChanges,
        sourceFeedSamples: window.__historySmoke.sourceFeedSamples,
        blockedWebSocketSends: window.__historySmoke.blockedWebSocketSends,
        isolatedPresence: window.__historySmoke.isolatedPresence,
        coordinateRebases: window.__historySmoke.coordinateRebases,
        nestedHistoryScrollports: [...document.querySelectorAll('.hapi-pane-focused [data-step-process-body]')]
          .filter(element => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))
          .map(element => ({ overflowY: getComputedStyle(element).overflowY,
            canConsumeScroll: element.scrollHeight > element.clientHeight + 1 })) }));
      result.events = state.events; result.pageGeometry = state.checks; result.anchorCommits = state.anchorCommits;
      result.blockedWebSocketSends = state.blockedWebSocketSends;
      result.isolatedPresence = state.isolatedPresence;
      result.blockedWebSocketSends = state.blockedWebSocketSends;
      result.isolatedPresence = state.isolatedPresence;
      result.nestedHistoryScrollports = state.nestedHistoryScrollports;
      result.sourceFeedChanges = state.sourceFeedChanges;
      result.sourceFeedSamples = state.sourceFeedSamples;
      result.coordinateRebases = state.coordinateRebases;
      result.pageAvailability = pages.map(page => ({ status: page.status, error: page.error ?? null,
        frameCount: page.frameCount ?? null, durationMs: page.durationMs ?? null }));
      result.maxPageAnchorDriftPx = Math.max(0, ...state.checks.map(check => check.drift ?? 0));
      result.maxRawPageAnchorDriftPx = Math.max(0, ...state.checks.map(check => check.rawDrift ?? 0));
      result.olderPages = await page.evaluate(() => window.__historySmoke.olderCommittedPages);
      return state;
    };
    await page.evaluate(() => { const state = window.__historySmoke; state.direction = 0; state.longTasks = [];
      state.sourceFeedChanges = { replace: 0, prepend: 0, append: 0, unchanged: 0 }; state.sourceFeedSamples = []; state.coordinateRebases = [];
      state.monitorFrames = true; state.previousFrameAt = null; });
    result.readablePages = 0;
    // Three pages missed reports that start smoothly and stall only after
    // repeated reading. Keep both scenarios bounded by the same 60s deadline.
    while (result.readablePages < 6) {
      result.step = `readable-page-${result.readablePages + 1}`; check();
      const before = result.olderPages;
      const readingHead = await page.evaluate(() => window.__historySmoke.sample()?.rows[0]?.key ?? null);
      const count = await page.evaluate(() => window.__historySmoke.pageChecks.length);
      // Repeated, ordinary wheel increments drive the actual boundary. A single
      // giant wheel delta can land just outside the one-viewport prefetch lead
      // after the prior prepend's anchor compensation and falsely look like a
      // missing next page.
      const requested = await page.evaluate(() => window.__historySmoke.events.requested ?? 0);
      const gestures = [];
      // Long source sessions can begin thousands of pixels from the history
      // edge. A fixed 16 x 250px budget timed out before it ever exercised a
      // page request, which mislabeled a scroll distance as a paging failure.
      let earlierContent = false;
      while (performance.now() - started < config.timeoutMs) {
        const topBefore = await port.evaluate(element => element.scrollTop);
        await move(name === 'mobile' ? -1200 : -240, name === 'mobile');
        const state = await page.evaluate(() => {
          const port = document.querySelector('.hapi-pane-focused [data-hapi-session-reveal="ready"] [data-conversation-scroll]');
          return { top: port?.scrollTop ?? null, anchorOwned: port?.hasAttribute('data-hapi-interrupted-prepend') ?? false,
            maxTop: port ? port.scrollHeight - port.clientHeight : null,
            requested: window.__historySmoke.events.requested ?? 0,
            committed: window.__historySmoke.olderCommittedPages, input: window.__historySmoke.input,
            readingHead: window.__historySmoke.sample()?.rows[0]?.key ?? null };
        });
        gestures.push({ topBefore: Math.round(topBefore), topAfter: Math.round(state.top ?? 0),
          maxTop: Math.round(state.maxTop ?? 0),
          anchorOwned: state.anchorOwned, requests: state.requested,
          inputDirection: state.input?.direction ?? null, inputPixels: Math.round(state.input?.pixels ?? 0) });
        result.gestureDiagnostics = [...gestures];
        if (await page.evaluate(() => (window.__historySmoke.events.failed ?? 0) > 0)) fail('seamless-page-failed');
        earlierContent = state.committed > before && state.readingHead !== null && state.readingHead !== readingHead;
        if (earlierContent) break;
      }
      if (!earlierContent) fail('earlier-readable-content-unavailable');
      await page.waitForFunction(count => window.__historySmoke.pageChecks.length > count
        || (window.__historySmoke.events.failed ?? 0) > 0, count, { timeout: 10_000 });
      await Promise.all([...pendingResponses]); check();
      const committed = await page.evaluate(() => window.__historySmoke.olderCommittedPages);
      if (committed === before) fail('page-cached-or-not-requested');
      // A source page read can be prefetched ahead of use. Count only pages
      // whose visible prepend has committed, while retaining all read results
      // for cursor/error diagnostics.
      await page.waitForFunction(count => window.__historySmoke.pageChecks.length >= count
        || (window.__historySmoke.events.failed ?? 0) > 0, committed, { timeout: 3_000 });
      const state = await collectChecks();
      if (state.nestedHistoryScrollports.length) fail('nested-history-scrollport');
      const pageLimitError = assessPageLimits((result.targetReadRequests ?? []).filter(request =>
        ['hapi/sourceHistoryWindowPage', 'hapi/sourceHistoryWindowPageStream'].includes(request.method) && request.cursor === 'before'));
      if (pageLimitError) fail(pageLimitError);
      const error = assessCommittedPages(pages, state.checks, state.events, before + 1);
      if (error) fail(error);
      result.readablePages++;
    }
    if (profileActive) {
      try {
        const profile = (await profileSession.send('Profiler.stop')).profile;
        profileActive = false;
        const profileNodes = new Map(profile.nodes.map(node => [node.id, node]));
        const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
        const parents = new Map();
        for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
        const totals = new Map(), sampleCounts = new Map();
        profile.samples.forEach((nodeId, index) => {
          totals.set(nodeId, (totals.get(nodeId) ?? 0) + (profile.timeDeltas[index] ?? 0));
          sampleCounts.set(nodeId, (sampleCounts.get(nodeId) ?? 0) + 1);
        });
        result.cpuProfileTop = [...totals].map(([id, micros]) => {
          const frame = nodes.get(id), stack = [];
          let current = id;
          while (current !== undefined && stack.length < 7) {
            const ancestor = profileNodes.get(current)?.callFrame;
            if (ancestor) stack.unshift(`${ancestor.functionName || '(anonymous)'}@${ancestor.lineNumber + 1}:${ancestor.columnNumber + 1}`);
            current = parents.get(current);
          }
          return {
          function: frame?.functionName || '(anonymous)',
          script: frame?.url ? new URL(frame.url).pathname.split('/').at(-1) : '',
          line: (frame?.lineNumber ?? -1) + 1,
          column: (frame?.columnNumber ?? -1) + 1,
          samples: sampleCounts.get(id) ?? 0,
          selfMs: Math.round(micros / 1000),
          stack,
        }}).sort((left, right) => right.selfMs - left.selfMs).slice(0, 24);
      } catch { /* The browser may not expose sampling profiles. */ }
    }
    const pagingFrames = await page.evaluate(() => {
      const state = window.__historySmoke; state.direction = 0; state.monitorFrames = false; state.previousFrameAt = null;
      return { maxFrameGapMs: Math.max(0, ...state.frameIntervals), over50ms: state.frameIntervals.filter(gap => gap > 50).length,
        longTasks: state.longTasks };
    });
    result.pagingFrames = { maxFrameGapMs: Math.round(pagingFrames.maxFrameGapMs), over50ms: pagingFrames.over50ms,
      longTasks: pagingFrames.longTasks };
    if (pagingFrames.maxFrameGapMs > 80) fail('page-scroll-frame-hitch');
    await page.evaluate(() => { window.__historySmoke.motion = []; window.__historySmoke.frameIntervals = []; });
    result.step = 'round-trip-reading';
    const duplicateReadsBefore = result.duplicateRangeReads;
    await page.evaluate(() => { window.__historySmoke.bookmark = window.__historySmoke.captureBookmark(); });
    for (const direction of [-1, 1]) {
      // Later first, then earlier, returning over the same already loaded text.
      await page.evaluate(direction => { window.__historySmoke.direction = direction; }, direction);
      for (let index = 0; index < (direction === -1 ? 3 : 8); index++) {
        await move(direction === -1 ? 180 : -180);
        if (direction === 1 && await page.evaluate(() => {
          const state = window.__historySmoke;
          return state.bookmarkState().returned && state.motion.filter(frame => frame.direction === 1)
            .reduce((total, frame) => total + frame.dy, 0) >= 150;
        })) break;
      }
      await pause(250);
      await page.evaluate(() => { window.__historySmoke.direction = 0; });
    }
    const measured = await page.evaluate(() => {
      const state = window.__historySmoke, offset = state.anchorOffset(state.bookmark);
      const motion = state.motion;
      return { events: state.events, roundTrip: offset !== null && state.bookmark ? Math.abs(offset - state.bookmark.offset) : null,
        ...state.bookmarkState(),
        blankFrames: motion.filter(frame => frame.blank).length,
        unpairedFrames: motion.filter(frame => !frame.paired).length,
        up: motion.filter(frame => frame.direction === 1).reduce((total, frame) => total + frame.dy, 0),
        down: motion.filter(frame => frame.direction === -1).reduce((total, frame) => total - frame.dy, 0),
        reverse: Math.max(0, ...motion.map(frame => -frame.dy * frame.direction)),
        jumpRatio: Math.max(0, ...motion.map(frame => Math.abs(frame.dy) / frame.viewport)),
        maxFrameGapMs: Math.max(0, ...state.frameIntervals),
        frameOver50ms: state.frameIntervals.filter(gap => gap > 50).length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
        visibleError: !!document.querySelector('.hapi-pane-focused [data-hapi-seamless="error"], .hapi-pane-focused [data-hapi-seamless="suspended"]') };
    });
    result.events = measured.events;
    result.roundTripDriftPx = measured.roundTrip;
    result.reading = { upPx: Math.round(measured.up), downPx: Math.round(measured.down),
      maxReversePx: Math.round(measured.reverse), maxFrameViewportRatio: measured.jumpRatio,
      maxFrameGapMs: Math.round(measured.maxFrameGapMs), frameOver50ms: measured.frameOver50ms,
      blankFrames: measured.blankFrames, unpairedFrames: measured.unpairedFrames,
      retained: measured.retained, sameOrder: measured.sameOrder, returned: measured.returned };
    const readingError = assessReading({ ...measured, duplicateReads: result.duplicateRangeReads - duplicateReadsBefore });
    if (readingError) fail(readingError);
    result.step = 'latest-return-cached-reading';
    const latest = pane.getByRole('button', { name: /^(回到底部|Back to bottom)$/ }).first();
    await latest.click();
    await page.waitForFunction(() => !!document.querySelector('.hapi-pane-focused [data-chat-following-tail]'),
      undefined, { timeout: 5_000 });
    const cachedReadsBefore = (result.targetReadRequests ?? []).filter(request => request.cursor === 'before').length;
    const cachedStart = await port.evaluate(element => element.scrollTop);
    const cachedHead = await page.evaluate(() => window.__historySmoke.sample()?.rows[0]?.key ?? null);
    for (let index = 0; index < 3; index++) await move(-180);
    await Promise.all([...pendingResponses]);
    const cachedEnd = await port.evaluate(element => element.scrollTop);
    const cachedAfter = await page.evaluate(() => ({ head: window.__historySmoke.sample()?.rows[0]?.key ?? null,
      pending: !!window.__historySmoke.pending, failed: window.__historySmoke.events.failed ?? 0 }));
    const cachedReadsAfter = (result.targetReadRequests ?? []).filter(request => request.cursor === 'before').length;
    result.latestReturnCache = { upPx: Math.round(cachedStart - cachedEnd),
      olderRequests: cachedReadsAfter - cachedReadsBefore, earlierContent: !!cachedAfter.head && cachedAfter.head !== cachedHead,
      pending: cachedAfter.pending };
    if (cachedReadsAfter !== cachedReadsBefore) fail('resident-tail-history-read-again');
    if (cachedStart - cachedEnd < 150 || !result.latestReturnCache.earlierContent || cachedAfter.pending || cachedAfter.failed) {
      fail('resident-tail-history-unavailable');
    }
    if (measured.horizontalOverflow) fail('horizontal-overflow');
    if (measured.visibleError || (measured.events.failed ?? 0) || (measured.events.suspended ?? 0)) fail('visible-history-error');
    await page.waitForFunction(() => !window.__historySmoke.pending && !window.__historySmoke.tracking.size
      || (window.__historySmoke.events.failed ?? 0) > 0, undefined, { timeout: 3_000 });
    await Promise.all([...pendingResponses]);
    const finalState = await collectChecks();
    if (finalState.nestedHistoryScrollports.length) fail('nested-history-scrollport');
    const finalError = assessCommittedPages(pages, finalState.checks, finalState.events);
    if (finalError) fail(finalError);
    check(); result.status = 'passed'; result.step = 'complete';
  } catch (error) {
    result.status = 'failed';
    result.error = timedOut ? 'scene-budget-exhausted' : result.blockedWrites ? 'unexpected-write-blocked' : error.smokeCode ?? (error.name === 'TimeoutError' ? 'step-timeout' : 'interaction-failed');
    if (page && !page.isClosed()) {
      result.events = await page.evaluate(() => window.__historySmoke?.events ?? {}).catch(() => result.events);
      result.diagnostics = await page.evaluate(() => ({ focusedPanes: document.querySelectorAll('.hapi-pane-focused').length,
        readyPanes: document.querySelectorAll('.hapi-pane-focused [data-hapi-session-reveal="ready"]').length,
        loadingPanes: document.querySelectorAll('.hapi-pane-focused [data-hapi-session-loading]').length,
        failedMarkers: document.querySelectorAll('[data-hapi-seamless="error"], [data-hapi-seamless="suspended"]').length,
        failureReasons: window.__historySmoke?.failureReasons,
        mountedControls: document.querySelectorAll('.hapi-pane-focused [data-hapi-mounted-chat], .hapi-pane-focused[data-hapi-mounted-chat]').length,
        mountedMarks: performance.getEntriesByType('mark').filter(entry => ['hapi-dsh:mounted-chat:control', 'hapi-dsh:mounted-chat:unmounted', 'hapi-dsh:pane-native:with-pane', 'hapi-dsh:pane-native:no-pane'].includes(entry.name)).map(entry => entry.name),
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
  if (process.argv.includes('--help')) process.stdout.write('Usage: node scripts/test-history-smoke.mjs [--session-title TITLE] [--session-occurrence N] [--scenario both|desktop|mobile] [--url-file FILE] [--timeout-ms 1..60000] [--report FILE] [--cpu-profile]\nCPU profiling is opt-in because the profiler perturbs frame-time measurements. Default target: HAPI_DSH_SMOKE_SESSION_TITLE or ~/.config/hapi-dsh/smoke-session-title. Occurrence disambiguates duplicate titles in catalog order. Requires the external webshot Playwright runtime.\n');
  else await main();
}
