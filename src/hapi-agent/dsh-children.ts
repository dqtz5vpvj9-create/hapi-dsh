import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type AgentCancelCause, type AgentEventDispatch, type AgentOptions, type AgentStatus, type Inbox, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { HapiSession } from '../codex/contracts.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { canonicalJson, record } from '../codex/native.js'
import { NativeHistoryChangedError } from '../codex/projector.js'
import type { HapiObservedTransport } from './agent.js'
import { sourceChildSessionId, type SourceChildOwnerState } from './children.js'
import { SourceDshChildDelivery } from './dsh-child-delivery.js'
import { sourceDshChildBindingSchema, sourceDshChildMessageSchema,
  type SourceDshChildBinding, type SourceDshChildDescriptor, type SourceDshChildReceipt, type SourceDshChildState } from './dsh-child-types.js'
import { SourceDshChildUnavailable, readSourceDshChildHistory, sourceDshChildBinding, sourceDshChildCatalog,
  sourceDshChildItems, validateSourceDshChild, type SourceDshChildHistory } from './dsh-child-protocol.js'
import type { HapiObservedProjection, ObservedSidechainSummary } from './projection-types.js'
import { hapiObservedProjectionDefinition } from './projection-state.js'
import { ObservedProjector } from './projector.js'
import { establishSourceChild } from './subagent-metadata.js'

export interface SourceDshChildrenOwner {
  agent: Agent
  logicalSessionId: SessionId
  displayRevision: number
  source(): HapiSession
  state(): SourceChildOwnerState
  isCurrent(): boolean
  changed(): void
  historyChanged(): Promise<void>
}
const historySchema = z.object({ epoch: z.string(), after: z.number().int().nonnegative(),
  rows: z.array(sourceDshChildMessageSchema), truncated: z.boolean() })
const cacheSchema = z.object({ version: z.literal(1), binding: sourceDshChildBindingSchema, history: historySchema, readAt: z.number() })
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const describe = (error: unknown) => error instanceof Error ? error.message : 'The original DSH child is unavailable'
const noQueueMutation = (): never => { throw new SourceDshChildUnavailable('The source DSH child owns its queue and exposes no queue editing or context injection API') }
/** Separate plugin entry bundles must recognize the same exact registered capability. */
const sourceChildCapability = Symbol.for('hapi-dsh/source-dsh-child')
export function isHapiDshChildAgent(agent: Agent | undefined): agent is HapiDshChildAgent {
  return agent !== undefined && sourceChildCapability in agent && agent[sourceChildCapability] === true
}

class ChildInbox implements Inbox {
  readonly nextTurn: readonly UserMessage[] = Object.freeze([])
  readonly nextStep: readonly UserMessage[] = Object.freeze([])
  constructor(private readonly owner: HapiDshChildAgent) {}
  append(target: InboxTarget, message: UserMessage): void { this.owner.send(message, target, true) }
  prepend(_target: InboxTarget, _message: UserMessage): void { noQueueMutation() }
  clear(): void { noQueueMutation() }
  replace(_id: MessageId, _message: UserMessage): boolean { return noQueueMutation() }
  remove(_id: MessageId): boolean { return noQueueMutation() }
  splice(_target: InboxTarget, _start: number, _count: number, _inserted: UserMessage[]): UserMessage[] { return noQueueMutation() }
}

/** A source child remains a child of its real parent, and never starts a local AgentLoop. */
export class HapiDshChildAgent implements Agent {
  readonly [sourceChildCapability] = true
  readonly id: SessionId
  readonly logicalSessionId: SessionId
  readonly parentSessionId: SessionId
  readonly binding: SourceDshChildBinding
  readonly ctx: Context
  readonly inbox: ChildInbox
  readonly dispatch: AgentEventDispatch
  readonly journal: SourceDshChildDelivery
  private readonly scope: Scope
  private current: Session
  private readonly projector: ObservedProjector
  private readonly cacheFile: string
  private history: SourceDshChildHistory | undefined
  private lastReadAt: number | null = null
  private historyError: string | null = null
  private sourceError: string | null = null
  private parentVersion: number
  private initializing = true
  private disposed = false
  private fingerprint = ''
  private title = ''
  private activity: AgentStatus = 'idle'
  private detachAgent: (() => void) | undefined
  private detachSession: (() => void) | undefined
  private pendingRefresh: Promise<void> | undefined
  private readonly idleWaiters = new Set<{ resolve(): void; reject(error: Error): void }>()

  private constructor(readonly owner: SourceDshChildrenOwner, readonly transport: HapiObservedTransport,
    directory: string, private descriptor: SourceDshChildDescriptor) {
    this.binding = sourceDshChildBinding(transport.hubId, owner.source(), descriptor)
    this.parentVersion = owner.source().metadataVersion
    const scopeId = `dsh-child:${descriptor.sessionId}`
    this.id = sourceChildSessionId(owner.agent.id, scopeId)
    this.logicalSessionId = sourceChildSessionId(owner.logicalSessionId, scopeId)
    this.parentSessionId = owner.agent.id
    this.scope = createScope(owner.agent.ctx, this, { parent: owner.agent }); this.ctx = this.scope.ctx
    this.ctx.sessionProjections.register(hapiObservedProjectionDefinition)
    this.current = this.ctx.sessions.prepare(this.id, { meta: this.meta() })
    this.dispatch = agentEvents(this.ctx, this); this.inbox = new ChildInbox(this)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.cacheFile = join(directory, `dsh-child-history-${hash(this.binding).slice(0, 32)}.json`)
    this.journal = new SourceDshChildDelivery(directory, this.binding, transport, () => this.validateForMutation(), () => {
      if (!this.initializing && !this.disposed) this.publish()
    })
    this.projector = new ObservedProjector(this.current, { scopeId, model: () => 'dsh',
      submittedMessage: () => undefined, content: () => undefined,
      stream: frame => this.dispatch.emit('agent/assistant-stream', { frame }) })
  }
  private meta() {
    return { cwd: this.owner.state().path, createdAt: this.descriptor.createdAt,
      parentSession: this.parentSessionId, origin: 'subagent' as const,
      delegationDepth: (this.owner.agent.session.header.delegationDepth ?? 0) + 1, agentPreset: 'hapi-source-dsh-child' }
  }
  static async create(owner: SourceDshChildrenOwner, transport: HapiObservedTransport, directory: string,
    descriptor: SourceDshChildDescriptor): Promise<HapiDshChildAgent> {
    const child = new HapiDshChildAgent(owner, transport, directory, descriptor)
    try {
      child.readCache()
      try {
        child.observeParent(await child.transport.getSession(child.binding.sourceSessionId))
        child.history = await readSourceDshChildHistory(transport, child.binding)
        child.observeParent(await child.transport.getSession(child.binding.sourceSessionId))
        child.lastReadAt = Date.now(); child.persistHistory(); child.historyError = null
      } catch (error) { child.historyError = describe(error) }
      child.projector.beginHistorySeed()
      if (child.history) child.projector.apply(sourceDshChildItems(child.history, child.binding.childDshSessionId))
      child.current = child.ctx.sessions.prepare(child.id, { seed: child.projector.historySeed(), meta: child.meta() })
      child.projector.finishHistorySeed(child.current)
      child.session.append('model/selection', { provider: 'hapi-observed', model: 'dsh' })
      establishSourceChild(owner.agent.session, child.session, child.scopeInfo.label, descriptor.mode === 'continuable')
      child.initializing = false; child.publish()
      child.detachSession = child.ctx.sessions.enter(child.session)
      child.detachAgent = child.ctx.agents.enter(child, owner.agent)
      child.blockLocalCommands()
      child.ctx.sessions.announce(child.session); await child.ctx.agents.announce(child, 'startup')
      return child
    } catch (error) { await child.dispose(); throw error }
  }
  get session(): Session { return this.current }
  get options(): AgentOptions { return { provider: 'hapi-observed', model: 'dsh' } }
  get status(): AgentStatus { return this.descriptor.activity === 'running' ? 'running' : 'idle' }
  get scopeInfo() {
    return { scopeId: `dsh-child:${this.binding.childDshSessionId}`, kind: 'dsh-child' as const,
      parentScopeId: null, parentToolCallId: null, sourceAgentId: this.binding.childDshSessionId,
      label: this.descriptor.name || this.descriptor.label || this.binding.childDshSessionId,
      status: this.descriptor.activity === 'running' ? 'running' as const : this.descriptor.lastTurnCompleted === true ? 'completed' as const : 'observed' as const,
      createdAt: this.descriptor.createdAt, updatedAt: this.owner.source().updatedAt }
  }
  get summary(): ObservedSidechainSummary {
    const { parentScopeId: _parentScopeId, ...scope } = this.scopeInfo
    return { ...scope, sessionId: this.id, logicalSessionId: this.logicalSessionId,
      parentSessionId: this.parentSessionId, rootSessionId: this.owner.agent.id }
  }
  private unavailableReason(): string | null {
    if (this.disposed || !this.owner.isCurrent()) return 'This DSH child display has been detached from its source owner'
    if (this.owner.state().connection !== 'connected') return 'The source Hub connection is unavailable'
    if (!this.owner.source().active) return 'The original DSH parent is not attached to an active Runner'
    if (this.sourceError) return this.sourceError
    if (this.historyError) return this.historyError
    if (this.journal.error) return this.journal.error
    if (this.descriptor.mode !== 'continuable') return 'Only continuable DSH children accept source prompts and interrupts'
    return null
  }
  get state(): SourceDshChildState {
    const unavailableReason = this.unavailableReason()
    return { sessionId: this.id, logicalSessionId: this.logicalSessionId, parentSessionId: this.parentSessionId,
      hubId: this.binding.hubId, sourceSessionId: this.binding.sourceSessionId, parentDshSessionId: this.binding.parentDshSessionId,
      childDshSessionId: this.binding.childDshSessionId, machineId: this.binding.machineId,
      descriptor: structuredClone(this.descriptor), readOnly: unavailableReason !== null, unavailableReason,
      history: { epoch: this.history?.epoch ?? null, after: this.history?.after ?? 0, loaded: this.history?.rows.length ?? 0,
        complete: Boolean(this.history) && this.historyError === null, truncated: this.history?.truncated ?? false,
        lastReadAt: this.lastReadAt, error: this.historyError }, receipts: this.journal.list() }
  }
  get projection(): NonNullable<HapiObservedProjection> {
    const state = this.state, { sessionId: _id, logicalSessionId: _logical, ...sidechain } = this.summary
    return { ...this.owner.state(), engine: 'hapi', ownership: 'hapi-runner', flavor: 'dsh',
      logicalSessionId: this.logicalSessionId, displayRevision: this.owner.displayRevision, nativeId: this.binding.childDshSessionId,
      thinking: this.descriptor.activity === 'running', controlledByUser: false, readOnly: state.readOnly,
      // The source catalog exposes a provider but does not expose this child's
      // selected model, settings, approval queue, file scope, or rich inputs.
      model: null, effort: null, permissionMode: null,
      capabilities: { steer: this.descriptor.mode === 'continuable', switchToRemote: false, images: false,
        forkCurrent: false, forkAtMessage: false, rewindToMessage: false, model: false, effort: false, permissions: false },
      pendingRequests: [], resolvedRequests: [], delivery: [], notices: [], usage: null,
      sidechain, dshChild: state, error: this.sourceError ?? this.historyError ?? this.journal.error }
  }
  update(descriptor: SourceDshChildDescriptor): void {
    if (descriptor.sessionId !== this.binding.childDshSessionId || descriptor.createdAt !== this.binding.childCreatedAt) throw new NativeHistoryChangedError('The source DSH child identity was replaced')
    if ((descriptor.mode === 'continuable') !== (this.descriptor.mode === 'continuable')) throw new NativeHistoryChangedError('The original child continuation capability changed; acquire the current display generation')
    this.descriptor = descriptor; this.publish()
  }
  publish(): void {
    if (this.disposed || this.initializing) return
    const title = this.scopeInfo.label
    if (this.title !== title) { this.session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } }); this.title = title }
    const projection = this.projection, fingerprint = canonicalJson(projection)
    if (fingerprint !== this.fingerprint) { appendPluginRecord(this.session, 'plugin:hapi-dsh-observed/state', projection); this.fingerprint = fingerprint }
    if (this.status !== this.activity) { this.activity = this.status; this.dispatch.emit('agent/status', { status: this.status }) }
    if (this.owner.state().connection !== 'connected' || this.sourceError || !this.owner.source().active) this.rejectWaiters('Source child activity is unavailable until the original owner reconnects')
    else if (this.status === 'idle') { for (const waiter of this.idleWaiters) waiter.resolve(); this.idleWaiters.clear() }
  }
  private observeParent(source: HapiSession): void {
    if (source.metadataVersion < Math.max(this.parentVersion, this.owner.source().metadataVersion)) throw new SourceDshChildUnavailable('The source returned stale parent metadata; the child operation was not retargeted')
    const descriptor = validateSourceDshChild(this.binding, source)
    if ((descriptor.mode === 'continuable') !== (this.descriptor.mode === 'continuable')) throw new NativeHistoryChangedError('The original child continuation capability changed; acquire the current display generation')
    this.descriptor = descriptor
    this.parentVersion = source.metadataVersion; this.sourceError = null
  }
  private async validateForMutation(): Promise<void> {
    try {
      if (this.disposed || !this.owner.isCurrent() || this.owner.state().connection !== 'connected') throw new SourceDshChildUnavailable('The original DSH child display is no longer available for submission')
      const source = await this.transport.getSession(this.binding.sourceSessionId)
      this.observeParent(source); validateSourceDshChild(this.binding, source, true)
      if (this.disposed || !this.owner.isCurrent()) throw new SourceDshChildUnavailable('The DSH child display changed before source submission')
    } catch (error) { this.sourceError = describe(error); this.publish(); throw error }
  }
  refresh(authoritative = false, notifyHistoryChange = true): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh
    const task = (async () => {
      if (this.disposed || !this.owner.isCurrent()) throw new SourceDshChildUnavailable('Acquire the current source DSH child display')
      if (this.owner.state().connection !== 'connected') { this.publish(); throw new SourceDshChildUnavailable('The source Hub connection is unavailable') }
      try {
        this.observeParent(await this.transport.getSession(this.binding.sourceSessionId))
        const history = await readSourceDshChildHistory(this.transport, this.binding, this.history, authoritative)
        this.observeParent(await this.transport.getSession(this.binding.sourceSessionId))
        if (this.disposed || !this.owner.isCurrent()) throw new SourceDshChildUnavailable('The DSH child observation changed while reading history')
        this.projector.apply(sourceDshChildItems(history, this.binding.childDshSessionId))
        this.history = history; this.lastReadAt = Date.now(); this.persistHistory(); this.historyError = null
      } catch (error) {
        this.historyError = describe(error)
        if (error instanceof NativeHistoryChangedError && notifyHistoryChange) await this.owner.historyChanged()
        throw error
      } finally { this.publish() }
    })()
    this.pendingRefresh = task
    void task.finally(() => { if (this.pendingRefresh === task) this.pendingRefresh = undefined }).catch(() => {})
    return task
  }
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (!wakeup) noQueueMutation()
    // An exact repeated official message identity is a receipt read, even after
    // disconnect. It never becomes another POST or another source requestId.
    const previous = this.journal.byMessageId(message.id)
    if (!previous) this.assertWritable()
    this.journal.prompt(message, target === 'next-step' ? 'steer' : 'queue')
  }
  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(_message: UserMessage): void { noQueueMutation() }
  async interrupt(operationId: string): Promise<SourceDshChildReceipt> {
    const previous = this.journal.read(operationId)
    if (!previous) this.assertWritable()
    const receipt = this.journal.interrupt(operationId)
    await this.journal.settled(); this.publish()
    return this.journal.read(receipt.operationId)!
  }
  cancel(cause: AgentCancelCause): void {
    if (cause.kind === 'disposed') return
    const operationId = `cancel:${hash([this.binding, this.history?.epoch, this.descriptor.openSince, this.descriptor.settledMs]).slice(0, 48)}`
    if (!this.journal.read(operationId)) this.assertWritable()
    this.journal.interrupt(operationId)
  }
  whenIdle(): Promise<void> {
    if (this.disposed || !this.owner.isCurrent() || this.owner.state().connection !== 'connected'
      || this.sourceError || this.historyError || !this.owner.source().active) return Promise.reject(new Error('The source has not confirmed child execution quiescence'))
    if (this.status === 'idle') return Promise.resolve()
    return new Promise((resolve, reject) => { this.idleWaiters.add({ resolve, reject }) })
  }
  runMaintenance<T>(_task: (signal: AbortSignal) => Promise<T>): Promise<T> { return noQueueMutation() }
  private assertWritable(): void { const reason = this.unavailableReason(); if (reason) throw new SourceDshChildUnavailable(reason) }
  private blockLocalCommands(): void {
    this.ctx.inject(['commands'], ctx => {
      const registered = new Set<string>(), block = () => {
        for (const command of ctx.commands.list(this)) {
          if (registered.has(command.name)) continue
          registered.add(command.name)
          ctx.commands.register({ definitionId: CommandDefinitionId(`hapi-dsh/source-child/${command.name}`),
            name: command.name, description: 'The original DSH child owns command execution',
            handler: () => { throw new SourceDshChildUnavailable('This source child API exposes plain text prompts; local DSH commands cannot execute in its place') } })
        }
      }
      ctx.on('commands/change', block); block()
    })
  }
  private readCache(): void {
    try {
      const saved = cacheSchema.parse(JSON.parse(readFileSync(this.cacheFile, 'utf8')))
      if (canonicalJson(saved.binding) !== canonicalJson(this.binding)) throw new Error('The cached child transcript belongs to a different source owner')
      this.history = saved.history; this.lastReadAt = saved.readAt
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }
  private persistHistory(): void {
    if (this.history && this.lastReadAt !== null) writeDurableJson(this.cacheFile, { version: 1, binding: this.binding, history: this.history, readAt: this.lastReadAt })
  }
  private rejectWaiters(message: string): void { for (const waiter of this.idleWaiters) waiter.reject(new Error(message)); this.idleWaiters.clear() }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.rejectWaiters('The source DSH child view was detached'); this.projector.abandonStream()
    this.detachAgent?.(); this.detachSession?.(); await this.journal.settled(); await this.scope.dispose()
  }
}

/** Register actual source catalog members without turning them into HAPI roots. */
export class SourceDshChildren {
  private readonly children = new Map<string, HapiDshChildAgent>()
  private mounted = false
  private disposed = false
  private pendingRefresh: Promise<void> | undefined
  constructor(private readonly owner: SourceDshChildrenOwner, private readonly transport: HapiObservedTransport, private readonly directory: string) {}
  list(): readonly HapiDshChildAgent[] { return [...this.children.values()] }
  get(sessionId: string): HapiDshChildAgent | undefined { return this.list().find(child => child.id === sessionId) }
  get summaries(): ObservedSidechainSummary[] { return this.list().map(child => child.summary) }
  async mount(): Promise<void> { if (this.mounted || this.disposed) return; this.mounted = true; await this.refresh(true) }
  refresh(authoritative = false): Promise<void> {
    if (this.disposed || !this.mounted || this.owner.source().metadata?.flavor !== 'dsh') return Promise.resolve()
    if (this.pendingRefresh) return this.pendingRefresh
    const task = (async () => {
      const descriptors = sourceDshChildCatalog(this.owner.source())
      const ids = new Map(descriptors.map(descriptor => [descriptor.sessionId, descriptor]))
      for (const child of this.children.values()) {
        const descriptor = ids.get(child.binding.childDshSessionId)
        if (!descriptor || descriptor.createdAt !== child.binding.childCreatedAt) throw new NativeHistoryChangedError('The original DSH child membership changed; acquire the current display generation')
      }
      for (const descriptor of descriptors) {
        if (this.disposed) return
        let child = this.children.get(descriptor.sessionId)
        if (!child) {
          child = await HapiDshChildAgent.create(this.owner, this.transport, this.directory, descriptor)
          if (this.disposed) { await child.dispose(); return }
          this.children.set(descriptor.sessionId, child)
        } else {
          child.update(descriptor)
          try { await child.refresh(authoritative, false) }
          catch (error) { if (error instanceof NativeHistoryChangedError) throw error }
        }
      }
      this.owner.changed()
    })()
    this.pendingRefresh = task
    void task.finally(() => { if (this.pendingRefresh === task) this.pendingRefresh = undefined }).catch(() => {})
    return task
  }
  publishOwner(): void { for (const child of this.children.values()) child.publish() }
  async settled(): Promise<void> { await Promise.allSettled(this.list().map(child => child.journal.settled())) }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const child of [...this.children.values()].reverse()) await child.dispose()
    this.children.clear()
  }
}
