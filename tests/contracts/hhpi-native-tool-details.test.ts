/** Resource identity and cancellation alongside the real official Tool-slot browser journey. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ToolDetailPanel, installNativeToolDetails } from '../../src/client/native-tool-details.tsx'
import { TOOL_DETAIL_MIME, type ToolDetailEnvelope } from '../../src/shared/native-tool-detail.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { Context } from '@deepseek-ai/cordis'
import { fixture } from './hhpi-reading-fixture.ts'

const ref = '12345678-1234-4234-8234-123456789abc'
const value = (revision: number): ToolDetailEnvelope => ({ _hhpiDetail: { kind: 'hhpi-tool-detail', ref, revision, bytes: 8, part: 'output' }, preview: `preview-${revision}` })
test('detail revision and source changes abort old reads, reset controls and ignore late content', { timeout: 15000 }, async t => {
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  t.after(() => { if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT') })
  const f = await fixture(t), container = f.dom.window.document.getElementById('root')!, root = createRoot(container)
  const pending: Array<{ sessionId: string; path: string; signal: AbortSignal; resolve: (value: unknown) => void }> = []
  const api = { resource: (request: { sessionId: string; path: string }, signal: AbortSignal) => new Promise(resolve => pending.push({ ...request, signal, resolve })) } as unknown as HhpiRemoteApi
  const render = async (sessionId: string, revision: number) => act(async () => { root.render(createElement(ToolDetailPanel, { sessionId, value: value(revision), api })) })
  const first = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Read first section')!
  const answer = (index: number, revision: number, text: string) => pending[index]!.resolve({ ok: true, value: { encoding: 'base64', mimeType: TOOL_DETAIL_MIME,
    content: Buffer.from(JSON.stringify({ ref, revision, part: 'output', offset: 0, nextOffset: null, total: 8, bytesBase64: Buffer.from(text).toString('base64') })).toString('base64') } })
  try {
    await render('source-a', 1)
    assert.equal(pending.length, 0, 'preview does not request full content')
    await act(async () => first().click())
    assert.equal(pending[0]!.path, `detail:${ref}:1:0`)
    await render('source-a', 2)
    assert.ok(pending[0]!.signal.aborted)
    assert.equal(first().disabled, false, 'new revision must not inherit pending old controls')
    await act(async () => { answer(0, 1, 'obsolete'); await Promise.resolve() })
    assert.doesNotMatch(container.textContent!, /obsolete/)
    await act(async () => first().click())
    assert.equal(pending[1]!.path, `detail:${ref}:2:0`)
    await render('source-b', 2)
    assert.ok(pending[1]!.signal.aborted, 'a different source cannot share a pending resource request')
    await act(async () => first().click())
    assert.equal(pending[2]!.sessionId, 'source-b')
    await act(async () => { answer(2, 2, 'accepted'); await Promise.resolve() })
    assert.match(container.textContent!, /accepted/)
    await act(async () => root.unmount())
    assert.ok(pending[2]!.signal.aborted)
    // The official registry chooses ascending rank and stamps its caller fiber
    // into diagnostics. Neither identity may be guessed from a supplied label.
    const entries: Array<{ component: unknown; options: { key: string; priority: number }; registrant: string }> = []
    const Original = () => createElement('span', { 'data-normal-native-row': '' }, 'Original official command')
    entries.push({ component: Original, options: { key: 'codex.commandExecution', priority: 1000 }, registrant: 'official-command-alias' })
    let notify = () => {}, registrations = 0
    const context = { locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) }, remote: { hhpi: api }, slots: {
      inject: (_name: string, ready: () => () => void) => ready(),
      entries: () => entries,
      entriesOfSlot: () => [...entries].sort((a, b) => a.options.priority - b.options.priority).filter((entry, index, values) => values.findIndex(value => value.options.key === entry.options.key) === index),
      subscribe: (_name: string, listener: () => void) => { notify = listener; return () => {} },
      register: (options: { key: string; priority: number }, component: unknown) => {
        const entry = { component, options, registrant: 'runtime-stamped-fiber' }; entries.push(entry); registrations++; notify()
        return () => { entries.splice(entries.indexOf(entry), 1); notify() }
      },
    } } as unknown as Context
    const stop = installNativeToolDetails(context)
    try {
      const count = registrations
      notify(); notify()
      assert.equal(registrations, count, 'a stamped registrant cannot cause the wrapper to register itself repeatedly')
      const winner = entries.filter(entry => entry.options.key === 'codex.commandExecution').sort((a, b) => a.options.priority - b.options.priority)[0]!
      assert.notEqual(winner.component, Original, 'detail wrapper must actually win official slot election')
      const normalRoot = createRoot(container)
      try {
        await act(async () => { normalRoot.render(createElement(winner.component as React.ComponentType<any>, { phase: 'result', block: { kind: 'tool-result', call: { argsRaw: '{}' }, content: [], isError: false }, sessionId: 'source-b' })) })
        assert.equal(container.querySelector('[data-normal-native-row]')?.textContent, 'Original official command', 'normal calls delegate once to the original renderer')
      } finally { await act(async () => normalRoot.unmount()) }
    } finally { stop() }
  } finally { await act(async () => root.unmount()) }
})
