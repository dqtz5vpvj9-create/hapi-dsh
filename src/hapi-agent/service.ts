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
import { HistoryReadInvalidatedError, SourceHistoryJournal, type HistoryCheckpoint } from '../codex/history-journal.js'
import { SourceHistoryLifetimes } from '../codex/history-lifecycle.js'
import { SourceHistorySync } from '../codex/history-sync.js'

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
  private readonly historyJournals = new Map<string, SourceHistoryJournal>()
  private readonly lifetimes = new SourceHistoryLifetimes()
  private readonly excluded = new Set<string>()
  private readonly attachRetries = new Map<string, SourceHistorySync>()
  private readonly pendingResets = new Map<string, SessionId>()
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
    this.capture({ type: 'session-removed', sessionId: sourceId })
    const agent = this.agents.get(sourceId)
    this.agents.delete(sourceId); this.errors.delete(sourceId)
    await agent?.dispose()
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
    if (this.disposed) throw new Error('The source service was disposed')
    if (this.lifetimes.removed(sourceId)) return undefined
    const existing = this.agents.get(sourceId)
    if (existing) return existing
    const pending = this.attaching.get(sourceId)
    if (pending) {
      await pending
      if (this.attaching.get(sourceId) === pending) this.attaching.delete(sourceId)
      return this.agents.get(sourceId) ?? (this.disposed || this.lifetimes.removed(sourceId) ? undefined : this.attach(sourceId))
    }
    const version = this.lifetimes.version(sourceId)
    const task = (async () => {
      const source = await this.transport.getSession(sourceId)
      if (this.disposed || !this.lifetimes.current(sourceId, version)) return undefined
      if (!(this.eligible(source))) { this.excluded.add(sourceId); this.historyJournals.delete(sourceId); return undefined }
      this.excluded.delete(sourceId)
      const agent = await this.create(source, undefined, undefined, version)
      if (this.disposed || !this.lifetimes.current(sourceId, version)) { await agent.dispose(); return undefined }
      this.agents.set(sourceId, agent); this.errors.delete(sourceId)
      this.attachRetries.get(sourceId)?.dispose(); this.attachRetries.delete(sourceId)
      agent.startHistorySync()
      await this.announceReset(sourceId, agent.id)
      return agent
    })()
    this.attaching.set(sourceId, task)
    try { return await task }
    catch (error) {
      if (this.disposed || !this.lifetimes.current(sourceId, version)) return undefined
      // A failed attempt may have announced before a late asynchronous hook
      // failed. Consume its namespace before any automatic read-only retry.
      this.advanceRevision(sourceId)
      this.retryAttach(sourceId)
      throw error
    } finally { if (this.attaching.get(sourceId) === task) this.attaching.delete(sourceId) }
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
      const journal = this.historyFor(sourceId)
      journal.capture({ type: 'messages-invalidated', sessionId: sourceId })
      const checkpoint = journal.checkpoint()
      await this.replaceDisplay(existing, await readNativeHistory(this.transport, sourceId), source, checkpoint)
    } else await existing.refresh(true)
    this.errors.delete(sourceId); return this.agents.get(sourceId)
  }
  private historyFor(sourceId: string): SourceHistoryJournal {
    let journal = this.historyJournals.get(sourceId)
    if (!journal) { journal = new SourceHistoryJournal(); this.historyJournals.set(sourceId, journal) }
    return journal
  }
  private create(source: HapiSession, rows?: readonly HapiMessage[], checkpoint?: HistoryCheckpoint, version = this.lifetimes.version(source.id)) {
    const logical = observedSessionId(this.transport.hubId, source.id)
    return HapiObservedAgent.create(this.ctx, this.transport, source, { ...this.options,
      displayRevision: this.revisions.get(logical) ?? 0,
      historyJournal: this.historyFor(source.id), ...(checkpoint ? { historyCheckpoint: checkpoint } : {}),
      assertSourceCurrent: () => { if (this.disposed) throw new HistoryReadInvalidatedError(); this.lifetimes.assertCurrent(source.id, version) },
      onHistoryChanged: (agent, snapshot, checkpoint) => this.replaceDisplay(agent, snapshot, undefined, checkpoint) }, rows)
  }
  private async replaceDisplay(previous: HapiObservedAgent, rows: HapiMessage[], source?: HapiSession, checkpoint = this.historyFor(previous.binding.hapiSessionId).checkpoint()): Promise<void> {
    const sourceId = previous.binding.hapiSessionId
    const pending = this.attaching.get(sourceId)
    if (pending) {
      const current = await pending
      if (source && current && source.metadataVersion > current.sourceSession.metadataVersion
        && !sameObservedIdentity(current.binding, observedBinding(this.transport.hubId, source))) {
        if (this.attaching.get(sourceId) === pending) this.attaching.delete(sourceId)
        await this.replaceDisplay(current, rows, source, checkpoint)
      }
      return
    }
    if (this.disposed || this.agents.get(sourceId) !== previous || this.lifetimes.removed(sourceId)) return
    const journal = this.historyFor(sourceId), version = this.lifetimes.version(sourceId)
    journal.assertCurrent(checkpoint)
    this.advanceRevision(sourceId, previous.displayRevision)
    const task = (async () => {
      let current: HapiObservedAgent | undefined
      try {
        // Delivery and approval journals have exactly one writable owner.
        // Retire the old Agent before constructing the replacement; the
        // service retry below survives disposal of its history sync worker.
        this.pendingResets.set(sourceId, this.pendingResets.get(sourceId) ?? previous.id)
        await previous.dispose(); this.agents.delete(sourceId)
        current = await this.create(source ?? await this.transport.getSession(sourceId), rows, checkpoint, version)
        journal.assertCurrent(checkpoint); this.lifetimes.assertCurrent(sourceId, version)
        if (this.disposed) { await current.dispose(); return undefined }
        this.agents.set(sourceId, current)
        current.startHistorySync()
        await this.announceReset(sourceId, current.id)
        return current
      } catch (error) {
        if (this.agents.get(sourceId) !== current) await current?.dispose()
        if (this.disposed || !this.lifetimes.current(sourceId, version)) return undefined
        this.advanceRevision(sourceId)
        this.retryAttach(sourceId)
        throw error
      }
    })()
    this.attaching.set(sourceId, task)
    try { await task }
    catch (error) { this.report(error, sourceId); throw error }
    finally { if (this.attaching.get(sourceId) === task) this.attaching.delete(sourceId) }
  }

  private async announceReset(sourceId: string, currentId: SessionId): Promise<void> {
    const previousId = this.pendingResets.get(sourceId)
    if (!previousId) return
    this.pendingResets.delete(sourceId)
    // A consumer notification failure must not undo a successfully entered
    // current Agent or recycle its already announced event namespace.
    try { await this.options.onDisplayReset?.(previousId, currentId) }
    catch (error) { this.report(error, sourceId) }
  }

  private advanceRevision(sourceId: string, minimum = -1): void {
    const logical = observedSessionId(this.transport.hubId, sourceId)
    this.revisions.set(logical, Math.max(this.revisions.get(logical) ?? 0, minimum) + 1)
    writeDurableJson(this.revisionFile, Object.fromEntries(this.revisions))
  }

  private retryAttach(sourceId: string): void {
    if (this.disposed || this.lifetimes.removed(sourceId)) return
    let sync = this.attachRetries.get(sourceId)
    if (!sync) {
      sync = new SourceHistorySync(async () => { await this.attach(sourceId) }, error => this.report(error, sourceId))
      this.attachRetries.set(sourceId, sync)
    }
    sync.request(true)
  }

  private enqueue(event: HapiEvent): void {
    if (this.disposed || event.type === 'toast') return
    if (event.type === 'connection-changed') {
      for (const journal of this.historyJournals.values()) journal.capture(event)
      for (const agent of this.agents.values()) this.queue(agent.binding.hapiSessionId, event)
      if (event.data?.status === 'connected') void this.refreshCatalog().catch(error => this.report(error))
    } else { this.capture(event); this.queue(event.sessionId, event) }
  }
  private capture(event: Exclude<HapiEvent, { type: 'toast' | 'connection-changed' }>): void {
    const id = event.sessionId
    if (event.type === 'session-added') this.lifetimes.revive(id)
    if (event.type === 'session-added' || event.type === 'session-updated') this.excluded.delete(id)
    if (!this.excluded.has(id)) this.historyFor(id).capture(event)
    if (event.type === 'session-removed') {
      if (this.agents.has(id) || this.attaching.has(id)) this.advanceRevision(id)
      this.lifetimes.remove(id); this.historyJournals.delete(id); this.excluded.delete(id)
      this.attachRetries.get(id)?.dispose(); this.attachRetries.delete(id); this.pendingResets.delete(id)
    }
  }

  private queue(sourceId: string, event: HapiEvent): void {
    const version = this.lifetimes.version(sourceId), checkpoint = this.historyJournals.get(sourceId)?.checkpoint()
    const removedAgent = event.type === 'session-removed' ? this.agents.get(sourceId) : undefined
    const previous = this.work.get(sourceId) ?? Promise.resolve()
    const task = previous.then(async () => {
      if (this.disposed) return
      if (event.type === 'session-removed') {
        // A remove/add burst can advance the lifecycle before queued work
        // runs. Retire exactly the removed incarnation, never a later one.
        if (removedAgent && this.agents.get(sourceId) === removedAgent) {
          this.agents.delete(sourceId); this.errors.delete(sourceId)
        }
        await removedAgent?.dispose(); return
      }
      if (!this.lifetimes.current(sourceId, version)) return
      const pending = this.attaching.get(sourceId)
      if (pending) { try { await pending } catch { /* A service-owned retry repairs failed preparation. */ } }
      let agent = this.agents.get(sourceId)
      if (!agent) agent = await this.attach(sourceId)
      if (!agent || !this.lifetimes.current(sourceId, version)) return
      // Versioned identity checks remain serialized. Ordinary metadata updates
      // no longer page all history before the next live message is delivered.
      if (event.type === 'session-updated' || event.type === 'session-added') {
        const source = await this.transport.getSession(sourceId)
        if (!sameObservedIdentity(agent.binding, observedBinding(this.transport.hubId, source))) { await this.reconcileNow(sourceId); return }
      }
      try { await agent.handleEvent(event, checkpoint) }
      catch (error) { if (error instanceof NativeHistoryChangedError || error instanceof HistoryReadInvalidatedError) { agent.reportError(error); agent.requestHistorySync() } else throw error }
    }).catch(error => { this.agents.get(sourceId)?.reportError(error); this.report(error, sourceId) })
    this.track(sourceId, task)
  }
  private track(id: string, task: Promise<void>): void {
    this.work.set(id, task); void task.then(() => { if (this.work.get(id) === task) this.work.delete(id) })
  }
  async settled(): Promise<void> {
    do {
      while (this.work.size) await Promise.all([...this.work.values()])
      await Promise.all(this.list().map(agent => agent.settled()))
    } while (this.work.size)
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe?.()
    for (const sync of this.attachRetries.values()) sync.dispose()
    this.attachRetries.clear()
    await Promise.allSettled([...this.attaching.values(), ...this.work.values(), ...(this.catalogRefresh ? [this.catalogRefresh] : [])])
    await Promise.allSettled(this.list().map(agent => agent.dispose())); this.agents.clear(); this.historyJournals.clear(); this.unregister?.()
  }
  private report(error: unknown, sourceId?: string): void {
    const failure = error instanceof Error ? error : new Error('The original HAPI source could not be synchronized')
    if (sourceId) this.errors.set(sourceId, failure.message)
    this.options.onError?.(failure, sourceId)
  }
}
