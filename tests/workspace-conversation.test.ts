/** Public SlotCore ownership is real; shell services are explicit test doubles.
 * This contract covers plugin ownership, not full rendering or source writes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { installRemotePane } from '../src/client/remote-pane.tsx'

test('pane composition preserves the original main/header ownership and third-party header entries through disposal', () => {
    const core = new SlotCore(), Empty = () => null
    core.register({ name: 'root', children: {
        main: { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' }, 'settings.launcher': { kind: 'single', scope: 'root' },
        'sidebar.right.tab.menu.item': { kind: 'list', scope: 'session' }, 'rightbar.session': { kind: 'single', scope: 'session' },
    } }, (_props: PropsRenderSlots<'main' | 'shell.overlay' | 'sidebar.panellist' | 'settings.launcher' | 'sidebar.right.tab.menu.item' | 'rightbar.session'>) => null)
    core.register({ name: 'main', key: 'conversation', children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } } }, (_props: PropsRenderSlots<'main.conversation'>) => null)
    core.register({ name: 'main.conversation', children: { 'conversation.header': { kind: 'single', scope: 'session-maybe' } } }, (_props: PropsRenderSlots<'conversation.header'>) => null)
    core.register({ name: 'conversation.header', children: { 'conversation.session.header': { kind: 'single', scope: 'session' } } }, (_props: PropsRenderSlots<'conversation.session.header'>) => null)
    core.register({ name: 'conversation.session.header', children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
        'conversation.session.header.corner': { kind: 'single', scope: 'session' },
        'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
    } }, (_props: PropsRenderSlots<'conversation.session.header.actions' | 'conversation.session.header.utilities' | 'conversation.session.header.corner' | 'conversation.session.header.lineage'>) => null)
    const originalMain = core.entriesOfSlot('main')[0], originalRoot = core.entriesOfSlot('main.conversation')[0]
    const originalHeader = core.entriesOfSlot('conversation.header')[0]
    let panelSubscriptions = 0
    let activePanelId: string | null = null
    const selections: Array<string | null> = []
    const ctx = { layout: { selectPanel: (id: string | null) => { activePanelId = id; selections.push(id) }, panelInfo: { getSnapshot: () => ({ activePanelId }), subscribe: () => {
        panelSubscriptions++
        return () => { panelSubscriptions-- }
    } } }, slots: {
        register: core.register.bind(core), entriesOfSlot: core.entriesOfSlot.bind(core), subscribe: core.subscribe.bind(core),
        inject: (_key: string, callback: () => () => void) => callback(),
    }, locale: { subscribe: () => () => {} },
    // This ownership fixture does not provide shared workspace preferences.
    // A real Cordis dependency scope remains dormant until that service exists.
    inject: () => ({ dispose() {} }),
    } as unknown as Context
    const pane = installRemotePane(ctx, { localeInstalled: true })
    assert.equal(panelSubscriptions, 1)
    const reference = {} as SessionReference
    pane.renderView(reference, { target: { type: 'panel', panelId: 'plugins' }, visible: true, focused: false })
    assert.deepEqual(selections, ['plugins'], 'select the saved panel before React mounts the official root')
    pane.renderView(reference, { target: { type: 'panel', panelId: 'plugins' }, visible: true, focused: true })
    assert.deepEqual(selections, ['plugins'], 'focus changes do not repeat panel navigation')
    assert.equal(core.entriesOfSlot('main')[0], originalMain)
    assert.equal(core.entriesOfSlot('main.conversation')[0], originalRoot)
    assert.equal(core.entriesOfSlot('conversation.header')[0], originalHeader)
    assert.equal(core.entries('main').length, 1)
    assert.equal(core.entriesOfSlot('shell.overlay').some(entry => entry.options.id === 'hapi.workspace.pane-bridge'), true)
    core.register({ name: 'conversation.session.header.utilities', id: 'third-party-test' }, Empty)
    const utility = core.entriesOfSlot('conversation.session.header.utilities')[0]
    pane.dispose(); pane.dispose()
    assert.equal(panelSubscriptions, 0)
    assert.equal(core.entriesOfSlot('main')[0], originalMain)
    assert.equal(core.entriesOfSlot('main.conversation')[0], originalRoot)
    assert.equal(core.entriesOfSlot('conversation.header')[0], originalHeader)
    assert.equal(core.entriesOfSlot('conversation.session.header.utilities')[0], utility)
    assert.equal(core.spec('hapi.remote.bridge'), undefined)
})
