/** Original HAPI machine TerminalHost transport behind the official DSH terminal wire contract. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Manager } from 'socket.io-client'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { RemoteError, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from '@deepseek-ai/dsh-api-terminal-controller'
import type { TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalInput, TerminalRetentionFrame, TerminalShell, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { HapiClient } from './client.ts'
import type { NativeWorkbench } from './workbench.ts'
import { HapiRequestError } from '../codex/contracts.ts'
import type { WorkbenchSource } from '../workbench-types.ts'

type Authentication = Awaited<ReturnType<HapiClient['socketAuthentication']>>
const idSchema = z.string().min(1).max(256)
const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }
/** This is the pinned HAPI public protocol, not a replacement PTY implementation. */
export const machineTerminalInfoSchema = z.strictObject({
  terminalId: idSchema, title: z.string(), cwd: z.string(), pid: z.number().int().nullable(), createdAt: z.number(), endedAt: z.number().nullable(),
  status: z.enum(['starting', 'running', 'closing', 'exited', 'lost']), exitCode: z.number().int().nullable(),
  ...dimensions, seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), controllerId: idSchema.nullable(), controlVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export type MachineTerminalInfo = z.infer<typeof machineTerminalInfoSchema>
export type MachineTerminalCommand =
  | { type: 'list' }
  | { type: 'create'; terminalId: string; cwd: string; title: string; cols: number; rows: number }
  | { type: 'attach'; terminalId: string; afterSeq?: number }
  | { type: 'detach' | 'terminate'; terminalId: string }
  | { type: 'claim'; terminalId: string; controllerId: string; takeover: boolean }
  | { type: 'release'; terminalId: string; controllerId: string; controlVersion: number }
  | { type: 'input'; terminalId: string; controllerId: string; controlVersion: number; data: string }
  | { type: 'resize'; terminalId: string; controllerId: string; controlVersion: number; cols: number; rows: number }
  | { type: 'rename'; terminalId: string; title: string }
const machineEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('output'), terminalId: idSchema, seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), data: z.string().max(16 * 1024 * 1024) }),
  z.strictObject({ type: z.literal('state'), terminal: machineTerminalInfoSchema }),
  z.strictObject({ type: z.literal('disconnected'), error: z.string().max(8192) }),
])
export type MachineTerminalEvent = z.infer<typeof machineEventSchema>
const envelopeSchema = z.strictObject({ machineId: idSchema, event: machineEventSchema })
const replaySchema = z.strictObject({ terminal: machineTerminalInfoSchema, reset: z.boolean(), data: z.string().max(16 * 1024 * 1024), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
export { replaySchema as machineTerminalReplaySchema }
export function sourceMachineTerminalPrefix(source: WorkbenchSource, machineId: string): string {
  return `hapi-dsh-${createHash('sha256').update(JSON.stringify([source.sourceHubId, source.sourceSessionId, machineId])).digest('hex').slice(0, 32)}-`
}
const replySchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.string().max(8192) })])

export interface MachineTerminalChannel {
  request(machineId: string, command: MachineTerminalCommand, signal?: AbortSignal): Promise<unknown>
  subscribe(listener: (machineId: string, event: MachineTerminalEvent) => void): () => void
  close(): void
}
export type MachineTerminalConnector = (authentication: Authentication, signal: AbortSignal) => Promise<MachineTerminalChannel>

/** Never queue or retry a command across connection generations. Each ACK belongs to the original source request. */
export const connectMachineTerminal: MachineTerminalConnector = async (authentication, signal) => {
  signal.throwIfAborted()
  const manager = new Manager(authentication.url, { path: authentication.path, transports: ['websocket'], autoConnect: false, reconnection: false, timeout: 15_000 })
  const socket = manager.socket('/terminal', { auth: { token: authentication.token } })
  const listeners = new Set<(machineId: string, event: MachineTerminalEvent) => void>()
  let closed = false
  const close = () => { if (closed) return; closed = true; socket.removeAllListeners(); socket.disconnect() }
  socket.on('machine-terminal:event', (raw: unknown) => {
    const parsed = envelopeSchema.safeParse(raw)
    if (!parsed.success) { for (const listener of listeners) listener('', { type: 'disconnected', error: 'Incompatible source terminal event' }); close(); return }
    for (const listener of listeners) listener(parsed.data.machineId, parsed.data.event)
  })
  socket.on('disconnect', () => { for (const listener of listeners) listener('', { type: 'disconnected', error: 'The source terminal connection ended; no input will be replayed' }) })
  await new Promise<void>((resolve, reject) => {
    const abort = () => { cleanup(); close(); reject(signal.reason ?? new Error('Terminal connection cancelled')) }
    const connected = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); close(); reject(new HapiRequestError('The source terminal transport is unavailable', 'rejected', undefined, 'terminal_unavailable')) }
    const cleanup = () => { signal.removeEventListener('abort', abort); socket.off('connect', connected); socket.off('connect_error', failed) }
    signal.addEventListener('abort', abort, { once: true }); socket.once('connect', connected); socket.once('connect_error', failed); socket.connect()
  })
  return {
    async request(machineId, command, requestSignal) {
      requestSignal?.throwIfAborted()
      if (closed || !socket.connected || manager.engine?.transport.writable !== true) throw new HapiRequestError('The source is disconnected. This terminal command was not sent.', 'rejected', undefined, 'terminal_not_sent')
      const abort = () => { close() }
      requestSignal?.addEventListener('abort', abort, { once: true })
      try {
        const raw: unknown = await socket.volatile.timeout(27_000).emitWithAck('machine-terminal:request', { machineId, command })
        const reply = replySchema.safeParse(raw)
        if (!reply.success) throw new HapiRequestError('The source returned an incompatible terminal reply', 'indeterminate', undefined, 'protocol_mismatch')
        if (!reply.data.ok) throw new HapiRequestError(reply.data.error, command.type === 'list' || command.type === 'attach' ? 'rejected' : 'indeterminate', undefined, 'terminal_source_error')
        return reply.data.value
      } catch (error) {
        // Closing also prevents later commands queued at this transport from
        // taking effect after a timeout has become visible to the user.
        close()
        if (error instanceof HapiRequestError) throw error
        throw new HapiRequestError('The terminal command lost its source acknowledgement; its outcome is unknown. It was not retried.', 'indeterminate', undefined, 'terminal_ack_unknown')
      } finally { requestSignal?.removeEventListener('abort', abort) }
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    close,
  }
}

function remoteFailure(error: unknown): never {
  if (error instanceof HapiRequestError) throw new RemoteError('hapi/request', error.message, { outcome: error.outcome,
    ...(error.status === undefined ? {} : { status: error.status }), ...(error.code === undefined ? {} : { sourceCode: error.code }) })
  throw error
}
function protocol<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new HapiRequestError('The source returned an incompatible terminal response', 'indeterminate', undefined, 'protocol_mismatch')
  return parsed.data
}
const closedSchema = z.strictObject({ version: z.literal(1), terminals: z.record(z.string(), z.enum(['requested', 'confirmed'])) })
type ClosedState = z.infer<typeof closedSchema>

class TerminalFrames<T> {
  private readonly queue: Array<{ value: T; bytes: number }> = []
  private bytes = 0
  private failure: unknown
  private ended = false
  private wake: (() => void) | undefined
  constructor(private readonly maxBytes: number) {}
  push(value: T): void {
    if (this.ended || this.failure !== undefined) return
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (this.bytes + bytes > this.maxBytes) { this.fail(new Error('Terminal output receiver fell behind. Reconnect for the source screen.')); return }
    this.queue.push({ value, bytes }); this.bytes += bytes; this.wake?.()
  }
  fail(error: unknown): void { this.failure = error; this.wake?.() }
  end(): void { this.ended = true; this.wake?.() }
  async *read(signal: AbortSignal): AsyncIterable<T> {
    const abort = () => { this.end() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (this.failure !== undefined) throw this.failure
        const item = this.queue.shift()
        if (item) { this.bytes -= item.bytes; yield item.value; continue }
        if (this.ended) return
        await new Promise<void>(resolve => { this.wake = resolve })
        this.wake = undefined
      }
    } finally { signal.removeEventListener('abort', abort) }
  }
}

/** The original Runner owns the PTY, its process, screen, history and control lease. */
export class NativeMachineTerminals {
  private readonly lifetime = new AbortController()
  private readonly channels = new Set<MachineTerminalChannel>()
  private readonly allocations = new Map<string, Promise<unknown>>()
  constructor(
    private readonly authenticate: () => Promise<Authentication>,
    private readonly workbench: Pick<NativeWorkbench, 'resolveTerminalSource'>,
    private readonly config: Config,
    private readonly options: { stateFile: string; connect?: MachineTerminalConnector },
  ) {}

  async environment(source: WorkbenchSource, signal: AbortSignal): Promise<TerminalEnvironment> {
    try {
      signal.throwIfAborted()
      const session = await this.workbench.resolveTerminalSource(source)
      return { cwd: session.metadata!.path, maxInputBytes: Math.min(65_536, this.config.maxInputBytes), maxBufferedBytes: this.config.maxBufferedBytes,
        maxCols: Math.min(500, this.config.maxCols), maxRows: Math.min(200, this.config.maxRows), scrollback: this.config.scrollback }
    } catch (error) { return remoteFailure(error) }
  }

  async shells(source: WorkbenchSource, signal: AbortSignal): Promise<TerminalShell[]> {
    await this.environment(source, signal)
    // The source supports its configured default but advertises no executable
    // discovery API. An empty menu lets official creation use that default;
    // no fabricated executable path is offered to the user.
    return []
  }

  async list(source: WorkbenchSource, signal: AbortSignal): Promise<WebTerminalInfo[]> {
    try {
      const target = await this.target(source)
      const closed = await this.closed()
      return await this.withChannel(signal, async channel => {
        const list = protocol(z.array(machineTerminalInfoSchema), await channel.request(target.machineId, { type: 'list' }, signal))
        return list.filter(info => info.terminalId.startsWith(target.prefix) && closed.terminals[info.terminalId] !== 'confirmed')
          .map(info => this.info(info, target.prefix, closed.terminals[info.terminalId] === 'requested'))
      })
    } catch (error) { return remoteFailure(error) }
  }

  async create(source: WorkbenchSource, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> {
    try {
      if (!/^[\w-]{1,128}$/u.test(request.id)) throw new Error('Invalid terminal identity')
      this.validateDimensions(request.cols, request.rows)
      if (request.shellPath !== undefined) throw new RemoteError('terminal/unavailable', 'The HAPI Runner selects its configured default shell; executable selection is not advertised by this source.', {})
      const target = await this.target(source), terminalId = target.prefix + request.id
      return await this.serialize(target.prefix, async () => {
        signal.throwIfAborted()
        if ((await this.closed()).terminals[terminalId] !== undefined) throw new RemoteError('terminal/unavailable', 'This terminal identity was explicitly closed and cannot create another shell', {})
        return this.withChannel(signal, async channel => {
          const existing = protocol(z.array(machineTerminalInfoSchema), await channel.request(target.machineId, { type: 'list' }, signal))
          const known = existing.find(info => info.terminalId === terminalId)
          if (known) return this.info(known, target.prefix)
          if (existing.filter(info => info.terminalId.startsWith(target.prefix) && ['starting', 'running', 'closing'].includes(info.status)).length >= this.config.maxTerminals) {
            throw new RemoteError('terminal/limit-reached', 'The source session terminal limit was reached', { limit: this.config.maxTerminals })
          }
          const info = protocol(machineTerminalInfoSchema, await channel.request(target.machineId, { type: 'create', terminalId, cwd: target.cwd, title: 'Terminal', cols: request.cols, rows: request.rows }, signal))
          this.assertId(info, terminalId)
          return this.info(info, target.prefix)
        })
      })
    } catch (error) { return remoteFailure(error) }
  }

  async rename(source: WorkbenchSource, id: WebTerminalId, title: string, signal: AbortSignal): Promise<void> {
    try {
      if (!title.trim() || title.length > 120) throw new Error('Terminal title must contain 1–120 characters')
      const target = await this.target(source), terminalId = this.rawId(target.prefix, id)
      await this.withChannel(signal, async channel => {
        const info = protocol(machineTerminalInfoSchema, await channel.request(target.machineId, { type: 'rename', terminalId, title: title.trim() }, signal))
        this.assertId(info, terminalId)
        if (info.title !== title.trim()) throw new HapiRequestError('The source did not confirm the terminal title', 'indeterminate', undefined, 'terminal_ack_unknown')
      })
    } catch (error) { remoteFailure(error) }
  }

  async closeTerminal(source: WorkbenchSource, id: WebTerminalId, signal: AbortSignal): Promise<void> {
    try {
      const target = await this.target(source), terminalId = this.rawId(target.prefix, id)
      await this.serialize(target.prefix, async () => {
        signal.throwIfAborted()
        if ((await this.closed()).terminals[terminalId] === 'confirmed') return
        await this.recordClose(terminalId, 'requested')
        await this.withChannel(signal, async channel => {
          const list = protocol(z.array(machineTerminalInfoSchema), await channel.request(target.machineId, { type: 'list' }, signal))
          const found = list.find(info => info.terminalId === terminalId)
          if (!found) { await this.recordClose(terminalId, 'confirmed'); return }
          const info = protocol(machineTerminalInfoSchema, await channel.request(target.machineId, { type: 'terminate', terminalId }, signal))
          this.assertId(info, terminalId)
          if (info.status !== 'exited') throw new HapiRequestError('The source has not confirmed that the original terminal exited. Its identity remains closed to new creation.', 'indeterminate', undefined, 'terminal_exit_unconfirmed')
          await this.recordClose(terminalId, 'confirmed')
        })
      })
    } catch (error) { remoteFailure(error) }
  }

  async *retain(source: WorkbenchSource, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    const list = await this.list(source, signal)
    if (!list.some(info => info.id === id && info.error !== 'Terminal close has not been confirmed by its source')) throw new RemoteError('terminal/unavailable', 'The original source terminal is unavailable', {})
    yield { type: 'retained' }
    if (signal.aborted) return
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }

  async *attach(source: WorkbenchSource, id: WebTerminalId, input: AsyncIterable<TerminalInput>, signal: AbortSignal, inputWindow?: RemoteUplinkWindow): AsyncIterable<TerminalFrame> {
    const lifetime = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal, this.lifetime.signal])
    let channel: MachineTerminalChannel | undefined
    let unsubscribe: (() => void) | undefined
    let commands: Promise<void> | undefined
    let uplink: AsyncIterator<TerminalInput> | undefined
    try {
      const target = await this.target(source), terminalId = this.rawId(target.prefix, id)
      if ((await this.closed()).terminals[terminalId] !== undefined) throw new RemoteError('terminal/unavailable', 'This source terminal is closing or closed', {})
      channel = await this.channel(combined)
      const events = new TerminalFrames<MachineTerminalEvent | TerminalFrame>(this.config.maxBufferedBytes)
      const controllerId = randomUUID()
      let current: MachineTerminalInfo | undefined
      const observe = (info: MachineTerminalInfo): void => {
        // ACKs and already queued screen events can cross. Never restore an
        // older control lease while draining the display queue.
        if (current !== undefined && (info.controlVersion < current.controlVersion
          || info.controlVersion === current.controlVersion && info.seq < current.seq)) return
        current = info
      }
      unsubscribe = channel.subscribe((machineId, event) => {
        if (machineId && machineId !== target.machineId) return
        if (event.type === 'disconnected') { events.fail(new Error(event.error)); return }
        if (event.type === 'state') {
          if (event.terminal.terminalId !== terminalId) return
          observe(event.terminal)
        } else if (event.terminalId !== terminalId) return
        events.push(event)
      })
      const replay = protocol(replaySchema, await channel.request(target.machineId, { type: 'attach', terminalId }, combined))
      this.assertId(replay.terminal, terminalId)
      if (!replay.reset) throw new HapiRequestError('The source did not provide the required complete terminal screen', 'indeterminate', undefined, 'protocol_mismatch')
      observe(replay.terminal)
      if (replay.terminal.status === 'running') {
        const claimed = protocol(machineTerminalInfoSchema, await channel.request(target.machineId, { type: 'claim', terminalId, controllerId, takeover: true }, combined))
        this.assertId(claimed, terminalId)
        observe(claimed)
        if (claimed.controllerId !== controllerId) throw new HapiRequestError('The source did not confirm this view\'s terminal control', 'indeterminate', undefined, 'terminal_control_unconfirmed')
      }
      let outputSequence = replay.seq
      const writable = () => current?.status === 'running' && current.controllerId === controllerId && !combined.aborted
      uplink = input[Symbol.asyncIterator]()
      const sourceChannel = channel, sourceInput = uplink
      commands = (async () => {
        let sequence = 0
        while (!combined.aborted) {
          const next = await sourceInput.next()
          if (next.done || combined.aborted) return
          const command = next.value
          if (!Number.isSafeInteger(command.sequence) || command.sequence !== ++sequence) throw new Error('Terminal input sequence has a gap')
          if (current?.status !== 'running') { events.push({ type: 'ack', sequence, refusal: 'not-running' }); continue }
          if (!writable()) { events.push({ type: 'ack', sequence, refusal: 'read-only' }); continue }
          const claim: { terminalId: string; controllerId: string; controlVersion: number } = { terminalId, controllerId, controlVersion: current.controlVersion }
          if (command.type === 'write') {
            if (Buffer.byteLength(command.data, 'utf8') > Math.min(65_536, this.config.maxInputBytes)) throw new Error('Terminal input exceeds the configured limit')
            const reply = await sourceChannel.request(target.machineId, { type: 'input', ...claim, data: command.data }, combined)
            if (reply !== null) throw new HapiRequestError('The source did not return an input acceptance acknowledgement', 'indeterminate', undefined, 'protocol_mismatch')
          } else {
            this.validateDimensions(command.cols, command.rows)
            const reply: MachineTerminalInfo = protocol(machineTerminalInfoSchema, await sourceChannel.request(target.machineId, { type: 'resize', ...claim, cols: command.cols, rows: command.rows }, combined))
            this.assertId(reply, terminalId)
            observe(reply)
            events.push({ type: 'state', terminal: reply })
          }
          events.push({ type: 'ack', sequence })
        }
      })().catch(error => { if (!combined.aborted) events.fail(error) })
      yield { type: 'snapshot', sequence: outputSequence, screen: replay.data, info: this.info(current ?? replay.terminal, target.prefix), writable: writable(), ...(inputWindow === undefined ? {} : { inputWindow }) }
      for await (const event of events.read(combined)) {
        if (event.type === 'output' && 'terminalId' in event) {
          if (event.seq <= outputSequence) continue
          if (event.seq !== outputSequence + 1) throw new Error('The source terminal output has a gap. Reconnect for its complete screen.')
          outputSequence = event.seq
          yield { type: 'output', sequence: outputSequence, data: event.data }
        } else if (event.type === 'state' && 'terminal' in event) {
          observe(event.terminal)
          yield { type: 'state', info: this.info(current ?? event.terminal, target.prefix), writable: writable() }
        } else if (event.type === 'ack') yield event
      }
    } catch (error) {
      if (!combined.aborted) remoteFailure(error)
    } finally {
      lifetime.abort(); unsubscribe?.()
      if (channel) { this.channels.delete(channel); channel.close() }
      // Source disconnection releases only this viewer's lease and subscription.
      // It never emits terminate, agent abort, or a replacement create.
      await uplink?.return?.()
      await commands
    }
  }

  dispose(): void { this.lifetime.abort(); for (const channel of this.channels) channel.close(); this.channels.clear() }

  private async target(source: WorkbenchSource): Promise<{ prefix: string; machineId: string; cwd: string }> {
    const session = await this.workbench.resolveTerminalSource(source)
    const machineId = session.metadata!.machineId!
    const prefix = sourceMachineTerminalPrefix(source, machineId)
    return { prefix, machineId, cwd: session.metadata!.path }
  }
  private rawId(prefix: string, id: WebTerminalId): string {
    if (!/^[\w-]{1,128}$/u.test(id)) throw new Error('Invalid terminal identity')
    return prefix + id
  }
  private assertId(info: MachineTerminalInfo, id: string): void {
    if (info.terminalId !== id) throw new HapiRequestError('The source returned a different terminal identity', 'indeterminate', undefined, 'source_mismatch')
  }
  private info(info: MachineTerminalInfo, prefix: string, closing = false): WebTerminalInfo {
    if (!info.terminalId.startsWith(prefix)) throw new HapiRequestError('The terminal belongs to another source session', 'rejected', undefined, 'source_mismatch')
    return { id: info.terminalId.slice(prefix.length) as WebTerminalId, title: info.title,
      shell: { path: '', args: [], name: 'HAPI Runner default shell' }, cwd: info.cwd, cols: info.cols, rows: info.rows,
      state: closing || info.status === 'lost' ? 'failed' : info.status === 'exited' ? 'exited' : 'running', exitCode: info.exitCode,
      ...(closing ? { error: 'Terminal close has not been confirmed by its source' } : info.status === 'lost' ? { error: 'The original terminal process was lost; attaching never creates another shell' } : {}) }
  }
  private validateDimensions(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > Math.min(500, this.config.maxCols)
      || !Number.isSafeInteger(rows) || rows < 1 || rows > Math.min(200, this.config.maxRows)) throw new Error('Terminal dimensions exceed the configured source limits')
  }
  private async channel(signal: AbortSignal): Promise<MachineTerminalChannel> {
    this.lifetime.signal.throwIfAborted(); signal.throwIfAborted()
    const channel = await (this.options.connect ?? connectMachineTerminal)(await this.authenticate(), AbortSignal.any([signal, this.lifetime.signal]))
    this.channels.add(channel)
    return channel
  }
  private async withChannel<T>(signal: AbortSignal, run: (channel: MachineTerminalChannel) => Promise<T>): Promise<T> {
    const channel = await this.channel(signal)
    try { return await run(channel) }
    finally { this.channels.delete(channel); channel.close() }
  }
  private async serialize<T>(source: string, run: () => Promise<T>): Promise<T> {
    const previous = this.allocations.get(source) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(run)
    this.allocations.set(source, task)
    try { return await task }
    finally { if (this.allocations.get(source) === task) this.allocations.delete(source) }
  }
  private async closed(): Promise<ClosedState> {
    let text: string
    try { text = await readFile(this.options.stateFile, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, terminals: {} }; throw error }
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Terminal close registry exceeds its supported size')
    return closedSchema.parse(JSON.parse(text) as unknown)
  }
  private async recordClose(id: string, state: 'requested' | 'confirmed'): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true, mode: 0o700 })
    await withFileLock(this.options.stateFile, async () => {
      const value = await this.closed()
      if (value.terminals[id] === 'confirmed') return
      value.terminals[id] = state
      await writeFileAtomic(this.options.stateFile, JSON.stringify(value) + '\n', { mode: 0o600, dirMode: 0o700 })
    })
  }
}
