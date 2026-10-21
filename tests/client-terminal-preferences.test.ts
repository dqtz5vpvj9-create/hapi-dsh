import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkspaceUiPreferences } from '../src/client/ui-preferences.ts'
import { TerminalPreferences, TERMINAL_KEYS, TERMINAL_SETTINGS, terminalKeys, terminalSettings } from '../src/client/source-terminal/preferences.ts'
import { alignedColumns, placeKey, toolbarRows } from '../src/client/source-terminal/havenLayout.ts'
import { importLayout, exportLayout } from '../src/client/source-terminal/keyCatalog.ts'
import { DEFAULT_TOUCHBAR_KEYS } from '../src/client/source-terminal/defaultKeys.ts'

test('original HAPI terminal preferences update all pane consumers and survive a new graph', () => {
  const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  data.set(TERMINAL_KEYS, JSON.stringify([...DEFAULT_TOUCHBAR_KEYS, { id: 'custom-saved', label: 'Saved macro', send: 'pwd\r', row: 0 }]))
  const shared = createWorkspaceUiPreferences(storage), alpha = new TerminalPreferences(shared), beta = new TerminalPreferences(shared)
  assert.equal(alpha.getSnapshot().keys.at(-1)?.send, 'pwd\r')
  const custom = { id: 'custom-test', label: 'Build', send: 'npm test\r', row: 2 as const, col: 1 }
  assert.equal(alpha.updateKeys([...alpha.getSnapshot().keys, custom]), true)
  assert.deepEqual(beta.getSnapshot().keys.at(-1), custom)
  assert.equal(beta.updateSettings({ navMode: 'inline', uniformGrid: true, minKeyWidth: 41 }), true)
  assert.equal(alpha.getSnapshot().settings.minKeyWidth, 41)
  alpha.dispose(); beta.dispose(); shared.dispose()
  const newShared = createWorkspaceUiPreferences(storage), reload = new TerminalPreferences(newShared)
  assert.deepEqual(reload.getSnapshot().keys.at(-1), custom)
  assert.equal(reload.getSnapshot().settings.uniformGrid, true)
  reload.dispose(); newShared.dispose()
})

test('malformed or excessive key layouts are visible errors and never become terminal input', () => {
  const data = new Map<string, string>([[TERMINAL_KEYS, '[{"id":"unsafe","label":"Bad","send":1}]']])
  const shared = createWorkspaceUiPreferences({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } })
  const preferences = new TerminalPreferences(shared)
  assert.match(preferences.getSnapshot().error!, /Invalid/)
  assert.equal(preferences.getSnapshot().keys.some(key => key.id === 'unsafe'), false)
  assert.equal(data.get(TERMINAL_KEYS), '[{"id":"unsafe","label":"Bad","send":1}]', 'Invalid stored preferences are not silently overwritten')
  assert.throws(() => terminalKeys([{ id: 'x', label: 'x', send: 'a'.repeat(16_385) }]))
  assert.throws(() => terminalKeys([{ id: 'same', label: 'one', send: '1' }, { id: 'same', label: 'two', send: '2' }]), /unique/)
  assert.throws(() => terminalSettings({ navMode: 'inline', uniformGrid: false, minKeyWidth: 65 }))
  assert.equal(preferences.updateKeys(DEFAULT_TOUCHBAR_KEYS), true)
  assert.equal(preferences.getSnapshot().error, null)
  assert.equal(preferences.updateSettings({ navMode: 'aligned', uniformGrid: false, minKeyWidth: 0 }), true)
  assert.ok(data.has(TERMINAL_SETTINGS)); preferences.dispose(); shared.dispose()
})

test('Haven layout, off-bar snippets, navigation pairs, JSON, and explicit reorder retain exact key bytes', () => {
  const keys = importLayout('[ ["esc_key", "arrow_up", {"label":"Macro", "send":"echo hi\\r"}], ["arrow_down", "paste"] ]')
  assert.deepEqual(importLayout(exportLayout(keys)).map(({ label, send, action }) => ({ label, send, action })), keys.map(({ label, send, action }) => ({ label, send, action })))
  const macro = keys.find(key => key.label === 'Macro')!
  const hidden = placeKey(keys, macro.id, 0)
  assert.equal(toolbarRows(hidden).flat().some(key => key.id === macro.id), false)
  assert.equal(hidden.find(key => key.id === macro.id)?.send, 'echo hi\r')
  const columns = alignedColumns(DEFAULT_TOUCHBAR_KEYS)
  assert.ok(columns.some(pair => pair[0]?.id === 'home' && pair[1]?.id === 'left'))
  assert.ok(columns.some(pair => pair[0]?.id === 'up' && pair[1]?.id === 'down'))
  const moved = placeKey(DEFAULT_TOUCHBAR_KEYS, 'right', 1, 'slash')
  const row = toolbarRows(moved)[0]!
  assert.equal(row[row.findIndex(key => key.id === 'slash') - 1]?.id, 'right')
})

test('browser quota errors keep the edited keys in every live pane and clear only after a successful save', () => {
  const data = new Map<string, string>(); let fail = true
  const shared = createWorkspaceUiPreferences({ getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { if (fail) throw new Error('Quota exceeded'); data.set(key, value) }, removeItem: key => { data.delete(key) } })
  const alpha = new TerminalPreferences(shared), beta = new TerminalPreferences(shared)
  const next = [...DEFAULT_TOUCHBAR_KEYS, { id: 'custom-quota', label: 'Local', send: 'local', row: 0 as const }]
  assert.equal(alpha.updateKeys(next), false)
  assert.match(alpha.getSnapshot().error!, /Quota/)
  assert.equal(beta.getSnapshot().keys.at(-1)?.send, 'local')
  assert.equal(data.has(TERMINAL_KEYS), false)
  fail = false; assert.equal(alpha.updateKeys(next), true)
  assert.equal(alpha.getSnapshot().error, null)
  assert.ok(data.has(TERMINAL_KEYS)); alpha.dispose(); beta.dispose(); shared.dispose()
})
