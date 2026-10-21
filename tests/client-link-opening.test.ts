import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceLinkNavigation, readWorkspaceLinkOpening, workspaceExternalHref, type LinkActivation } from '../src/client/link-opening.ts'
import { createWorkspaceUiPreferences } from '../src/client/ui-preferences.ts'

const click: LinkActivation = { href: 'https://docs.example.test/a?q=exact#part', button: 0, defaultPrevented: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }
const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

test('original HAPI link default and true key coexist with an explicit official DSH destination', () => {
    const data = new Map<string, string>(), preferences = createWorkspaceUiPreferences({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } })
    assert.equal(readWorkspaceLinkOpening(preferences), 'same-tab')
    preferences.setItem('hapi-open-external-links-in-new-tab', 'true')
    assert.equal(readWorkspaceLinkOpening(preferences), 'new-tab')
    preferences.setItem('hapi-dsh-link-opening', 'dsh')
    assert.equal(readWorkspaceLinkOpening(preferences), 'dsh')
    preferences.removeItem('hapi-dsh-link-opening')
    assert.equal(readWorkspaceLinkOpening(preferences), 'new-tab')
    preferences.dispose()
})

test('workspace link handling excludes browser gestures, downloads, paths and plugin-owned navigation', () => {
    assert.equal(workspaceExternalHref(click), click.href)
    for (const variation of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true },
        { download: true }, { native: true }, { target: 'plugin-frame' }, { href: '/settings' }, { href: '//docs.example.test' }, { href: '#section' },
        { href: 'dsh-resource://file/session/one/a.md' }, { href: 'mailto:friend@example.test' }, { href: 'javascript:alert(1)' }, { href: 'https://[' }]) {
        assert.equal(workspaceExternalHref({ ...click, ...variation }), null)
    }
    assert.equal(workspaceExternalHref({ ...click, href: 'HTTPS://docs.example.test/a%20b' }), 'https://docs.example.test/a%20b')
})

test('same-tab departure waits for durable drafts and reports save failure without leaving', async () => {
    const save = deferred(), assigned: string[] = []
    const navigation = new WorkspaceLinkNavigation({ prepare: () => save.promise, assign: href => assigned.push(href), open: () => assert.fail('same-tab never opens a popup') })
    navigation.open(click.href!, 'same-tab')
    await tick(); assert.deepEqual(assigned, []); assert.equal(navigation.getSnapshot().phase, 'saving')
    save.resolve(); await tick(); assert.deepEqual(assigned, [click.href]); navigation.dispose()
    const failed = new WorkspaceLinkNavigation({ prepare: async () => { throw new Error('Attachment persistence failed') }, assign: () => assert.fail('save failure must keep current page'), open: () => {} })
    failed.open(click.href!, 'same-tab'); await tick()
    assert.deepEqual(failed.getSnapshot(), { phase: 'failed', error: 'Attachment persistence failed' }); failed.dispose()
})

test('cancelling or replacing a pending departure cannot revive a stale navigation', async () => {
    const save = deferred(), assigned: string[] = [], opened: string[] = []
    const navigation = new WorkspaceLinkNavigation({ prepare: () => save.promise, assign: href => assigned.push(href), open: href => opened.push(href) })
    navigation.open('https://first.example.test', 'same-tab'); await tick(); navigation.cancel(); save.resolve(); await tick()
    assert.deepEqual(assigned, [])
    navigation.open('https://second.example.test', 'same-tab'); navigation.open('https://third.example.test', 'new-tab'); await tick()
    assert.deepEqual(assigned, []); assert.deepEqual(opened, ['https://third.example.test'])
    navigation.dispose(); navigation.open('https://closed.example.test', 'new-tab'); assert.equal(opened.length, 1)
})
