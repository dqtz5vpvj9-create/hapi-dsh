/** Real Socket.IO carrier with an explicit HAPI protocol fixture; it owns no real PTY. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Server, type Socket } from 'socket.io'
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts'
import type { HapiClient } from '../src/hapi/client.ts'
import { connectMachineTerminal, sourceMachineTerminalPrefix, type MachineTerminalCommand, type MachineTerminalInfo } from '../src/hapi/machine-terminals.ts'
import { decodeRetainedTerminalText } from '../src/hapi/terminal-text.ts'
import { NativeWorkbench } from '../src/hapi/workbench.ts'
import { MAX_TERMINAL_TEXT_ROWS } from '../src/workbench-types.ts'

const source = { sourceSessionId: 'retained-source', sourceHubId: 'stable-hub', machineId: 'owning-machine' }
const terminalId = 'original-terminal'
const rawId = sourceMachineTerminalPrefix(source, source.machineId) + terminalId
const signal = (): AbortSignal => new AbortController().signal

async function carrier() {
  const http = createServer(), io = new Server(http, { path: '/source-prefix/socket.io/', transports: ['websocket'], serveClient: false })
  const events = new EventEmitter(), sockets = new Map<string, Socket>()
  const commands: Array<{ socketId: string; machineId: string; command: MachineTerminalCommand }> = [], inputs: string[] = []
  const info: MachineTerminalInfo = { terminalId: rawId, title: 'Retained original terminal', cwd: '/remote/project', cols: 80, rows: 24,
    pid: 123, createdAt: 1, endedAt: null, status: 'running', exitCode: null, seq: 420, controllerId: null, controlVersion: 8 }
  let owner: string | undefined
  let replyMode: 'ok' | 'wrong-terminal' | 'wrong-sequence' | 'incremental' | 'hang' = 'ok'
  const namespace = io.of('/terminal')
  namespace.use((socket, next) => { next(socket.handshake.auth.token === 'fixture-only' ? undefined : new Error('Not authorized')) })
  namespace.on('connection', socket => {
    sockets.set(socket.id, socket)
    socket.on('disconnect', () => {
      sockets.delete(socket.id)
      if (owner === socket.id) { owner = undefined; info.controllerId = null; info.controlVersion++ }
      events.emit('disconnected', socket.id)
    })
    socket.on('machine-terminal:request', (request: { machineId: string; command: MachineTerminalCommand }, acknowledge: (value: unknown) => void) => {
      const { machineId, command } = request
      commands.push({ socketId: socket.id, machineId, command: structuredClone(command) })
      events.emit('command')
      if (machineId !== source.machineId || command.type === 'list' || command.terminalId !== rawId) { acknowledge({ ok: false, error: 'Unknown source terminal' }); return }
      if (command.type === 'attach') {
        if (replyMode === 'hang') return
        acknowledge({ ok: true, value: { terminal: { ...info, ...(replyMode === 'wrong-terminal' ? { terminalId: 'other-terminal' } : {}) },
          reset: replyMode !== 'incremental', seq: info.seq + (replyMode === 'wrong-sequence' ? 1 : 0),
          data: Array.from({ length: 420 }, (_, index) => `source history ${index + 1}`).join('\r\n') } })
        return
      }
      if (command.type === 'claim') { owner = socket.id; info.controllerId = command.controllerId; info.controlVersion++; acknowledge({ ok: true, value: { ...info } }); return }
      if (command.type === 'input' && owner === socket.id && command.controllerId === info.controllerId && command.controlVersion === info.controlVersion) {
        inputs.push(command.data); acknowledge({ ok: true, value: null }); return
      }
      acknowledge({ ok: false, error: 'This fixture does not permit that operation' })
    })
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const address = http.address(); assert.ok(address && typeof address !== 'string')
  const authentication = { url: `http://127.0.0.1:${address.port}`, path: '/source-prefix/socket.io/', token: 'fixture-only' }
  const session: HapiSession = { id: source.sourceSessionId, active: false, thinking: false, activeAt: 1, updatedAt: 1, metadataVersion: 1, agentStateVersion: 1,
    metadata: { path: '/remote/project', machineId: source.machineId }, namespace: 'fixture-only', seq: 1, createdAt: 1, thinkingAt: 0, agentState: null }
  const client: Pick<HapiClient, 'hubId' | 'getSession' | 'request' | 'readBinary' | 'socketAuthentication'> = {
    hubId: source.sourceHubId, getSession: async () => structuredClone(session), socketAuthentication: async () => authentication,
    request: async () => { throw new Error('A terminal snapshot must not use filesystem routes') },
    readBinary: async () => { throw new Error('A terminal snapshot must not read local or source files') },
  }
  const workbench = new NativeWorkbench(client), control = await connectMachineTerminal(authentication, signal())
  await control.request(source.machineId, { type: 'claim', terminalId: rawId, controllerId: 'existing-controller', takeover: true })
  const controller = info.controllerId!, version = info.controlVersion, controlSocketId = owner!
  const waitFor = async (name: string, check: () => boolean): Promise<void> => {
    if (check()) return
    await new Promise<void>((resolve, reject) => {
      const changed = (): void => { if (check()) { cleanup(); resolve() } }
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${name}`)) }, 3000)
      const cleanup = (): void => { clearTimeout(timeout); events.off(name, changed) }
      events.on(name, changed)
    })
  }
  return { workbench, client, session, info, inputs, commands, controlSocketId,
    setReply: (mode: typeof replyMode) => { replyMode = mode },
    write: (data: string) => control.request(source.machineId, { type: 'input', terminalId: rawId, controllerId: controller, controlVersion: version, data }),
    checkLease: () => { assert.equal(owner, controlSocketId); assert.equal(info.controllerId, controller); assert.equal(info.controlVersion, version) },
    readerCommands: () => commands.filter(command => command.socketId !== controlSocketId),
    waitForReader: (count: number) => waitFor('command', () => commands.filter(command => command.command.type === 'attach').length >= count),
    waitForClosed: (socketId: string) => waitFor('disconnected', () => !sockets.has(socketId)),
    close: async () => { workbench.close(); control.close(); await new Promise<void>(resolve => { io.close(() => { resolve() }) }) },
  }
}

test('read-only source snapshot returns retained lines and closes only its viewer while the original input lease stays valid', async () => {
  const fixture = await carrier()
  try {
    await fixture.write('before snapshot')
    const snapshot = await fixture.workbench.nativeTerminalText({ source, terminalId })
    const reader = fixture.readerCommands()
    assert.equal(reader.length, 1)
    assert.deepEqual(reader[0]?.command, { type: 'attach', terminalId: rawId })
    assert.equal(reader[0]?.machineId, source.machineId)
    await fixture.waitForClosed(reader[0]!.socketId)
    fixture.checkLease()
    await fixture.write('after reader closed')
    assert.deepEqual(fixture.inputs, ['before snapshot', 'after reader closed'])
    assert.equal(snapshot.lines.length, 420)
    assert.equal(snapshot.lines[0], 'source history 1')
    assert.equal(snapshot.lines.at(-1), 'source history 420')
    assert.equal(snapshot.sequence, 420)
    assert.equal(snapshot.sourceHistory, 'bounded-unknown')
    assert.equal(snapshot.localLimitReached, false)
    assert.equal(fixture.info.cols, 80); assert.equal(fixture.info.rows, 24)
    assert.equal(JSON.stringify(snapshot).includes('fixture-only'), false)
  } finally { await fixture.close() }
})

test('malformed or incremental source replay fails closed without claim, retry, create, resize or termination', async () => {
  const fixture = await carrier()
  try {
    for (const mode of ['wrong-terminal', 'wrong-sequence', 'incremental'] as const) {
      fixture.setReply(mode)
      await assert.rejects(fixture.workbench.nativeTerminalText({ source, terminalId }),
        (error: unknown) => error instanceof HapiRequestError && error.code === 'protocol_mismatch')
      await fixture.waitForClosed(fixture.readerCommands().at(-1)!.socketId)
      fixture.checkLease()
    }
    assert.deepEqual(fixture.readerCommands().map(value => value.command.type), ['attach', 'attach', 'attach'])
    await fixture.write('still controlled')
    assert.deepEqual(fixture.inputs, ['still controlled'])
  } finally { await fixture.close() }
})

test('cancelling a pending read and disposing the workbench both close their own viewer without changing the original lease', async () => {
  const fixture = await carrier()
  try {
    fixture.setReply('hang')
    const abort = new AbortController()
    const first = fixture.workbench.nativeTerminalText({ source, terminalId }, abort.signal)
    const firstRejected = assert.rejects(first)
    await fixture.waitForReader(1)
    abort.abort(new Error('Read dialog was closed'))
    await firstRejected
    await fixture.waitForClosed(fixture.readerCommands()[0]!.socketId)
    fixture.checkLease()
    const second = fixture.workbench.nativeTerminalText({ source, terminalId })
    const secondRejected = assert.rejects(second)
    await fixture.waitForReader(2)
    fixture.workbench.close()
    await secondRejected
    await fixture.waitForClosed(fixture.readerCommands()[1]!.socketId)
    fixture.checkLease()
    await fixture.write('after both cancellations')
    assert.deepEqual(fixture.readerCommands().map(value => value.command.type), ['attach', 'attach'])
    assert.deepEqual(fixture.inputs, ['after both cancellations'])
  } finally { await fixture.close() }
})

test('terminal text resolves its immutable source first, including offline chats, and rejects a different machine or Hub before attaching', async () => {
  const fixture = await carrier()
  try {
    await assert.rejects(fixture.workbench.nativeTerminalText({ source: { ...source, sourceHubId: 'other-hub' }, terminalId }), /another HAPI Hub/)
    await assert.rejects(fixture.workbench.nativeTerminalText({ source: { ...source, machineId: 'other-machine' }, terminalId }), /another source machine/)
    await assert.rejects(fixture.workbench.nativeTerminalText({ source, terminalId: '../wrong' }))
    assert.equal(fixture.readerCommands().length, 0)
    fixture.checkLease()
    assert.equal(fixture.session.active, false)
    assert.equal((await fixture.workbench.nativeTerminalText({ source, terminalId })).lines.length, 420)
  } finally { await fixture.close() }
})

test('public headless buffer decoding handles wrapped lines, ANSI colors and erased text without exposing escape commands', async () => {
  const result = await decodeRetainedTerminalText('\x1b[31m123456789012345\x1b[0m\r\nreplace me\r\x1b[2Kclean\r\n\x1b]0;private title\x07last', 10, 3, signal())
  assert.deepEqual(result.lines, ['123456789012345', 'clean', 'last'])
  assert.equal(result.localLimitReached, false)
})

test('retained text has an explicit local retention limit and an aborted decoder never produces a snapshot', async () => {
  const result = await decodeRetainedTerminalText(Array.from({ length: MAX_TERMINAL_TEXT_ROWS + 20 }, (_, index) => `line ${index}`).join('\r\n'), 80, 24, signal())
  assert.equal(result.localLimitReached, true)
  assert.equal(result.lines.length, MAX_TERMINAL_TEXT_ROWS)
  assert.equal(result.lines.at(-1), `line ${MAX_TERMINAL_TEXT_ROWS + 19}`)
  assert.notEqual(result.lines[0], 'line 0')
  const abort = new AbortController(); abort.abort(new Error('Cancelled before reading'))
  await assert.rejects(decodeRetainedTerminalText('must not appear', 80, 24, abort.signal), /Cancelled before reading/)
})
