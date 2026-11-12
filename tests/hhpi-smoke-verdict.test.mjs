import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { hhpiRequestPolicy, canonicalHhpiSessionId, syntheticWorkspace, matchVisibleSourcePage, captureVisibleSourceAnchor,
  sourceAnchorVerdict, installObserver, createSmokeReadStateIsolation, settleReadPublications,
  publicConsoleCategory, allowedMissingModuleNames, safeHhpiDiagnosticMarks } from '../scripts/test-hhpi-smoke.mjs';
import { readStreams, requestPolicy, streamPolicy } from '../scripts/smoke-read-policy.mjs';
import { parseWorkspaceState } from '../src/client/model.ts';

const target = 'hhpi:runner%3Aone:codex-main:codex:thread%2F42';
const body = (request = {}) => ({ payload: { args: { request } } });

test('ordinary acceptance retains bad-frame intervals and phases without geometry or CPU instrumentation', () => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const { window } = dom, frames = [];
    const rects = window.HTMLElement.prototype.getClientRects;
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    vm.runInContext(`(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [] })})`, dom.getInternalVMContext());
    const state = window.__hhpiSmoke;
    const frame = at => { const callback = frames.shift(); assert.ok(callback); callback(at); };
    frame(0); state.monitor = true;
    frame(10); frame(90);
    assert.equal(state.frameHitches.length, 0, 'the original 80ms boundary is unchanged');
    state.phase = 'reader-settled'; frame(190);
    assert.deepEqual(JSON.parse(JSON.stringify(state.frameHitches)), [{ start: 90, end: 190, gap: 100, phaseAtStart: 'opening', phaseAtEnd: 'reader-settled' }]);
    assert.equal(window.HTMLElement.prototype.getClientRects, rects);
    assert.equal(state.frameEvents.length, 0); assert.equal(state.longTasks.length, 0);
    state.monitor = false; frame(600); state.monitor = true; frame(700);
    assert.equal(state.frameHitches.length, 1, 'a pause outside reading does not create a frame violation');
  } finally { dom.window.close(); }
});

test('trace-only observation keeps phase/frame samples without wrapping native geometry', async () => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const { window } = dom, marks = [];
    const rect = window.HTMLElement.prototype.getBoundingClientRect;
    const rects = window.HTMLElement.prototype.getClientRects;
    window.performance.mark = name => { marks.push(name); };
    vm.runInContext(`(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [], profile: true, geometryProfile: false })})`, dom.getInternalVMContext());
    assert.equal(window.HTMLElement.prototype.getBoundingClientRect, rect);
    assert.equal(window.HTMLElement.prototype.getClientRects, rects);
    const state = window.__hhpiSmoke;
    state.monitor = true;
    for (let i = 0; i < 3; i++) await new Promise(window.requestAnimationFrame);
    assert.equal(state.phases[0].phase, 'opening');
    assert.deepEqual(marks, ['hhpi-smoke:opening']);
    assert.ok(state.frameEvents.length > 0);
    assert.equal(Object.keys(state.nativeReads).length, 0);
    assert.equal(state.mutationReads.length, 0);
  } finally { dom.window.close(); }
});

test('geometry diagnostics correlate each slow call with anonymous retained, changed and newly mounted rows', () => {
  const dom = new JSDOM('<main data-chat-virtual-rows><div data-chat-virtual-row><span>private-source-body</span></div><div data-chat-virtual-row>other-body</div></main>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const { window } = dom;
    let clock = 0;
    Object.defineProperty(window.performance, 'now', { value: () => clock });
    window.performance.mark = () => {};
    window.HTMLElement.prototype.getClientRects = function() { clock += 7; return []; };
    window.HTMLElement.prototype.getBoundingClientRect = function() { clock += 5; return new window.DOMRect(0, 0, 800, 96); };
    vm.runInContext(`(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [], profile: true })})`, dom.getInternalVMContext());
    window.eval('function measureList() { return document.querySelector("main").getClientRects(); }\n//# sourceURL=https://private.invalid/credential.js');
    const state = window.__hhpiSmoke, list = window.document.querySelector('main'), row = list.firstElementChild;
    window.measureList();
    const first = state.mutationReads[0];
    assert.equal(first.fresh, 2);
    assert.equal(new Set(first.rowIds).size, 2);
    row.getBoundingClientRect();
    window.measureList();
    assert.equal(state.mutationReads[1].fresh, 0);
    assert.deepEqual([...state.mutationReads[1].rowIds], [...first.rowIds]);
    assert.equal(state.mutationReads[1].rowChanges.length, 0, 'an unchanged retained row is distinguishable from a new mount');
    row.querySelector('span').firstChild.data = 'private-revised-body';
    window.measureList();
    assert.equal(state.mutationReads[2].fresh, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(state.mutationReads[2].rowChanges)), [{ row: first.rowIds[0], changes: { 'content:characterData': 1 } }]);
    const added = window.document.createElement('div'); added.setAttribute('data-chat-virtual-row', ''); list.append(added);
    window.measureList();
    assert.equal(state.mutationReads[3].fresh, 1);
    assert.deepEqual([...state.mutationReads[3].rowIds.slice(0, 2)], [...first.rowIds]);
    assert.deepEqual([...state.mutationReads[3].freshRowIds], [state.mutationReads[3].rowIds[2]]);
    assert.equal(state.slowGeometryReads.length, 5, 'later slow calls remain observable even below an earlier maximum');
    assert.equal(state.slowGeometryReads[1].row, first.rowIds[0]);
    assert.equal(state.slowGeometryReads[1].duration, 5);
    assert.match(state.slowGeometryReads[0].stack[0], /measureList/);
    const serialized = JSON.stringify({ changes: state.mutationReads, reads: state.slowGeometryReads });
    assert.doesNotMatch(serialized, /private-source-body|private-revised-body|private\.invalid|credential\.js/);
    for (let i = 0; i < 70; i++) window.measureList();
    assert.equal(state.slowGeometryReads.length, 64);
  } finally { dom.window.close(); }
});

test('the navigation checkpoint includes a head read queued by the previous publication', async () => {
  const first = Promise.withResolvers(), next = Promise.withResolvers();
  const publications = [first.promise], responses = new Set();
  let checkpoints = 0, settled = false;
  const work = settleReadPublications(publications, responses, async () => {
    if (++checkpoints === 1) publications.push(next.promise);
  }).then(() => { settled = true; });
  first.resolve();
  await new Promise(setImmediate);
  assert.equal(settled, false, 'Latest must not cancel a read omitted from the gesture snapshot');
  next.resolve(); await work;
  assert.equal(checkpoints, 2);
});

test('an earlier-page checkpoint includes a response and DOM publication queued while its first publication settles', async () => {
  const first = Promise.withResolvers(), response = Promise.withResolvers(), rendered = Promise.withResolvers();
  const responses = new Set(), publications = [first.promise.then(() => {
    const pending = response.promise.then(() => {
      responses.delete(pending);
      publications.push(rendered.promise);
    });
    responses.add(pending);
  })];
  let settled = false;
  const reading = settleReadPublications(publications, responses, async () => {}).then(() => { settled = true; });
  first.resolve();
  await new Promise(setImmediate);
  assert.equal(settled, false, 'a read queued by the initial DOM commit is still pending');
  response.resolve();
  await new Promise(setImmediate);
  assert.equal(settled, false, 'source bytes alone do not establish the next visible body');
  rendered.resolve();
  await reading;
  assert.equal(settled, true);
});

test('a failed read publication still rejects the pre-navigation checkpoint', async () => {
  await assert.rejects(settleReadPublications([Promise.reject(new Error('physical anchor lost'))], new Set(), async () => {}),
    /physical anchor lost/);
});

test('a native DSH assistant anchor matches its visible answer without requiring collapsed reasoning', () => {
  const text = 'The actual native DSH answer remains visible in this reading window.';
  const record = { page: { context: [], entries: [{ type: 'event', event: { seq: 80, type: 'assistant/message', data: { message: {
    content: [{ type: 'reasoning', text: 'Internal reasoning stays folded outside the visible answer.' }, { type: 'text', text }],
  } } } }] } };
  const anchor = captureVisibleSourceAnchor([{ key: 'native-step', anchor: 'step:1:2', bodyText: text, text,
    visible: true }], [record]);
  assert.equal(anchor?.seq, 80);
  assert.equal(anchor?.sourceText, text);
});

test('Markdown native answers correlate through the exact official context and visible source text', () => {
  const text = 'Clear text survives formatting and remains visible in the original native answer.';
  const record = { page: { context: [], entries: [{ type: 'event', event: { seq: 80, type: 'assistant/message', data: {
    turn: 2, step: 3, message: { content: [{ type: 'text', text: `**Clear** text survives formatting and remains visible in the original native answer.` }] },
  } } }] } };
  const row = { key: '14:assistant-step2:3', anchor: 'flow:original', bodyText: text, text, visible: true };
  assert.equal(captureVisibleSourceAnchor([row], [record])?.seq, 80);
  assert.equal(captureVisibleSourceAnchor([{ ...row, key: '14:assistant-step2:4' }], [record]), null,
    'similar wording in another original step cannot certify the requested source body');
});

test('visible native answers inside an official process group remain observable as body text', () => {
  const dom = new JSDOM(`<section class="hapi-pane" data-session-id="${target}" data-hapi-pane-visible="true">
    <div data-conversation-scroll><div data-chat-flow-kind="turn-process">
      <div data-chat-node-key="native-answer" data-chat-anchor-key="step:1:2" data-chat-flow-kind="assistant-step">
        <div data-slot="conversation.chat.node"><span>Visible native answer.</span><div data-variant="think">Folded reasoning.</div></div>
      </div></div></div></section>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    dom.window.HTMLElement.prototype.getBoundingClientRect = function() { return new dom.window.DOMRect(0, 0, 390, 200); };
    dom.window.HTMLElement.prototype.getClientRects = function() { return [this.getBoundingClientRect()]; };
    dom.window.eval(`(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [] })})`);
    const row = dom.window.__hhpiSmoke.rows().rows[0];
    assert.equal(row.visible, true);
    assert.equal(row.bodyText, 'Visible native answer.');
  } finally { dom.window.close(); }
});

test('HHPI smoke admission accepts only canonical IDs and exact-target read/resource calls', () => {
  assert.equal(canonicalHhpiSessionId(target), true);
  assert.equal(canonicalHhpiSessionId('hhpi:runner:codex-main:codex:thread/42'), false);
  assert.equal(canonicalHhpiSessionId('hapi-codex-0123456789abcdef0123456789abcdef'), false);
  assert.equal(requestPolicy('hhpi/catalog', { payload: { args: {} } }), 'read');
  assert.equal(requestPolicy('hhpi/read', body({ sessionId: target })), 'read');
  assert.equal(requestPolicy('hhpi/resource', body({ sessionId: target, path: 'asset' })), 'read');
  assert.equal(hhpiRequestPolicy('hhpi/catalog', { payload: { args: {} } }, target), 'read');
  assert.equal(hhpiRequestPolicy('hhpi/catalog', body({ sessionId: target }), target), 'block');
  assert.equal(hhpiRequestPolicy('hhpi/read', body({ sessionId: target }), target), 'read');
  assert.equal(hhpiRequestPolicy('hhpi/resolve', body({ sessionId: target }), target), 'read');
  assert.equal(hhpiRequestPolicy('hhpi/resolve', body({ sessionId: 'hhpi:other:source:codex:thread' }), target), 'block');
  assert.equal(hhpiRequestPolicy('hhpi/resource', body({ sessionId: target, path: 'asset' }), target), 'read');
  assert.equal(hhpiRequestPolicy('hhpi/read', body({ sessionId: 'hhpi:other:source:codex:thread' }), target), 'block');
  assert.equal(hhpiRequestPolicy('hhpi/nativeCapabilities', body({ sourceId: 'codex-main' }), target), 'read');
  assert.equal(hhpiRequestPolicy('hhpi/nativeCapabilities', body({ sourceId: 'another-source' }), target), 'block');
  assert.equal(hhpiRequestPolicy('hhpi/nativeCapabilities', body({ sourceId: 'codex-main', operationId: 'write' }), target), 'block');
  assert.equal(hhpiRequestPolicy('hhpi/nativeCapabilities', body({ sourceId: 'codex-main' }), 'hhpi:invalid'), 'block');
  for (const method of ['hhpi/operate', 'hhpi/create', 'session/prompt', 'session/cancel', 'hapi/nativeCancel']) {
    assert.equal(hhpiRequestPolicy(method, body({ sessionId: target }), target), 'block', method);
  }
  assert.equal(hhpiRequestPolicy('hapi/sourceHistoryWindowPage', body({ sessionId: target }), target), 'block');
  assert.equal(hhpiRequestPolicy('hapi/sourceSessionResolve', body({ hubId: 'retired-hub', sourceSessionId: 'retired-session' }), target), 'block');
  assert.equal(hhpiRequestPolicy('hapi/sourceReadStateWrite', body({ expectedVersion: 0 }), target), 'block');
  assert.equal(hhpiRequestPolicy('hapi/workspacePut', body({ expectedRevision: 0, state: syntheticWorkspace(target) }), target), 'isolate-workspace');
  assert.equal(streamPolicy('/hapi-dsh/remote.mux', { type: 'open', endpoint: 'hhpi/changes' }), 'read');
  assert.equal(requestPolicy('hhpi/changes', body({ sessionId: target })), 'block', 'changes is stream-only');
});

test('native-position diagnostic reads stay on the exact HHPI source', () => {
  const request = { sessionId: target, position: { turnId: 'original-turn', itemId: 'original-item' } };
  assert.equal(hhpiRequestPolicy('sourceNavigation/locatePosition', body(request), target), 'read');
  assert.equal(hhpiRequestPolicy('sourceNavigation/locatePosition', body({ ...request, sessionId: 'hhpi:other:source:codex:thread' }), target), 'block');
  assert.equal(hhpiRequestPolicy('sourceNavigation/locatePosition', body({ ...request, operationId: 'write' }), target), 'block');
  assert.equal(hhpiRequestPolicy('sourceNavigation/locatePosition', body(request), 'not-a-canonical-source'), 'block');
});

test('HHPI workspace bootstrap is a synthetic single-pane target, never a persisted production workspace', () => {
  const workspace = syntheticWorkspace(target);
  assert.doesNotThrow(() => parseWorkspaceState(workspace));
  assert.deepEqual(workspace.windows[0].root.resource, { kind: 'chat', sessionId: target });
  assert.equal(workspace.revision, 0);
});

test('application settings reads cannot authorize notification or read-state writes', () => {
  assert.equal(hhpiRequestPolicy('sourceWorkspace/resolve', body({ sessionId: target }), target), 'read');
  assert.equal(hhpiRequestPolicy('sourceWorkspace/resolve', body({ sessionId: target, write: true }), target), 'block');
  assert.equal(hhpiRequestPolicy('sourceWorkspace/resolve', body({ sessionId: 'another-source' }), target), 'block');
  assert.equal(hhpiRequestPolicy('appServices/appNotificationSettings', body({ deviceId: 'probe' }), target), 'read');
  assert.equal(hhpiRequestPolicy('appServices/appNotificationSettings', body({ deviceId: 'probe', subscribe: true }), target), 'block');
  for (const method of ['appPushSubscribe', 'appReadStateWrite', 'appShareCreate']) {
    assert.equal(hhpiRequestPolicy(`appServices/${method}`, body({ deviceId: 'probe' }), target), 'block');
  }
});

test('visible-reader state writes use the exact target and account only inside the disposable CAS store', async () => {
  const scope = { origin: 'https://smoke.invalid', accountId: 'synthetic-account' };
  const source = { kind: 'hhpi', hostId: 'local', sessionId: target,
    identity: { machineId: 'runner:one', sourceId: 'codex-main', engine: 'codex', nativeId: 'thread/42' } };
  const isolation = createSmokeReadStateIsolation(scope, target);
  const request = { deviceId: 'probe', source, expectedRevision: 0, operationId: 'original-seen', intent: { kind: 'seen', position: { kind: 'hhpi', epoch: 'accepted', seq: 80 }, at: 1 } };
  try {
    assert.equal(hhpiRequestPolicy('appServices/appReadStateWrite', body(request), target), 'isolate-app-read-state');
    assert.equal(hhpiRequestPolicy('appServices/appReadStateWrite', body({ ...request, extra: true }), target), 'block');
    assert.equal(hhpiRequestPolicy('appServices/appReadStateWrite', body(request), 'hhpi:other:source:codex:thread'), 'block');
    assert.equal(await isolation.read({ source }), null);
    const applied = await isolation.write(request); assert.equal(applied.applied, true);
    assert.deepEqual(applied.state.scope, scope); assert.deepEqual(applied.state.source, source); assert.equal(applied.state.revision, 1);
    const stale = await isolation.write({ ...request, operationId: 'second-seen' }); assert.equal(stale.applied, false); assert.equal(stale.state.revision, 1);
    assert.equal((await isolation.write(request)).state.revision, 1, 'the original receipt does not apply twice');
    await assert.rejects(isolation.write({ ...request, source: { ...source, hostId: 'another-host' } }), /source-mismatch/);
    assert.equal((await isolation.read({ source })).revision, 1);
  } finally { isolation.close(); }
});

test('serialized browser observer has no module closure and enforces the HHPI read-stream boundary', () => {
  const sent = [], callbacks = [];
  const window = { addEventListener() {}, hhpiSmokeBlocked() { this.blockedCalls = (this.blockedCalls ?? 0) + 1; } };
  const WebSocket = { prototype: { send(data) { sent.push(data); return 'sent'; } } };
  const sandbox = {
    window, WebSocket, URL, Element: class Element {}, performance: { now: () => 0 },
    requestAnimationFrame(callback) { callbacks.push(callback); return callbacks.length; },
    document: { querySelectorAll: () => [] },
  };
  const setup = `(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [...readStreams] })})`;
  vm.runInNewContext(setup, sandbox);
  assert.equal(window.__hhpiSmoke.rows().exists, false);
  const socket = Object.assign(Object.create(WebSocket.prototype), { url: 'wss://example.test/hapi-dsh/remote.mux' });
  assert.equal(socket.send(JSON.stringify({ type: 'open', streamId: 'changes-1', endpoint: 'hhpi/changes',
    payload: { args: { request: { sessionId: target } } } })), 'sent');
  assert.equal(window.__hhpiSmoke.changesStreams, 1);
  assert.equal(socket.send(JSON.stringify({ type: 'end', streamId: 'changes-1' })), 'sent');
  assert.equal(socket.send(JSON.stringify({ type: 'open', streamId: 'changes-2', endpoint: 'hhpi/changes',
    payload: { args: { request: { sessionId: 'hhpi:other:source:codex:thread' } } } })), undefined);
  assert.equal(window.blockedCalls, 1);
  assert.equal(sent.length, 2);
});

test('publication idle keeps native gesture ends distinct from a later layout clamp', async () => {
  // The event order is captured from the actual browser; jsdom supplies only EventTarget and the clock.
  const dom = new JSDOM(`<section class="hapi-pane" data-session-id="${target}" data-hapi-pane-visible="true">
    <div data-conversation-scroll><div data-chat-flow><div data-chat-virtual-row data-index="0">
      <div data-chat-node-key="answer" data-chat-anchor-key="answer" data-chat-flow-kind="assistant-step">Original answer</div>
    </div></div></div></section>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const { window } = dom, port = window.document.querySelector('[data-conversation-scroll]');
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 500, top: 0, bottom: 500, width: 500, height: 500 });
    Object.defineProperty(port, 'onscrollend', { value: null });
    vm.runInContext(`(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [] })})`, dom.getInternalVMContext());
    const state = window.__hhpiSmoke;
    state.rows();
    const gesture = () => port.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -220, bubbles: true }));
    gesture(); port.scrollTop = 216; port.dispatchEvent(new window.Event('scroll'));
    let completed = false;
    const first = state.waitForGestureSettled().then(() => { completed = true; });
    const start = window.performance.now();
    while (window.performance.now() - start < 300) await new Promise(window.requestAnimationFrame);
    assert.equal(completed, false, 'a real reader gesture still requires its native scrollend');
    port.dispatchEvent(new window.Event('scrollend'));
    await first;
    // The official landing completed, then a layout clamp emitted scroll only.
    port.scrollTop = 96; port.dispatchEvent(new window.Event('scroll'));
    const clampStart = window.performance.now();
    await state.waitForGestureSettled();
    assert.ok(window.performance.now() - clampStart >= 250, 'layout movement retains the full quiet checkpoint');
    gesture(); port.scrollTop = 48; port.dispatchEvent(new window.Event('scroll'));
    completed = false;
    const next = state.waitForGestureSettled().then(() => { completed = true; });
    const nextStart = window.performance.now();
    while (window.performance.now() - nextStart < 300) await new Promise(window.requestAnimationFrame);
    assert.equal(completed, false, 'a later gesture cannot reuse the previous native end');
    port.dispatchEvent(new window.Event('scrollend'));
    await next;
    // A real wheel at an underfilled edge has no movement and no scrollend.
    gesture();
    await state.waitForGestureSettled();
    port.scrollTop = 24; port.dispatchEvent(new window.Event('scroll'));
    await state.waitForGestureSettled();
  } finally { dom.window.close(); }
});

test('publication measures the exact visible source body when a process prefix is regrouped', async () => {
  const dom = new JSDOM(`<section class="hapi-pane" data-session-id="${target}" data-hapi-pane-visible="true">
    <div data-conversation-scroll><div data-chat-flow><div><button disabled>Loading</button></div>
      <div data-chat-virtual-row data-index="0"><div data-chat-group-key="old-prefix" data-chat-anchor-key="group:old-prefix">Process header</div></div>
      <div data-chat-virtual-row data-index="1"><div data-chat-node-key="original-body" data-chat-anchor-key="original-body" data-chat-flow-kind="assistant-step">Original answer</div></div>
    </div></div></section>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const { window } = dom, group = window.document.querySelector('[data-chat-group-key]');
    const body = window.document.querySelector('[data-chat-node-key]'), row = body.parentElement;
    const button = window.document.querySelector('button');
    let bodyTop = 88;
    window.HTMLElement.prototype.getBoundingClientRect = function() {
      const top = this.hasAttribute('data-chat-node-key') ? bodyTop : this.hasAttribute('data-chat-group-key') ? 52 : 0;
      const height = this.hasAttribute('data-conversation-scroll') ? 500 : 36;
      return { x: 0, y: top, left: 0, right: 500, top, bottom: top + height, width: 500, height };
    };
    window.document.elementsFromPoint = () => [group];
    vm.runInContext(`(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [] })})`, dom.getInternalVMContext());
    const state = window.__hhpiSmoke;
    const first = await state.armLayoutCommit();
    const replacement = group.cloneNode(true);
    replacement.dataset.chatGroupKey = 'extended-prefix'; replacement.dataset.chatAnchorKey = 'group:extended-prefix';
    group.replaceWith(replacement); row.dataset.index = '2'; button.disabled = false;
    for (let i = 0; i < 5 && !state.layoutCommits[first].done; i++) await new Promise(window.requestAnimationFrame);
    assert.equal(state.layoutCommits[first].kind, 'node');
    assert.equal(state.layoutCommits[first].retained, true, 'regrouping does not retire the exact visible source body');
    assert.equal(state.layoutCommits[first].delta, 0);
    button.disabled = true;
    window.document.elementsFromPoint = () => [replacement];
    const moved = await state.armLayoutCommit();
    bodyTop += 4; row.dataset.index = '3'; button.disabled = false;
    for (let i = 0; i < 5 && !state.layoutCommits[moved].done; i++) await new Promise(window.requestAnimationFrame);
    assert.equal(state.layoutCommits[moved].retained, true);
    assert.equal(state.layoutCommits[moved].delta, 4, 'a real body jump remains outside the unchanged 2px limit');
  } finally { dom.window.close(); }
});

test('publication measurement keeps a visible group instead of its offscreen first child', async () => {
  // Explicit synthetic geometry tests the probe's selection, not browser layout.
  const dom = new JSDOM(`<section class="hapi-pane" data-session-id="${target}" data-hapi-pane-visible="true">
    <div data-conversation-scroll><div data-chat-flow><div><button disabled>Loading</button></div>
      <div data-chat-virtual-row data-index="1"><div data-chat-anchor-key="group:g" data-chat-group-key="g">
        Visible group heading<div data-step-process-content><div data-chat-anchor-key="offscreen">Offscreen first child</div></div>
      </div></div></div></div></section>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const { window } = dom, port = window.document.querySelector('[data-conversation-scroll]'), group = window.document.querySelector('[data-chat-group-key]');
    window.HTMLElement.prototype.getBoundingClientRect = function() {
      const top = this.dataset.chatAnchorKey === 'offscreen' ? -900 : 0;
      return { x: 0, y: top, left: 0, right: 500, top, bottom: top + 500, width: 500, height: 500 };
    };
    window.document.elementsFromPoint = () => [group, port];
    Object.defineProperty(port, 'onscrollend', { value: null });
    vm.runInContext(`(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [] })})`, dom.getInternalVMContext());
    window.__hhpiSmoke.rows();
    port.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
    let captured = false;
    const capture = window.__hhpiSmoke.armLayoutCommit().then(index => { captured = true; return index; });
    port.dispatchEvent(new window.Event('scroll'));
    port.dispatchEvent(new window.Event('touchend', { bubbles: true }));
    const start = window.performance.now();
    while (window.performance.now() - start < 300) await new Promise(window.requestAnimationFrame);
    assert.equal(captured, false, 'stable frames before native scrollend cannot be mistaken for finished touch momentum');
    port.dispatchEvent(new window.Event('scrollend'));
    const index = await capture;
    window.document.querySelector('[data-chat-anchor-key="offscreen"]').remove();
    window.document.querySelector('button').disabled = false;
    for (let i = 0; i < 5 && !window.__hhpiSmoke.layoutCommits[index].done; i++) await new Promise(window.requestAnimationFrame);
    assert.equal(window.__hhpiSmoke.layoutCommits[index].retained, true, 'virtual recycling of an offscreen child cannot invalidate the visible group measurement');
    assert.equal(window.__hhpiSmoke.layoutCommits[index].delta, 0);
  } finally { dom.window.close(); }
});

test('publication fallback measures a stable body instead of a regenerated turn control', async () => {
  const dom = new JSDOM(`<section class="hapi-pane" data-session-id="${target}" data-hapi-pane-visible="true">
    <div data-conversation-scroll><div data-chat-flow><div><button disabled>Loading</button></div>
      <div data-chat-virtual-row data-index="0"><div data-chat-node-key="partial-turn-control" data-chat-anchor-key="partial-turn-control" data-chat-flow-kind="turn-process">Completed</div></div>
      <div data-chat-virtual-row data-index="1"><div data-chat-node-key="original-answer" data-chat-anchor-key="original-answer" data-chat-flow-kind="assistant-step">Original readable answer</div></div>
    </div></div></section>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const { window } = dom;
    window.HTMLElement.prototype.getBoundingClientRect = function() {
      const top = this.dataset.chatFlowKind === 'turn-process' ? 46 : this.dataset.chatFlowKind === 'assistant-step' ? 100 : 0;
      const height = this.hasAttribute('data-conversation-scroll') ? 500 : 40;
      return { x: 0, y: top, left: 0, right: 390, top, bottom: top + height, width: 390, height };
    };
    // The top pixel hits padding: the real smoke must take its fallback path.
    window.document.elementsFromPoint = () => [];
    vm.runInContext(`(${installObserver.toString()})(${JSON.stringify({ sessionId: target, allowedReadStreams: [] })})`, dom.getInternalVMContext());
    const index = await window.__hhpiSmoke.armLayoutCommit();
    const record = window.__hhpiSmoke.layoutCommits[index];
    assert.equal(record.flowKind, 'assistant-step');
    window.document.querySelector('[data-chat-flow-kind="turn-process"]').closest('[data-chat-virtual-row]').remove();
    window.document.querySelector('[data-chat-flow-kind="assistant-step"]').closest('[data-chat-virtual-row]').dataset.index = '11';
    window.document.querySelector('button').disabled = false;
    for (let i = 0; i < 5 && !record.done; i++) await new Promise(window.requestAnimationFrame);
    assert.equal(record.done, true);
    assert.equal(record.retained, true, 'replacing a turn control is not losing the visible original answer');
    assert.equal(record.delta, 0);
  } finally { dom.window.close(); }
});

test('failure diagnostics retain only safe categories, whitelisted missing modules, counts and scrubbed HAPI marks', () => {
  const consoleText = 'web boot: 33 entries did not activate; require("@deepseek-ai/dsh-brand") and require("@deepseek-ai/cosmokit") missed the module table at https://private.example/session/secret';
  assert.equal(publicConsoleCategory(consoleText), 'web-boot-activation');
  assert.deepEqual(allowedMissingModuleNames(consoleText), ['@deepseek-ai/dsh-brand', '@deepseek-ai/cosmokit']);
  assert.deepEqual(allowedMissingModuleNames('require("@private/module") failed'), []);
  assert.deepEqual(safeHhpiDiagnosticMarks([
    'hapi-dsh:target:ready', 'hapi-dsh:pane:boot:private-host',
    'hapi-dsh:pane:native-check:private-host:has', 'hapi-dsh:rpc:outline:23',
    'hapi-dsh:unrecognized:secret', 'https://private.example/mark',
  ]), [
    'hapi-dsh:pane:boot:<host>', 'hapi-dsh:pane:native-check:<host>:has',
    'hapi-dsh:rpc:outline:<elapsed-ms>', 'hapi-dsh:target:ready',
  ]);
});

test('an earlier page counts only when its returned sequence and source text appear on a new visible DOM anchor', () => {
  const record = { request: { sessionId: target, before: 90 }, page: { session: { id: target }, before: 40, entries: [
    { type: 'event', event: { seq: 60, type: 'user/message', data: { content: [{ type: 'text', text: 'The unique earlier source passage 6789.' }] } } },
  ] } };
  const previous = new Set(['user:90']), previousSeqs = new Set([90]);
  const row = { key: 'user:60', anchor: 'flow:user:60', visible: true, text: 'The unique earlier source passage 6789.' };
  const match = matchVisibleSourcePage(record, [row], previous, previousSeqs, 90);
  assert.equal(match?.seq, 60);
  assert.equal(match?.key, row.key);
  assert.equal(match?.anchor, row.anchor);
  assert.equal(matchVisibleSourcePage(record, [], previous, previousSeqs, 90), null, 'cursor progress without visible text is not a page');
  assert.equal(matchVisibleSourcePage(record, [{ ...row, text: 'Different text' }], previous, previousSeqs, 90), null);
  assert.equal(matchVisibleSourcePage(record, [{ ...row, key: 'user:90' }], previous, previousSeqs, 90), null, 'an old DOM key cannot count as new content');
  assert.equal(matchVisibleSourcePage({ ...record, page: { ...record.page, context: [60] } }, [row], previous, previousSeqs, 90), null,
    'a body included only as dependency context is not counted as the requested page');
});

test('page two and three follow the same source-sequence and visible-text evidence as every other page', () => {
  let priorHead = 100;
  const knownSeqs = new Set([100]), keys = new Set(['user:100']);
  for (let index = 0; index < 6; index++) {
    const seq = priorHead - 10, text = `unique body segment ${index + 1} with readable content`;
    const record = { request: { sessionId: target, before: priorHead }, page: { session: { id: target }, before: seq - 1, entries: [
      { type: 'event', event: { seq, type: 'user/message', data: { content: [{ type: 'text', text }] } } },
    ] } };
    const key = `user:${seq}`, match = matchVisibleSourcePage(record,
      [{ key, anchor: `anchor:${seq}`, visible: true, text }], keys, knownSeqs, priorHead);
    assert.equal(match?.seq, seq, `segment ${index + 1} must expose its returned source sequence`);
    keys.add(key); knownSeqs.add(seq); priorHead = seq;
  }
});

test('tool-only source intervals require the exact call identity and its visible source name', () => {
  const record = { request: { sessionId: target, before: 90 }, page: { session: { id: target }, before: 50, entries: [
    { type: 'event', event: { seq: 60, type: 'tool/call', data: { callId: 'unique-earlier-call', name: 'codex.commandExecution' } } },
  ] } };
  const row = { key: 'tool:unique-earlier-call', anchor: 'call:unique-earlier-call', visible: true, text: 'Tool call · codex.commandExecution · read source' };
  assert.equal(matchVisibleSourcePage(record, [row], new Set(), new Set([90]), 90)?.seq, 60);
  assert.equal(matchVisibleSourcePage(record, [{ ...row, anchor: 'call:another-call' }], new Set(), new Set([90]), 90), null,
    'a different call with the same display name cannot count as this source event');
  assert.equal(matchVisibleSourcePage(record, [{ ...row, text: 'loading' }], new Set(), new Set([90]), 90), null);
  assert.equal(captureVisibleSourceAnchor([row], [record])?.seq, 60);
});

test('native command cards correlate their visible source action text with the original call', () => {
  const record = { request: { sessionId: target, before: 90 }, page: { session: { id: target }, before: 50, entries: [
    { type: 'event', event: { seq: 60, type: 'tool/call', data: { callId: 'source-read-call', name: 'codex.commandExecution',
      arguments: JSON.stringify({ command: 'cat path/to/source-contract.ts', commandActions: [{ type: 'read', name: 'source-contract.ts' }] }) } } },
  ] } };
  const row = { key: 'tool:source-read-call', anchor: 'call:source-read-call', visible: true,
    text: 'Read source-contract.ts', bodyText: 'Read source-contract.ts' };
  assert.equal(matchVisibleSourcePage(record, [row], new Set(), new Set([90]), 90)?.seq, 60);
  assert.equal(captureVisibleSourceAnchor([row], [record])?.seq, 60);
  assert.equal(matchVisibleSourcePage(record, [{ ...row, anchor: 'call:different-read-call' }], new Set(), new Set([90]), 90), null);
  assert.equal(matchVisibleSourcePage(record, [{ ...row, text: 'Read unrelated-file.ts', bodyText: 'Read unrelated-file.ts' }], new Set(), new Set([90]), 90), null);
});

test('source anchor verdict separates identity, body change, virtualization, and stable retention', () => {
  const sourceText = 'A stable source message body that stays in the conversation.';
  const anchor = { key: 'user:100', anchor: 'flow:user:100', seq: 100, sourceText };
  const row = (fields = {}) => ({ key: anchor.key, anchor: anchor.anchor, visible: true,
    text: `${sourceText} copied edited delete`, bodyText: sourceText, ...fields });

  assert.equal(sourceAnchorVerdict(anchor, [row()]), 'retained',
    'toolbar text in the containing row does not alter the source body verdict');
  assert.equal(sourceAnchorVerdict(anchor, [row({ key: 'user:100-rekeyed' })]), 'key-missing');
  assert.equal(sourceAnchorVerdict(anchor, [row({ anchor: 'flow:user:100-replaced' })]), 'anchor-changed');
  assert.equal(sourceAnchorVerdict(anchor, [row({ bodyText: 'A revised source message body.' })]), 'source-text-changed');
  assert.equal(sourceAnchorVerdict(anchor, [row({ visible: false })]), 'old-row-outside-visible-range');
  assert.equal(sourceAnchorVerdict(anchor, []), 'old-row-outside-virtual-range');
  assert.equal(sourceAnchorVerdict(null, []), 'pre-response-anchor-unavailable');
});

test('response-boundary anchor captures a visible source body, not row controls', () => {
  const sourceText = 'A stable source message body that stays in the conversation.';
  const record = { page: { context: [], entries: [{ type: 'event', event: { seq: 100, type: 'user/message',
    data: { content: [{ type: 'text', text: sourceText }] } } }] } };
  const captured = captureVisibleSourceAnchor([
    { key: 'user:100', anchor: 'flow:user:100', visible: true, bodyText: sourceText,
      text: `${sourceText} copied edited delete` },
  ], [record]);
  assert.deepEqual(captured, { key: 'user:100', anchor: 'flow:user:100', seq: 100, sourceText });
  assert.equal(captureVisibleSourceAnchor([
    { key: 'user:100', anchor: 'flow:user:100', visible: false, bodyText: sourceText },
  ], [record]), null, 'the response-boundary sample must be a currently visible source body');
});
