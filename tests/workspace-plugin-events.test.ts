/** Fake wire tests. The official browser integration exercises the real Host carrier. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { isPluginEventsRequest, pluginEventsOverWebSocket, SharedPluginEvents } from '../src/client/plugin-events.ts'

const encode = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const encoder = new TextEncoder(), decoder = new TextDecoder()
const next = () => new Promise<void>(resolve => setImmediate(resolve))

test('many official graphs share one Host event stream and a late graph gets the latest graph and rebuilds', async () => {
    let wire!: ReadableStreamDefaultController<Uint8Array>
    let calls = 0
    const lifetime = new AbortController()
    const events = new SharedPluginEvents(async () => {
        calls++
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller } }), { headers: { 'content-type': 'text/event-stream' } })
    }, 'plugins/events', lifetime.signal)
    const firstAbort = new AbortController()
    const first = (await events.response(firstAbort.signal)).body!.getReader()
    const second = (await events.response()).body!.getReader()
    assert.equal(calls, 1)
    const graph = encode({ type: 'graph', graph: { rev: 'g1', entries: [] } })
    // Network chunk boundaries must not become SSE frame boundaries.
    wire.enqueue(encoder.encode(graph.slice(0, 8))); wire.enqueue(encoder.encode(graph.slice(8)))
    assert.equal(decoder.decode((await first.read()).value), graph)
    assert.equal(decoder.decode((await second.read()).value), graph)
    wire.enqueue(encoder.encode(encode({ type: 'rebuilt', id: 'plugin', rev: 'r1' }) + encode({ type: 'rebuilt', id: 'plugin', rev: 'r2' })))
    await first.read(); await first.read(); await second.read(); await second.read()
    const late = (await events.response()).body!.getReader()
    assert.equal(decoder.decode((await late.read()).value), graph)
    assert.equal(decoder.decode((await late.read()).value), encode({ type: 'rebuilt', id: 'plugin', rev: 'r2' }))
    firstAbort.abort(new Error('pane closed'))
    await assert.rejects(first.read(), /pane closed/)
    const latest = encode({ type: 'graph', graph: { rev: 'g2', entries: [] } })
    wire.enqueue(encoder.encode(latest))
    assert.equal(decoder.decode((await second.read()).value), latest)
    assert.equal(decoder.decode((await late.read()).value), latest)
    const final = (await events.response()).body!.getReader()
    assert.equal(decoder.decode((await final.read()).value), latest)
    assert.equal(calls, 1)
    lifetime.abort(new Error('Host disconnected'))
    await assert.rejects(second.read(), /Host disconnected/)
    await assert.rejects(late.read(), /Host disconnected/)
    await assert.rejects(final.read(), /Host disconnected/)
    wire.close()
})

test('plugin stream recognition does not intercept RPC, query variants, or another origin', () => {
    assert.equal(isPluginEventsRequest('plugins/events'), true)
    assert.equal(isPluginEventsRequest('/hapi-dsh/machine/runner/plugins/events'), true)
    assert.equal(isPluginEventsRequest('/api/session/list'), false)
    assert.equal(isPluginEventsRequest('/plugins/events', { method: 'POST' }), false)
    assert.equal(isPluginEventsRequest('/plugins/events?other=1'), false)
    assert.equal(isPluginEventsRequest('https://another.example/plugins/events'), false)
    assert.equal(isPluginEventsRequest('https://workspace.example/plugins/events', undefined, 'https://workspace.example'), true)
})

test('a new official fetch reconnects after a failed stream and never replays stale generation frames', async () => {
    const wires: ReadableStreamDefaultController<Uint8Array>[] = []
    const events = new SharedPluginEvents(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { wires.push(controller) } })), 'plugins/events')
    const original = (await events.response()).body!.getReader()
    wires[0]!.enqueue(encoder.encode(encode({ type: 'graph', graph: { rev: 'old' } })))
    await original.read()
    wires[0]!.error(new Error('wire interrupted'))
    await assert.rejects(original.read(), /wire interrupted/)
    const recovered = (await events.response()).body!.getReader()
    assert.equal(wires.length, 2)
    const latest = encode({ type: 'graph', graph: { rev: 'new' } })
    wires[1]!.enqueue(encoder.encode(latest))
    assert.equal(decoder.decode((await recovered.read()).value), latest)
    const joined = (await events.response()).body!.getReader()
    assert.equal(decoder.decode((await joined.read()).value), latest)
    assert.equal(wires.length, 2)
    events.stop(new Error('test finished'))
    await assert.rejects(recovered.read(), /test finished/)
    await assert.rejects(joined.read(), /test finished/)
    wires[1]!.close()
})

class FakeSocket extends EventTarget {
    binaryType = 'blob'
    closed = false
    close(): void { this.closed = true; this.dispatchEvent(new Event('close')) }
    sendFrame(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
    sendBytes(text: string): void { this.dispatchEvent(new MessageEvent('message', { data: encoder.encode(text).buffer })) }
}

test('WebSocket carrier preserves response headers, binary chunks, source end, and per-Host cancellation', async () => {
    const socket = new FakeSocket()
    const response = pluginEventsOverWebSocket('ws://host.invalid/hapi-dsh/plugin-events?host=local', undefined, () => socket as unknown as WebSocket)
    socket.sendFrame({ type: 'head', status: 200, headers: [['content-type', 'text/event-stream']] })
    const result = await response, reader = result.body!.getReader()
    assert.equal(result.headers.get('content-type'), 'text/event-stream')
    assert.equal(socket.binaryType, 'arraybuffer')
    socket.sendBytes(': connected\n\n')
    assert.equal(decoder.decode((await reader.read()).value), ': connected\n\n')
    socket.sendFrame({ type: 'end' })
    assert.equal((await reader.read()).done, true)
    assert.equal(socket.closed, true)

    const aborted = new FakeSocket(), lifetime = new AbortController()
    const pending = pluginEventsOverWebSocket('ws://host.invalid/', lifetime.signal, () => aborted as unknown as WebSocket)
    lifetime.abort(new Error('Host disposed'))
    await assert.rejects(pending, /Host disposed/)
    assert.equal(aborted.closed, true)
})

test('an interrupted event carrier errors its body instead of reporting a normal stream end', async () => {
    const socket = new FakeSocket()
    const pending = pluginEventsOverWebSocket('ws://host.invalid/', undefined, () => socket as unknown as WebSocket)
    socket.sendFrame({ type: 'head', status: 200, headers: [['content-type', 'text/event-stream']] })
    const reader = (await pending).body!.getReader()
    socket.close()
    await assert.rejects(reader.read(), /before its source ended/)
    await next()
})
