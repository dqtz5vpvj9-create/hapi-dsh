import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import { deferInitialWorkspaceStream } from '../src/client/initial-workspace-stream.ts'

function fixture() {
    const sent: string[] = [], events = new EventTarget(), abort = new AbortController()
    let resolveReady!: () => void
    const ready = { promise: new Promise<void>(resolve => { resolveReady = resolve }), resolve: () => resolveReady() }
    const socket: ConnectionWebSocket = {
        readyState: 1,
        send: message => { sent.push(message) },
        close: () => { events.dispatchEvent(new Event('close')) },
        addEventListener: (event, listener, options) => events.addEventListener(event, listener as EventListener, options),
        removeEventListener: (event, listener) => events.removeEventListener(event, listener as EventListener),
    }
    return { sent, events, abort, ready, socket: deferInitialWorkspaceStream(socket, ready.promise, abort.signal) }
}
const workspace = (streamId = 'workspace') => JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } })
const session = JSON.stringify({ type: 'open', streamId: 'session', endpoint: 'session/follow', payload: { args: { sessionId: 'original' } } })

test('initial navigation delays only Workspace opening and forwards original bytes after readiness', async () => {
    const f = fixture(), open = workspace()
    f.socket.send(open); f.socket.send(session)
    assert.deepEqual(f.sent, [session])
    f.ready.resolve(); await f.ready.promise
    assert.deepEqual(f.sent, [session, open])
    f.socket.send(workspace('next'))
    assert.deepEqual(f.sent, [session, open, workspace('next')])
})

test('cancel removes a pending Workspace open without sending an unknown cancellation to the Host', async () => {
    const f = fixture()
    f.socket.send(workspace())
    f.socket.send(JSON.stringify({ type: 'cancel', streamId: 'workspace' }))
    const unrelated = JSON.stringify({ type: 'cancel', streamId: 'session' })
    f.socket.send(unrelated)
    f.ready.resolve(); await f.ready.promise
    assert.deepEqual(f.sent, [unrelated])
})

test('graph abort and socket close prevent a delayed Workspace open from escaping after disposal', async () => {
    for (const close of [(f: ReturnType<typeof fixture>) => f.abort.abort(), (f: ReturnType<typeof fixture>) => f.socket.close(),
        (f: ReturnType<typeof fixture>) => f.events.dispatchEvent(new Event('close'))]) {
        const f = fixture()
        f.socket.send(workspace()); close(f)
        f.ready.resolve(); await f.ready.promise
        assert.deepEqual(f.sent, [])
    }
})
