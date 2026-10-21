/** Real official SlotCore lifecycle, with explicit DOM and locale boundary doubles. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { installSourceTerminalActions, OFFICIAL_TERMINAL_SEAT } from '../src/client/source-terminal-actions.tsx'
import { createWorkspaceUiPreferences, type WorkspaceUiPreferences } from '../src/client/ui-preferences.ts'

test('terminal composition preserves the official face, follows plugin reload, and restores the original seat', async () => {
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let styles = 0, locales = 0
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ dataset: {}, remove() { styles-- } }), head: { append() { styles++ } } } })
  try {
    const core = new SlotCore(), root = core.register({ name: 'root', children: { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session',
      inject: { hooks: { tabInfo: () => () => { throw new Error('No DOM rendering occurs in this registry lifecycle test') } } },
    } } }, (() => null) as never)
    const snapshot = { fontSizes: { terminal: 13 } } as ThemeSnapshot
    const face = { view: () => { throw new Error('Registration never mounts or connects a terminal') },
      hooks: { theme: { getSnapshot: () => snapshot, subscribe: (_listener: () => void) => () => {} }, untouched: {} }, keyedHooks: { terminal: () => ({}) } }, seen: string[] = []
    let preferences: WorkspaceUiPreferences | undefined
    const Official = () => null
    let original = core.register({ name: 'sidebar.right.pane.tab', key: OFFICIAL_TERMINAL_SEAT, locale: 'hapiTerminalKeys', inject: (sessionId: SessionId) => { seen.push(sessionId); return face } }, Official)
    const ctx = { get: (name: string) => name === 'hapiWorkspaceUi' && preferences ? { preferences } : undefined,
      slots: { register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core), inject: (_name: string, apply: () => (() => void)) => apply() },
      locale: { register: () => { locales++; return () => { locales-- } }, bind: () => (key: string) => key } } as unknown as Context
    const dispose = installSourceTerminalActions(ctx)
    assert.equal(styles, 1); assert.equal(locales, 1)
    assert.equal(core.entries('sidebar.right.pane.tab').length, 2)
    const active = core.entriesOfSlot('sidebar.right.pane.tab')[0]!
    assert.notEqual(active.component, Official)
    assert.equal((active.inject as (id: SessionId) => unknown)('own-session' as SessionId), face)
    assert.deepEqual(seen, ['own-session']); assert.equal(active.locale, 'hapiTerminalKeys')
    const storage = new Map<string, string>([['hapi-terminal-font-size', '9']])
    const shared = createWorkspaceUiPreferences({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } })
    preferences = shared
    const themed = (active.inject as (id: SessionId) => typeof face)('own-session' as SessionId)
    assert.notEqual(themed, face)
    assert.equal(themed.view, face.view); assert.equal(themed.keyedHooks, face.keyedHooks); assert.equal(themed.hooks.untouched, face.hooks.untouched)
    assert.equal(themed.hooks.theme.getSnapshot().fontSizes.terminal, 9)
    assert.equal(face.hooks.theme.getSnapshot().fontSizes.terminal, 13, 'official shared theme remains unchanged')
    let updates = 0
    const unsubscribeTheme = themed.hooks.theme.subscribe(() => { updates++ })
    shared.setItem('hapi-terminal-font-size', '17')
    assert.equal(updates, 1); assert.equal(themed.hooks.theme.getSnapshot().fontSizes.terminal, 17)
    unsubscribeTheme(); shared.dispose(); preferences = undefined
    original(); await new Promise<void>(resolve => queueMicrotask(resolve)); await new Promise<void>(resolve => queueMicrotask(resolve))
    assert.equal(core.entries('sidebar.right.pane.tab').length, 0)
    const Reloaded = () => null
    original = core.register({ name: 'sidebar.right.pane.tab', key: OFFICIAL_TERMINAL_SEAT, inject: () => face }, Reloaded)
    await new Promise<void>(resolve => queueMicrotask(resolve))
    assert.equal(core.entries('sidebar.right.pane.tab').length, 2)
    assert.notEqual(core.entriesOfSlot('sidebar.right.pane.tab')[0]?.component, Reloaded)
    dispose()
    assert.equal(core.entriesOfSlot('sidebar.right.pane.tab')[0]?.component, Reloaded)
    assert.equal(core.entries('sidebar.right.pane.tab').length, 1)
    assert.equal(styles, 0); assert.equal(locales, 0)
    original(); root()
  } finally { if (document) Object.defineProperty(globalThis, 'document', document); else Reflect.deleteProperty(globalThis, 'document') }
})
