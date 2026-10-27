import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableJson } from './durable-file.ts'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { HapiEvent, HapiMessage, HapiSession, HapiTransport } from './contracts.js'
import { NativeCodexAgent, type NativeCodexOptions } from './agent.js'
import { NativeHistoryChangedError } from './projector.js'
import { bindingFor, canonicalJson, nativeSessionId, record } from './native.js'
import { readNativeHistorySnapshot } from './history.js'
import { hapiProjectionDefinition } from './projection-state.js'
import { HistoryReadInvalidatedError, SourceHistoryJournal, type HistoryCheckpoint } from './history-journal.js'
import { SourceHistoryLifetimes } from './history-lifecycle.js'
import { SourceHistorySync } from './history-sync.js'
import { SourceEventQueue, replacesCumulativeSnapshot, sourceEventBytes, type QueuedSourceEvent } from './event-queue.js'
import { DISPLAY_LEASE_TTL_MS, DISPLAY_RELEASE_GRACE_MS, DisplayLeases } from './display-leases.js'

export interface CodexServiceOptions extends Omit<NativeCodexOptions, 'displayRevision' | 'onHistoryChanged'> {
  /** The unified source catalog already lists unopened sessions. Materialize
   * their official display history only when a view or operation asks for it. */
  discovery?: 'eager' | 'on-demand'
  onDisplayReset?: (oldDisplayId: SessionId, newDisplayId: SessionId) => void | Promise<void>
  onError?: (error: Error, sourceSessionId?: string) => void
  /** A retired display's virtual source window must release its agent/cache. */
  onDisplayRetired?: (displayId: string, sourceId: string) => void
  /** Browser reference leases; absent leases keep the old retain-until-removal behavior. */
  displayLeaseTtlMs?: number
  displayReleaseGraceMs?: number
}

/** One unmodified DSH host can catalogue native Codex sessions from a HAPI Hub. */
export class CodexService {
  private readonly agents = new Map<string, NativeCodexAgent>()
  private readonly attaching = new Map<string, Promise<NativeCodexAgent | undefined>>()
  private readonly eventWork = new Map<string, SourceEventQueue<QueuedSourceEvent<NativeCodexAgent>>>()
  private readonly reconciling = new Map<string, Promise<NativeCodexAgent | undefined>>()
  private readonly historyJournals = new Map<string, SourceHistoryJournal>()
  private readonly lifetimes = new SourceHistoryLifetimes()
  private readonly excluded = new Set<string>()
  private readonly attachRetries = new Map<string, SourceHistorySync>()
  private readonly pendingResets = new Map<string, SessionId>()
  private readonly revisions = new Map<string, number>()
  private readonly revisionFile: string
  private unsubscribe: (() => void) | undefined
  private unregisterProjection: (() => void) | undefined
  private catalogRefresh: Promise<void> | undefined
  private disposed = false
  private started = false
  private readonly errors = new Map<string, string>()
  private readonly leases = new DisplayLeases()
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly suspended = new Set<string>()
  private readonly leased = new Set<string>()
  private readonly leaseSweep: ReturnType<typeof setInterval>

  constructor(readonly ctx: Context, readonly transport: HapiTransport, readonly options: CodexServiceOptions) {
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
    const hubKey = nativeSessionId(transport.hubId, 'display-revisions')
    this.revisionFile = join(options.stateDirectory, `${hubKey}.revisions.json`)
    try {
      const revisions = z.record(z.string(), z.number().int().nonnegative()).parse(JSON.parse(readFileSync(this.revisionFile, 'utf8')))
      for (const [key, revision] of Object.entries(revisions)) this.revisions.set(key, revision)
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
    this.leaseSweep = setInterval(() => { void this.expireDisplayLeases() }, 30_000)
    this.leaseSweep.unref?.()
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.disposed) throw new Error('The Codex service was disposed')
    this.started = true
    this.unregisterProjection = this.ctx.sessionProjections.register(hapiProjectionDefinition)
    // Subscribe before discovery; source changes in the loading window are queued.
    this.unsubscribe = this.transport.subscribe(event => this.enqueue(event))
    await this.refreshCatalog()
  }

  list(): readonly NativeCodexAgent[] { return [...this.agents.values()] }
  get(sessionId: string): NativeCodexAgent | undefined {
    return this.list().find(agent => agent.id === sessionId || agent.logicalSessionId === sessionId)
  }
  byHapiSession(sessionId: string): NativeCodexAgent | undefined { return this.agents.get(sessionId) }

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
    const queue = this.eventWork.get(sourceId)
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
        this.options.onDisplayRetired?.(current.id, sourceId)
        // A future open is a new official Session generation, never a reused
        // event namespace or an old browser-draft owner.
        this.advanceRevision(sourceId)
        this.historyJournals.delete(sourceId)
        this.attachRetries.get(sourceId)?.dispose(); this.attachRetries.delete(sourceId)
        this.pendingResets.delete(sourceId)
        this.suspended.delete(sourceId)
        this.leased.delete(sourceId)
        return true
      }
      const retired = queue ? await queue.run(retire) : await retire()
      if (this.eventWork.get(sourceId) === queue) this.eventWork.delete(sourceId)
      return retired
    })()
    const tracked = task.then(() => undefined, () => undefined)
    this.releasing.set(sourceId, tracked)
    try { return await task }
    finally { if (this.releasing.get(sourceId) === tracked) this.releasing.delete(sourceId) }
  }
  /** Testable expiry path for a browser that vanished without releasing. */
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
  failures(): ReadonlyMap<string, string> { return this.errors }

  /** Opening an existing view verifies its owner without re-reading the archive.
   * The resolver may pass its identity-checked reply for this operation only;
   * a release boundary or identity change still requires the normal fresh read. */
  async openSource(sourceId: string, snapshot?: HapiSession): Promise<NativeCodexAgent | undefined> {
    if (snapshot && snapshot.id !== sourceId) throw new Error('The source snapshot belongs to another session')
    const releasing = this.releasing.get(sourceId)
    if (releasing) { await releasing; snapshot = undefined }
    const existing = this.agents.get(sourceId)
    if (!existing) return this.attach(sourceId, snapshot)
    const source = snapshot ?? await this.transport.getSession(sourceId)
    if (source.metadata?.flavor !== 'codex' || source.metadata.codexNativeSession !== true
      || !source.metadata.codexSessionId || canonicalJson(bindingFor(this.transport.hubId, source)) !== canonicalJson(existing.binding)) {
      return this.reconcileSource(sourceId)
    }
    await existing.refreshSettings(source)
    return this.agents.get(sourceId) === existing ? existing : this.openSource(sourceId)
  }

  /**
   * Reconcile an explicit source lifecycle operation. A versioned identity
   * change retires the old display/Agent before entering a new generation;
   * old references cannot silently send to the replacement thread or home.
   */
  reconcileSource(sourceId: string): Promise<NativeCodexAgent | undefined> {
    const pending = this.reconciling.get(sourceId)
    if (pending) return pending
    const work: Promise<NativeCodexAgent | undefined> = this.queueForSource(sourceId).run(async () => {
      if (this.reconciling.get(sourceId) === work) this.reconciling.delete(sourceId)
      if (this.disposed) throw new Error('The Codex service was disposed')
      const existing = this.agents.get(sourceId)
      if (!existing) return this.attach(sourceId)
      const source = await this.transport.getSession(sourceId)
      if (source.metadataVersion < existing.sourceSession.metadataVersion) return existing
      if (source.metadata?.flavor !== 'codex' || source.metadata.codexNativeSession !== true || !source.metadata.codexSessionId) {
        existing.reportError(new Error('The HAPI native identity is not source-ready after its lifecycle change'))
        return undefined
      }
      const nextBinding = bindingFor(this.transport.hubId, source)
      if (canonicalJson(nextBinding) !== canonicalJson(existing.binding)) {
        if (source.metadataVersion === existing.sourceSession.metadataVersion) {
          throw new Error('HAPI changed native identity without advancing its metadata version')
        }
        // Disable admission while reading a newly identified native history.
        existing.reportError(new Error('The HAPI source changed native identity; acquiring its new display generation'))
        const journal = this.historyFor(sourceId)
        journal.capture({ type: 'messages-invalidated', sessionId: sourceId })
        const checkpoint = journal.checkpoint()
        const snapshot = await readNativeHistorySnapshot(this.transport, sourceId)
        await this.replaceDisplay(existing, this.historyFor(sourceId).merge(snapshot.rows, checkpoint), source, checkpoint, snapshot.epoch)
      } else await existing.refresh(true)
      this.errors.delete(sourceId)
      return this.agents.get(sourceId)
    })
    this.reconciling.set(sourceId, work)
    const release = () => { if (this.reconciling.get(sourceId) === work) this.reconciling.delete(sourceId) }
    void work.then(release, release)
    return work
  }

  async refreshCatalog(): Promise<void> {
    if (this.options.discovery === 'on-demand') return
    if (this.catalogRefresh) return this.catalogRefresh
    const work = (async () => {
      const sessions = await this.transport.listSessions()
      // HAPI summaries deliberately omit codexNativeSession. Inspect details
      // for Codex candidates before admitting their native identity.
      const candidates = sessions.filter(session => session.metadata?.flavor === 'codex')
      for (let index = 0; index < candidates.length; index += 4) {
        if (this.disposed) return
        await Promise.all(candidates.slice(index, index + 4).map(async session => {
          try { await this.attach(session.id) } catch (error) { this.report(error, session.id) }
        }))
      }
    })()
    this.catalogRefresh = work
    try { await work } finally { if (this.catalogRefresh === work) this.catalogRefresh = undefined }
  }

  async attach(sourceId: string, snapshot?: HapiSession): Promise<NativeCodexAgent | undefined> {
    if (snapshot && snapshot.id !== sourceId) throw new Error('The source snapshot belongs to another session')
    if (this.disposed) throw new Error('The source service was disposed')
    if (this.lifetimes.removed(sourceId)) return undefined
    const releasing = this.releasing.get(sourceId)
    if (releasing) { await releasing; snapshot = undefined }
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
      // Keep attachment publication ahead of constructor hooks even when the
      // resolver already owns the source reply.
      const source = await (snapshot ?? this.transport.getSession(sourceId))
      if (this.disposed || !this.lifetimes.current(sourceId, version)) return undefined
      if (!(source.metadata?.flavor === 'codex' && source.metadata.codexNativeSession === true && !!source.metadata.codexSessionId)) { this.excluded.add(sourceId); this.historyJournals.delete(sourceId); return undefined }
      this.excluded.delete(sourceId)
      const agent = await this.createAgent(source, undefined, undefined, version)
      if (this.disposed || !this.lifetimes.current(sourceId, version)) { await agent.dispose(); return undefined }
      this.agents.set(sourceId, agent); this.errors.delete(sourceId)
      this.attachRetries.get(sourceId)?.dispose(); this.attachRetries.delete(sourceId)
      agent.startHistorySync()
      await this.announceReset(sourceId, agent.id)
      // A lease may have been released while this attach was in flight.
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

  private historyFor(sourceId: string): SourceHistoryJournal {
    let journal = this.historyJournals.get(sourceId)
    if (!journal) { journal = new SourceHistoryJournal(); this.historyJournals.set(sourceId, journal) }
    return journal
  }

  private createAgent(source: HapiSession, rows?: readonly HapiMessage[], checkpoint?: HistoryCheckpoint, version = this.lifetimes.version(source.id), epoch?: number): Promise<NativeCodexAgent> {
    const base = nativeSessionId(this.transport.hubId, source.id)
    return NativeCodexAgent.create(this.ctx, this.transport, source, {
      stateDirectory: this.options.stateDirectory, displayRevision: this.revisions.get(base) ?? 0,
      historyJournal: this.historyFor(source.id), ...(checkpoint ? { historyCheckpoint: checkpoint } : {}),
      ...(epoch === undefined ? {} : { historyEpoch: epoch }),
      assertSourceCurrent: () => { if (this.disposed) throw new HistoryReadInvalidatedError(); this.lifetimes.assertCurrent(source.id, version) },
      ...(this.options.fastHistorySeed === undefined ? {} : { fastHistorySeed: this.options.fastHistorySeed }),
      ...(this.options.resolveAttachments ? { resolveAttachments: this.options.resolveAttachments } : {}),
      ...(this.options.importArtifact ? { importArtifact: this.options.importArtifact } : {}),
      ...(this.options.resumeSession ? { resumeSession: this.options.resumeSession } : {}),
      onHistoryChanged: (agent, snapshot, checkpoint, epoch) => this.replaceDisplay(agent, snapshot, undefined, checkpoint, epoch),
      ...(rows ? { initialRowsMerged: true } : {}),
    }, rows)
  }

  private async replaceDisplay(previous: NativeCodexAgent, rows: HapiMessage[], source?: HapiSession, checkpoint = this.historyFor(previous.binding.hapiSessionId).checkpoint(), epoch?: number): Promise<void> {
    const sourceId = previous.binding.hapiSessionId
    const pending = this.attaching.get(sourceId)
    if (pending) {
      const current = await pending
      if (source && current && source.metadataVersion > current.sourceSession.metadataVersion
        && canonicalJson(bindingFor(this.transport.hubId, source)) !== canonicalJson(current.binding)) {
        if (this.attaching.get(sourceId) === pending) this.attaching.delete(sourceId)
        await this.replaceDisplay(current, rows, source, checkpoint, epoch)
      }
      return
    }
    if (this.disposed || this.agents.get(sourceId) !== previous || this.lifetimes.removed(sourceId)) return
    const journal = this.historyFor(sourceId), version = this.lifetimes.version(sourceId)
    journal.assertCurrent(checkpoint)
    this.advanceRevision(sourceId, previous.displayRevision)
    const task = (async () => {
      let current: NativeCodexAgent | undefined
      try {
        // Delivery and approval journals have exactly one writable owner.
        // Retire the old Agent before constructing the replacement; the
        // service retry below survives disposal of its history sync worker.
        this.pendingResets.set(sourceId, this.pendingResets.get(sourceId) ?? previous.id)
        await previous.dispose(); this.agents.delete(sourceId)
        this.options.onDisplayRetired?.(previous.id, sourceId)
        current = await this.createAgent(source ?? await this.transport.getSession(sourceId), rows, checkpoint, version, epoch)
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
    const logical = nativeSessionId(this.transport.hubId, sourceId)
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
        .map(agent => this.queueFor(agent.binding.hapiSessionId, event)).filter(Boolean)
      if (event.data?.status === 'connected') void this.refreshCatalog().catch(error => this.report(error))
      if (pressure.length) return Promise.all(pressure).then(() => {})
      return
    }
    this.capture(event)
    return this.queueFor(event.sessionId, event)
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

  private queueFor(sourceId: string, event: HapiEvent): void | Promise<void> {
    if (this.suspended.has(sourceId)) return
    if (this.options.discovery === 'on-demand' && !this.agents.has(sourceId) && !this.attaching.has(sourceId)) return
    return this.queueForSource(sourceId).enqueue({ event, version: this.lifetimes.version(sourceId),
      checkpoint: this.historyJournals.get(sourceId)?.checkpoint(),
      removedAgent: event.type === 'session-removed' ? this.agents.get(sourceId) : undefined }, sourceEventBytes(event))
  }

  private queueForSource(sourceId: string): SourceEventQueue<QueuedSourceEvent<NativeCodexAgent>> {
    let queue = this.eventWork.get(sourceId)
    if (queue) return queue
    queue = new SourceEventQueue(async ({ event, version, checkpoint, removedAgent }) => {
      if (this.disposed) return
      if (event.type === 'session-removed') {
        // A remove/add burst can advance the lifecycle before queued work
        // runs. Retire exactly the removed incarnation, never a later one.
        if (removedAgent && this.agents.get(sourceId) === removedAgent) {
          this.agents.delete(sourceId); this.errors.delete(sourceId)
        }
        await removedAgent?.dispose()
        if (removedAgent) this.options.onDisplayRetired?.(removedAgent.id, sourceId)
        return
      }
      if (!this.lifetimes.current(sourceId, version)) return
      const pending = this.attaching.get(sourceId)
      if (pending) { try { await pending } catch { /* A service-owned retry repairs failed preparation. */ } }
      let agent = this.agents.get(sourceId)
      if (!agent) agent = await this.attach(sourceId)
      if (!agent || !this.lifetimes.current(sourceId, version)) return
      try { await agent.handleEvent(event, checkpoint) } catch (error) {
        console.warn(`[hapi-dsh] native event sync failed type=${event.type}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
        if (error instanceof NativeHistoryChangedError || error instanceof HistoryReadInvalidatedError) { agent.reportError(error); agent.requestHistorySync() }
        else throw error
      }
    }, replacesCumulativeSnapshot, error => {
      this.agents.get(sourceId)?.reportError(error)
      this.report(error, sourceId)
    }, () => { if (!this.disposed) this.agents.get(sourceId)?.requestHistorySync() }, undefined,
    () => { if (this.eventWork.get(sourceId) === queue) this.eventWork.delete(sourceId) })
    this.eventWork.set(sourceId, queue)
    return queue
  }

  /** Wait for currently received source events; useful for explicit refresh and integration tests. */
  async settled(): Promise<void> {
    do {
      await Promise.all([...this.eventWork.values()].map(queue => queue.settled()))
      await Promise.all(this.list().map(agent => agent.settled()))
    } while ([...this.eventWork.values()].some(queue => queue.pending.items > 0))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.leaseSweep); this.leases.clear()
    for (const timer of this.releaseTimers.values()) clearTimeout(timer)
    this.releaseTimers.clear()
    for (const sync of this.attachRetries.values()) sync.dispose()
    this.attachRetries.clear()
    this.unsubscribe?.()
    await Promise.allSettled([...this.attaching.values(), ...[...this.eventWork.values()].map(queue => queue.dispose()), ...(this.catalogRefresh ? [this.catalogRefresh] : [])])
    await Promise.allSettled(this.list().map(agent => { this.options.onDisplayRetired?.(agent.id, agent.binding.hapiSessionId); return agent.dispose() }))
    this.agents.clear()
    this.eventWork.clear()
    this.reconciling.clear()
    this.historyJournals.clear()
    this.unregisterProjection?.()
  }

  private report(error: unknown, sourceSessionId?: string): void {
    const failure = error instanceof Error ? error : new Error('The HAPI native source could not be synchronized')
    if (sourceSessionId) this.errors.set(sourceSessionId, failure.message)
    this.options.onError?.(failure, sourceSessionId)
  }

  private persistRevisions(): void {
    writeDurableJson(this.revisionFile, Object.fromEntries(this.revisions))
  }
}
