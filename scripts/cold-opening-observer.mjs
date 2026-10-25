/** Runs before application code. It records the entire opening, not just first paint. */
export function installColdOpeningObserver(options = {}) {
  const selector = options.paneSelector ?? '.hapi-pane-focused, .hapi-pane';
  const expectedTitle = options.expectedTitle?.trim();
  const expectedText = options.expectedText;
  const staleText = options.staleText;
  const stableMs = options.stableMs ?? 750;
  const states = [], titles = [], tasks = [];
  const first = { workspace: null, title: null, body: null, editor: null, latest: null, ready: null, stable: null };
  const titleIds = new Map(), documentTitleIds = new Map();
  let previous, previousBody = '', bodyRevision = 0, readySince = null, stableSince = null;
  let stopped = false, frame, dirty = true, latestRange, staleRange, lastTitle;
  let cachedPane, cachedView, cachedFlow, cachedPort, cachedEditor, candidates = [], lastBodySample = -Infinity;
  let visibleBodyCharacters = 0, bodyVisible = false;
  const titleKind = title => !title ? 'missing' : /^(?:untitled(?: session| conversation)?|未命名(?:会话|对话)?|无标题)$/i.test(title)
    ? 'placeholder' : expectedTitle && title === expectedTitle ? 'expected' : 'other';
  const normalizedTitle = value => value.replace(/^(?:Pane|窗格)[:：]\s*/, '').trim();
  const titleOf = node => normalizedTitle(node?.getAttribute('aria-label') ?? '');
  const revision = (map, value) => {
    if (!map.has(value)) map.set(value, map.size);
    return map.get(value);
  };
  const titleChange = (title, at, reason) => {
    if (title === lastTitle) return;
    lastTitle = title;
    titles.push({ at, reason, kind: titleKind(title), revision: revision(titleIds, title),
      ...(options.captureTitles ? { value: title } : {}) });
  };
  const intersects = (a, b) => a.width > 0 && a.height > 0 && a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
  const screen = () => ({ top: 0, left: 0, bottom: innerHeight, right: innerWidth });
  const visible = (node, clip = screen()) => {
    // The preparing surface can have layout boxes under an opacity:0 ancestor.
    // Its descendants' own computed opacity is still 1. Keep inert content
    // visually readable here; only the editor's usability check rejects inert.
    if (!(node instanceof Element) || !node.isConnected
      || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
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
  const rangeVisible = (range, clip) => Boolean(range?.startContainer.isConnected && clip
    && visible(range.startContainer.parentElement, clip)
    && [...range.getClientRects()].some(rect => intersects(rect, clip) && intersects(rect, screen())));
  const sample = reason => {
    const at = performance.now();
    const pane = currentPane();
    const title = titleOf(pane), kind = titleKind(title);
    titleChange(title, at, reason);
    // Retired generations remain connected in the parked Host. Connectivity
    // alone does not make their ranges/editor the current visible occurrence.
    // Resolve only the small set of view roots, never all transcript rows.
    if (pane !== cachedPane || !pane?.contains(cachedPort) || !visible(cachedPort)
      || !cachedView?.contains(cachedEditor) || !visible(cachedEditor)
      || !cachedEditor?.matches('[contenteditable="true"]') || !cachedFlow?.isConnected) {
      const view = [...pane?.querySelectorAll('[data-hapi-session-view]') ?? []].find(node => visible(node)) ?? pane;
      const port = [...view?.querySelectorAll('[data-conversation-scroll]') ?? []].find(node => visible(node));
      const flow = port?.querySelector('[data-chat-flow]');
      const editor = [...view?.querySelectorAll('[data-composer-input][contenteditable="true"]') ?? []].find(node => visible(node));
      if (pane !== cachedPane || view !== cachedView || port !== cachedPort || flow !== cachedFlow || editor !== cachedEditor) {
        cachedPane = pane; cachedView = view; cachedPort = port; cachedFlow = flow; cachedEditor = editor;
        latestRange = staleRange = undefined; candidates = [];
        dirty = true; lastBodySample = -Infinity;
      }
    }
    // Moving an existing view between mount points collapses live DOM Ranges
    // to the old parent even though its text nodes remain on screen. Refresh
    // that invalidated marker immediately; do not mistake a stale Range for a
    // lost message or wait for a transcript mutation that never occurs.
    const invalidated = range => range && (range.collapsed
      || !cachedFlow?.contains(range.startContainer) || !cachedFlow.contains(range.endContainer));
    if (invalidated(latestRange) || invalidated(staleRange)) { dirty = true; lastBodySample = -Infinity; }
    const port = cachedPort;
    const clip = visible(port) ? port.getBoundingClientRect() : undefined;
    // A long restored transcript must not turn the measuring tool into a long
    // task. Inspect a bounded tail (plus initial rows) at <=10 Hz. Per-frame
    // readiness uses only cached marker Ranges and the editor/viewport boxes.
    if (at - lastBodySample >= 100) {
      lastBodySample = at;
      if (dirty) {
        const rows = [...cachedFlow?.querySelectorAll('[data-chat-node-key]') ?? []];
        candidates = [...new Set([...rows.slice(0, 8), ...rows.slice(-64)])];
        latestRange = rangeFor(candidates, expectedText); staleRange = rangeFor(candidates, staleText); dirty = false;
      }
      const body = candidates.filter(row => clip && visible(row, clip))
        .map(row => row.textContent?.trim() ?? '').filter(Boolean).join('\n');
      if (body !== previousBody) { bodyRevision++; previousBody = body; }
      bodyVisible = Boolean(body); visibleBodyCharacters = body.length;
    }
    const editor = cachedEditor;
    const editorVisible = visible(editor);
    const editorBox = editorVisible ? editor.getBoundingClientRect() : undefined;
    const hit = editorBox ? document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, editorBox.left + editorBox.width / 2)),
      Math.min(innerHeight - 1, Math.max(0, editorBox.top + editorBox.height / 2))) : undefined;
    const editorUsable = editorVisible && editor.matches('[contenteditable="true"]') && editor.getAttribute('aria-disabled') !== 'true'
      && !editor.closest('[inert], [aria-disabled="true"]') && Boolean(hit && (hit === editor || editor.contains(hit)));
    const opening = Boolean(pane && (pane.matches('[aria-busy="true"], [data-hapi-pane-opening="loading"]')
      || [...pane.querySelectorAll('.hapi-loading, [data-hapi-pane-opening="loading"], [aria-busy="true"]')].some(node => visible(node))));
    const latestVisible = expectedText ? rangeVisible(latestRange, clip) : null;
    const titleReady = expectedTitle ? kind === 'expected' : kind === 'other';
    // A missing latest-source marker is explicitly unverified, never ready.
    const ready = Boolean(pane && titleReady && latestVisible && editorUsable && !opening);
    const state = { paneVisible: Boolean(pane), titleKind: kind, titleRevision: revision(titleIds, title),
      documentTitleRevision: revision(documentTitleIds, document.title), bodyVisible, bodyRevision,
      visibleBodyCharacters, latestAttached: expectedText ? Boolean(latestRange?.startContainer.isConnected) : null,
      latestVisible, staleVisible: staleText ? rangeVisible(staleRange, clip) : null,
      editorVisible, editorUsable, opening, ready };
    if (options.captureTitles && previous?.latestVisible && !latestVisible) {
      state.disappearance = {
        view: cachedView?.getAttribute('data-hapi-session-view'), dirty,
        portVisible: visible(port), port: clip?.toJSON?.(),
        range: latestRange ? [...latestRange.getClientRects()].map(rect => rect.toJSON()) : [],
        rangeCollapsed: latestRange?.collapsed, rangeNode: latestRange?.startContainer.nodeName,
        rangeParentVisible: visible(latestRange?.startContainer.parentElement),
        matches: latestRange?.toString() === expectedText,
        surfaces: [...pane?.querySelectorAll('[data-hapi-session-view]') ?? []].map(view => ({
          id: view.getAttribute('data-hapi-session-view'), visible: visible(view),
          handoff: view.closest('[data-hapi-handoff]')?.getAttribute('data-hapi-handoff'),
          port: view.querySelector('[data-conversation-scroll]')?.getBoundingClientRect().toJSON(),
        })),
      };
    }
    const sameBody = previous?.bodyRevision === bodyRevision && previous?.titleRevision === state.titleRevision;
    if (!ready) { readySince = null; stableSince = null; }
    else {
      readySince ??= at;
      if (!sameBody || stableSince === null) stableSince = at;
      if (first.ready === null) first.ready = at;
      if (at - stableSince >= stableMs && first.stable === null) first.stable = at;
    }
    const marks = { workspace: Boolean(pane), title: titleReady, body: bodyVisible, editor: editorUsable, latest: latestVisible };
    for (const [name, yes] of Object.entries(marks)) if (yes && first[name] === null) first[name] = at;
    if (!previous || Object.keys(state).some(key => state[key] !== previous[key])) states.push({ at, reason, ...state });
    previous = state;
    probe.current = { at, ...state, stableForMs: stableSince === null ? 0 : at - stableSince };
  };
  const observer = new MutationObserver(records => {
    // Preserve even two title writes in one task. A final DOM assertion (or
    // only rAF) would otherwise miss known -> Untitled -> known completely.
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.type !== 'attributes' && (!cachedFlow?.isConnected || cachedFlow.contains(record.target))) dirty = true;
      if (record.type !== 'attributes' || record.attributeName !== 'aria-label' || record.target !== currentPane()) continue;
      const next = records.slice(i + 1).find(row => row.target === record.target && row.attributeName === 'aria-label');
      const value = (next ? next.oldValue : record.target.getAttribute('aria-label')) ?? '';
      titleChange(normalizedTitle(value), performance.now(), 'title-mutation');
    }
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['aria-label'], attributeOldValue: true });
  new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push({ at: entry.startTime, ms: entry.duration }); })
    .observe({ type: 'longtask', buffered: true });
  const probe = window.__hapiColdOpening = {
    first, states, titles, tasks, current: null, startedAt: performance.now(), stoppedAt: null,
    verifiedFreshness: Boolean(expectedText), verifiedTitle: Boolean(expectedTitle), stableMs,
    checkpoint(name) { sample(name); return probe.current; },
    stop() { if (!stopped) { sample('stop'); stopped = true; observer.disconnect(); cancelAnimationFrame(frame); probe.stoppedAt = performance.now(); } },
  };
  const tick = () => { if (!stopped) { sample('frame'); frame = requestAnimationFrame(tick); } };
  sample('navigation'); frame = requestAnimationFrame(tick);
}

/** Explain failures from the whole trace, including states which later recovered. */
export function coldOpeningIssues(result) {
  const issues = [];
  if (!result.verifiedFreshness) issues.push('Latest source marker was not supplied; freshness is unverified');
  if (!result.verifiedTitle) issues.push('Expected source title was not supplied; title identity is unverified');
  let knownTitle = false, expectedTitle = false;
  for (const row of result.titles) {
    if (expectedTitle && row.kind === 'other') issues.push(`Known title changed at ${row.at.toFixed(1)} ms`);
    if (row.kind === 'expected') expectedTitle = true;
    if (row.kind === 'expected' || row.kind === 'other') knownTitle = true;
    else if (knownTitle) issues.push(`Title regressed to ${row.kind} at ${row.at.toFixed(1)} ms`);
  }
  let fresh = false;
  for (const row of result.states) {
    if (row.latestVisible) fresh = true;
    else if (fresh) issues.push(`Latest source body disappeared at ${row.at.toFixed(1)} ms`);
    if (row.staleVisible && !row.latestVisible && row.editorUsable && !row.opening)
      issues.push(`Stale body appeared ready at ${row.at.toFixed(1)} ms`);
  }
  if (!result.current?.ready || result.current.stableForMs < result.stableMs)
    issues.push('Opening did not finish with visible latest body, usable editor and a stable known title');
  return issues;
}
