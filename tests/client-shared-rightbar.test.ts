/** Navigation/store capabilities are protocol fixtures; the production route
 * performs focus checks, public target parsing, and ordered navigation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import { redirectSharedRightbar } from '../src/client/surface/shared-rightbar.tsx'

const sessionId = 'shared-source-display' as SessionId
const tab = { kind: 'document', contentId: 'dsh-resource://files/session/shared-source-display/report.md', title: 'Original report' }
const params = { selection: { start: 8, end: 12 }, readonly: true }

function pane(paneId: string, state: { visible: boolean; focused: boolean }, events: unknown[], hostId = 'remote'):
    Pick<WorkspacePaneNavigation, 'paneId' | 'hostId' | 'state' | 'openView'> {
    return { paneId, hostId, state: { getSnapshot: () => state, subscribe: () => () => {} },
        openView(target, options) { events.push({ paneId, target, options }) },
    }
}

test('one remote rightbar expansion routes only the focused visible occurrence of the same session', () => {
    const events: unknown[] = []
    const firstState = { visible: true, focused: false }, secondState = { visible: true, focused: true }
    const first = pane('first', firstState, events), second = pane('second', secondState, events)
    const hidden = pane('parked', { visible: false, focused: true }, events)
    const actions = { setExpanded: (id: string, expanded: boolean) => { events.push({ id, expanded }) } }
    assert.equal(redirectSharedRightbar(first, sessionId, tab, params, actions), false)
    assert.equal(redirectSharedRightbar(second, sessionId, tab, params, actions), true)
    assert.equal(redirectSharedRightbar(hidden, sessionId, tab, params, actions), false)
    assert.deepEqual(events, [
        { paneId: 'second', target: { type: 'resource', address: tab.contentId, params }, options: { beside: 'horizontal', title: tab.title } },
        { id: sessionId, expanded: false },
    ])

    // A scheduled effect retains its pane capability, but must consult current
    // presentation before consuming the next graph/session-wide expansion.
    firstState.focused = true; secondState.focused = false; events.length = 0
    assert.equal(redirectSharedRightbar(second, sessionId, tab, params, actions), false)
    assert.equal(redirectSharedRightbar(first, sessionId, tab, params, actions), true)
    assert.equal((events[0] as { paneId: string }).paneId, 'first')
    assert.equal(events.length, 2)
})

test('local shared chrome retains its official rightbar and a failed remote route leaves expansion intact', () => {
    const events: unknown[] = []
    const actions = { setExpanded: (id: string, expanded: boolean) => { events.push({ id, expanded }) } }
    const local = pane('local-pane', { visible: true, focused: true }, events, 'local')
    assert.equal(redirectSharedRightbar(local, sessionId, tab, params, actions), false)
    assert.equal(redirectSharedRightbar(undefined, sessionId, tab, params, actions), false)
    const remote = pane('remote-pane', { visible: true, focused: true }, events)
    remote.openView = () => { throw new Error('The workspace could not retain this resource') }
    assert.throws(() => redirectSharedRightbar(remote, sessionId, tab, params, actions), /could not retain/)
    assert.deepEqual(events, [], 'do not collapse the only original view until its destination has accepted it')
})
