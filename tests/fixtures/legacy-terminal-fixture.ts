/** Explicit simulated SessionTerminal PTY behind the original Socket.IO wire.
 * It retains original session/terminal IDs and never executes a shell. */
import type { Socket } from 'socket.io'
import type { HapiSession } from '../../src/codex/contracts.ts'

interface Cursor { epoch: string; offset: number }
interface Terminal { sessionId: string; terminalId: string; epoch: string; output: string }
interface Attach { sessionId: string; terminalId: string; cols: number; rows: number; replayProtocol: 1; outputCursor?: Cursor }
const key = (sessionId: string, terminalId: string): string => `${sessionId}\0${terminalId}`
export class LegacyTerminalWireFixture {
  readonly attachments: Attach[] = []
  readonly inputs: Array<{ sessionId: string; machineId: string; terminalId: string; data: string }> = []
  readonly resizes: Array<{ sessionId: string; terminalId: string; cols: number; rows: number }> = []
  readonly closeRequests: Array<{ terminalId: string }> = []
  readonly detachments: Array<{ sessionId: string; terminalId: string }> = []
  private readonly terminals = new Map<string, Terminal>()
  private readonly viewers = new Map<Socket, Terminal>()
  constructor(private readonly sessions: () => HapiSession[]) {}
  seed(sessionId: string, terminalId: string, output = 'Simulated original SessionTerminal\r\n$ '): void {
    if (!this.sessions().some(session => session.id === sessionId)) throw new Error('Unknown fixture source')
    this.terminals.set(key(sessionId, terminalId), { sessionId, terminalId, epoch: `fixture-${terminalId}`, output })
  }
  attach(socket: Socket): void {
    socket.on('terminal:create', (request: Attach) => {
      const terminal = this.terminals.get(key(request.sessionId, request.terminalId))
      if (!terminal || request.replayProtocol !== 1) { socket.emit('terminal:error', { terminalId: request.terminalId,
        sessionId: request.sessionId, message: 'Original fixture terminal is not available' }); return }
      this.attachments.push(structuredClone(request)); this.viewers.set(socket, terminal)
      const requested = request.outputCursor, valid = !requested || requested.epoch === terminal.epoch && requested.offset <= terminal.output.length
      const start = requested && valid ? requested.offset : 0
      socket.emit('terminal:output', { sessionId: terminal.sessionId, terminalId: terminal.terminalId,
        data: terminal.output.slice(start), stream: { version: 1, epoch: terminal.epoch, startOffset: start,
          endOffset: terminal.output.length, replay: true, ...(!valid ? { gap: 'epoch-changed' } : {}) } })
      socket.emit('terminal:ready', { sessionId: terminal.sessionId, terminalId: terminal.terminalId, replayProtocol: 1 })
    })
    socket.on('terminal:write', (request: { terminalId: string; data: string }) => {
      const terminal = this.viewers.get(socket)
      if (!terminal || terminal.terminalId !== request.terminalId) return
      const session = this.sessions().find(session => session.id === terminal.sessionId)
      if (!session?.metadata?.machineId) throw new Error('Original source machine is missing')
      this.inputs.push({ sessionId: terminal.sessionId, terminalId: terminal.terminalId, machineId: session.metadata.machineId, data: request.data })
    })
    socket.on('terminal:resize', (request: { terminalId: string; cols: number; rows: number }) => {
      const terminal = this.viewers.get(socket)
      if (terminal?.terminalId === request.terminalId) this.resizes.push({ sessionId: terminal.sessionId, ...request })
    })
    socket.on('terminal:close', (request: { terminalId: string }) => { this.closeRequests.push(structuredClone(request)) })
    socket.on('disconnect', () => {
      const terminal = this.viewers.get(socket)
      if (terminal) this.detachments.push({ sessionId: terminal.sessionId, terminalId: terminal.terminalId })
      this.viewers.delete(socket)
    })
  }
  output(sessionId: string, terminalId: string, data: string): void {
    const terminal = this.terminals.get(key(sessionId, terminalId))
    if (!terminal) throw new Error('Unknown original fixture terminal')
    const startOffset = terminal.output.length; terminal.output += data
    for (const [socket, owned] of this.viewers) if (owned === terminal) socket.emit('terminal:output', {
      sessionId, terminalId, data, stream: { version: 1, epoch: terminal.epoch, startOffset, endOffset: terminal.output.length, replay: false },
    })
  }
}
