import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { hhpiRequestPolicy, canonicalHhpiSessionId, syntheticWorkspace, matchVisibleSourcePage, installObserver,
  publicConsoleCategory, allowedMissingModuleNames, safeHhpiDiagnosticMarks } from '../scripts/test-hhpi-smoke.mjs';
import { readStreams, requestPolicy, streamPolicy } from '../scripts/test-history-smoke.mjs';
import { parseWorkspaceState } from '../src/client/model.ts';

const target = 'hhpi:runner%3Aone:codex-main:codex:thread%2F42';
const body = (request = {}) => ({ payload: { args: { request } } });

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
  assert.equal(hhpiRequestPolicy('hhpi/resource', body({ sessionId: target, path: 'asset' }), target), 'read');
  assert.equal(hhpiRequestPolicy('hhpi/read', body({ sessionId: 'hhpi:other:source:codex:thread' }), target), 'block');
  for (const method of ['hhpi/operate', 'hhpi/create', 'session/prompt', 'session/cancel', 'hapi/nativeCancel']) {
    assert.equal(hhpiRequestPolicy(method, body({ sessionId: target }), target), 'block', method);
  }
  assert.equal(hhpiRequestPolicy('hapi/sourceHistoryWindowPage', body({ sessionId: target }), target), 'block');
  assert.equal(hhpiRequestPolicy('hapi/workspacePut', body({ expectedRevision: 0, state: syntheticWorkspace(target) }), target), 'isolate-workspace');
  assert.equal(streamPolicy('/hapi-dsh/remote.mux', { type: 'open', endpoint: 'hhpi/changes' }), 'read');
  assert.equal(requestPolicy('hhpi/changes', body({ sessionId: target })), 'block', 'changes is stream-only');
});

test('HHPI workspace bootstrap is a synthetic single-pane target, never a persisted production workspace', () => {
  const workspace = syntheticWorkspace(target);
  assert.doesNotThrow(() => parseWorkspaceState(workspace));
  assert.deepEqual(workspace.windows[0].root.resource, { kind: 'chat', sessionId: target });
  assert.equal(workspace.revision, 0);
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
