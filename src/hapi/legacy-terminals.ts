/** Original session-scoped PTYs behind the public DSH terminal wire. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Config } from '@deepseek-ai/dsh-api-terminal-controller'
import type { TerminalEnvironment, TerminalFrame, TerminalInput, TerminalRetentionFrame, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { RemoteError, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
import { HapiRequestError } from '../codex/contracts.ts'
import type { NativeWorkbench } from './workbench.ts'
import { createNativeTerminalSocket, type NativeTerminalAuthentication, type NativeTerminalSocket } from './terminal.ts'
import { terminalOutputStreamSchema, workbenchSourceSchema, type TerminalOutputCursor, type WorkbenchSource } from '../workbench-types.ts'
import { LEGACY_TERMINAL_ID_PREFIX, isLegacyTerminalId, legacyTerminalInputs, type LegacyTerminalOpenRequest, type LegacyTerminalReadRequest, type LegacyTerminalListRequest, type LegacyTerminalState } from '../legacy-terminal-types.ts'
import { LegacyTerminalScreen } from './legacy-terminal-screen.ts'
import { LegacyTerminalFrames } from './legacy-terminal-frames.ts'
import type { LegacyTerminalTextSnapshot } from '../legacy-terminal-text-types.ts'

export type LegacyTerminalLimits = Pick<Config, 'maxInputBytes' | 'maxBufferedBytes' | 'maxCols' | 'maxRows' | 'scrollback' | 'maxTerminals'>
export interface LegacySessionTerminalsOptions {
  authenticate: () => Promise<NativeTerminalAuthentication>
  workbench: Pick<NativeWorkbench, 'resolveSource'>
  getLimits: () => LegacyTerminalLimits
  createSocket?: (authentication: NativeTerminalAuthentication) => NativeTerminalSocket
  /** Bounded open-to-retain handoff; test overrides do not change source idle policy. */
  handoffMs?: number
  openTimeoutMs?: number
  /** Preserve the original SessionTerminal's 10,000-row history by default. */
  scrollback?: number
  now?: () => number
}
type Source = LegacyTerminalState['source']
type Phase = LegacyTerminalState['phase']
type ReplayIssue = LegacyTerminalState['replay']['issue']
interface Follower { frames: LegacyTerminalFrames; active: boolean; generation: number }
interface Opening { generation: number; promise: Promise<void>; resolve(): void; reject(error: unknown): void; timer?: ReturnType<typeof setTimeout> | undefined }
interface Retained {
  id: WebTerminalId; bindings: Set<string>; terminalId: string; source: Source; screen: LegacyTerminalScreen
  environment: TerminalEnvironment | null; phase: Phase; info: WebTerminalInfo | null
  dimensions: LegacyTerminalState['facts']['dimensions']; lastSourceReadyAt: number | null; exitSignal: string | null
  cursor: TerminalOutputCursor | null; issue: ReplayIssue; sequence: number; error: string | null
  accepted: number; lastAcceptedAt: number | null; uncertain: boolean
  socket?: NativeTerminalSocket | undefined; generation: number; sourceReady: boolean; replayReady: boolean; opening?: Opening | undefined
  queue: Promise<void>; queuedBytes: number; queuedTasks: number; preparing: number; holds: Set<symbol>; followers: Set<Follower>; controller?: Follower | undefined
  handoff?: ReturnType<typeof setTimeout> | undefined; lastUsed: number
}
const outputSchema = z.object({ terminalId: z.string(), sessionId: z.string().optional(), data: z.string().max(4 * 1024 * 1024), stream: terminalOutputStreamSchema.optional() })
const readySchema = z.object({ terminalId: z.string(), sessionId: z.string().optional(), replayProtocol: z.literal(1).optional() })
const exitSchema = z.object({ terminalId: z.string(), sessionId: z.string().optional(), code: z.number().int().nullable(), signal: z.string().nullable() })
const errorSchema = z.object({ terminalId: z.string(), sessionId: z.string().optional(), message: z.string().max(8192) })
const compatibility: LegacyTerminalState['compatibility'] = {
  open: 'attach-or-create', inputAcknowledgement: 'adapter-transport', replay: 'bounded-source-tail', retention: 'source-idle-policy', close: 'detach-only',
}
const unknownShell = { path: '', args: [] as string[], name: 'Shell not reported by legacy source' }
function unavailable(message: string): RemoteError<'terminal/unavailable'> { return new RemoteError('terminal/unavailable', message, {}) }
function failed(message: string, outcome: 'rejected' | 'indeterminate', code: string): HapiRequestError { return new HapiRequestError(message, outcome, 409, code) }
function displayId(source: Source, terminalId: string): WebTerminalId {
  return `${LEGACY_TERMINAL_ID_PREFIX}${createHash('sha256').update(JSON.stringify([source.sourceHubId, source.sourceSessionId, source.machineId, terminalId])).digest('hex').slice(0, 40)}` as WebTerminalId
}
function canonicalSource(input: WorkbenchSource): Source {
  const source = workbenchSourceSchema.parse(input)
  if (!source.sourceHubId || !source.machineId) throw failed('The original terminal requires a verified Hub and source machine.', 'rejected', 'source_unavailable')
  return { sourceHubId: source.sourceHubId, sourceSessionId: source.sourceSessionId, machineId: source.machineId }
}
function sameSource(left: Source, right: Source): boolean { return left.sourceHubId === right.sourceHubId && left.sourceSessionId === right.sourceSessionId && left.machineId === right.machineId }
function assertHint(hint: WorkbenchSource, expected: Source): void {
  if (hint.sourceSessionId !== expected.sourceSessionId || hint.sourceHubId !== undefined && hint.sourceHubId !== expected.sourceHubId || hint.machineId !== undefined && hint.machineId !== expected.machineId) {
    throw failed('This terminal belongs to a different original HAPI source.', 'rejected', 'source_mismatch')
  }
}
async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => { reject(signal.reason ?? new Error('Terminal request cancelled')) }; signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([promise, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}

/** One source connection per original tuple; view shutdown never terminates it. */
export class LegacySessionTerminals {
  private readonly records = new Map<WebTerminalId, Retained>()
  private readonly lifetime = new AbortController()
  private readonly handoffMs: number
  private readonly openTimeoutMs: number
  private readonly now: () => number
  private readonly scrollback: number
  private accessSequence = 0
  constructor(private readonly options: LegacySessionTerminalsOptions) {
    this.handoffMs = options.handoffMs ?? 10_000
    this.openTimeoutMs = options.openTimeoutMs ?? 20_000
    this.now = options.now ?? Date.now
    this.scrollback = options.scrollback ?? 10_000
    if (!Number.isSafeInteger(this.handoffMs) || this.handoffMs < 1 || !Number.isSafeInteger(this.openTimeoutMs) || this.openTimeoutMs < 1) throw new Error('Invalid legacy terminal connection deadlines')
    if (!Number.isSafeInteger(this.scrollback) || this.scrollback < 0 || this.scrollback > 10_000) throw new Error('Invalid legacy terminal scrollback limit')
  }

  /** Explicit old attach-or-create; list/read/retain never call this mutation. */
  async open(input: LegacyTerminalOpenRequest, expectedSource: WorkbenchSource, signal: AbortSignal): Promise<LegacyTerminalState> {
    const request = legacyTerminalInputs.sourceLegacyTerminalOpen.parse(input), source = canonicalSource(expectedSource)
    assertHint(request.source, source); signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
    const limits = this.limits(), id = displayId(source, request.terminalId)
    let record = this.records.get(id)
    if (!record) {
      this.evictUnused(source, limits.maxTerminals)
      if ([...this.records.values()].filter(value => sameSource(value.source, source)).length >= limits.maxTerminals) {
        throw new RemoteError('terminal/limit-reached', 'The original source terminal view limit was reached.', { limit: limits.maxTerminals })
      }
      if (this.records.size >= 512) throw unavailable('The legacy terminal adapter has reached its retained-screen limit.')
      const cols = Math.max(2, Math.min(request.cols, limits.maxCols)), rows = Math.max(1, Math.min(request.rows, limits.maxRows))
      record = { id, bindings: new Set(), terminalId: request.terminalId, source, screen: new LegacyTerminalScreen(cols, rows, limits.scrollback),
        environment: null, phase: 'opening', info: null, dimensions: null, lastSourceReadyAt: null, exitSignal: null,
        cursor: null, issue: null, sequence: 0, error: null, accepted: 0, lastAcceptedAt: null, uncertain: false,
        generation: 0, sourceReady: false, replayReady: false, queue: Promise.resolve(), queuedBytes: 0, queuedTasks: 0, preparing: 0,
        holds: new Set(), followers: new Set(), lastUsed: ++this.accessSequence }
      this.records.set(id, record)
    }
    record.bindings.add(request.sessionId)
    record.lastUsed = ++this.accessSequence
    record.preparing++; this.cancelHandoff(record)
    try {
      // A deliberate Open/Reload can establish a fresh bounded replay. A plain
      // attach/reconnect never discards a cursor or revives an observed exit.
      if ((record.issue && record.issue !== 'truncated') || record.phase === 'exited') {
        await withSignal(this.enqueue(record, () => {
          this.disconnect(record)
          for (const follower of record.followers) this.failFollower(record, follower, unavailable('The original source replay was explicitly reloaded.'))
          record.controller = undefined; record.screen.reset(); record.cursor = null; record.issue = null; record.info = null
          record.phase = 'opening'; record.error = null; record.sourceReady = false; record.replayReady = false; record.exitSignal = null
          record.dimensions = null; record.lastSourceReadyAt = null
        }), signal)
      }
      await withSignal(this.ensureConnected(record), signal)
      return this.state(record, request.sessionId)
    } finally { record.preparing--; this.releaseIfUnused(record, true) }
  }

  read(input: LegacyTerminalReadRequest, expectedSource: WorkbenchSource): LegacyTerminalState | null {
    const request = legacyTerminalInputs.sourceLegacyTerminalRead.parse(input), source = canonicalSource(expectedSource)
    this.lifetime.signal.throwIfAborted()
    if (!isLegacyTerminalId(request.id)) throw unavailable('This is not an original SessionTerminal display identity.')
    const record = this.records.get(request.id as WebTerminalId)
    if (!record) return null
    this.authorize(record, request.sessionId, source)
    return this.state(record, request.sessionId)
  }

  list(input: LegacyTerminalListRequest, expectedSource: WorkbenchSource): LegacyTerminalState[] {
    const request = legacyTerminalInputs.sourceLegacyTerminals.parse(input), source = canonicalSource(expectedSource)
    this.lifetime.signal.throwIfAborted()
    return [...this.records.values()].filter(record => record.bindings.has(request.sessionId) && sameSource(record.source, source)).map(record => this.state(record, request.sessionId))
  }

  async readText(input: LegacyTerminalReadRequest, expectedSource: WorkbenchSource, signal?: AbortSignal): Promise<LegacyTerminalTextSnapshot> {
    const request = legacyTerminalInputs.sourceLegacyTerminalRead.parse(input)
    const record = this.get(request.sessionId, expectedSource, request.id as WebTerminalId)
    const lifetime = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    lifetime.throwIfAborted()
    return withSignal(this.enqueue(record, () => {
      lifetime.throwIfAborted()
      return { id: record.id, sessionId: request.sessionId, terminalId: record.terminalId, source: { ...record.source },
        provenance: 'adapter-observed', replay: 'bounded-source-tail', replayIssue: record.issue,
        sequence: record.sequence, capturedAt: this.now(), ...record.screen.text() }
    }), lifetime)
  }

  async *retain(sessionId: string, expectedSource: WorkbenchSource, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    const record = this.get(sessionId, expectedSource, id), hold = Symbol('legacy terminal view')
    signal.throwIfAborted(); record.holds.add(hold); this.cancelHandoff(record)
    try {
      // A local adapter/window hold only. No source attach, input transfer,
      // activity heartbeat, or claim that source idle cleanup is suppressed.
      yield { type: 'retained' }
      if (!signal.aborted && !this.lifetime.signal.aborted) await new Promise<void>(resolve => {
        const done = (): void => { signal.removeEventListener('abort', done); this.lifetime.signal.removeEventListener('abort', done); resolve() }
        signal.addEventListener('abort', done, { once: true }); this.lifetime.signal.addEventListener('abort', done, { once: true })
      })
    } finally { record.holds.delete(hold); this.releaseIfUnused(record) }
  }

  async *attach(sessionId: string, expectedSource: WorkbenchSource, id: WebTerminalId, input: AsyncIterable<TerminalInput>, signal: AbortSignal, inputWindow?: RemoteUplinkWindow): AsyncIterable<TerminalFrame> {
    const record = this.get(sessionId, expectedSource, id), lifetime = new AbortController(), combined = AbortSignal.any([signal, lifetime.signal, this.lifetime.signal])
    // A follower owns a pending view immediately, but joins the output stream
    // only in the same FIFO transaction as its complete baseline snapshot.
    const follower: Follower = { frames: new LegacyTerminalFrames(this.limits().maxBufferedBytes), active: false, generation: -1 }
    let uplink: AsyncIterator<TerminalInput> | undefined, commands: Promise<void> | undefined
    record.followers.add(follower); this.cancelHandoff(record)
    try {
      if (record.phase !== 'exited') await withSignal(this.ensureConnected(record), combined)
      const baseline = await this.enqueue(record, () => {
        combined.throwIfAborted()
        if (!record.info || record.phase !== 'ready' && record.phase !== 'exited') throw unavailable('The original terminal has not confirmed a running process.')
        const screen = record.screen.snapshot(), sequence = record.sequence
        follower.generation = record.generation
        follower.active = true
        record.controller = record.phase === 'ready' ? follower : undefined
        this.broadcastState(record, follower)
        return { type: 'snapshot' as const, sequence, screen, info: this.info(record), writable: this.writable(record, follower), ...(inputWindow ? { inputWindow } : {}) }
      })
      uplink = input[Symbol.asyncIterator]()
      commands = this.consumeInput(record, follower, uplink, combined).catch(error => { if (!combined.aborted) this.failFollower(record, follower, error) })
      yield baseline
      yield* follower.frames.read(combined)
    } finally {
      lifetime.abort(); follower.active = false; follower.frames.close(); record.followers.delete(follower)
      if (record.controller === follower) { record.controller = undefined; this.broadcastState(record) }
      await uplink?.return?.(); await commands
      this.releaseIfUnused(record)
    }
  }

  rename(sessionId: string, expectedSource: WorkbenchSource, id: WebTerminalId, title: string): void {
    const record = this.get(sessionId, expectedSource, id)
    if (!title.trim() || title.trim().length > 120) throw new Error('Terminal title must contain 1–120 characters')
    if (!record.info) throw unavailable('The original terminal has not completed preparation.')
    record.info = { ...record.info, title: title.trim() }; this.broadcastState(record)
  }

  /** This compatibility kind has no process-termination API. */
  close(sessionId: string, expectedSource: WorkbenchSource, id: WebTerminalId): never {
    this.get(sessionId, expectedSource, id)
    throw unavailable('Original SessionTerminal views detach when closed. This compatibility provider does not terminate the source process.')
  }

  async dispose(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort()
    for (const record of this.records.values()) {
      this.cancelHandoff(record); this.disconnect(record)
      record.opening?.reject(unavailable('The legacy terminal adapter stopped.'))
      for (const follower of record.followers) follower.frames.close()
    }
    await Promise.allSettled([...this.records.values()].map(record => record.queue))
    for (const record of this.records.values()) record.screen.dispose()
    this.records.clear()
  }

  private limits(): LegacyTerminalLimits {
    const value = this.options.getLimits()
    for (const name of ['maxInputBytes', 'maxBufferedBytes', 'maxCols', 'maxRows', 'maxTerminals', 'scrollback'] as const) {
      if (!Number.isSafeInteger(value[name]) || value[name] < (name === 'scrollback' ? 0 : name === 'maxCols' ? 2 : 1)) throw new Error('Invalid legacy terminal limits')
    }
    return { ...value, maxInputBytes: Math.min(65_536, value.maxInputBytes), maxBufferedBytes: Math.min(16 * 1024 * 1024, value.maxBufferedBytes),
      maxCols: Math.min(1000, value.maxCols), maxRows: Math.min(1000, value.maxRows), scrollback: this.scrollback }
  }
  private authorize(record: Retained, sessionId: string, source: Source): void {
    if (!record.bindings.has(sessionId) || !sameSource(record.source, source)) throw failed('The terminal display is bound to a different source session.', 'rejected', 'source_mismatch')
  }
  private get(sessionId: string, expectedSource: WorkbenchSource, id: WebTerminalId): Retained {
    this.lifetime.signal.throwIfAborted()
    if (!isLegacyTerminalId(id)) throw unavailable('This is not an original SessionTerminal identity.')
    const record = this.records.get(id)
    if (!record) throw unavailable('This original SessionTerminal is not prepared. Reopen its saved source resource.')
    this.authorize(record, sessionId, canonicalSource(expectedSource)); record.lastUsed = ++this.accessSequence; return record
  }
  private state(record: Retained, sessionId: string): LegacyTerminalState {
    return structuredClone({ id: record.id, sessionId, terminalId: record.terminalId, source: record.source, phase: record.phase, environment: record.environment,
      info: record.info ? this.info(record) : null,
      facts: { title: 'adapter-display-alias' as const, shell: { kind: 'unreported' as const }, initialCwd: { kind: 'unreported' as const }, dimensions: record.dimensions,
        lastSourceReadyAt: record.lastSourceReadyAt, exitSignal: record.exitSignal },
      replay: { cursor: record.cursor, issue: record.issue, sequence: record.sequence }, compatibility,
      delivery: { adapterAccepted: record.accepted, lastAcceptedAt: record.lastAcceptedAt, uncertain: record.uncertain }, error: record.error })
  }
  private info(record: Retained): WebTerminalInfo {
    if (!record.info) throw unavailable('The original terminal metadata is not ready.')
    const warning = record.error ?? (record.issue === 'truncated' ? 'The original source retained only a bounded output tail; this adapter screen may omit earlier output.' : undefined)
    return { ...record.info, shell: { ...unknownShell, args: [] }, ...(warning ? { error: warning } : {}) }
  }
  private writable(record: Retained, follower: Follower): boolean {
    return follower.active && !follower.frames.failed && record.controller === follower && follower.generation === record.generation && record.phase === 'ready' && record.sourceReady
      && record.replayReady && Boolean(record.cursor) && (!record.issue || record.issue === 'truncated') && record.socket?.connected === true && !this.lifetime.signal.aborted
  }
  private broadcastState(record: Retained, except?: Follower): void {
    if (!record.info) return
    for (const follower of record.followers) if (follower !== except && follower.active) this.push(record, follower, { type: 'state', info: this.info(record), writable: this.writable(record, follower) })
  }
  private failFollower(record: Retained, follower: Follower, error: unknown): void {
    follower.active = false; follower.frames.fail(error)
    if (record.controller === follower) record.controller = undefined
  }
  private push(record: Retained, follower: Follower, frame: TerminalFrame): void {
    if (!follower.frames.push(frame)) {
      follower.active = false
      if (record.controller === follower) record.controller = undefined
    }
  }
  private enqueue<T>(record: Retained, run: () => T | Promise<T>, bytes = 0): Promise<T> {
    if (record.queuedBytes + bytes > this.limits().maxBufferedBytes) return Promise.reject(unavailable('Original terminal output exceeded the adapter buffer; reconnect using the accepted source cursor.'))
    record.queuedBytes += bytes
    record.queuedTasks++
    const result = record.queue.then(run)
    record.queue = result.then(() => undefined, () => undefined).finally(() => { record.queuedBytes -= bytes; record.queuedTasks-- })
    return result
  }
  private cancelHandoff(record: Retained): void { if (record.handoff) { clearTimeout(record.handoff); record.handoff = undefined } }
  private releaseIfUnused(record: Retained, handoff = false): void {
    if (record.preparing || record.holds.size || record.followers.size || this.lifetime.signal.aborted) return
    this.cancelHandoff(record)
    if (handoff) {
      record.handoff = setTimeout(() => { record.handoff = undefined; this.releaseIfUnused(record) }, this.handoffMs)
      record.handoff.unref(); return
    }
    this.disconnect(record)
    record.lastUsed = ++this.accessSequence
    if (record.phase !== 'exited' && record.phase !== 'failed') record.phase = 'disconnected'
    record.opening?.reject(unavailable('No view retained the original terminal connection.'))
  }
  private disconnect(record: Retained): void {
    const socket = record.socket; record.socket = undefined; record.sourceReady = false; record.replayReady = false
    socket?.disconnect()
  }

  private evictUnused(source: Source, maxTerminals: number): void {
    const unused = [...this.records.values()].filter(record => !record.preparing && !record.holds.size && !record.followers.size
      && !record.handoff && !record.opening && !record.socket && !record.queuedTasks).sort((left, right) => left.lastUsed - right.lastUsed)
    let sourceCount = [...this.records.values()].filter(record => sameSource(record.source, source)).length
    for (const record of unused) {
      const belongs = sameSource(record.source, source)
      if (!(belongs && sourceCount >= maxTerminals) && this.records.size < 512) continue
      this.records.delete(record.id); record.screen.dispose()
      if (belongs) sourceCount--
    }
  }

  private ensureConnected(record: Retained): Promise<void> {
    if (record.phase === 'ready' && record.socket?.connected && record.cursor) return record.queue
    if (record.opening) return record.opening.promise
    if (record.issue && record.issue !== 'truncated') return Promise.reject(unavailable('The original source replay has a gap. Explicitly reload its bounded replay before entering more input.'))
    if (record.phase === 'exited') return Promise.resolve()
    this.lifetime.signal.throwIfAborted()
    let resolve!: () => void, reject!: (error: unknown) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    const generation = record.generation + 1
    const opening: Opening = { generation, promise, resolve: () => { settle(); resolve() }, reject: error => { settle(); reject(error) } }
    const settle = (): void => { if (opening.timer) clearTimeout(opening.timer); if (record.opening === opening) record.opening = undefined }
    record.opening = opening; record.phase = 'opening'; record.error = null
    // Stop new old-socket events first, then let already admitted FIFO writes
    // update their real xterm screen/cursor before starting a new generation.
    this.disconnect(record)
    const pending = record.queue
    opening.timer = setTimeout(() => {
      if (record.opening !== opening) return
      const error = failed('The original terminal did not confirm ready and compatible replay before the deadline.', 'indeterminate', 'legacy_terminal_open_unknown')
      this.fail(record, record.generation, error); opening.reject(error)
    }, this.openTimeoutMs)
    opening.timer.unref()
    void (async () => {
      await pending
      if (this.lifetime.signal.aborted || record.opening !== opening) return
      record.generation = generation; record.phase = 'opening'; record.error = null
      const session = await this.options.workbench.resolveSource(record.source)
      if (this.lifetime.signal.aborted || record.opening !== opening) return
      const limits = this.limits()
      record.environment = { cwd: session.metadata!.path, maxInputBytes: limits.maxInputBytes, maxBufferedBytes: limits.maxBufferedBytes,
        maxCols: limits.maxCols, maxRows: limits.maxRows, scrollback: limits.scrollback }
      const authentication = await this.options.authenticate()
      if (this.lifetime.signal.aborted || record.opening !== opening) return
      this.disconnect(record)
      const socket = (this.options.createSocket ?? createNativeTerminalSocket)(authentication)
      record.socket = socket; record.sourceReady = false; record.replayReady = false
      const current = (): boolean => record.generation === generation && record.socket === socket && !this.lifetime.signal.aborted
      const owns = (value: { terminalId: string; sessionId?: string | undefined }): boolean => value.terminalId === record.terminalId && (value.sessionId === undefined || value.sessionId === record.source.sourceSessionId)
      const explicitlyOther = (value: unknown): boolean => {
        if (!value || typeof value !== 'object') return false
        const terminalId = Reflect.get(value, 'terminalId'), sessionId = Reflect.get(value, 'sessionId')
        return typeof terminalId === 'string' && terminalId !== record.terminalId || typeof sessionId === 'string' && sessionId !== record.source.sourceSessionId
      }
      const queued = (run: () => void | Promise<void>, bytes = 0): void => {
        if (!current()) return
        void this.enqueue(record, async () => { if (record.generation === generation) await run() }, bytes).catch(error => this.fail(record, generation, error))
      }
      const malformed = (value: unknown): void => {
        if (!current() || explicitlyOther(value)) return
        record.issue = 'invalid-stream'; record.sourceReady = false; record.replayReady = false
        queued(() => { throw unavailable('The original source returned a malformed terminal frame. Input remains disabled until an explicit replay reload.') })
      }
      socket.on('connect', () => {
        if (!current()) return
        record.phase = 'replaying'
        // This is the pinned original attach-or-create operation. The same ID
        // is reused, and the source decides whether its PTY still exists.
        socket.emit('terminal:create', { sessionId: record.source.sourceSessionId, terminalId: record.terminalId,
          cols: record.screen.cols, rows: record.screen.rows, replayProtocol: 1, ...(record.cursor ? { outputCursor: { ...record.cursor } } : {}) })
      })
      socket.on('terminal:output', value => {
        const parsed = outputSchema.safeParse(value)
        if (!parsed.success) { malformed(value); return }
        if (!owns(parsed.data)) return
        queued(() => this.output(record, parsed.data), Buffer.byteLength(parsed.data.data, 'utf8'))
      })
      socket.on('terminal:ready', value => {
        const parsed = readySchema.safeParse(value)
        if (!parsed.success) { malformed(value); return }
        if (!owns(parsed.data)) return
        queued(() => {
          if (parsed.data.replayProtocol !== 1) { record.issue = 'legacy-stream'; throw unavailable('The source does not advertise the required version 1 terminal replay. Input remains disabled.') }
          record.sourceReady = true; record.lastSourceReadyAt = this.now()
          record.dimensions = { cols: record.screen.cols, rows: record.screen.rows, basis: 'source-open-ready' }
          record.info = { id: record.id, title: record.info?.title ?? 'HAPI SessionTerminal', shell: { ...unknownShell, args: [] }, cwd: '', cols: record.screen.cols, rows: record.screen.rows, state: 'running', exitCode: null }
          this.ready(record)
        })
      })
      socket.on('terminal:exit', value => {
        const parsed = exitSchema.safeParse(value)
        if (!parsed.success) { malformed(value); return }
        if (!owns(parsed.data)) return
        queued(() => {
          record.phase = 'exited'; record.exitSignal = parsed.data.signal; record.error = null
          if (record.info) record.info = { ...record.info, state: 'exited', exitCode: parsed.data.code }
          this.disconnect(record); this.broadcastState(record)
          if (record.opening?.generation === generation) record.opening.reject(unavailable('The original terminal exited before preparation completed.'))
        })
      })
      socket.on('terminal:error', value => {
        const parsed = errorSchema.safeParse(value)
        if (!parsed.success) { malformed(value); return }
        if (owns(parsed.data)) queued(() => { throw failed(parsed.data.message, 'indeterminate', 'legacy_terminal_source_error') })
      })
      socket.on('connect_error', () => { if (current()) this.fail(record, generation, failed('The original terminal transport could not connect.', 'indeterminate', 'legacy_terminal_disconnected'), true) })
      socket.on('disconnect', () => {
        if (!current()) return
        record.sourceReady = false; record.replayReady = false
        queued(() => this.fail(record, generation, failed('The original terminal disconnected. Recent input may have reached it; input is never automatically replayed.', 'indeterminate', 'legacy_terminal_disconnected'), true))
      })
      socket.connect()
    })().catch(error => this.fail(record, generation, error))
    return promise
  }

  private async output(record: Retained, output: z.infer<typeof outputSchema>): Promise<void> {
    const stream = output.stream
    if (!stream) { record.issue = 'legacy-stream'; throw unavailable('The original source output lacks version 1 replay coordinates.') }
    if (stream.gap) { record.issue = stream.gap; throw unavailable(`The original source replay has a ${stream.gap} gap. Reload its bounded replay explicitly.`) }
    if (stream.endOffset - stream.startOffset !== output.data.length) { record.issue = 'invalid-stream'; throw unavailable('The original source output offsets do not match its UTF-16 data.') }
    const cursor = record.cursor
    if (!cursor && !stream.replay) { record.issue = 'invalid-stream'; throw unavailable('The original source output arrived without its replay baseline.') }
    if (cursor && cursor.epoch !== stream.epoch) { record.issue = 'epoch-changed'; throw unavailable('The original source terminal output epoch changed. Input remains disabled until an explicit replay reload.') }
    if (cursor && stream.startOffset > cursor.offset) { record.issue = 'history-truncated'; throw unavailable('The original source output has a gap after the accepted cursor.') }
    if (cursor && stream.endOffset <= cursor.offset) { if (stream.replay) record.replayReady = true; this.ready(record); return }
    const unseen = cursor ? output.data.slice(Math.max(0, cursor.offset - stream.startOffset)) : output.data
    await record.screen.write(unseen)
    // Advance only after xterm accepted the exact FIFO write. Offsets count
    // UTF-16 code units, not encoded UTF-8 bytes or display frames.
    record.cursor = { epoch: stream.epoch, offset: stream.endOffset }
    if (!cursor && stream.truncated) record.issue = 'truncated'
    if (stream.replay) record.replayReady = true
    if (unseen) {
      record.sequence++
      for (const follower of record.followers) if (follower.active && follower.generation === record.generation) this.push(record, follower, { type: 'output', sequence: record.sequence, data: unseen })
    }
    this.ready(record)
  }
  private ready(record: Retained): void {
    if (!record.sourceReady || !record.replayReady || !record.cursor || !record.socket?.connected || !record.info) return
    if (record.phase === 'ready') return
    record.phase = 'ready'; record.error = null; record.opening?.resolve(); this.broadcastState(record)
  }
  private fail(record: Retained, generation: number, error: unknown, disconnected = false): void {
    if (record.generation !== generation || this.lifetime.signal.aborted) return
    record.phase = disconnected ? 'disconnected' : 'failed'
    record.error = error instanceof Error ? error.message.slice(0, 8192) : 'The original terminal operation could not be completed.'
    if (record.accepted) record.uncertain = true
    this.disconnect(record); record.controller = undefined
    if (record.opening?.generation === generation) record.opening.reject(error)
    this.broadcastState(record)
    for (const follower of record.followers) if (follower.active && follower.generation === generation) this.failFollower(record, follower, error)
  }
  private async consumeInput(record: Retained, follower: Follower, input: AsyncIterator<TerminalInput>, signal: AbortSignal): Promise<void> {
    let sequence = 0
    while (!signal.aborted && follower.active) {
      const next = await input.next()
      if (next.done || signal.aborted || !follower.active) return
      const command = next.value
      if (!Number.isSafeInteger(command.sequence) || command.sequence !== ++sequence) throw new Error('Legacy terminal input sequence has a gap')
      await this.enqueue(record, () => {
        signal.throwIfAborted()
        if (record.phase === 'exited') { this.push(record, follower, { type: 'ack', sequence, refusal: 'not-running' }); return }
        if (!this.writable(record, follower)) { this.push(record, follower, { type: 'ack', sequence, refusal: 'read-only' }); return }
        const socket = record.socket!
        if (!socket.writable()) throw failed('Input was not accepted because the original terminal transport is backlogged or disconnected. It will not be replayed.', 'rejected', 'legacy_terminal_input_not_sent')
        const limits = this.limits()
        if (command.type === 'write') {
          if (!command.data || Buffer.byteLength(command.data, 'utf8') > limits.maxInputBytes || command.data.length > 65_536) throw new Error('Terminal input exceeds the configured legacy limit')
          try { socket.emitInput('terminal:write', { terminalId: record.terminalId, data: command.data }) }
          catch { record.uncertain = true; throw failed('Terminal input delivery is uncertain. It has not been replayed.', 'indeterminate', 'legacy_terminal_input_unknown') }
        } else {
          if (!Number.isSafeInteger(command.cols) || !Number.isSafeInteger(command.rows) || command.cols < 2 || command.cols > limits.maxCols || command.rows < 1 || command.rows > limits.maxRows) throw new Error('Terminal dimensions exceed the configured legacy limit')
          try { socket.emitInput('terminal:resize', { terminalId: record.terminalId, cols: command.cols, rows: command.rows }) }
          catch { record.uncertain = true; throw failed('Terminal resize delivery is uncertain. It has not been replayed.', 'indeterminate', 'legacy_terminal_input_unknown') }
          record.screen.resize(command.cols, command.rows)
          record.dimensions = { cols: command.cols, rows: command.rows, basis: 'adapter-resize-admission' }
          if (record.info) record.info = { ...record.info, cols: command.cols, rows: command.rows }
          this.broadcastState(record)
        }
        record.accepted++; record.lastAcceptedAt = this.now()
        // This acknowledges THIS provider's volatile transport admission only.
        // The original protocol has no Runner ACK and authorizes no replay.
        this.push(record, follower, { type: 'ack', sequence })
      })
    }
  }
}
