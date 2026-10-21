/** Navigation contract tests use explicit fakes; official rendering is exercised by e2e/. */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SurfaceActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { initialWorkspace, parseWorkspaceState, WorkspaceStore } from '../src/client/model.ts'
import { parseDshPaneTarget, parseNavigationValue } from '../src/workspace/dsh-view.ts'
import { restoreOfficialPaneTarget, targetForTab } from '../src/client/pane-bridge.tsx'

const sessionId = 'actual-session' as SessionId

function rig() {
    const calls: unknown[][] = []
    const definitions = new Map<string, { kind: string; title(address: string): string; canOpen?: (address: string) => boolean }>([
        ['terminal', { kind: 'terminal', title: () => 'Terminal' }],
        ['custom-page', { kind: 'custom-page', title: () => 'Custom page' }],
    ])
    const context = {
        layout: { selectPanel: (...args: unknown[]) => { calls.push(['selectPanel', ...args]) } },
        sidebarRightTabs: { get: (kind: string) => definitions.get(kind) },
        sidebarRight: {
            openResourceIn: (...args: unknown[]) => { calls.push(['openResourceIn', ...args]) },
            openTabIn: (...args: unknown[]) => { calls.push(['openTabIn', ...args]) },
            close: () => { assert.fail('A workspace view must never close provider resources') },
            tabDomain: { navigate: (...args: unknown[]) => { calls.push(['navigate', ...args]) } },
        },
    } as unknown as Pick<Context, 'sidebarRight' | 'sidebarRightTabs' | 'layout'>
    const actions = {
        openContent: (id: string, intent: unknown, settled: (tabId: string) => void) => { calls.push(['openContent', id, intent]); settled('tab7') },
        setExpanded: (...args: unknown[]) => { calls.push(['setExpanded', ...args]) },
    } as unknown as SurfaceActions
    return { context, actions, definitions, calls }
}

test('opaque third-party DSH destinations survive geometry persistence without a matching renderer', () => {
    let sequence = 0
    const id = () => `node-${++sequence}`
    const store = new WorkspaceStore(initialWorkspace(id), id)
    const target = parseDshPaneTarget({ type: 'resource', address: 'dsh-resource://third-party/session/actual-session/result', params: { line: 17, nested: ['context', true, null] } })
    store.openResource({ kind: 'view', sessionId, viewId: 'third-party-view', target })
    store.createWindow('Other')
    store.openResource({ kind: 'view', sessionId, viewId: 'separate-instance', target: { type: 'tab', kind: 'not-installed', address: 'sidebar://not-installed/stable-instance' } })
    const restored = parseWorkspaceState(JSON.parse(JSON.stringify(store.getSnapshot())))
    assert.equal(restored.windows.length, 2)
    assert.deepEqual(restored, store.getSnapshot())
    store.closeWindow(store.active().id); store.restoreWindow()
    assert.deepEqual(store.focusedPane().resource, { kind: 'view', sessionId, viewId: 'separate-instance', target: { type: 'tab', kind: 'not-installed', address: 'sidebar://not-installed/stable-instance' } })
})

test('layout rejects executable destinations and non-JSON plugin parameters', () => {
    for (const address of ['javascript:alert(1)', 'https://example.com', 'dsh-resource://user:secret@file/a']) assert.throws(() => parseDshPaneTarget({ type: 'resource', address }))
    assert.throws(() => parseNavigationValue({ callback() {} }))
    assert.throws(() => parseNavigationValue({ value: Number.POSITIVE_INFINITY }))
    assert.throws(() => parseNavigationValue(JSON.parse('{"__proto__":{"injected":true}}')))
    assert.throws(() => parseDshPaneTarget({ type: 'tab', kind: 'terminal', address: 'sidebar://other/1' }))
})

test('resource viewers are selected by the official router, retaining typed navigation params', () => {
    const { context, actions, calls } = rig()
    restoreOfficialPaneTarget(context, sessionId, actions, { type: 'resource', address: 'dsh-resource://file/session/actual-session/home/readme.md', params: { line: 42 } })
    assert.deepEqual(calls, [['selectPanel', null], ['openResourceIn', sessionId, 'dsh-resource://file/session/actual-session/home/readme.md', { params: { line: 42 } }]])
    assert.deepEqual(targetForTab({ kind: 'third-party-markdown', contentId: 'dsh-resource://file/session/actual-session/readme.md' }, { line: 4 }), {
        type: 'resource', address: 'dsh-resource://file/session/actual-session/readme.md', params: { line: 4 },
    })
})

test('restoring a multiple terminal uses its exact occurrence contentId and never allocates a replacement', () => {
    const { context, actions, calls } = rig()
    const target = { type: 'tab', kind: 'terminal', address: 'sidebar://terminal/existing-occurrence', params: { terminalId: 'real-pty-id' } } as const
    restoreOfficialPaneTarget(context, sessionId, actions, target)
    assert.deepEqual(calls, [
        ['selectPanel', null],
        ['openContent', sessionId, { kind: 'terminal', contentId: target.address, title: 'Terminal' }],
        ['navigate', sessionId, 'tab7', { address: target.address, params: { terminalId: 'real-pty-id' } }],
    ])
    assert.equal(calls.some(call => call[0] === 'openTabIn'), false)
})

test('a new independent page uses the official openTab allocator and missing plugin keeps its destination', () => {
    const { context, actions, calls } = rig()
    restoreOfficialPaneTarget(context, sessionId, actions, { type: 'tab', kind: 'terminal' })
    assert.deepEqual(calls.at(-1), ['openTabIn', sessionId, 'terminal', {}])
    calls.length = 0
    assert.throws(() => restoreOfficialPaneTarget(context, sessionId, actions, { type: 'tab', kind: 'missing-extension', address: 'sidebar://missing-extension/saved-id' }), /original address is preserved/)
    assert.deepEqual(calls, [['selectPanel', null]])
})

test('revealing Conversation only hides official resources; it never executes explicit tab close hooks', () => {
    const { context, actions, calls } = rig()
    restoreOfficialPaneTarget(context, sessionId, actions, { type: 'conversation' })
    assert.deepEqual(calls, [['selectPanel', null], ['setExpanded', sessionId, false]])
    calls.length = 0
    restoreOfficialPaneTarget(context, sessionId, actions, { type: 'panel', panelId: 'third-party-dashboard' })
    assert.deepEqual(calls, [['selectPanel', 'third-party-dashboard']])
})
