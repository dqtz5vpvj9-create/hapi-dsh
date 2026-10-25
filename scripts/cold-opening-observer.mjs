/**
 * Runs before application code. It records the whole opening and the reader
 * interactions that follow, not just first paint.
 *
 * Product acceptance rules implemented here:
 * - A painted body is never allowed to be unusable for even one frame. The
 *   sampler runs after paint, so a same-task React assembly completed before
 *   paint is not a product state. A frame actually painted partial is recorded
 *   immediately (no 100 ms allowance).
 * - Editor, scroll-root and visible-view identity use finite per-node counters,
 *   not WeakMap.size. A visible successor after first presentation is a
 *   replacement, not a successful opening.
 * - Latest-marker loss is intentional only with a trusted wheel/touch/key
 *   gesture, a committed history page, or a committed navigation target.
 *   Normal live appends that keep the old marker attached are not replacements.
 *   A nonempty body swap with no reader intent fails even without staleText.
 * - History/navigation/editor capabilities need action evidence, not just DOM
 *   existence or scrollHeight > clientHeight.
 * - Observation continues through the required post-sync window. 6 s and 20 s
 *   checkpoints are retained, so final recovery cannot erase a failure.
 */
export function installColdOpeningObserver(options = {}) {
  const selector = options.paneSelector ?? '.hapi-pane-focused, .hapi-pane';
  const expectedTitle = options.expectedTitle?.trim();
  const expectedText = options.expectedText;
  const staleText = options.staleText;
  const expectedViewId = options.expectedViewId?.trim();
  const expectedNavigationText = options.expectedNavigationText;
  const navigationAction = options.navigationAction === 'return-latest' ? 'return-latest' : 'unvisited-target';
  const stableMs = options.stableMs ?? 750;
  // Product acceptance is full by default. A sampler-mechanics test may
  // explicitly narrow its fixture; no production probe has to opt in.
  const requiresHistory = options.requiresHistory !== false;
  const navigationRequirement = options.requiresNavigation ?? 'auto';
  const fullCapabilities = options.fullCapabilities !== false;
  const requireEditorInput = options.requireEditorInput ?? fullCapabilities;
  const requireLiveUpdate = options.requireLiveUpdate ?? fullCapabilities;
  const requireHistoryAction = options.requireHistoryAction ?? (fullCapabilities && requiresHistory);
  const requireNavigationAction = options.requireNavigationAction ?? (fullCapabilities && navigationRequirement === true);
  const observeAfterReadyMs = Math.max(0, options.observeAfterReadyMs ?? 30_000);
  const failureDeadlineMs = Math.max(1, options.failureDeadlineMs ?? 60_000);
  const checkpointsMs = [...(options.checkpointsMs ?? [6_000, 20_000])].filter(value => Number.isFinite(value) && value >= 0);
  const bodySampleMs = Math.max(16, options.bodySampleMs ?? 100);
  const maxTailRows = Math.max(16, options.maxTailRows ?? 96);
  const states = [], titles = [], tasks = [];
  const first = { workspace: null, title: null, body: null, editor: null, latest: null, input: null, live: null,
    history: null, navigation: null, ready: null, full: null, stable: null, partial: null };
  const observation = { startedAt: performance.now(), firstFullAt: null, completeAt: null, complete: false,
    deadlineAt: 0, deadlineMissed: false, stoppedEarly: false, lastSyncActivityAt: null, lastBodyUpdateAt: null, checkpoints: [] };
  observation.deadlineAt = observation.startedAt + failureDeadlineMs;

  const titleIds = new Map(), documentTitleIds = new Map();
  const nodeIds = new WeakMap();
  let nextNodeId = 0;
  const identityOf = value => {
    if (!(value instanceof Element)) return 0;
    let id = nodeIds.get(value);
    if (id === undefined) { id = ++nextNodeId; nodeIds.set(value, id); }
    return id;
  };
  const hashText = value => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return hash >>> 0;
  };
  const keyHash = row => hashText(row?.dataset?.chatAnchorKey ?? row?.dataset?.chatNodeKey ?? '');
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const revision = (map, value) => {
    if (!map.has(value)) map.set(value, map.size + 1);
    return map.get(value);
  };
  const titleKind = title => !title ? 'missing' : /^(?:untitled(?: session| conversation)?|未命名(?:会话|对话)?|无标题)$/i.test(title)
    ? 'placeholder' : expectedTitle && title === expectedTitle ? 'expected' : 'other';
  const normalizedTitle = value => value.replace(/^(?:Pane|窗格)[:：]\s*/, '').trim();
  const titleOf = node => normalizedTitle(node?.getAttribute('aria-label') ?? '');
  const intersects = (a, b) => a.width > 0 && a.height > 0 && a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
  const screen = () => ({ top: 0, left: 0, bottom: innerHeight, right: innerWidth });
  const visible = (node, clip = screen()) => {
    // A preparing surface can have layout boxes under an opacity:0 ancestor.
    // Its descendants' computed opacity is still 1. Keep inert content
    // visually readable here; the editor usability check rejects inert.
    if (!(node instanceof Element) || !node.isConnected) return false;
    try { if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false; } catch { /* old engines */ }
    const rect = node.getBoundingClientRect();
    return intersects(rect, clip) && intersects(rect, screen());
  };
  const currentPane = () => options.paneSelector
    ? [...document.querySelectorAll(selector)].find(node => visible(node))
    : [...document.querySelectorAll('.hapi-pane-focused')].find(node => visible(node))
      ?? [...document.querySelectorAll('.hapi-pane')].find(node => visible(node));
  const rangeFor = (roots, needle) => {
    if (!needle) return undefined;
    const nodes = [];
    let text = '';
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) { nodes.push({ node, offset: text.length }); text += node.textContent ?? ''; }
    }
    const start = text.indexOf(needle);
    if (start < 0) return undefined;
    const end = start + needle.length;
    const from = nodes.find(row => row.offset + row.node.textContent.length > start);
    const to = nodes.find(row => row.offset + row.node.textContent.length >= end);
    if (!from || !to) return undefined;
    const range = document.createRange();
    range.setStart(from.node, start - from.offset); range.setEnd(to.node, end - to.offset);
    return range;
  };
  const rangeCurrent = (range, needle) => Boolean(range?.startContainer.isConnected && cachedFlow?.contains(range.startContainer)
    && cachedFlow.contains(range.endContainer) && !range.collapsed && range.toString() === needle);
  const rangeVisible = (range, clip) => Boolean(range?.startContainer.isConnected && clip
    && visible(range.startContainer.parentElement, clip)
    && [...range.getClientRects()].some(rect => intersects(rect, clip) && intersects(rect, screen())));
  const findOlderControl = flow => {
    if (!flow) return null;
    // The official column puts the one-button older-history wrapper directly
    // under the flow column. This is a path, not proof that paging works.
    for (const child of Array.from(flow.children)) {
      if (child instanceof HTMLButtonElement) return child;
      if (child.children.length === 1 && child.firstElementChild instanceof HTMLButtonElement) return child.firstElementChild;
    }
    return null;
  };

  const turnLabel = value => /jump to turn|load and jump|跳转到第|加载并跳转/i.test(value ?? '');
  const findRail = pane => {
    if (!pane) return null;
    const navs = [...pane.querySelectorAll('nav[aria-label]')].filter(nav => visible(nav));
    return navs.find(nav => /turn navigation|轮次导航/i.test(nav.getAttribute('aria-label') ?? ''))
      ?? navs.find(nav => [...nav.querySelectorAll('button')].some(button => turnLabel(button.getAttribute('aria-label') ?? '')))
      ?? null;
  };
  const clickKind = label => /load and jump|加载并跳转/i.test(label ?? '') ? 'load-jump'
    : /jump to turn|跳转到第/i.test(label ?? '') ? 'jump'
      : /to bottom|回到(?:底部|最新)/i.test(label ?? '') ? 'to-bottom' : 'other';

  // Evidence stays numeric/boolean/hashed. No transcript text, node ids or
  // session ids are persisted in the trace by the observer itself.
  const inputEvidence = { focusAt: null, focusTrusted: false, trustedKeys: 0, printableKeys: 0, firstPrintableAt: null,
    trustedInputs: 0, textHash: 0, textLength: 0, textRevision: 0, everRetained: false, retainedAt: null, lostAt: null,
    lastTextAt: null, lastTrustedKeyAt: null, replacedAt: null };
  const reader = { intents: 0, lastAt: null, lastKind: null, wheel: 0, touch: 0, key: 0, pointer: 0 };
  const historyEvidence = { intents: 0, intentAt: null, lastIntentAt: null, nearTopIntents: 0,
    requestRevision: 0, requestAt: null, observedRevision: 0, commitRevision: 0, commitAt: null,
    domPrependRevision: 0, failureRevision: 0, failureAt: null,
    networkRequests: 0, networkOlder: 0, lastNetworkAt: null, hasMore: false, controlDisabled: null,
    anchorKeyHash: null, anchorOffset: null, anchorRetained: null, anchorDriftPx: null, anchorAt: null };
  const navigationEvidence = { intents: 0, intentAt: null, commitRevision: 0, commitAt: null,
    clickedKind: null, clickedIndex: null, targetVisible: null, beforeBodyRevision: 0, beforeScrollTop: null,
    mode: null, required: false, marks: 0, usable: false, action: navigationAction,
    targetIntents: 0, returnLatestIntents: 0 };

  let stopped = false, frame, rowsDirty = true;
  let cachedPane, cachedView, cachedFlow, cachedPort, cachedEditor, cachedRail, candidates = [];
  let latestRange, staleRange, lastTitle, lastBodySample = -Infinity;
  let bodyVisible = false, bodyText = '', bodyRevisionCounter = 0, visibleBodyCharacters = 0, bodyRowCount = 0;
  let firstKeyHash = 0, lastKeyHash = 0, previousFirstKey = 0, previousLastKey = 0, previousRowCount = 0;
  let historyScrollable = false, historyNavigable = !requiresHistory, navigationRequired = false, navigationUsable = true;
  let navigationMarkCount = 0, viewMatches = true, opening = false, partialRecorded = false, readySince = null, stableSince = null;
  let presented = false, firstEditorId = null, firstPortId = null, firstViewId = null;
  let editorIdentityChanged = false, portIdentityChanged = false, viewIdentityChanged = false;
  let bodyReplacement = false, latestOffscreenUnprompted = false, staleReadyUnprompted = false, openingReappeared = false;
  let editorIgnoredInput = false, draftLost = false, draftReplaced = false;
  let latestEverVisible = false, latestVisibleAt = null, bodyChangedAt = null, readerIntentAt = null, tailAppendedAt = null;
  let firstBodySeen = false, firstBodyWrong = false, contentHash = 0;
  let liveUpdateAt = null, liveRevision = 0, lastEditorText = '', editorTextInitialized = false;
  let anchorRowKey, anchorOffset, touchY = null, previous;

  const noteSyncActivity = at => {
    if (Number.isFinite(at)) observation.lastSyncActivityAt = at;
  };
  const titleChange = (title, at, reason) => {
    if (title === lastTitle) return;
    lastTitle = title;
    titles.push({ at, reason, kind: titleKind(title), revision: revision(titleIds, title), ...(options.captureTitles ? { value: title } : {}) });
    noteSyncActivity(at);
  };
  const captureAnchor = () => {
    if (!cachedPort) { anchorRowKey = undefined; historyEvidence.anchorOffset = null; historyEvidence.anchorKeyHash = null; return; }
    const box = cachedPort.getBoundingClientRect();
    // Hit tests are bounded and avoid scanning a long virtualized history on
    // every wheel. The fallback is the already-bounded candidate set.
    let row;
    const x = clamp((box.left + box.right) / 2, 0, innerWidth - 1);
    for (const fraction of [0.02, 0.15, 0.35, 0.5]) {
      const hit = document.elementFromPoint(x, clamp(box.top + (box.bottom - box.top) * fraction, 0, innerHeight - 1));
      const candidate = hit?.closest?.('[data-chat-anchor-key], [data-chat-node-key]');
      if (candidate instanceof Element && cachedPort.contains(candidate) && !candidate.closest('[hidden]')) { row = candidate; break; }
    }
    row ??= candidates.find(candidate => visible(candidate, box));
    if (!row) { anchorRowKey = undefined; historyEvidence.anchorOffset = null; historyEvidence.anchorKeyHash = null; return; }
    anchorRowKey = row.dataset.chatAnchorKey ?? row.dataset.chatNodeKey ?? '';
    anchorOffset = row.getBoundingClientRect().top - box.top;
    historyEvidence.anchorKeyHash = hashText(anchorRowKey);
    historyEvidence.anchorOffset = anchorOffset;
    historyEvidence.anchorAt = performance.now();
    historyEvidence.anchorRetained = null;
    historyEvidence.anchorDriftPx = null;
  };
  const commitAnchor = () => {
    if (!cachedPort || anchorRowKey === undefined) return;
    const box = cachedPort.getBoundingClientRect();
    let row = candidates.find(candidate => (candidate.dataset.chatAnchorKey ?? candidate.dataset.chatNodeKey) === anchorRowKey);
    row ??= [...cachedPort.querySelectorAll('[data-chat-anchor-key], [data-chat-node-key]')]
      .find(candidate => (candidate.dataset.chatAnchorKey ?? candidate.dataset.chatNodeKey) === anchorRowKey);
    historyEvidence.anchorRetained = Boolean(row);
    historyEvidence.anchorDriftPx = row && anchorOffset !== null ? row.getBoundingClientRect().top - box.top - anchorOffset : null;
  };
  const setReaderIntent = (at, kind) => {
    reader.intents++;
    reader.lastAt = at;
    reader.lastKind = kind;
    reader[kind] = (reader[kind] ?? 0) + 1;
    if (kind === 'wheel' || kind === 'touch' || kind === 'key') readerIntentAt = at;
  };
  const setHistoryIntent = (at, kind) => {
    // A wheel that arrives immediately after a committed page is the natural
    // continuation of the same boundary gesture, not a new uncommitted intent.
    if (historyEvidence.intentAt !== null && historyEvidence.commitAt !== null
      && historyEvidence.commitAt >= historyEvidence.intentAt && at - historyEvidence.commitAt < 3000) return;
    historyEvidence.intents++;
    historyEvidence.intentAt = at;
    historyEvidence.lastIntentAt = at;
    setReaderIntent(at, kind);
    captureAnchor();
  };

  const refreshRows = () => {
    const rows = [...(cachedFlow?.querySelectorAll('[data-chat-node-key]') ?? [])];
    candidates = [...new Set([...rows.slice(0, 12), ...rows.slice(-maxTailRows)])];
    rowsDirty = false;
    return rows;
  };
  const quickBodyVisible = clip => {
    if (!clip || !candidates.length) return false;
    if (rangeVisible(latestRange, clip) || (staleText && rangeVisible(staleRange, clip))) return true;
    const step = Math.max(1, Math.floor(candidates.length / 8));
    for (let index = 0; index < candidates.length; index += step) if (visible(candidates[index], clip)) return true;
    return visible(candidates.at(-1), clip);
  };
  const refreshCapabilities = at => {
    const control = findOlderControl(cachedFlow);
    historyEvidence.hasMore = Boolean(control);
    historyEvidence.controlDisabled = control ? control.disabled : null;
    historyScrollable = Boolean(cachedPort?.isConnected && cachedPort.scrollHeight > cachedPort.clientHeight + 8);
    historyNavigable = !requiresHistory || Boolean(historyEvidence.hasMore && historyScrollable);
    // Do not treat a busy rail turn, approval or delivery receipt as a pane
    // opening state. Those are normal interactive elements. Only the pane
    // lifecycle marker and the explicit loading region count here.
    opening = Boolean(cachedPane && (cachedPane.getAttribute('data-hapi-pane-state') === 'opening'
      || cachedPane.matches('[data-hapi-pane-opening="loading"]')
      || [...cachedPane.querySelectorAll('.hapi-loading, [data-hapi-pane-opening="loading"]')].some(node => visible(node))));
    if (expectedViewId) viewMatches = cachedView?.getAttribute('data-hapi-session-view') === expectedViewId;
  };
  const sampleEditor = at => {
    const view = cachedView;
    const editors = view ? [...view.querySelectorAll('[data-composer-input][contenteditable="true"]')].filter(node => visible(node)) : [];
    const editor = editors[0];
    if (editor !== cachedEditor) {
      cachedEditor = editor;
      lastEditorText = editor?.textContent ?? '';
      editorTextInitialized = Boolean(editor);
    }
    const editorVisible = Boolean(editor && visible(editor));
    const editorBox = editorVisible ? editor.getBoundingClientRect() : undefined;
    const hit = editorBox ? document.elementFromPoint(clamp(editorBox.left + editorBox.width / 2, 0, innerWidth - 1),
      clamp(editorBox.top + editorBox.height / 2, 0, innerHeight - 1)) : undefined;
    const editorUsable = Boolean(editorVisible && editor.matches('[contenteditable="true"]')
      && editor.getAttribute('aria-disabled') !== 'true' && !editor.closest('[inert], [aria-disabled="true"]')
      && hit && (hit === editor || editor.contains(hit)));
    const text = editor?.textContent ?? '';
    if (!editorTextInitialized && editor) { lastEditorText = text; editorTextInitialized = true; }
    if (text !== lastEditorText) {
      const previousText = lastEditorText;
      lastEditorText = text;
      inputEvidence.textRevision++;
      inputEvidence.textHash = hashText(text);
      inputEvidence.textLength = text.length;
      inputEvidence.lastTextAt = at;
      if (text.length > 0 && inputEvidence.printableKeys > 0 && inputEvidence.retainedAt === null
        && at - (inputEvidence.lastTrustedKeyAt ?? -Infinity) > 500) {
        inputEvidence.everRetained = true;
        inputEvidence.retainedAt = at;
      }
      // A retained nonempty draft replaced by different nonempty text without
      // a recent trusted key/input is an unsafe handoff, even at equal length.
      if (previousText.length > 0 && text.length > 0 && text !== previousText && inputEvidence.everRetained
        && at - (inputEvidence.lastTrustedKeyAt ?? -Infinity) > 500) {
        draftReplaced = true;
        inputEvidence.replacedAt = at;
      }
      if (text.length === 0 && inputEvidence.everRetained && at - (inputEvidence.lastTrustedKeyAt ?? -Infinity) > 500) {
        draftLost = true;
        inputEvidence.lostAt = at;
      }
    } else if (text.length > 0 && inputEvidence.printableKeys > 0 && inputEvidence.retainedAt === null
      && at - (inputEvidence.lastTextAt ?? at) >= 500 && editorUsable) {
      inputEvidence.everRetained = true;
      inputEvidence.retainedAt = at;
    }
    if (presented && editor) {
      if (firstEditorId === null) firstEditorId = identityOf(editor);
      else if (identityOf(editor) !== firstEditorId) editorIdentityChanged = true;
    }
    if (editor && inputEvidence.printableKeys > 0 && inputEvidence.textRevision === 0
      && inputEvidence.firstPrintableAt !== null && at - inputEvidence.firstPrintableAt > 2000) editorIgnoredInput = true;
    return { editor, editorVisible, editorUsable, editors };
  };

  const sampleBody = at => {
    if (rowsDirty || !candidates.length) refreshRows();
    const port = cachedPort;
    const clip = port && visible(port) ? port.getBoundingClientRect() : undefined;
    const oldLatest = latestRange, oldStale = staleRange;
    latestRange = rangeFor(candidates, expectedText);
    staleRange = rangeFor(candidates, staleText);
    if (!latestRange && rangeCurrent(oldLatest, expectedText)) latestRange = oldLatest;
    if (!staleRange && rangeCurrent(oldStale, staleText)) staleRange = oldStale;
    const visibleRows = clip ? candidates.filter(row => visible(row, clip)) : [];
    // A long virtualized transcript can be showing rows outside the
    // first/last bounded sample. Five hit tests keep the body definition
    // bounded without scanning the whole history every frame.
    if (clip) {
      const x = clamp((clip.left + clip.right) / 2, 0, innerWidth - 1);
      for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const hit = document.elementFromPoint(x, clamp(clip.top + (clip.bottom - clip.top) * fraction, 0, innerHeight - 1));
        const row = hit?.closest?.('[data-chat-node-key]');
        if (row instanceof Element && cachedFlow?.contains(row) && !visibleRows.includes(row)) visibleRows.push(row);
      }
    }
    const nextBody = visibleRows.map(row => row.textContent?.trim() ?? '').filter(Boolean).join('\n');
    bodyVisible = Boolean(nextBody);
    if (bodyVisible) presented = true;
    visibleBodyCharacters = nextBody.length;
    bodyRowCount = candidates.length;
    firstKeyHash = candidates.length ? keyHash(candidates[0]) : 0;
    lastKeyHash = candidates.length ? keyHash(candidates.at(-1)) : 0;
    const priorFirstKey = previousFirstKey, priorLastKey = previousLastKey, priorRowCount = previousRowCount;
    const sameRowSet = priorRowCount === bodyRowCount && priorFirstKey === firstKeyHash && priorLastKey === lastKeyHash;
    const priorContentHash = contentHash;
    const nextContentHash = hashText(candidates.map(row => row.textContent ?? '').join('\n'));
    const previousLastRetained = priorLastKey !== 0 && candidates.some(row => keyHash(row) === priorLastKey);
    if (priorRowCount > 0 && priorLastKey !== 0 && lastKeyHash !== priorLastKey && previousLastRetained) {
      tailAppendedAt = at;
      // A new tail node with the previous tail retained is the normal live
      // append path. A history commit in the same interval is a page prepend,
      // not a live source update.
      if (first.full !== null && firstKeyHash === priorFirstKey && rangeCurrent(latestRange, expectedText)
        && at - (historyEvidence.commitAt ?? -Infinity) > 1000) { liveUpdateAt = at; liveRevision++; noteSyncActivity(at); }
    }
    if (nextBody !== bodyText) {
      bodyText = nextBody;
      bodyRevisionCounter++;
    }
    previousFirstKey = firstKeyHash;
    previousLastKey = lastKeyHash;
    previousRowCount = bodyRowCount;
    // An older-page prepend is observed from the DOM even if a diagnostic event
    // is absent. The top row changes and the mounted row set grows.
    const prepended = priorRowCount > 0 && firstKeyHash !== priorFirstKey && bodyRowCount > priorRowCount;
    const contentUpdated = nextContentHash !== priorContentHash;
    if (contentUpdated) {
      contentHash = nextContentHash;
      bodyChangedAt = at;
      observation.lastBodyUpdateAt = at;
      // Source/display content updates extend the post-sync observation.
      // Reader-only scrolling that remounts a different row set does not.
      const sourcePage = prepended && (historyEvidence.requestAt !== null || historyEvidence.commitAt !== null);
      const tailOnly = priorFirstKey === firstKeyHash;
      if (sameRowSet || sourcePage || (tailOnly && (tailAppendedAt === at || liveUpdateAt === at))) noteSyncActivity(at);
    }
    if (prepended) {
      // DOM growth is corroboration only. It never becomes source-page commit
      // evidence without an observed source request/commit pair.
      historyEvidence.domPrependRevision++;
      if (historyEvidence.requestAt !== null || historyEvidence.intentAt !== null) commitAnchor();
    }
    if (cachedView && presented) {
      if (firstViewId === null) firstViewId = identityOf(cachedView);
      else if (identityOf(cachedView) !== firstViewId) viewIdentityChanged = true;
    }
    if (cachedPort && presented) {
      if (firstPortId === null) firstPortId = identityOf(cachedPort);
      else if (identityOf(cachedPort) !== firstPortId) portIdentityChanged = true;
    }
    return { clip };
  };

  const sampleNavigation = () => {
    const turnButtons = cachedRail?.isConnected && visible(cachedRail)
      ? [...cachedRail.querySelectorAll('button')].filter(node => visible(node)) : [];
    const turnUsable = turnButtons.length >= 2 && !turnButtons[0]?.closest('[inert]')
      && turnButtons.some(button => !button.disabled);
    const container = cachedView?.querySelector('[data-conversation-content]') ?? cachedView ?? cachedPane;
    const width = container ? container.getBoundingClientRect().width : 0;
    navigationEvidence.mode = turnUsable ? 'rail' : width <= 900 ? 'mobile' : 'none';
    navigationMarkCount = turnUsable ? turnButtons.length : 0;
    navigationEvidence.marks = navigationMarkCount;
    navigationEvidence.usable = turnUsable;
    navigationRequired = navigationRequirement === true
      || (navigationRequirement === 'auto' && width > 900);
    navigationEvidence.required = navigationRequired;
    navigationUsable = navigationRequired ? turnUsable : true;
  };

  const sample = reason => {
    if (stopped) return;
    const at = performance.now();
    const pane = currentPane();
    const title = titleOf(pane), kind = titleKind(title);
    titleChange(title, at, reason);
    if (pane !== cachedPane || !pane?.contains(cachedPort) || !visible(cachedPort)
      || !cachedView?.contains(cachedEditor) || !visible(cachedEditor)
      || !cachedEditor?.matches('[contenteditable="true"]') || !cachedFlow?.isConnected) {
      const view = [...pane?.querySelectorAll('[data-hapi-session-view]') ?? []].find(node => visible(node)) ?? pane;
      const port = [...view?.querySelectorAll('[data-conversation-scroll]') ?? []].find(node => visible(node));
      const flow = port?.querySelector('[data-chat-flow]');
      const editor = [...view?.querySelectorAll('[data-composer-input][contenteditable="true"]') ?? []].find(node => visible(node));
      const rail = findRail(pane);
      if (pane !== cachedPane || view !== cachedView || port !== cachedPort || flow !== cachedFlow || editor !== cachedEditor || rail !== cachedRail) {
        const viewChanged = cachedView !== undefined && view !== cachedView;
        cachedPane = pane; cachedView = view; cachedPort = port; cachedFlow = flow; cachedEditor = editor; cachedRail = rail;
        latestRange = staleRange = undefined; candidates = [];
        rowsDirty = true; lastBodySample = -Infinity;
        if (viewChanged) noteSyncActivity(at);
      }
    }
    // The official rail can mount asynchronously after its view. Re-query the
    // small nav set each painted frame.
    const liveRail = findRail(pane);
    if (liveRail !== cachedRail) cachedRail = liveRail;
    const invalidated = range => range && (range.collapsed
      || !cachedFlow?.contains(range.startContainer) || !cachedFlow.contains(range.endContainer));
    if (invalidated(latestRange) || invalidated(staleRange)) { rowsDirty = true; lastBodySample = -Infinity; }
    const editorEvidence = sampleEditor(at);
    const editor = editorEvidence.editor;
    const editorUsable = editorEvidence.editorUsable;
    const editorRevision = editor ? identityOf(editor) : 0;
    const portRevision = cachedPort ? identityOf(cachedPort) : 0;
    // Identity is checked on every painted frame, not only at the 10 Hz body
    // sample, so a short root/view handoff cannot hide between samples.
    if (presented && cachedPort && firstPortId !== null && portRevision !== firstPortId) portIdentityChanged = true;
    if (presented && cachedView && firstViewId !== null && identityOf(cachedView) !== firstViewId) viewIdentityChanged = true;
    if (expectedViewId) viewMatches = cachedView?.getAttribute('data-hapi-session-view') === expectedViewId;
    const clip = cachedPort && visible(cachedPort) ? cachedPort.getBoundingClientRect() : undefined;
    // A full body scan is bounded to the first/last rows and happens at 10 Hz,
    // or immediately while no body/markers exist or the cached latest marker
    // was invalidated. Editor/rail/history capability checks stay per-frame so
    // a short painted partial window is not missed, and the transcript DOM is
    // not rescanned on every painted frame.
    const markerInvalid = Boolean(expectedText && latestRange && !rangeCurrent(latestRange, expectedText));
    if (!candidates.length || !bodyVisible || markerInvalid || at - lastBodySample >= bodySampleMs) {
      lastBodySample = at;
      sampleBody(at);
      refreshCapabilities(at);
    } else {
      bodyVisible = bodyVisible || quickBodyVisible(clip);
      // History capability is O(1) per frame: one direct-child control lookup
      // and one scroll geometry read. A painted missing pager is not allowed to
      // hide behind the 100 ms body text cadence.
      const control = findOlderControl(cachedFlow);
      historyEvidence.hasMore = Boolean(control);
      historyEvidence.controlDisabled = control ? control.disabled : null;
      historyScrollable = Boolean(cachedPort?.isConnected && cachedPort.scrollHeight > cachedPort.clientHeight + 8);
      historyNavigable = !requiresHistory || Boolean(historyEvidence.hasMore && historyScrollable);
      opening = opening || Boolean(cachedPane && (cachedPane.getAttribute('data-hapi-pane-state') === 'opening'
        || cachedPane.matches('[data-hapi-pane-opening="loading"]')));
    }
    sampleNavigation();
    const latestVisible = expectedText ? rangeVisible(latestRange, clip) : null;
    const latestAttached = expectedText ? rangeCurrent(latestRange, expectedText) : null;
    if (latestVisible) { latestVisibleAt = at; latestEverVisible = true; }
    const titleReady = expectedTitle ? kind === 'expected' : kind === 'other';
    // The first painted target body must already identify the expected source
    // watermark/read position. A wrong body with complete controls cannot be
    // excused by a later correct body.
    if (!firstBodySeen && bodyVisible && (!expectedViewId || viewMatches)) {
      firstBodySeen = true;
      if ((expectedText && latestVisible !== true) || (expectedTitle && !titleReady)) firstBodyWrong = true;
    }
    if (presented && bodyVisible) {
      // A nonempty body whose latest marker vanished is only intentional when
      // a trusted reader intent and a committed page/navigation explain it.
      if (latestEverVisible && expectedText && latestAttached === false) {
        const prompted = (historyEvidence.intentAt !== null && historyEvidence.commitAt !== null
          && historyEvidence.commitAt >= historyEvidence.intentAt - 50 && at - historyEvidence.commitAt < 3000)
          || (navigationEvidence.intentAt !== null && navigationEvidence.commitAt !== null
            && navigationEvidence.commitAt >= navigationEvidence.intentAt - 50 && at - navigationEvidence.commitAt < 3000)
          // A trusted reader gesture is the intent the spec requires before a
          // marker may leave the reading window (virtualized rows can unmount).
          || (readerIntentAt !== null && latestVisibleAt !== null && readerIntentAt >= latestVisibleAt);
        // A trusted older-page or navigation target that is still loading can
        // temporarily replace the window. Do not call that arbitrary while the
        // intent is pending; a missing commit becomes its own explicit failure.
        const pending = (historyEvidence.intentAt !== null && at - historyEvidence.intentAt <= 12000
          && (historyEvidence.commitAt === null || historyEvidence.commitAt < historyEvidence.intentAt))
          || (navigationEvidence.intentAt !== null && at - navigationEvidence.intentAt <= 12000
            && (navigationEvidence.commitAt === null || navigationEvidence.commitAt < navigationEvidence.intentAt));
        if (!prompted && !pending) bodyReplacement = true;
      }
      if (latestEverVisible && latestAttached && !latestVisible && !latestOffscreenUnprompted) {
        const intended = latestVisibleAt !== null && (
          (readerIntentAt !== null && readerIntentAt >= latestVisibleAt)
          || (historyEvidence.commitAt !== null && historyEvidence.commitAt >= latestVisibleAt)
          || (navigationEvidence.intentAt !== null && navigationEvidence.intentAt >= latestVisibleAt)
          || (navigationEvidence.commitAt !== null && navigationEvidence.commitAt >= latestVisibleAt));
        const appended = latestVisibleAt !== null && tailAppendedAt !== null && tailAppendedAt >= latestVisibleAt;
        if (!intended && !appended) latestOffscreenUnprompted = true;
      }
    }
    const historyIntentUncommitted = historyEvidence.hasMore && historyEvidence.intentAt !== null
      && at - historyEvidence.intentAt > 5000
      && (historyEvidence.commitAt === null || historyEvidence.commitAt < historyEvidence.intentAt);
    // Navigation commit is evaluated against the target text or a real DOM
    // change. A decorative rail button that changes nothing never commits.
    if (navigationEvidence.intentAt !== null
      && (navigationEvidence.commitAt === null || navigationEvidence.commitAt < navigationEvidence.intentAt)) {
      const targetVisible = expectedNavigationText
        ? rangeVisible(rangeFor([cachedFlow], expectedNavigationText), clip) : null;
      const changed = targetVisible === true
        || (expectedNavigationText === undefined && (bodyRevisionCounter !== navigationEvidence.beforeBodyRevision
          || (cachedPort && navigationEvidence.beforeScrollTop !== null
            && Math.abs(cachedPort.scrollTop - navigationEvidence.beforeScrollTop) > 8)));
      if (changed) {
        navigationEvidence.commitRevision++;
        navigationEvidence.commitAt = at;
        navigationEvidence.targetVisible = targetVisible;
      }
    }
    const navigationIntentUncommitted = navigationEvidence.intentAt !== null
      && at - navigationEvidence.intentAt > 5000
      && (navigationEvidence.commitAt === null || navigationEvidence.commitAt < navigationEvidence.intentAt);
    if (!presented && (bodyVisible || first.full !== null)) presented = true;
    const capabilitiesMissing = Boolean(bodyVisible && (!editorUsable || !titleReady || opening
      || (expectedViewId && !viewMatches) || (requiresHistory && !historyNavigable) || (navigationRequired && !navigationUsable)));
    const ready = Boolean(pane && titleReady && (!expectedViewId || viewMatches) && latestVisible && editorUsable && !opening
      && (!requiresHistory || historyNavigable) && navigationUsable);
    const staleVisible = staleText ? rangeVisible(staleRange, clip) : null;
    if (staleVisible && !latestVisible && editorUsable && !opening && !staleReadyUnprompted) {
      const latestAt = latestVisibleAt;
      const intended = latestAt !== null && (
        (readerIntentAt !== null && readerIntentAt >= latestAt)
        || (historyEvidence.commitAt !== null && historyEvidence.commitAt >= latestAt)
        || (navigationEvidence.intentAt !== null && navigationEvidence.intentAt >= latestAt)
        || (navigationEvidence.commitAt !== null && navigationEvidence.commitAt >= latestAt));
      if (!intended) staleReadyUnprompted = true;
    }
    if (opening && first.full !== null) openingReappeared = true;
    const state = {
      paneVisible: Boolean(pane), titleKind: kind, titleRevision: revision(titleIds, title),
      documentTitleRevision: revision(documentTitleIds, document.title),
      viewRevision: cachedView ? identityOf(cachedView) : 0, viewMatches,
      bodyVisible, bodyRevision: bodyRevisionCounter, bodyHash: hashText(bodyText),
      visibleBodyCharacters, bodyRowCount, bodyFirstKeyHash: firstKeyHash, bodyLastKeyHash: lastKeyHash,
      latestAttached, latestVisible, staleVisible,
      editorVisible: editorEvidence.editorVisible, editorUsable,
      editorFocused: Boolean(editor && (document.activeElement === editor || editor.contains(document.activeElement))),
      editorRevision, editorTextLength: inputEvidence.textLength, editorTextHash: inputEvidence.textHash,
      editorTextRevision: inputEvidence.textRevision, visibleEditors: editorEvidence.editors.length,
      portRevision, historyScrollable, historyHasMore: historyEvidence.hasMore,
      historyControlDisabled: historyEvidence.controlDisabled, historyNavigable,
      historyIntentRevision: historyEvidence.intents, historyRequestRevision: historyEvidence.requestRevision,
      historyCommitRevision: historyEvidence.commitRevision, historyFailureRevision: historyEvidence.failureRevision,
      historyIntentUncommitted,
      navigationRequired, navigationMode: navigationEvidence.mode, navigationMarks: navigationMarkCount,
      navigationUsable, navigationIntentRevision: navigationEvidence.intents,
      navigationCommitRevision: navigationEvidence.commitRevision, navigationIntentUncommitted,
      readerIntentRevision: reader.intents, inputRevision: inputEvidence.textRevision,
      editorIdentityChanged, portIdentityChanged, viewIdentityChanged,
      bodyReplacement, latestOffscreenUnprompted, staleReadyUnprompted, openingReappeared,
      firstBodyWrong, editorIgnoredInput, draftLost, draftReplaced,
      liveUpdateRevision: liveRevision,
      capabilitiesMissing, partialExposure: undefined, opening, ready,
    };
    if (capabilitiesMissing && first.full === null && !partialRecorded) {
      partialRecorded = true;
      first.partial = at;
      state.partialExposure = { editorUsable, titleKind: kind, historyScrollable, historyHasMore: historyEvidence.hasMore,
        navigationUsable, opening, viewMatches };
    }
    if (!ready) { readySince = null; stableSince = null; }
    else {
      readySince ??= at;
      const sameBody = previous?.bodyRevision === bodyRevisionCounter && previous?.titleRevision === state.titleRevision;
      if (!sameBody || stableSince === null) stableSince = at;
      if (first.ready === null) first.ready = at;
      if (first.full === null) {
        first.full = at; observation.firstFullAt = at;
        if (at > observation.deadlineAt) observation.deadlineMissed = true;
      }
      if (at - stableSince >= stableMs && first.stable === null) first.stable = at;
    }
    const marks = { workspace: Boolean(pane), title: titleReady, body: bodyVisible, editor: editorUsable, latest: latestVisible,
      input: inputEvidence.everRetained, live: liveUpdateAt !== null, history: historyNavigable, navigation: navigationUsable };
    for (const [name, yes] of Object.entries(marks)) if (yes && first[name] === null) first[name] = at;
    if (previous && Object.keys(state).some(key => state[key] !== previous[key])) states.push({ at, reason, ...state });
    else if (!previous) states.push({ at, reason, ...state });
    previous = state;
    probe.current = { at, ...state, stableForMs: stableSince === null ? 0 : at - stableSince };
    probe.liveUpdateAt = liveUpdateAt;
    if (first.full !== null) {
      for (const offset of checkpointsMs) {
        const name = `t+${offset}`;
        if (at >= first.full + offset && !observation.checkpoints.some(row => row.name === name))
          observation.checkpoints.push({ name, at, state: { ...state, at } });
      }
    }
    if (!observation.complete && !observation.deadlineMissed) {
      if (first.full === null) {
        if (at >= observation.deadlineAt) observation.deadlineMissed = true;
      } else {
        const since = Math.max(first.full, observation.lastSyncActivityAt ?? first.full);
        if (at >= since + observeAfterReadyMs) { observation.complete = true; observation.completeAt = at; }
        else if (at >= observation.deadlineAt) observation.deadlineMissed = true;
      }
    }
  };

  const contentObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') rowsDirty = true;
    }
  });
  contentObserver.observe(document, { subtree: true, childList: true, characterData: true });
  const titleObserver = new MutationObserver(records => {
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (record.type !== 'attributes' || record.attributeName !== 'aria-label') continue;
      if (record.target !== currentPane()) continue;
      // Preserve every title write in one task. A final DOM assertion would
      // otherwise miss known -> Untitled -> known completely.
      const next = records.slice(index + 1).find(row => row.target === record.target && row.attributeName === 'aria-label');
      const value = (next ? next.oldValue : record.target.getAttribute('aria-label')) ?? '';
      titleChange(normalizedTitle(value), performance.now(), 'title-mutation');
    }
  });
  titleObserver.observe(document, { subtree: true, attributes: true, attributeFilter: ['aria-label'], attributeOldValue: true });
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'longtask') { tasks.push({ at: entry.startTime, ms: entry.duration }); continue; }
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* long-task timing is optional */ }
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        let path = '';
        try { path = new URL(entry.name, location.href).pathname; } catch { continue; }
        if (!/(?:\/session\/page|\/messages)$/.test(path)) continue;
        historyEvidence.networkRequests++;
        if (/beforeSeq|beforeAt/.test(entry.name)) {
          historyEvidence.networkOlder++;
          historyEvidence.requestRevision++;
          historyEvidence.requestAt = Math.max(historyEvidence.requestAt ?? 0, entry.startTime);
        }
        historyEvidence.lastNetworkAt = performance.now();
        noteSyncActivity(performance.now());
      }
    }).observe({ type: 'resource', buffered: true });
  } catch { /* resource timing is optional */ }
  window.addEventListener('hapi-dsh:seamless-history', event => {
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object') return;
    const paneId = cachedPane?.getAttribute('data-pane-id');
    const sessionId = cachedView?.getAttribute('data-hapi-session-view');
    if (detail.paneId && paneId && detail.paneId !== paneId) return;
    if (detail.sessionId && sessionId && detail.sessionId !== sessionId) return;
    const at = performance.now();
    noteSyncActivity(at);
    if (detail.type === 'requested') { historyEvidence.requestRevision++; historyEvidence.requestAt = at; }
    else if (detail.type === 'observed') historyEvidence.observedRevision++;
    else if (detail.type === 'committed') { historyEvidence.commitRevision++; historyEvidence.commitAt = at; noteSyncActivity(at); commitAnchor(); }
    else if (detail.type === 'failed' || detail.type === 'suspended') { historyEvidence.failureRevision++; historyEvidence.failureAt = at; }
  });
  window.addEventListener('keydown', event => {
    if (!event.isTrusted) return;
    const target = event.target;
    const editor = target instanceof Element ? target.closest('[data-composer-input][contenteditable="true"]') : null;
    if (editor && cachedView?.contains(editor)) {
      inputEvidence.lastTrustedKeyAt = performance.now();
      inputEvidence.focusTrusted = true;
      inputEvidence.trustedKeys++;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        inputEvidence.printableKeys++;
        inputEvidence.firstPrintableAt ??= performance.now();
        inputEvidence.lastTrustedKeyAt = performance.now();
      }
    }
    if (!(target instanceof Element) || !target.closest('[data-conversation-scroll]')) return;
    if (['PageUp', 'Home', 'ArrowUp'].includes(event.key) && cachedPort
      && cachedPort.scrollTop <= cachedPort.clientHeight) setHistoryIntent(performance.now(), 'key');
    else setReaderIntent(performance.now(), 'key');
  }, { capture: true, passive: true });
  window.addEventListener('wheel', event => {
    if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest('[data-conversation-scroll]')) return;
    setReaderIntent(performance.now(), 'wheel');
    if (event.deltaY < 0 && cachedPort && cachedPort.scrollTop <= cachedPort.clientHeight) {
      // The official automation enters paging within one viewport of the
      // boundary. Count that trusted gesture as the paging intent; a later
      // wheel at exactly the top is the same gesture.
      historyEvidence.nearTopIntents++;
      setHistoryIntent(performance.now(), 'wheel');
    }
  }, { capture: true, passive: true });
  window.addEventListener('touchstart', event => {
    if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest('[data-conversation-scroll]')) return;
    touchY = event.touches?.[0]?.clientY ?? null;
    setReaderIntent(performance.now(), 'touch');
  }, { capture: true, passive: true });
  window.addEventListener('touchmove', event => {
    if (!event.isTrusted || touchY === null || !(event.target instanceof Element) || !event.target.closest('[data-conversation-scroll]')) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    const at = performance.now();
    setReaderIntent(at, 'touch');
    if (touch.clientY > touchY + 8 && cachedPort
      && cachedPort.scrollTop <= Math.max(8, cachedPort.clientHeight)) setHistoryIntent(at, 'touch');
  }, { capture: true, passive: true });
  const endTouch = () => { touchY = null; };
  window.addEventListener('touchend', endTouch, { capture: true, passive: true });
  window.addEventListener('touchcancel', endTouch, { capture: true, passive: true });
  window.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest('[data-conversation-scroll]')) return;
    setReaderIntent(performance.now(), 'pointer');
  }, { capture: true, passive: true });
  window.addEventListener('input', event => {
    if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest('[data-composer-input][contenteditable="true"]')) return;
    inputEvidence.trustedInputs++;
    inputEvidence.lastTrustedKeyAt = performance.now();
  }, { capture: true, passive: true });
  window.addEventListener('focusin', event => {
    if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest('[data-composer-input][contenteditable="true"]')) return;
    inputEvidence.focusAt = performance.now();
    inputEvidence.focusTrusted = true;
  }, { capture: true, passive: true });
  window.addEventListener('click', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    if (!button) return;
    const label = button.getAttribute('aria-label') ?? '';
    const rail = button.closest('nav[aria-label]');
    if ((rail && turnLabel(label)) || /to bottom|回到(?:底部|最新)/i.test(label)) {
      navigationEvidence.intents++;
      navigationEvidence.intentAt = performance.now();
      navigationEvidence.clickedKind = clickKind(label);
      navigationEvidence.clickedIndex = button.dataset.index ? Number(button.dataset.index) : null;
      navigationEvidence.targetVisible = null;
      navigationEvidence.beforeBodyRevision = bodyRevisionCounter;
      navigationEvidence.beforeScrollTop = cachedPort?.scrollTop ?? null;
      if (navigationEvidence.clickedKind === 'to-bottom') navigationEvidence.returnLatestIntents++;
      else navigationEvidence.targetIntents++;
    } else if (button === findOlderControl(cachedFlow)) {
      setHistoryIntent(performance.now(), 'key');
    }
  }, { capture: true, passive: true });

  const probe = window.__hapiColdOpening = {
    first, states, titles, tasks, current: null, startedAt: observation.startedAt, stoppedAt: null,
    verifiedFreshness: Boolean(expectedText), verifiedTitle: Boolean(expectedTitle),
    verifiedView: Boolean(expectedViewId), verifiedTarget: Boolean(expectedTitle && expectedText && expectedViewId),
    expectedViewSupplied: Boolean(expectedViewId), navigationAction,
    expectedNavigationTextSupplied: Boolean(expectedNavigationText),
    stableMs, requiresHistory, requiresNavigation: navigationRequirement, fullCapabilities,
    requireEditorInput, requireLiveUpdate, requireHistoryAction, requireNavigationAction,
    observation, history: historyEvidence, navigation: navigationEvidence, reader, input: inputEvidence,
    liveUpdateAt: null,
    checkpoint(name) {
      sample(name ?? 'checkpoint');
      const current = probe.current;
      if (current) observation.checkpoints.push({ name: name ?? 'checkpoint', at: current.at, state: { ...current } });
      return current;
    },
    stop() {
      if (stopped) return;
      sample('stop');
      stopped = true;
      contentObserver.disconnect(); titleObserver.disconnect();
      cancelAnimationFrame(frame);
      probe.stoppedAt = performance.now();
      probe.observation.stoppedEarly = !probe.observation.complete;
      probe.liveUpdateAt = liveUpdateAt;
    },
  };
  // A post-paint sample is the product-visible frame boundary. rAF alone runs
  // before paint and would misclassify a same-task assembly as exposed.
  const tick = () => {
    if (stopped) return;
    frame = requestAnimationFrame(() => {
      setTimeout(() => { if (!stopped) sample('frame'); }, 0);
      tick();
    });
  };
  // Initial rail mode is derived from the container width for 'auto'. This is
  // only an observation label; the rail must still be visible and functional.
  navigationEvidence.mode = 'none';
  sample('navigation');
  refreshCapabilities(performance.now());
  tick();
}

/** Explain failures from the whole trace, including states which later recovered. */
export function coldOpeningIssues(result) {
  const issues = [], seen = new Set();
  const add = message => { if (!seen.has(message)) { seen.add(message); issues.push(message); } };
  if (!result.verifiedFreshness) add('Latest source marker was not supplied; freshness is unverified');
  if (!result.verifiedTitle) add('Expected source title was not supplied; title identity is unverified');
  const full = result.fullCapabilities !== false;
  if (full && !result.expectedViewSupplied) add('Expected source view identity was not supplied; exact target identity is unverified');
  const observed = result.observation;
  if (observed && !observed.complete) add('Observation window did not complete');
  if (observed?.deadlineMissed) add('Opening or observation exceeded the 60 s diagnostic deadline');
  if (observed?.stoppedEarly) add('Observation stopped before the required post-sync window');
  let knownTitle = false, expectedTitleSeen = false;
  for (const row of result.titles ?? []) {
    if (expectedTitleSeen && row.kind === 'other') add(`Known title changed at ${row.at.toFixed(1)} ms`);
    if (row.kind === 'expected') expectedTitleSeen = true;
    if (row.kind === 'expected' || row.kind === 'other') knownTitle = true;
    else if (knownTitle) add(`Title regressed to ${row.kind} at ${row.at.toFixed(1)} ms`);
  }
  let fresh = false, fullSeen = false, editorId, portId, viewId, presentedSeen = false;
  for (const row of result.states ?? []) {
    if (row.latestVisible) fresh = true;
    if (row.bodyVisible) presentedSeen = true;
    if (presentedSeen) {
      if (row.editorRevision > 0) {
        if (editorId === undefined) editorId = row.editorRevision;
        else if (row.editorRevision !== editorId) add(`Editor identity changed at ${row.at.toFixed(1)} ms`);
      }
      if (row.portRevision > 0) {
        if (portId === undefined) portId = row.portRevision;
        else if (row.portRevision !== portId) add(`Scroll root identity changed at ${row.at.toFixed(1)} ms`);
      }
      if (row.viewRevision > 0) {
        if (viewId === undefined) viewId = row.viewRevision;
        else if (row.viewRevision !== viewId) add(`Visible session view identity changed at ${row.at.toFixed(1)} ms`);
      }
    }
    if (row.viewMatches === false) add(`Visible session view did not match the exact target at ${row.at.toFixed(1)} ms`);
    if (row.viewIdentityChanged) add(`Visible session view was replaced at ${row.at.toFixed(1)} ms`);
    if (row.editorIdentityChanged) add(`Editor identity changed at ${row.at.toFixed(1)} ms`);
    if (row.portIdentityChanged) add(`Scroll root identity changed at ${row.at.toFixed(1)} ms`);
    if (row.bodyReplacement) add(`Nonempty body was replaced without trusted reader intent at ${row.at.toFixed(1)} ms`);
    if (row.firstBodyWrong) add(`First visible target body did not match the expected source watermark/read position at ${row.at.toFixed(1)} ms`);
    if (row.draftReplaced) add(`Unsent editor draft changed without trusted input at ${row.at.toFixed(1)} ms`);
    if (row.latestOffscreenUnprompted) add(`Latest source body left the viewport without trusted reader intent at ${row.at.toFixed(1)} ms`);
    if (row.partialExposure) add(`Partial conversation exposed at ${row.at.toFixed(1)} ms: ${JSON.stringify(row.partialExposure)}`);
    if (row.openingReappeared) add(`Opening/loading state reappeared after first presentation at ${row.at.toFixed(1)} ms`);
    // Stale content is expected after a committed older page or navigation.
    // Before that, it is an unprompted replacement of the target.
    if (row.staleReadyUnprompted) {
      add(`Stale body appeared ready at ${row.at.toFixed(1)} ms`);
      add(`Latest source body disappeared at ${row.at.toFixed(1)} ms`);
    }
    if (full && row.bodyVisible && !row.editorUsable) add(`Editor became unusable at ${row.at.toFixed(1)} ms`);
    if (full && row.visibleEditors > 1) add(`More than one visible official editor at ${row.at.toFixed(1)} ms`);
    if (full && result.requiresHistory === true && row.bodyVisible && row.historyHasMore === false
      && (result.history?.commitRevision ?? 0) === 0)
      add(`Source history had no older-page control at ${row.at.toFixed(1)} ms`);
    if (full && result.requiresHistory === true && row.bodyVisible && row.historyScrollable === false
      && ((result.history?.commitRevision ?? 0) === 0 || row.historyHasMore === true))
      add(`Source history was not scrollable at ${row.at.toFixed(1)} ms`);
    if (full && row.bodyVisible && row.navigationRequired && row.navigationUsable === false)
      add(`Required reading navigation was unavailable at ${row.at.toFixed(1)} ms`);
    if (row.historyIntentUncommitted) add(`Trusted history paging gesture produced no older-page commit by ${row.at.toFixed(1)} ms`);
    if (row.navigationIntentUncommitted) add(`Trusted navigation intent produced no target commit by ${row.at.toFixed(1)} ms`);
    if (row.editorIgnoredInput) add(`Editor accepted focus but ignored input by ${row.at.toFixed(1)} ms`);
    if (row.draftLost) add(`Unsent editor draft was not retained${row.at ? ` (lost by ${row.at.toFixed(1)} ms)` : ''}`);
    if (row.ready) fullSeen = true;
    if (fresh && !row.bodyVisible) add(`Latest source body disappeared at ${row.at.toFixed(1)} ms`);
  }
  // A capability is only established by an actual action, not by a DOM node.
  if (full && result.requiresHistory === true && (result.history?.intents ?? 0) === 0)
    add('No trusted history paging intent was observed; history is unproven');
  if (full && result.requiresHistory === true && (result.history?.intents ?? 0) > 0 && (result.history?.commitRevision ?? 0) === 0)
    add('Trusted history paging did not commit an older page');
  if (full && result.requireHistoryAction) {
    const h = result.history ?? {};
    const intentAt = h.lastIntentAt ?? h.intentAt ?? null;
    if ((h.intents ?? 0) === 0) add('History action evidence is required but no trusted intent was observed');
    else if ((h.requestRevision ?? 0) === 0 || h.requestAt === null)
      add('Trusted history paging did not issue a source page request');
    else if (intentAt !== null && h.requestAt < intentAt - 100)
      add('Source page request predates the trusted history gesture');
    else if ((h.commitRevision ?? 0) === 0 || h.commitAt === null)
      add('Source page request did not commit a source page');
    else if (h.commitAt < h.requestAt - 50)
      add('Source page commit predates its request');
    else {
      if (h.anchorRetained === false || h.anchorRetained === null)
        add('Older-page commit did not measure a retained reading anchor');
      if (h.anchorDriftPx !== null && Math.abs(h.anchorDriftPx) > 2)
        add(`Older-page commit drifted the reading anchor by ${h.anchorDriftPx.toFixed(1)} px`);
      if (h.anchorAt === null)
        add('Older-page reading anchor was not measured');
    }
  }
  const navigationRequired = (result.states ?? []).some(row => row.navigationRequired);
  if (full && navigationRequired && (result.navigation?.intents ?? 0) === 0)
    add('No trusted reading-navigation intent was observed; navigation is unproven');
  if (full && result.requireNavigationAction) {
    const n = result.navigation ?? {};
    const action = result.navigationAction === 'return-latest' ? 'return-latest' : 'unvisited-target';
    if ((n.intents ?? 0) === 0) add('Navigation action evidence is required but no reading-navigation intent was observed');
    if (action === 'return-latest') {
      if ((n.returnLatestIntents ?? 0) === 0) add('Return-latest action was not attempted');
      if ((n.commitRevision ?? 0) === 0) add('Return-latest action did not commit');
      if (n.targetVisible !== true) add('Return-latest action did not expose the latest source marker');
    } else {
      if ((n.targetIntents ?? 0) === 0) add('Unvisited navigation target was not attempted');
      if ((n.commitRevision ?? 0) === 0) add('Unvisited navigation target did not commit');
      if (n.targetVisible !== true) add('Unvisited navigation target did not expose the exact target');
    }
  }
  if (full && navigationRequired && result.expectedNavigationTextSupplied === false)
    add('Navigation target text was not supplied; the exact target is unverified');
  if (full && navigationRequired && (result.navigation?.intents ?? 0) > 0 && (result.navigation?.commitRevision ?? 0) === 0)
    add('Trusted reading navigation did not commit a target');
  if (full && result.requireEditorInput && (result.input?.printableKeys ?? 0) === 0)
    add('No trusted editor input was observed; focus and unsent-draft retention are unproven');
  if (full && result.requireEditorInput && (result.input?.everRetained ?? false) === false)
    add('No retained unsent draft was observed');
  if (full && result.requireLiveUpdate && (result.liveUpdateAt ?? null) === null)
    add('No live source update was observed during the required window');
  if (result.first.full === null || result.first.stable === null)
    add('Opening did not finish with visible latest body, usable editor'
      + (result.requiresHistory === true ? ', source history' : '')
      + (navigationRequired ? ', reading navigation' : '') + ' and a stable known title');
  if (result.current && result.current.bodyVisible && !result.current.editorUsable)
    add('Editor was unusable at the end of observation');
  return issues;
}
