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
import { readNativeHistory } from './history.js'
import { hapiProjectionDefinition } from './projection-state.js'

export interface CodexServiceOptions extends Omit<NativeCodexOptions, 'displayRevision' | 'onHistoryChanged'> {
  onDisplayReset?: (oldDisplayId: SessionId, newDisplayId: SessionId) => void | Promise<void>
  onError?: (error: Error, sourceSessionId?: string) => void
}

/** One unmodified DSH host can catalogue native Codex sessions from a HAPI Hub. */
export class CodexService {
  private readonly agents = new Map<string, NativeCodexAgent>()
  private readonly attaching = new Map<string, Promise<NativeCodexAgent | undefined>>()
  private readonly eventWork = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private readonly revisionFile: string
  private unsubscribe: (() => void) | undefined
  private unregisterProjection: (() => void) | undefined
  private catalogRefresh: Promise<void> | undefined
  private disposed = false
  private started = false
  private readonly errors = new Map<string, string>()

  constructor(readonly ctx: Context, readonly transport: HapiTransport, readonly options: CodexServiceOptions) {
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
    const hubKey = nativeSessionId(transport.hubId, 'display-revisions')
    this.revisionFile = join(options.stateDirectory, `${hubKey}.revisions.json`)
    try {
      const revisions = z.record(z.string(), z.number().int().nonnegative()).parse(JSON.parse(readFileSync(this.revisionFile, 'utf8')))
      for (const [key, revision] of Object.entries(revisions)) this.revisions.set(key, revision)
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
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
  failures(): ReadonlyMap<string, string> { return this.errors }

  /**
   * Reconcile an explicit source lifecycle operation. A versioned identity
   * change retires the old display/Agent before entering a new generation;
   * old references cannot silently send to the replacement thread or home.
   */
  reconcileSource(sourceId: string): Promise<NativeCodexAgent | undefined> {
    const previous = this.eventWork.get(sourceId) ?? Promise.resolve()
    const work = previous.then(async () => {
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
        const rows = await readNativeHistory(this.transport, sourceId)
        await this.replaceDisplay(existing, rows, source)
      } else await existing.refresh(true)
      this.errors.delete(sourceId)
      return this.agents.get(sourceId)
    })
    const tracked = work.then(() => {}, error => {
      this.agents.get(sourceId)?.reportError(error)
      this.report(error, sourceId)
    })
    this.eventWork.set(sourceId, tracked)
    void tracked.then(() => { if (this.eventWork.get(sourceId) === tracked) this.eventWork.delete(sourceId) })
    return work
  }

  async refreshCatalog(): Promise<void> {
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

  async attach(hapiSessionId: string): Promise<NativeCodexAgent | undefined> {
    if (this.disposed) throw new Error('The Codex service was disposed')
    const existing = this.agents.get(hapiSessionId)
    if (existing) return existing
    const pending = this.attaching.get(hapiSessionId)
    if (pending) return pending
    const work = (async () => {
      const source = await this.transport.getSession(hapiSessionId)
      if (source.metadata?.flavor !== 'codex' || !source.metadata.codexNativeSession || !source.metadata.codexSessionId) return undefined
      const agent = await this.createAgent(source)
      if (this.disposed) { await agent.dispose(); return undefined }
      this.agents.set(hapiSessionId, agent)
      this.errors.delete(hapiSessionId)
      return agent
    })()
    this.attaching.set(hapiSessionId, work)
    try { return await work } finally { if (this.attaching.get(hapiSessionId) === work) this.attaching.delete(hapiSessionId) }
  }

  private createAgent(source: HapiSession, rows?: readonly HapiMessage[]): Promise<NativeCodexAgent> {
    const base = nativeSessionId(this.transport.hubId, source.id)
    return NativeCodexAgent.create(this.ctx, this.transport, source, {
      stateDirectory: this.options.stateDirectory, displayRevision: this.revisions.get(base) ?? 0,
      ...(this.options.resolveAttachments ? { resolveAttachments: this.options.resolveAttachments } : {}),
      ...(this.options.importArtifact ? { importArtifact: this.options.importArtifact } : {}),
      onHistoryChanged: (agent, snapshot) => this.replaceDisplay(agent, snapshot),
    }, rows)
  }

  private async replaceDisplay(previous: NativeCodexAgent, rows: HapiMessage[], source?: HapiSession): Promise<void> {
    if (this.disposed || this.agents.get(previous.binding.hapiSessionId) !== previous) return
    const revision = previous.displayRevision + 1
    this.revisions.set(previous.logicalSessionId, revision)
    this.persistRevisions()
    const sourceId = previous.binding.hapiSessionId
    // Never recycle an event sequence namespace: other official plugins may
    // still own references to the previous display generation.
    await previous.dispose()
    this.agents.delete(sourceId)
    if (this.disposed) return
    const current = await this.createAgent(source ?? await this.transport.getSession(sourceId), rows)
    if (this.disposed) { await current.dispose(); return }
    this.agents.set(sourceId, current)
    await this.options.onDisplayReset?.(previous.id, current.id)
  }

  private enqueue(event: HapiEvent): void {
    if (this.disposed || event.type === 'toast') return
    if (event.type === 'connection-changed') {
      for (const agent of this.agents.values()) this.queueFor(agent.binding.hapiSessionId, event)
      if (event.data?.status === 'connected') void this.refreshCatalog().catch(error => this.report(error))
      return
    }
    this.queueFor(event.sessionId, event)
  }

  private queueFor(sourceId: string, event: HapiEvent): void {
    const previous = this.eventWork.get(sourceId) ?? Promise.resolve()
    const work = previous.then(async () => {
      if (this.disposed) return
      let agent = this.agents.get(sourceId)
      if (!agent && event.type !== 'session-removed') agent = await this.attach(sourceId)
      if (!agent) return
      if (event.type === 'session-removed') {
        await agent.dispose(); this.agents.delete(sourceId)
        return
      }
      try { await agent.handleEvent(event) } catch (error) {
        if (error instanceof NativeHistoryChangedError) await agent.refresh(true)
        else throw error
      }
    }).catch(error => {
      this.agents.get(sourceId)?.reportError(error)
      this.report(error, sourceId)
    })
    this.eventWork.set(sourceId, work)
    void work.then(() => { if (this.eventWork.get(sourceId) === work) this.eventWork.delete(sourceId) })
  }

  /** Wait for currently received source events; useful for explicit refresh and integration tests. */
  async settled(): Promise<void> {
    while (this.eventWork.size) await Promise.all([...this.eventWork.values()])
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    await Promise.allSettled([...this.attaching.values(), ...this.eventWork.values(), ...(this.catalogRefresh ? [this.catalogRefresh] : [])])
    await Promise.allSettled(this.list().map(agent => agent.dispose()))
    this.agents.clear()
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
