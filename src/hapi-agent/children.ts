import { SourceFrameFeed } from '../shared/source-frame-feed.ts'
import { withSourceAgentServices } from '../shared/source-agent-services.ts'
import { sessionHeaderCwd } from '../hapi/session-header-cwd.ts'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type AgentCancelCause, type AgentEventDispatch, type AgentOptions, type AgentStatus, type Inbox, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord, SessionId, type Session } from '@deepseek-ai/dsh-session'
import { toSourceFrames } from '../shared/source-frame-builder.ts'
import type { SourceFrame, SourceFrameBatch } from '../shared/source-frames.ts'
import type { ObservedItem } from './parser.js'
import { ObservedProjector } from './projector.js'
import type { HapiObservedProjection, ObservedNotice, ObservedSidechainSummary, ObservedUsage } from './projection-types.js'
import type { ObservedScopeInfo } from './scopes.js'
import { hapiObservedProjectionDefinition } from './projection-state.js'
import { establishSourceChild } from './subagent-metadata.js'

export type SourceChildOwnerState = Pick<NonNullable<HapiObservedProjection>,
  'hubId' | 'hapiSessionId' | 'flavor' | 'machineId' | 'machineName' | 'path' | 'active' | 'connection' | 'model' | 'effort' | 'permissionMode' | 'error'>
export interface SourceChildOwner {
  agent: Agent
  logicalSessionId: SessionId
  displayRevision: number
  state(): SourceChildOwnerState
  content(item: ObservedItem): readonly ContentBlock[] | undefined
}

export function sourceChildSessionId(rootId: SessionId, scopeId: string, generation = 0): SessionId {
  return SessionId(`${rootId}-child-${createHash('sha256').update(generation ? `${scopeId}\0${generation}` : scopeId).digest('hex').slice(0, 24)}`)
}
const readOnly = (): never => { throw new Error('This source child transcript is read-only; its original parent owns execution and controls') }
const terminal = (info: ObservedScopeInfo) => info.status === 'completed' || info.status === 'error' || info.status === 'aborted'

class ChildInbox implements Inbox {
  readonly nextTurn: readonly UserMessage[] = Object.freeze([])
  readonly nextStep: readonly UserMessage[] = Object.freeze([])
  append(_target: InboxTarget, _message: UserMessage): void { readOnly() }
  prepend(_target: InboxTarget, _message: UserMessage): void { readOnly() }
  clear(): void { readOnly() }
  replace(_id: MessageId, _message: UserMessage): boolean { return readOnly() }
  remove(_id: MessageId): boolean { return readOnly() }
  splice(_target: InboxTarget, _start: number, _count: number, _inserted: UserMessage[]): UserMessage[] { return readOnly() }
}

/** A real public Agent prevents an observer Session from being resumed by another engine. */
export class HapiObservedChild implements Agent {
  readonly id: SessionId
  readonly logicalSessionId: SessionId
  readonly ctx: Context
  readonly inbox = new ChildInbox()
  readonly dispatch: AgentEventDispatch
  readonly parentSessionId: SessionId
  private readonly scope: Scope
  private readonly current: Session
  private projector: ObservedProjector
  private readonly sourceFeed = new SourceFrameFeed(() => ({ kind: 'replace', frames: this.currentSourceFrames(), hasMoreBefore: false }))
  private transientKeys = new Set<string>()
  private transientSources = new Set<string>()
  private readonly notices = new Map<string, ObservedNotice>()
  private usage: ObservedUsage | null = null
  private lastTitle = ''
  private fingerprint = ''
  private activity: AgentStatus = 'idle'
  private disposed = false
  private detachAgent: (() => void) | undefined
  private detachSession: (() => void) | undefined
  private readonly idleWaiters = new Set<{ resolve(): void; reject(error: Error): void }>()

  private constructor(readonly owner: SourceChildOwner, readonly parent: Agent, private info: ObservedScopeInfo, generation: number) {
    this.id = sourceChildSessionId(owner.agent.id, info.scopeId, generation)
    this.logicalSessionId = sourceChildSessionId(owner.logicalSessionId, info.scopeId)
    this.parentSessionId = parent.id
    this.scope = createScope(parent.ctx, this, { parent }); this.ctx = withSourceAgentServices(this.scope.ctx, parent.ctx)
    // The official registry reference-counts one definition across scopes.
    // Native-only deployments do not otherwise need an observed root service.
    this.ctx.sessionProjections.register(hapiObservedProjectionDefinition)
    this.current = this.ctx.sessions.prepare(this.id, { meta: this.meta() })
    this.dispatch = agentEvents(this.ctx, this)
    this.projector = this.createProjector()
  }
  private createProjector(): ObservedProjector {
    return ObservedProjector.history({ scopeId: this.info.scopeId,
      model: () => this.options.model ?? this.owner.state().flavor, submittedMessage: () => undefined,
      content: item => this.owner.content(item), stream: () => {} })
  }
  private meta() {
    return { cwd: sessionHeaderCwd(this.owner.state().path), createdAt: this.info.createdAt, parentSession: this.parentSessionId,
      origin: 'subagent' as const, delegationDepth: (this.parent.session.header.delegationDepth ?? 0) + 1,
      agentPreset: 'hapi-observed-child' }
  }
  static async create(owner: SourceChildOwner, parent: Agent, info: ObservedScopeInfo, items: readonly ObservedItem[], generation = 0): Promise<HapiObservedChild> {
    const child = new HapiObservedChild(owner, parent, info, generation)
    try {
      child.apply(items, true)
      child.session.append('model/selection', { provider: 'hapi-observed', model: child.options.model ?? owner.state().flavor })
      establishSourceChild(parent.session, child.session, child.info.label)
      child.publish()
      child.detachSession = child.ctx.sessions.enter(child.session)
      child.detachAgent = child.ctx.agents.enter(child, parent)
      child.blockCommands()
      child.ctx.sessions.announce(child.session)
      try { await child.ctx.agents.announce(child, 'startup') }
      catch (error) { console.warn('[hapi-dsh] child startup listener failed; continuing:', error instanceof Error ? error.message : String(error)) }
      return child
    } catch (error) { await child.dispose(); throw error }
  }
  get session(): Session { return this.current }
  currentSourceFrames(): SourceFrame[] {
    return [...toSourceFrames({ events: this.projector.historySeed(), eventSources: this.projector.eventSources()!,
      turnAnchors: this.projector.turnAnchorEntries(), stepAnchors: this.projector.stepAnchorEntries() }), ...this.projector.activeSourceFrames()]
  }
  sourceFrameBaseline(): SourceFrameBatch { return this.sourceFeed.baseline() }
  sourceHistoryVersion(): number { return this.sourceFeed.version }
  sourceFrames(signal: AbortSignal): AsyncIterable<SourceFrameBatch> { return this.sourceFeed.watch(signal) }
  get status(): AgentStatus { return this.info.status === 'running' ? 'running' : 'idle' }
  get options(): AgentOptions { return { provider: 'hapi-observed', model: this.owner.state().model ?? this.owner.state().flavor } }
  get scopeInfo(): Readonly<ObservedScopeInfo> { return this.info }
  get summary(): ObservedSidechainSummary {
    const { parentScopeId: _parentScopeId, ...source } = this.info
    return { ...source, sessionId: this.id, logicalSessionId: this.logicalSessionId,
      parentSessionId: this.parentSessionId, rootSessionId: this.owner.agent.id }
  }
  get projection(): NonNullable<HapiObservedProjection> {
    const { sessionId: _sessionId, logicalSessionId: _logicalSessionId, ...sidechain } = this.summary
    return { ...this.owner.state(), engine: 'hapi', ownership: 'hapi-runner', logicalSessionId: this.logicalSessionId,
      displayRevision: this.owner.displayRevision, nativeId: this.info.sourceAgentId, thinking: this.info.status === 'running',
      controlledByUser: false, readOnly: true,
      capabilities: { steer: false, switchToRemote: false, images: false, forkCurrent: false, forkAtMessage: false,
        rewindToMessage: false, model: false, effort: false, permissions: false },
      pendingRequests: [], resolvedRequests: [], delivery: [],
      notices: [...this.notices.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200), usage: this.usage, sidechain }
  }
  apply(items: readonly ObservedItem[], authoritative: boolean, reset = false): void {
    const scoped = items.filter(item => item.scopeId === this.info.scopeId)
    const projector = authoritative ? this.createProjector() : this.projector
    const start = authoritative ? 0 : projector.historySeed().length
    // A corrected source transcript replaces only its read model. The read-only
    // Agent and its public Session remain valid for existing pane references.
    projector.apply(scoped)
    if (authoritative) {
      this.projector.abandonStream(); this.projector = projector
      this.notices.clear(); this.usage = null
    }
    const frames = this.currentSourceFrames()
    const active = new Set(frames.flatMap(frame => frame.transient && frame.source ? [frame.source.messageId] : []))
    const activeKeys = new Set(frames.flatMap(frame => frame.transient ? [frame.key] : []))
    const removeKeys = [...this.transientKeys].filter(key => !frames.some(frame => frame.key === key))
    const replaceSources = new Set([...this.transientSources, ...active])
    const changed = authoritative ? frames : frames.filter((frame, index) => index >= start || !!frame.source && replaceSources.has(frame.source.messageId))
    if (authoritative || changed.length || removeKeys.length || replaceSources.size) {
      this.sourceFeed.publish( { kind: authoritative ? 'replace' : 'merge', frames: changed, ...(reset ? { reset: true } : {}),
        ...(!authoritative && replaceSources.size ? { replaceSources: [...replaceSources] } : {}), ...(removeKeys.length ? { removeKeys } : {}) })
    }
    this.transientKeys = activeKeys; this.transientSources = active
    for (const item of scoped) {
      if (item.kind === 'notice') this.notices.set(item.key, item.notice)
      else if (item.kind === 'usage' && (!this.usage || item.createdAt >= this.usage.createdAt)) this.usage = item.usage
    }
  }
  update(info: ObservedScopeInfo): void {
    this.info = info; this.publish()
  }
  publish(): void {
    if (this.disposed) return
    if (this.lastTitle !== this.info.label) {
      this.session.append('session/title', { title: this.info.label, messageSeqs: [], source: { kind: 'user' } }); this.lastTitle = this.info.label
    }
    const value = this.projection, key = JSON.stringify(value)
    if (key !== this.fingerprint) { appendPluginRecord(this.session, 'plugin:hapi-dsh-observed/state', value); this.fingerprint = key }
    if (this.activity !== this.status) { this.activity = this.status; this.dispatch.emit('agent/status', { status: this.status }) }
    if (this.owner.state().connection !== 'connected') this.rejectWaiters('Source child activity is unavailable until the original owner reconnects')
    else if (terminal(this.info)) { for (const waiter of this.idleWaiters) waiter.resolve(); this.idleWaiters.clear() }
  }
  send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean): void { readOnly() }
  followup(_message: UserMessage): void { readOnly() }
  steer(_message: UserMessage): void { readOnly() }
  inject(_message: UserMessage): void { readOnly() }
  cancel(cause: AgentCancelCause): void { if (cause.kind !== 'disposed') readOnly() }
  runMaintenance<T>(_task: (signal: AbortSignal) => Promise<T>): Promise<T> { return readOnly() }
  whenIdle(): Promise<void> {
    if (this.disposed || this.owner.state().connection !== 'connected' || this.info.status === 'observed') {
      return Promise.reject(new Error('The original source has not confirmed child execution quiescence'))
    }
    if (terminal(this.info)) return Promise.resolve()
    return new Promise((resolve, reject) => { this.idleWaiters.add({ resolve, reject }) })
  }
  private blockCommands(): void {
    this.ctx.inject(['commands'], ctx => {
      const registered = new Set<string>()
      const block = (): void => {
        for (const command of ctx.commands.list(this)) {
          if (registered.has(command.name)) continue
          registered.add(command.name)
          ctx.commands.register({ definitionId: CommandDefinitionId(`hapi-dsh/child/${command.name}`),
            name: command.name, description: 'This source child transcript is read-only', handler: readOnly })
        }
      }
      ctx.on('commands/change', block); block()
    })
  }
  private rejectWaiters(message: string): void { for (const waiter of this.idleWaiters) waiter.reject(new Error(message)); this.idleWaiters.clear() }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.sourceFeed.dispose(); this.rejectWaiters('The source child observation was detached'); this.projector.abandonStream()
    this.detachAgent?.(); this.detachSession?.(); await this.scope.dispose()
  }
}

/** Child Agents are display resources only; root source catalogs never own them. */
export class ObservedChildren {
  private readonly children = new Map<string, HapiObservedChild>()
  private readonly generations = new Map<string, number>()
  private infos: readonly ObservedScopeInfo[] = []
  private pending: readonly ObservedItem[] = []
  private mounted = false
  private disposed = false
  constructor(private readonly owner: SourceChildOwner) {}
  list(): readonly HapiObservedChild[] { return [...this.children.values()] }
  get summaries(): ObservedSidechainSummary[] {
    return this.infos.map(info => {
      const { parentScopeId, ...source } = info
      return { ...source, sessionId: sourceChildSessionId(this.owner.agent.id, info.scopeId, this.generations.get(info.scopeId)),
        logicalSessionId: sourceChildSessionId(this.owner.logicalSessionId, info.scopeId),
        parentSessionId: parentScopeId ? sourceChildSessionId(this.owner.agent.id, parentScopeId, this.generations.get(parentScopeId)) : this.owner.agent.id,
        rootSessionId: this.owner.agent.id }
    })
  }
  async apply(items: readonly ObservedItem[], infos: readonly ObservedScopeInfo[], authoritative: boolean, reset = false): Promise<void> {
    if (this.disposed) return
    const byId = new Map(infos.map(info => [info.scopeId, info]))
    const retired = new Set<string>()
    for (const child of this.children.values()) {
      const info = byId.get(child.scopeInfo.scopeId)
      if (!info || info.parentScopeId !== child.scopeInfo.parentScopeId) retired.add(child.scopeInfo.scopeId)
    }
    // Retire descendants before their old parent scope. A genuinely changed
    // lineage gets a new child view identity; it never replaces the root owner.
    for (const child of this.children.values()) {
      if (child.scopeInfo.parentScopeId && retired.has(child.scopeInfo.parentScopeId)) retired.add(child.scopeInfo.scopeId)
    }
    for (const child of [...this.children.values()].reverse()) {
      const id = child.scopeInfo.scopeId
      if (!retired.has(id)) continue
      await child.dispose(); this.children.delete(id)
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    }
    this.infos = infos
    if (!this.mounted) { this.pending = items; return }
    const attach = async (info: ObservedScopeInfo): Promise<HapiObservedChild> => {
      const found = this.children.get(info.scopeId)
      if (found) return found
      const parentInfo = info.parentScopeId ? byId.get(info.parentScopeId) : undefined
      const parent = parentInfo ? await attach(parentInfo) : this.owner.agent
      const child = await HapiObservedChild.create(this.owner, parent, info, items, this.generations.get(info.scopeId))
      this.children.set(info.scopeId, child); return child
    }
    for (const info of infos) {
      const existing = this.children.get(info.scopeId)
      const child = existing ?? await attach(info)
      if (existing) child.apply(items, authoritative, reset)
      child.update(info)
    }
  }
  async mount(): Promise<void> {
    if (this.mounted || this.disposed) return
    this.mounted = true
    await this.apply(this.pending, this.infos, true); this.pending = []
  }
  publishOwner(): void { for (const child of this.children.values()) child.publish() }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const child of [...this.children.values()].reverse()) await child.dispose()
    this.children.clear()
  }
}
