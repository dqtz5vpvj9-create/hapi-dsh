/** Explicit fake browser storage; shared UI keys never grant access to another graph's stores. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceUiPreferences } from '../src/client/ui-preferences.ts'
import { graphStorage } from '../src/client/runtime-store.ts'

test('original terminal preferences share only their two public keys across graphs and preserve old values', () => {
    const data = new Map<string, string>([['hapi-terminal-touchbar-keys', '["escape","tab"]']])
    const storage: Storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) },
        clear: () => { data.clear() }, key: index => [...data.keys()][index] ?? null, get length() { return data.size } }
    const shared = createWorkspaceUiPreferences(storage), a = graphStorage(storage, 'one', 'pane-a'), b = graphStorage(storage, 'two', 'pane-b')
    let updates = 0
    const stop = shared.subscribe(() => updates++)
    assert.equal(shared.getItem('hapi-terminal-touchbar-keys'), '["escape","tab"]')
    a.setItem('dsh.sessions.current', 'a'); b.setItem('dsh.sessions.current', 'b')
    shared.setItem('hapi-terminal-toolbar-settings', '{"visible":true}')
    assert.equal(updates, 1); assert.equal(shared.getItem('hapi-terminal-toolbar-settings'), '{"visible":true}')
    assert.equal(a.getItem('hapi-terminal-toolbar-settings'), null); assert.equal(b.getItem('hapi-terminal-toolbar-settings'), null)
    assert.throws(() => shared.getItem('dsh.sessions.current' as never), /not a shared/)
    assert.equal(a.getItem('dsh.sessions.current'), 'a'); assert.equal(b.getItem('dsh.sessions.current'), 'b')
    shared.removeItem('hapi-terminal-toolbar-settings'); assert.equal(updates, 2)
    stop(); shared.dispose()
})

test('a failed browser write does not resurrect an older terminal preference', () => {
    const shared = createWorkspaceUiPreferences({ getItem: () => 'old', setItem: () => { throw new Error('Quota') }, removeItem: () => { throw new Error('Quota') } })
    const published: Array<string | null> = []
    shared.subscribe(() => published.push(shared.getItem('hapi-terminal-touchbar-keys')))
    assert.throws(() => shared.setItem('hapi-terminal-touchbar-keys', 'current'), /Quota/)
    assert.equal(shared.getItem('hapi-terminal-touchbar-keys'), 'current')
    assert.throws(() => shared.removeItem('hapi-terminal-touchbar-keys'), /Quota/)
    assert.equal(shared.getItem('hapi-terminal-touchbar-keys'), null)
    assert.deepEqual(published, ['current', null])
    shared.dispose()
})
