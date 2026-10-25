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
import { SourceEventQueue, replacesCumulativeSnapshot, sourceEventBytes, type QueuedSourceEvent } from '../codex/event-queue.js'
import { DISPLAY_LEASE_TTL_MS, DISPLAY_RELEASE_GRACE_MS, DisplayLeases } from '../codex/display-leases.js'

export interface HapiAgentServiceOptions extends Omit<HapiObservedOptions, 'displayRevision' | 'onHistoryChanged'> {
  /** Source discovery is independent of materializing display histories. */
  discovery?: 'eager' | 'on-demand'
  onDisplayReset?: (oldId: SessionId, newId: SessionId) => void | Promise<void>
  onError?: (error: Error, sourceSessionId?: string) => void
  /** A deployment may prefer an already federated official DSH Host for that same source. */
  includeSession?: (source: HapiSession) => boolean
  displayLeaseTtlMs?: number
  displayReleaseGraceMs?: number
}

export class HapiAgentService {
  private readonly agents = new Map<string, HapiObservedAgent>()
  private readonly attaching = new Map<string, Promise<HapiObservedAgent | undefined>>()
  private readonly work = new Map<string, SourceEventQueue<QueuedSourceEvent<HapiObservedAgent>>>()
  private readonly reconciling = new Map<string, Promise<HapiObservedAgent | undefined>>()
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
  private readonly leases = new DisplayLeases()
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly suspended = new Set<string>()
  private readonly leased = new Set<string>()
  private readonly leaseSweep: ReturnType<typeof setInterval>
  constructor(readonly ctx: Context, readonly transport: HapiObservedTransport, readonly options: HapiAgentServiceOptions) {
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
    this.revisionFile = join(options.stateDirectory, `${observedSessionId(transport.hubId, 'revisions')}.json`)
    try {
      const values = z.record(z.string(), z.number().int().nonnegative()).parse(JSON.parse(readFileSync(this.revisionFile, 'utf8')))
      for (const [key, value] of Object.entries(values)) this.revisions.set(key, value)
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
    this.leaseSweep = setInterval(() => { void this.expireDisplayLeases() }, 30_000)
    this.leaseSweep.unref?.()
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

  /** A browser reference lease; it neither attaches nor starts source execution. */
  async acquireDisplayLease(sourceId: string, leaseId: string, ttlMs?: number): Promise<void> {
    if (this.disposed) return
    await this.releasing.get(sourceId)
    this.clearReleaseTimer(sourceId)
    this.leases.acquire(sourceId, leaseId, ttlMs ?? this.options.displayLeaseTtlMs ?? DISPLAY_LEASE_TTL_MS)
    this.leased.add(sourceId)
    this.suspended.delete(sourceId)
  }
  async renewDisplayLease(sourceId: string, leaseId: string, ttlMs?: number): Promise<boolean> {
    if (this.disposed) return false
    await this.releasing.get(sourceId)
    return this.leases.renew(sourceId, leaseId, ttlMs ?? this.options.displayLeaseTtlMs ?? DISPLAY_LEASE_TTL_MS)
  }
  async releaseDisplayLease(sourceId: string, leaseId: string): Promise<boolean> {
    if (this.disposed) return true
    const empty = this.leases.release(sourceId, leaseId)
    if (!empty) return false
    this.scheduleDisplayRelease(sourceId)
    return !this.agents.has(sourceId)
  }
  /** Retire one lightweight display after the final live reference is gone. */
  async releaseDisplay(sourceId: string): Promise<boolean> {
    if (this.disposed || this.leases.has(sourceId)) return false
    if (!this.agents.has(sourceId) || this.attaching.has(sourceId)) return false
    this.suspended.add(sourceId)
    const queue = this.work.get(sourceId)
    const task = (async () => {
      const retire = async (): Promise<boolean> => {
        if (this.disposed || this.leases.has(sourceId) || this.attaching.has(sourceId)) {
          if (!this.leases.has(sourceId)) this.suspended.delete(sourceId)
          return false
        }
        const current = this.agents.get(sourceId)
        if (!current) { this.suspended.delete(sourceId); return false }
        this.agents.delete(sourceId); this.errors.delete(sourceId)
        await current.dispose()
        this.advanceRevision(sourceId)
        this.historyJournals.delete(sourceId)
        this.attachRetries.get(sourceId)?.dispose(); this.attachRetries.delete(sourceId)
        this.pendingResets.delete(sourceId)
        this.suspended.delete(sourceId)
        this.leased.delete(sourceId)
        return true
      }
      const retired = queue ? await queue.run(retire) : await retire()
      if (this.work.get(sourceId) === queue) this.work.delete(sourceId)
      return retired
    })()
    const tracked = task.then(() => undefined, () => undefined)
    this.releasing.set(sourceId, tracked)
    try { return await task }
    finally { if (this.releasing.get(sourceId) === tracked) this.releasing.delete(sourceId) }
  }
  async expireDisplayLeases(): Promise<string[]> {
    const expired = this.leases.expire()
    for (const sourceId of expired) this.scheduleDisplayRelease(sourceId)
    return expired
  }
  private scheduleDisplayRelease(sourceId: string): void {
    if (!this.leased.has(sourceId)) return
    if (this.disposed || this.leases.has(sourceId) || this.releaseTimers.has(sourceId)) return
    const grace = this.options.displayReleaseGraceMs ?? DISPLAY_RELEASE_GRACE_MS
    const timer = setTimeout(() => {
      this.releaseTimers.delete(sourceId)
      void this.releaseDisplay(sourceId).catch(error => this.report(error, sourceId))
    }, grace)
    timer.unref?.()
    this.releaseTimers.set(sourceId, timer)
  }
  private clearReleaseTimer(sourceId: string): void {
    const timer = this.releaseTimers.get(sourceId)
    if (!timer) return
    clearTimeout(timer); this.releaseTimers.delete(sourceId)
  }
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
  /** View admission needs current identity, not another complete archive scan. */
  async openSource(sourceId: string): Promise<HapiObservedAgent | undefined> {
    const releasing = this.releasing.get(sourceId)
    if (releasing) await releasing
    const existing = this.agents.get(sourceId)
    if (!existing) return this.attach(sourceId)
    const source = await this.transport.getSession(sourceId)
    if (!this.eligible(source) || !sameObservedIdentity(existing.binding, observedBinding(this.transport.hubId, source))) {
      return this.reconcileSource(sourceId)
    }
    await existing.refreshSettings()
    return this.agents.get(sourceId) === existing ? existing : this.openSource(sourceId)
  }
  private eligible(source: HapiSession): boolean { return source.metadata?.codexNativeSession !== true && (this.options.includeSession?.(source) ?? true) }
  async refreshCatalog(): Promise<void> {
    if (this.options.discovery === 'on-demand') return
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
    const releasing = this.releasing.get(sourceId)
    if (releasing) await releasing
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
      if (!this.leases.has(sourceId)) this.scheduleDisplayRelease(sourceId)
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
    const pending = this.reconciling.get(sourceId)
    if (pending) return pending
    const task: Promise<HapiObservedAgent | undefined> = this.queueForSource(sourceId).run(() => {
      if (this.reconciling.get(sourceId) === task) this.reconciling.delete(sourceId)
      return this.reconcileNow(sourceId)
    })
    this.reconciling.set(sourceId, task)
    const release = () => { if (this.reconciling.get(sourceId) === task) this.reconciling.delete(sourceId) }
    void task.then(release, release)
    return task
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
      const rows = journal.merge(await readNativeHistory(this.transport, sourceId), checkpoint)
      await this.replaceDisplay(existing, rows, source, checkpoint)
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
      onHistoryChanged: (agent, snapshot, checkpoint) => this.replaceDisplay(agent, snapshot, undefined, checkpoint),
      ...(rows ? { initialRowsMerged: true } : {}) }, rows)
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

  private enqueue(event: HapiEvent): void | Promise<void> {
    if (this.disposed || event.type === 'toast') return
    if (event.type === 'connection-changed') {
      for (const journal of this.historyJournals.values()) journal.capture(event)
      const pressure = [...this.agents.values()].filter(agent => !this.suspended.has(agent.binding.hapiSessionId))
        .map(agent => this.queue(agent.binding.hapiSessionId, event)).filter(Boolean)
      if (event.data?.status === 'connected') void this.refreshCatalog().catch(error => this.report(error))
      if (pressure.length) return Promise.all(pressure).then(() => {})
    } else { this.capture(event); return this.queue(event.sessionId, event) }
  }
  private capture(event: Exclude<HapiEvent, { type: 'toast' | 'connection-changed' }>): void {
    const id = event.sessionId
    if (event.type === 'session-removed') {
      this.leases.drop(id)
      this.leased.delete(id)
      this.clearReleaseTimer(id)
      this.suspended.delete(id)
    }
    if (this.suspended.has(id) && event.type !== 'session-removed') return
    if (event.type === 'session-added') this.lifetimes.revive(id)
    if (event.type === 'session-added' || event.type === 'session-updated') this.excluded.delete(id)
    if (!this.excluded.has(id) && (this.options.discovery !== 'on-demand' || this.historyJournals.has(id))) this.historyFor(id).capture(event)
    if (event.type === 'session-removed') {
      if (this.agents.has(id) || this.attaching.has(id)) this.advanceRevision(id)
      this.lifetimes.remove(id); this.historyJournals.delete(id); this.excluded.delete(id)
      this.attachRetries.get(id)?.dispose(); this.attachRetries.delete(id); this.pendingResets.delete(id)
    }
  }

  private queue(sourceId: string, event: HapiEvent): void | Promise<void> {
    if (this.suspended.has(sourceId)) return
    if (this.options.discovery === 'on-demand' && !this.agents.has(sourceId) && !this.attaching.has(sourceId)) return
    return this.queueForSource(sourceId).enqueue({ event, version: this.lifetimes.version(sourceId),
      checkpoint: this.historyJournals.get(sourceId)?.checkpoint(),
      removedAgent: event.type === 'session-removed' ? this.agents.get(sourceId) : undefined }, sourceEventBytes(event))
  }

  private queueForSource(sourceId: string): SourceEventQueue<QueuedSourceEvent<HapiObservedAgent>> {
    let queue = this.work.get(sourceId)
    if (queue) return queue
    queue = new SourceEventQueue(async ({ event, version, checkpoint, removedAgent }) => {
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
    }, replacesCumulativeSnapshot, error => {
      this.agents.get(sourceId)?.reportError(error); this.report(error, sourceId)
    }, () => { if (!this.disposed) this.agents.get(sourceId)?.requestHistorySync() }, undefined,
    () => { if (this.work.get(sourceId) === queue) this.work.delete(sourceId) })
    this.work.set(sourceId, queue)
    return queue
  }
  async settled(): Promise<void> {
    do {
      await Promise.all([...this.work.values()].map(queue => queue.settled()))
      await Promise.all(this.list().map(agent => agent.settled()))
    } while ([...this.work.values()].some(queue => queue.pending.items > 0))
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe?.()
    clearInterval(this.leaseSweep); this.leases.clear()
    for (const timer of this.releaseTimers.values()) clearTimeout(timer)
    this.releaseTimers.clear()
    for (const sync of this.attachRetries.values()) sync.dispose()
    this.attachRetries.clear()
    await Promise.allSettled([...this.attaching.values(), ...[...this.work.values()].map(queue => queue.dispose()), ...(this.catalogRefresh ? [this.catalogRefresh] : [])])
    await Promise.allSettled(this.list().map(agent => agent.dispose())); this.agents.clear(); this.work.clear(); this.reconciling.clear(); this.historyJournals.clear(); this.unregister?.()
  }
  private report(error: unknown, sourceId?: string): void {
    const failure = error instanceof Error ? error : new Error('The original HAPI source could not be synchronized')
    if (sourceId) this.errors.set(sourceId, failure.message)
    this.options.onError?.(failure, sourceId)
  }
}
