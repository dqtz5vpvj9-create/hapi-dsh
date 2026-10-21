import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { HapiRequestError, type HapiSession } from '../codex/contracts.js'
import { canonicalJson, record } from '../codex/native.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { observedNativeId, observedSessionId, type ObservedBinding } from '../hapi-agent/identity.js'
import { createSourceSessionSchema, sourceCreationOperationSchema, sourceCreationStateSchema,
  type CreateSourceSession, type SourceCreationOperation, type SourceCreationState } from '../hapi-agent/creation-types.js'
import { spawnSessionResponseSchema, type SpawnSessionInput, type SpawnSessionResponse } from './client.js'
import { sessionSchema } from './schemas.js'

export interface SourceCreationTransport {
  readonly hubId: string
  spawnSession(machineId: string, input: SpawnSessionInput): Promise<SpawnSessionResponse>
  request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>
}

export interface SourceCreationAgent {
  readonly id: string
  readonly binding: ObservedBinding
  readonly sourceSession: HapiSession
}

export interface SourceCreationSessions {
  reconcileSource(sourceId: string): Promise<SourceCreationAgent | undefined>
}

export interface SourceCreationOptions {
  maxReadAttempts?: number
  pollIntervalMs?: number
  readRequestTimeoutMs?: number
}

const locator = z.string().min(1).optional()
const registrationMetadata = sessionSchema.shape.metadata.unwrap().extend({
  hostPid: z.number().int().nonnegative().optional(),
  claudeSessionId: locator, dshSessionId: locator, copilotSessionId: locator,
  cursorSessionId: locator, grokSessionId: locator, kimiSessionId: locator,
  opencodeSessionId: locator, piSessionId: locator, qoderSessionId: locator, agySessionId: locator,
})
const sourceSchema = z.object({ session: sessionSchema.extend({ metadata: registrationMetadata.nullable() }) })
const savedSchema = z.object({ version: z.literal(1), operations: z.array(sourceCreationStateSchema) })
const text = (error: unknown): string => error instanceof Error ? error.message : 'The original Runner launch could not be confirmed'

/**
 * Existing HAPI engines keep their original Runner and durable spawn claim.
 * The Hub preallocates a row before launch, so a row id/flavor/machine alone
 * never proves that a process registered. No observer retry launches a second
 * process after a source id is known.
 */
export class SourceCreation {
  private readonly filename: string
  private readonly entries = new Map<string, SourceCreationState>()
  private readonly flights = new Map<string, Promise<SourceCreationState>>()
  private readonly maxReads: number
  private readonly interval: number
  private readonly readTimeout: number

  constructor(private readonly transport: SourceCreationTransport, private readonly sessions: SourceCreationSessions,
    directory: string, options: SourceCreationOptions = {}) {
    this.maxReads = options.maxReadAttempts ?? 8
    this.interval = options.pollIntervalMs ?? 300
    this.readTimeout = options.readRequestTimeoutMs ?? 1500
    if (!Number.isSafeInteger(this.maxReads) || this.maxReads < 1 || !Number.isFinite(this.interval) || this.interval < 0
      || !Number.isFinite(this.readTimeout) || this.readTimeout <= 0) throw new Error('Invalid source creation readiness budget')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${observedSessionId(transport.hubId, 'source-creations')}.json`)
    try {
      const saved = savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const state of saved.operations) {
        if (state.status === 'submitting') {
          state.status = 'indeterminate'
          state.message = 'The workspace restarted before the Runner reply was recorded. Preserve this launch request ID.'
        } else if (state.status === 'ready') {
          state.status = 'accepted'
          state.message = 'The original source is known. Check its current display before opening it.'
        }
        state.sessionId = null
        this.entries.set(state.requestId, state)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }

  list(): SourceCreationState[] {
    return structuredClone([...this.entries.values()].sort((left, right) => right.createdAt - left.createdAt))
  }

  async create(input: CreateSourceSession): Promise<SourceCreationState> {
    const request = createSourceSessionSchema.parse(input)
    const previous = this.entries.get(request.requestId)
    if (previous) {
      if (canonicalJson(previous.request) !== canonicalJson(request)) throw new HapiRequestError(
        'This source creation request ID belongs to another immutable launch intent', 'rejected', undefined, 'spawn_request_conflict')
      return this.operation({ requestId: request.requestId, action: 'read' })
    }
    const now = Date.now()
    const state: SourceCreationState = { requestId: request.requestId, request,
      status: 'submitting', sourceSessionId: null, nativeId: null, sessionId: null, registrationObservedAt: null,
      createdAt: now, updatedAt: now, message: null, sourceCode: null }
    this.entries.set(state.requestId, state)
    try { this.persist() } catch (error) { this.entries.delete(state.requestId); throw error }
    return this.run(state, true)
  }

  async operation(input: SourceCreationOperation): Promise<SourceCreationState> {
    const request = sourceCreationOperationSchema.parse(input)
    const state = this.entries.get(request.requestId)
    if (!state) throw new HapiRequestError('This source launch request is not known to the workspace', 'rejected', 404)
    const flight = this.flights.get(state.requestId)
    if (flight) return flight
    if (state.status === 'rejected') return structuredClone(state)
    // The pinned source exposes no GET for spawn receipts. Explicit reconcile
    // can repeat only this immutable durable claim if its response was lost.
    return this.run(state, request.action === 'reconcile' && state.sourceSessionId === null)
  }

  private run(state: SourceCreationState, recoverReceipt: boolean): Promise<SourceCreationState> {
    const existing = this.flights.get(state.requestId)
    if (existing) return existing
    const task = (async () => {
      if (recoverReceipt) await this.dispatch(state)
      if (state.sourceSessionId && state.status !== 'rejected') await this.observe(state)
      return structuredClone(state)
    })()
    this.flights.set(state.requestId, task)
    void task.finally(() => { if (this.flights.get(state.requestId) === task) this.flights.delete(state.requestId) }).catch(() => {})
    return task
  }

  private async dispatch(state: SourceCreationState): Promise<void> {
    state.status = 'submitting'; state.message = null; state.updatedAt = Date.now(); this.persist()
    try {
      const { machineId, ...input } = state.request
      const response = spawnSessionResponseSchema.parse(await this.transport.spawnSession(machineId, {
        requestId: input.requestId, directory: input.directory, agent: input.agent,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: input.modelReasoningEffort }),
        ...(input.yolo === undefined ? {} : { yolo: input.yolo }),
        ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
        ...(input.copilotAgentMode === undefined ? {} : { copilotAgentMode: input.copilotAgentMode }),
        ...(input.startingMode === undefined ? {} : { startingMode: input.startingMode }),
        ...(input.sessionType === undefined ? {} : { sessionType: input.sessionType }),
        ...(input.worktreeName === undefined ? {} : { worktreeName: input.worktreeName }),
      }))
      if (response.type === 'success') {
        state.sourceSessionId = response.sessionId; state.status = 'accepted'; state.sourceCode = null
        state.message = 'The Runner accepted this launch. Waiting for the original source registration.'
      } else {
        state.sourceSessionId = response.sessionId ?? null; state.sourceCode = response.code ?? null
        const rejected = response.code !== 'spawn_outcome_unknown' && (response.childStarted === false
          || response.code === 'runner_upgrade_required' || response.code === 'spawn_request_conflict')
        state.status = rejected ? 'rejected' : 'indeterminate'; state.message = response.message
      }
    } catch (error) {
      state.status = error instanceof HapiRequestError && error.outcome === 'rejected' && [400, 403, 404].includes(error.status ?? 0)
        ? 'rejected' : 'indeterminate'
      state.message = text(error); state.sourceCode = error instanceof HapiRequestError ? error.code ?? null : null
    }
    state.updatedAt = Date.now(); this.persist()
  }

  private async observe(state: SourceCreationState): Promise<void> {
    const sourceId = state.sourceSessionId
    if (!sourceId) return
    state.sessionId = null
    if (state.status === 'ready') state.status = 'accepted'
    for (let attempt = 0; attempt < this.maxReads; attempt++) {
      try {
        const { session } = sourceSchema.parse(await this.transport.request(`/api/sessions/${encodeURIComponent(sourceId)}`, { timeoutMs: this.readTimeout }))
        if (session.id !== sourceId) throw new Error('The Hub returned another source session for this launch')
        if (session.metadata?.flavor !== state.request.agent) throw new Error('The source has not confirmed the requested engine')
        if (session.metadata.machineId !== state.request.machineId) throw new Error('The source has not confirmed the requested Runner')
        if (session.metadata.codexNativeSession) throw new Error('A native Codex source cannot satisfy another engine launch')
        const binding: ObservedBinding = { hubId: this.transport.hubId, hapiSessionId: sourceId, flavor: state.request.agent,
          nativeId: observedNativeId(state.request.agent, session.metadata), machineId: state.request.machineId }
        if (state.nativeId && binding.nativeId !== state.nativeId) throw new Error('The original source conversation identity changed')
        // The Hub preallocated stub already contains flavor and machineId, but
        // no PID, engine locator, or live registration. Never open that stub as
        // a successfully launched engine merely because GET returned it.
        if (state.registrationObservedAt === null && !session.active && !binding.nativeId && !(session.metadata.hostPid && session.metadata.hostPid > 0)) {
          state.message = 'The Hub reserved this source session, but the Runner has not confirmed registration. Keep the same request ID and check again.'
        } else {
          state.registrationObservedAt ??= Date.now()
          state.nativeId ??= binding.nativeId
          state.status = 'accepted'; state.updatedAt = Date.now(); this.persist()
          const agent = await this.sessions.reconcileSource(sourceId)
          if (!agent || agent.binding.hubId !== this.transport.hubId || agent.binding.hapiSessionId !== sourceId
            || agent.binding.flavor !== state.request.agent || agent.binding.machineId !== state.request.machineId
            || state.nativeId && agent.binding.nativeId !== state.nativeId) throw new Error('The original source exists, but its matching display is not attached yet')
          state.nativeId ??= agent.binding.nativeId
          state.sessionId = agent.id; state.status = 'ready'; state.message = null; state.sourceCode = null
          state.updatedAt = Date.now(); this.persist(); return
        }
      } catch (error) { state.message = `The original launch remains recorded; readiness is not confirmed: ${text(error)}` }
      if (attempt + 1 < this.maxReads && this.interval > 0) await delay(this.interval)
    }
    state.updatedAt = Date.now(); this.persist()
  }

  async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }
  private persist(): void { writeDurableJson(this.filename, { version: 1, operations: [...this.entries.values()] }) }
}
