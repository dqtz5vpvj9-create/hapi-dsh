import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTerminalCopySnapshot, type TerminalSnapshotApi } from '../src/client/source-terminal/snapshot.ts'
import type { WorkbenchResponse } from '../src/workbench-types.ts'

const projection = { engine: 'codex', hapiSessionId: 'original-session', hubId: 'stable-source-hub', machineId: 'remote-runner' }
const retained: WorkbenchResponse<'nativeTerminalText'> = { terminalId: 'original-terminal', title: 'Source terminal', cwd: '/remote/project',
  capturedAt: 1, sequence: 4, lines: ['retained earlier line', 'last line'], sourceHistory: 'bounded-unknown', localLimitReached: false }
const local = { text: 'visible rows only', selected: false }
const signal = (): AbortSignal => new AbortController().signal

test('terminal copy preserves the official selected text and ordinary DSH visible snapshot without any source call', async () => {
  let calls = 0
  const api: TerminalSnapshotApi = { nativeTerminalText: async () => { calls++; return { ok: true, value: retained } } }
  assert.deepEqual(await readTerminalCopySnapshot(api, projection, false, retained.terminalId, { text: 'selected portion', selected: true }, signal()), { kind: 'selected', lines: ['selected portion'] })
  assert.deepEqual(await readTerminalCopySnapshot(api, null, false, retained.terminalId, local, signal()), { kind: 'visible', lines: ['visible rows only'] })
  assert.equal(calls, 0)
})

test('source copy asks for the exact terminal and immutable source, preserving the official cancellation signal', async () => {
  const abort = new AbortController(), calls: Array<Parameters<TerminalSnapshotApi['nativeTerminalText']>> = []
  const api: TerminalSnapshotApi = { nativeTerminalText: async (...args) => { calls.push(args); return { ok: true, value: retained } } }
  assert.deepEqual(await readTerminalCopySnapshot(api, projection, false, retained.terminalId, local, abort.signal), { kind: 'source', value: retained, lines: retained.lines })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.[0], { source: { sourceSessionId: 'original-session', sourceHubId: 'stable-source-hub', machineId: 'remote-runner' }, terminalId: 'original-terminal' })
  assert.equal(calls[0]?.[1], abort.signal)
})

test('a source read error, unbound projection or sidechain never falls back to visible text or another terminal', async () => {
  let calls = 0
  const api: TerminalSnapshotApi = { nativeTerminalText: async () => { calls++; throw new Error('Source disconnected') } }
  await assert.rejects(readTerminalCopySnapshot(api, projection, false, retained.terminalId, local, signal()), /Source disconnected/)
  assert.equal(calls, 1)
  await assert.rejects(readTerminalCopySnapshot(api, {}, false, retained.terminalId, local, signal()), /cannot be read/)
  await assert.rejects(readTerminalCopySnapshot(api, projection, true, retained.terminalId, local, signal()), /cannot be read/)
  await assert.rejects(readTerminalCopySnapshot(undefined, projection, false, retained.terminalId, local, signal()), /cannot be read/)
  assert.equal(calls, 1)
  const different: TerminalSnapshotApi = { nativeTerminalText: async () => ({ ok: true, value: { ...retained, terminalId: 'another' } }) }
  await assert.rejects(readTerminalCopySnapshot(different, projection, false, retained.terminalId, local, signal()), /different terminal/)
})

test('a late source snapshot is discarded after the copy dialog cancels its public RPC', async () => {
  const abort = new AbortController()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const api: TerminalSnapshotApi = { nativeTerminalText: async (_request, callerSignal) => { assert.equal(callerSignal, abort.signal); await gate; return { ok: true, value: retained } } }
  const request = readTerminalCopySnapshot(api, projection, false, retained.terminalId, local, abort.signal)
  const rejection = assert.rejects(request, /Closed copy view/)
  abort.abort(new Error('Closed copy view')); release()
  await rejection
})
