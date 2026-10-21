/** Real Socket.IO carrier; the server is an explicit HAPI wire fixture, not a PTY owner. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Server, type Socket } from 'socket.io'
import { connectMachineTerminal, type MachineTerminalChannel, type MachineTerminalCommand } from '../src/hapi/machine-terminals.ts'
import { HapiRequestError } from '../src/codex/contracts.ts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function carrier() {
  const http = createServer(), io = new Server(http, { path: '/original-prefix/socket.io/', transports: ['websocket'], serveClient: false })
  const namespace = io.of('/terminal'), received: Array<{ machineId: string; command: MachineTerminalCommand }> = [], sockets = new Set<Socket>()
  const accepted = deferred<void>()
  let handler: (socket: Socket, value: { machineId: string; command: MachineTerminalCommand }, reply: (result: unknown) => void) => void = (_socket, _value, reply) => { reply({ ok: true, value: [] }) }
  namespace.use((socket, next) => { next(socket.handshake.auth.token === 'fixture-only-credential' ? undefined : new Error('not authorized')) })
  namespace.on('connection', socket => {
    sockets.add(socket); socket.on('disconnect', () => { sockets.delete(socket) })
    socket.on('machine-terminal:request', (value: { machineId: string; command: MachineTerminalCommand }, reply: (result: unknown) => void) => { received.push(value); accepted.resolve(); handler(socket, value, reply) })
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const authentication = { url: `http://127.0.0.1:${address.port}`, path: '/original-prefix/socket.io/', token: 'fixture-only-credential' }
  const channels: MachineTerminalChannel[] = []
  return { received, accepted: accepted.promise, sockets,
    setHandler: (value: typeof handler) => { handler = value },
    connect: async () => { const channel = await connectMachineTerminal(authentication, new AbortController().signal); channels.push(channel); return channel },
    close: async () => { for (const channel of channels) channel.close(); await new Promise<void>(resolve => { io.close(() => { resolve() }) }) },
  }
}

test('real prefixed Socket.IO transport waits for the source command ACK and keeps credentials out of commands', async () => {
  const fixture = await carrier()
  try {
    const channel = await fixture.connect(), reply = deferred<(value: unknown) => void>()
    fixture.setHandler((_socket, _value, acknowledge) => { reply.resolve(acknowledge) })
    let complete = false
    const request = channel.request('source-machine', { type: 'input', terminalId: 'original', controllerId: 'controller', controlVersion: 3, data: 'once\r' }).then(value => { complete = true; return value })
    const acknowledge = await reply.promise
    assert.equal(complete, false)
    acknowledge({ ok: true, value: null })
    assert.equal(await request, null)
    assert.equal(fixture.received.length, 1)
    assert.deepEqual(fixture.received[0], { machineId: 'source-machine', command: { type: 'input', terminalId: 'original', controllerId: 'controller', controlVersion: 3, data: 'once\r' } })
    assert.equal(JSON.stringify(fixture.received).includes('fixture-only-credential'), false)
  } finally { await fixture.close() }
})

test('real source disconnect after input dispatch reports an unknown outcome and never reconnects or replays it', async () => {
  const fixture = await carrier()
  try {
    const first = await fixture.connect()
    fixture.setHandler((socket) => { socket.disconnect(true) })
    await assert.rejects(first.request('source-machine', { type: 'input', terminalId: 'original', controllerId: 'controller', controlVersion: 3, data: 'single dispatch' }),
      (error: unknown) => error instanceof HapiRequestError && error.outcome === 'indeterminate' && error.code === 'terminal_ack_unknown')
    await assert.rejects(first.request('source-machine', { type: 'input', terminalId: 'original', controllerId: 'controller', controlVersion: 3, data: 'not sent' }),
      (error: unknown) => error instanceof HapiRequestError && error.outcome === 'rejected' && error.code === 'terminal_not_sent')
    fixture.setHandler((_socket, _value, acknowledge) => { acknowledge({ ok: true, value: [] }) })
    const replacement = await fixture.connect()
    assert.deepEqual(await replacement.request('source-machine', { type: 'list' }), [])
    assert.deepEqual(fixture.received.map(value => value.command.type), ['input', 'list'])
  } finally { await fixture.close() }
})

test('real source rejection after a mutation does not become a successful input acknowledgement', async () => {
  const fixture = await carrier()
  try {
    const channel = await fixture.connect()
    fixture.setHandler((_socket, _value, acknowledge) => { acknowledge({ ok: false, error: 'Machine connection lost or timed out; command outcome unknown' }) })
    await assert.rejects(channel.request('source-machine', { type: 'terminate', terminalId: 'original' }),
      (error: unknown) => error instanceof HapiRequestError && error.outcome === 'indeterminate')
    assert.equal(fixture.received.length, 1)
  } finally { await fixture.close() }
})
