import assert from 'node:assert/strict'
import test from 'node:test'
import { openingHistoryMessage, withOpeningHistory } from '../src/client/session-opening-stream.ts'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'

const follow = (request: object, endpoint = 'session/follow') => JSON.stringify({ type: 'open', streamId: 'same-stream', endpoint,
    payload: { args: { request } } })
const request = { address: { kind: 'session', sessionId: 'existing' }, assistantStream: true,
    maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }

test('remote follow uses the viewport budget without changing identity, live subscription or turn requirements', () => {
    const result = JSON.parse(openingHistoryMessage(follow(request), new Set()))
    assert.equal(result.streamId, 'same-stream')
    assert.deepEqual(result.payload.args.request, { ...request, maxMessages: 20, turnWindow: { minMessages: 20, minTurns: 2 } })
})

test('smaller windows, page requests, commands, cancellations and invalid requests retain their exact wire', () => {
    for (const wire of [follow({ ...request, maxMessages: 10, turnWindow: { minMessages: 5, minTurns: 1 } }),
        follow({ ...request, maxMessages: 0 }), follow({ ...request, turnWindow: { minMessages: 501, minTurns: 2 } }),
        follow(request, 'session/page'), follow(request, 'session/prompt'),
        JSON.stringify({ type: 'cancel', streamId: 'same-stream' }), 'invalid-json']) {
        assert.equal(openingHistoryMessage(wire, new Set()), wire)
    }
})

test('the scoped transport forwards incoming events and socket disposal unchanged', () => {
    const events = new EventTarget(), sent: string[] = [], closes: unknown[] = []
    const socket: ConnectionWebSocket = { readyState: 1, send: value => { sent.push(value) },
        close: (code, reason) => { closes.push([code, reason]) },
        addEventListener: (event, listener, options) => events.addEventListener(event, listener as EventListener, options),
        removeEventListener: (event, listener) => events.removeEventListener(event, listener as EventListener) }
    const opened = new Set<string>()
    const carrier = withOpeningHistory(socket, opened)
    let received = 0
    const listener = () => { received++ }
    carrier.addEventListener('message', listener)
    events.dispatchEvent(new Event('message'))
    carrier.removeEventListener('message', listener)
    events.dispatchEvent(new Event('message'))
    carrier.send(follow(request))
    withOpeningHistory(socket, opened).send(follow(request))
    carrier.close(1000, 'view closed')
    assert.equal(received, 1)
    assert.equal(carrier.readyState, 1)
    assert.equal(JSON.parse(sent[0]!).payload.args.request.maxMessages, 20)
    assert.equal(sent[1], follow(request), 'reconnect preserves the official retained-window request')
    assert.deepEqual(closes, [[1000, 'view closed']])
})
