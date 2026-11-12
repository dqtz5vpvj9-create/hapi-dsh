/** Real pinned Chat, input, Session occurrence and memory provider. Synthetic IO
 * and deterministic jsdom geometry remain boundaries, not browser evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MountedChatControlV1 } from '../../src/client/mounted-chat-control.ts'
import type { PropsRuntime, PropsRenderFactories, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { fixture } from './hhpi-reading-fixture.ts'
import { installDomGeometry } from './dom-geometry.ts'
import { ACTIVE_CONVERSATION_INPUT } from './conversation-content-input.ts'
import { createWorkspaceUpdatePreparations } from '../../src/client/update-preparation.ts'
import { SourceReadingCache } from '../../src/client/remote-reading-cache.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'hhpi.test.update-reader': { kind: 'single'; scope: 'session' } } }

test('the real pinned reader samples its current position before update persistence and rejects storage failure', { timeout: 15000 }, async t => {
  const prepared = process.env.HHPI_PREPARED_CHAT_SOURCE
  const f = await fixture(t, prepared ? { preparedChatSource: prepared } : {}), geometry = installDomGeometry(f.dom.window, { width: 800, height: 600 })
  const pane = await f.open('checkpoint-occurrence', 'checkpoint-pane'), updates = createWorkspaceUpdatePreparations()
  let control: MountedChatControlV1 | undefined, unmount: (() => void) | undefined
  f.ctx.reflect.provide('mountedChatConsumer', { onMountedChat(value: MountedChatControlV1 | null) { control = value ?? undefined } })
  await f.ctx.plugin({ name: 'checkpoint-real-reader', inject: ['slots'], apply(ctx: Context) {
    const workspaces = { items: [], phase: 'ready' }, panelInfo = { activePanelId: null }
    ctx.slots.provideRoot({ hooks: { workspaces: { getSnapshot: () => workspaces, subscribe: () => () => {} },
      panelInfo: { getSnapshot: () => panelInfo, subscribe: () => () => {} } } })
    ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'hhpi.test.update-reader': { kind: 'single', scope: 'session' } } },
      (props: PropsRuntime<'root'> & PropsRenderSlots<'hhpi.test.update-reader'>) => createElement(props.SessionProvider,
        { session: pane.reference, children: props.renderSlot('hhpi.test.update-reader', {}) }))
    ctx.slots.register({ name: 'hhpi.test.update-reader' }, (props: PropsRenderFactories) => props.renderFactorySlot('conversation.content', ACTIVE_CONVERSATION_INPUT))
  } })
  const stop = f.remote.installReadingCheckpoint(updates, pane.binding, () => control)
  const prototype = f.dom.window.Storage.prototype, write = prototype.setItem
  try {
    await act(async () => { unmount = f.ctx.uiRenderer.mount(f.dom.window.document.getElementById('root')!) })
    assert.ok(control); assert.ok(f.dom.window.document.querySelector('[data-chat-flow]'))
    assert.ok(control.read().renderRevision! > 0, 'real Node seats must publish their layout commit revision')
    const snapshot = pane.conversation.target('chat').getSnapshot()!
    assert.ok([...snapshot.nodes.values()].some(node => node.visibility === 'visible' && control!.renderedNode?.(node.key) === node),
      'at least one actual visible snapshot node must match the original payload acknowledged by its mounted Node seat')
    await act(async () => { await updates.checkpoint() })
    const saved = new SourceReadingCache({ storage: f.dom.window.localStorage, scope: 'synthetic-reading' })
    try {
      const record = JSON.parse(f.dom.window.localStorage.getItem(`hhpi:reading:v1:synthetic-reading:${pane.binding.sessionId}`)!)
      assert.ok(Object.hasOwn(record.positions, 'checkpoint-pane'), 'the real reader must have saved this exact Pane position')
      if (control.read().following) assert.equal(record.positions['checkpoint-pane'].value, null, 'the actual live-tail position is null')
      else assert.ok(saved.readAnchor(pane.binding.sessionId, 'checkpoint-pane'), 'a non-tail position needs an exact source anchor')
    } finally { saved.dispose() }
    prototype.setItem = function(key: string, value: string) { if (key.startsWith('hhpi:reading:')) throw new Error('Actual reading quota'); return write.call(this, key, value) }
    await act(async () => { await assert.rejects(updates.checkpoint(), /Actual reading quota/) })
    prototype.setItem = write
    await act(async () => { await updates.checkpoint() })
    assert.equal(f.writes.length, 0, 'checkpoint cannot submit, cancel, approve or create native work')
    await act(async () => { unmount?.(); unmount = undefined })
    f.remote.revokeStorage()
    await assert.rejects(updates.checkpoint(), /source or account changed/)
  } finally {
    prototype.setItem = write; stop(); updates.dispose()
    if (unmount) await act(async () => { unmount?.() })
    geometry.dispose()
  }
})
