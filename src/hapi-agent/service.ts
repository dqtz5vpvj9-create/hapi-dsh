import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { HapiEvent, HapiMessage, HapiSession } from '../codex/contracts.js'
import { record } from '../codex/native.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { readNativeHistory } from '../codex/history.js'
import { NativeHistoryChangedError } from '../codex/projector.js'
import { HapiObservedAgent, type HapiObservedOptions, type HapiObservedTransport } from './agent.js'
import { observedBinding, observedSessionId, sameObservedIdentity } from './identity.js'
import { hapiObservedProjectionDefinition } from './projection-state.js'

export interface HapiAgentServiceOptions extends Omit<HapiObservedOptions, 'displayRevision' | 'onHistoryChanged'> {
  onDisplayReset?: (oldId: SessionId, newId: SessionId) => void | Promise<void>
  onError?: (error: Error, sourceSessionId?: string) => void
  /** A deployment may prefer an already federated official DSH Host for that same source. */
  includeSession?: (source: HapiSession) => boolean
}

export class HapiAgentService {
  private readonly agents = new Map<string, HapiObservedAgent>()
  private readonly attaching = new Map<string, Promise<HapiObservedAgent | undefined>>()
  private readonly work = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private readonly errors = new Map<string, string>()
  private readonly revisionFile: string
  private unsubscribe: (() => void) | undefined
  private unregister: (() => void) | undefined
  private started = false
  private disposed = false
  private catalogRefresh: Promise<void> | undefined
  constructor(readonly ctx: Context, readonly transport: HapiObservedTransport, readonly options: HapiAgentServiceOptions) {
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
    this.revisionFile = join(options.stateDirectory, `${observedSessionId(transport.hubId, 'revisions')}.json`)
    try {
      const values = z.record(z.string(), z.number().int().nonnegative()).parse(JSON.parse(readFileSync(this.revisionFile, 'utf8')))
      for (const [key, value] of Object.entries(values)) this.revisions.set(key, value)
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }
  async start(): Promise<void> {
    if (this.started) return
    if (this.disposed) throw new Error('The HAPI observation service was disposed')
    this.started = true
    this.unregister = this.ctx.sessionProjections.register(hapiObservedProjectionDefinition)
    this.unsubscribe = this.transport.subscribe(event => this.enqueue(event))
    await this.refreshCatalog()
  }
  list(): readonly HapiObservedAgent[] { return [...this.agents.values()] }
  get(id: string): HapiObservedAgent | undefined { return this.list().find(agent => agent.id === id || agent.logicalSessionId === id) }
  byHapiSession(id: string): HapiObservedAgent | undefined { return this.agents.get(id) }
  /** Exact current child display only; no root aliases or cross-parent fallback. */
  dshChild(sessionId: string) { return this.list().flatMap(agent => agent.dshChild(sessionId) ?? []).find(child => child.id === sessionId) }
  /** Detach an observation after the source confirms deletion; never stops its Runner. */
  async detachSource(sourceId: string): Promise<void> {
    const agent = this.agents.get(sourceId)
    if (!agent) return
    this.agents.delete(sourceId); this.errors.delete(sourceId); await agent.dispose()
  }
  failures(): ReadonlyMap<string, string> { return this.errors }
  private eligible(source: HapiSession): boolean { return source.metadata?.codexNativeSession !== true && (this.options.includeSession?.(source) ?? true) }
  async refreshCatalog(): Promise<void> {
    if (this.catalogRefresh) return this.catalogRefresh
    const task = (async () => {
      const sources = await this.transport.listSessions()
      for (let index = 0; index < sources.length; index += 4) {
        if (this.disposed) return
        await Promise.all(sources.slice(index, index + 4).map(async source => {
          try { await this.attach(source.id) } catch (error) { this.report(error, source.id) }
        }))
      }
    })()
    this.catalogRefresh = task
    try { await task } finally { if (this.catalogRefresh === task) this.catalogRefresh = undefined }
  }
  async attach(sourceId: string): Promise<HapiObservedAgent | undefined> {
    if (this.disposed) throw new Error('The HAPI observation service was disposed')
    const existing = this.agents.get(sourceId)
    if (existing) return existing
    const pending = this.attaching.get(sourceId)
    if (pending) return pending
    const task = (async () => {
      const source = await this.transport.getSession(sourceId)
      if (!this.eligible(source)) return undefined
      const agent = await this.create(source)
      if (this.disposed) { await agent.dispose(); return undefined }
      this.agents.set(sourceId, agent); this.errors.delete(sourceId); return agent
    })()
    this.attaching.set(sourceId, task)
    try { return await task } finally { if (this.attaching.get(sourceId) === task) this.attaching.delete(sourceId) }
  }
  reconcileSource(sourceId: string): Promise<HapiObservedAgent | undefined> {
    const previous = this.work.get(sourceId) ?? Promise.resolve()
    const task = previous.then(() => this.reconcileNow(sourceId))
    const tracked = task.then(() => {}, error => { this.agents.get(sourceId)?.reportError(error); this.report(error, sourceId) })
    this.track(sourceId, tracked); return task
  }
  private async reconcileNow(sourceId: string): Promise<HapiObservedAgent | undefined> {
    if (this.disposed) return undefined
    const existing = this.agents.get(sourceId)
    if (!existing) return this.attach(sourceId)
    const source = await this.transport.getSession(sourceId)
    if (source.metadataVersion < existing.sourceSession.metadataVersion) return existing
    if (!this.eligible(source)) { await existing.dispose(); this.agents.delete(sourceId); return undefined }
    if (!sameObservedIdentity(existing.binding, observedBinding(this.transport.hubId, source))) {
      if (source.metadataVersion === existing.sourceSession.metadataVersion) throw new Error('HAPI replaced the source engine identity without advancing metadata version')
      existing.reportError(new Error('The source engine identity changed; reading its replacement history'))
      await this.replaceDisplay(existing, await readNativeHistory(this.transport, sourceId), source)
    } else await existing.refresh(true)
    this.errors.delete(sourceId); return this.agents.get(sourceId)
  }
  private create(source: HapiSession, rows?: readonly HapiMessage[]) {
    const logical = observedSessionId(this.transport.hubId, source.id)
    return HapiObservedAgent.create(this.ctx, this.transport, source, { ...this.options,
      displayRevision: this.revisions.get(logical) ?? 0,
      onHistoryChanged: (agent, snapshot) => this.replaceDisplay(agent, snapshot) }, rows)
  }
  private async replaceDisplay(previous: HapiObservedAgent, rows: HapiMessage[], source?: HapiSession): Promise<void> {
    const sourceId = previous.binding.hapiSessionId
    if (this.disposed || this.agents.get(sourceId) !== previous) return
    this.revisions.set(previous.logicalSessionId, previous.displayRevision + 1)
    writeDurableJson(this.revisionFile, Object.fromEntries(this.revisions))
    await previous.dispose(); this.agents.delete(sourceId)
    if (this.disposed) return
    const current = await this.create(source ?? await this.transport.getSession(sourceId), rows)
    if (this.disposed) { await current.dispose(); return }
    this.agents.set(sourceId, current)
    await this.options.onDisplayReset?.(previous.id, current.id)
  }
  private enqueue(event: HapiEvent): void {
    if (this.disposed || event.type === 'toast') return
    if (event.type === 'connection-changed') {
      for (const agent of this.agents.values()) this.queue(agent.binding.hapiSessionId, event)
      if (event.data?.status === 'connected') void this.refreshCatalog().catch(error => this.report(error))
    } else this.queue(event.sessionId, event)
  }
  private queue(sourceId: string, event: HapiEvent): void {
    const previous = this.work.get(sourceId) ?? Promise.resolve()
    const task = previous.then(async () => {
      if (this.disposed) return
      let agent = this.agents.get(sourceId)
      if (!agent && event.type !== 'session-removed') agent = await this.attach(sourceId)
      if (!agent) return
      if (event.type === 'session-removed') { await agent.dispose(); this.agents.delete(sourceId); return }
      if (event.type === 'session-updated' || event.type === 'session-added') { await this.reconcileNow(sourceId); return }
      try { await agent.handleEvent(event) }
      catch (error) { if (error instanceof NativeHistoryChangedError) await agent.refresh(true); else throw error }
    }).catch(error => { this.agents.get(sourceId)?.reportError(error); this.report(error, sourceId) })
    this.track(sourceId, task)
  }
  private track(id: string, task: Promise<void>): void {
    this.work.set(id, task); void task.then(() => { if (this.work.get(id) === task) this.work.delete(id) })
  }
  async settled(): Promise<void> { while (this.work.size) await Promise.all([...this.work.values()]) }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe?.()
    await Promise.allSettled([...this.attaching.values(), ...this.work.values(), ...(this.catalogRefresh ? [this.catalogRefresh] : [])])
    await Promise.allSettled(this.list().map(agent => agent.dispose())); this.agents.clear(); this.unregister?.()
  }
  private report(error: unknown, sourceId?: string): void {
    const failure = error instanceof Error ? error : new Error('The original HAPI source could not be synchronized')
    if (sourceId) this.errors.set(sourceId, failure.message)
    this.options.onError?.(failure, sourceId)
  }
}
