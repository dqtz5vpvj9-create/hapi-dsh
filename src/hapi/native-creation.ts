import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableJson } from '../codex/durable-file.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { HapiRequestError } from '../codex/contracts.ts'
import { canonicalJson, nativeSessionId, record } from '../codex/native.ts'
import {
  createNativeSessionSchema, nativeCreationOperationSchema, nativeCreationStateSchema,
  type CreateNativeSession, type NativeCreationOperation, type NativeCreationState,
} from '../codex/creation-types.ts'
import { spawnSessionResponseSchema, type SpawnSessionInput, type SpawnSessionResponse } from './client.ts'
import { sessionSchema } from './schemas.ts'
import type { NativeControlSessions } from './native-control.ts'

export interface NativeCreationTransport {
  readonly hubId: string
  spawnSession(machineId: string, input: SpawnSessionInput): Promise<SpawnSessionResponse>
  request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>
}

export interface NativeCreationOptions {
  /** A bounded metadata-read budget per caller; no timer causes a new spawn. */
  maxReadAttempts?: number
  pollIntervalMs?: number
  readRequestTimeoutMs?: number
}

const savedSchema = z.object({ version: z.literal(1), operations: z.array(nativeCreationStateSchema) })
const sourceSchema = z.object({ session: sessionSchema })
const text = (error: unknown): string => error instanceof Error ? error.message : 'The native launch could not be confirmed'

/**
 * The HAPI source reserves a durable requestId before dispatching the runner.
 * Our receipt keeps that identity across a lost HTTP response and DSH restart.
 * Once a sourceSessionId is known, every retry is a bounded read/attach only.
 */
export class NativeCreation {
  private readonly filename: string
  private readonly entries = new Map<string, NativeCreationState>()
  private readonly flights = new Map<string, Promise<NativeCreationState>>()
  private readonly maxReads: number
  private readonly interval: number
  private readonly readTimeout: number

  constructor(private readonly transport: NativeCreationTransport, private readonly sessions: NativeControlSessions,
    directory: string, options: NativeCreationOptions = {}) {
    this.maxReads = options.maxReadAttempts ?? 8
    this.interval = options.pollIntervalMs ?? 300
    this.readTimeout = options.readRequestTimeoutMs ?? 1500
    if (!Number.isSafeInteger(this.maxReads) || this.maxReads < 1 || !Number.isFinite(this.interval) || this.interval < 0
      || !Number.isFinite(this.readTimeout) || this.readTimeout <= 0) throw new Error('Invalid native creation readiness budget')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${nativeSessionId(transport.hubId, 'native-creations')}.json`)
    try {
      const saved = savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const state of saved.operations) {
        if (state.status === 'submitting') {
          state.status = 'indeterminate'
          state.message = 'The observer restarted before the Runner launch response was recorded. Recover this same request ID.'
        }
        if (state.status === 'ready') {
          state.status = 'accepted'
          state.message = 'The original native thread is known. Check its current display before opening it.'
        }
        state.sessionId = null
        this.entries.set(state.requestId, state)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }

  list(): NativeCreationState[] {
    return structuredClone([...this.entries.values()].sort((left, right) => right.createdAt - left.createdAt))
  }

  async create(input: CreateNativeSession): Promise<NativeCreationState> {
    const request = createNativeSessionSchema.parse(input)
    const previous = this.entries.get(request.requestId)
    if (previous) {
      if (canonicalJson(previous.request) !== canonicalJson(request)) {
        throw new HapiRequestError('This native creation request ID already belongs to another immutable launch intent', 'rejected', undefined, 'spawn_request_conflict')
      }
      // Reopening or retrying the form cannot redispatch an accepted launch.
      return this.operation({ requestId: request.requestId, action: 'read' })
    }
    const state: NativeCreationState = {
      requestId: request.requestId, request, status: 'submitting', sourceSessionId: null, nativeThreadId: null, sessionId: null,
      createdAt: Date.now(), updatedAt: Date.now(), message: null, sourceCode: null,
    }
    this.entries.set(state.requestId, state)
    try { this.persist() } catch (error) { this.entries.delete(state.requestId); throw error }
    return this.run(state, true)
  }

  async operation(input: NativeCreationOperation): Promise<NativeCreationState> {
    const request = nativeCreationOperationSchema.parse(input)
    const state = this.entries.get(request.requestId)
    if (!state) throw new HapiRequestError('The native creation request is not known to this Hub workspace', 'rejected', 404)
    const flight = this.flights.get(state.requestId)
    if (flight) return flight
    if (state.status === 'rejected') return structuredClone(state)
    // No GET endpoint exists for HAPI's spawn-request receipt. Explicit
    // reconciliation of a lost receipt may use the identical POST: the pinned
    // Hub's durable claim never dispatches an admitted request a second time.
    return this.run(state, request.action === 'reconcile' && state.sourceSessionId === null)
  }

  private run(state: NativeCreationState, mayRecoverReceipt: boolean): Promise<NativeCreationState> {
    const found = this.flights.get(state.requestId)
    if (found) return found
    const work = (async () => {
      if (mayRecoverReceipt) await this.dispatch(state)
      if (state.sourceSessionId && state.status !== 'rejected') await this.observe(state)
      return structuredClone(state)
    })()
    this.flights.set(state.requestId, work)
    void work.finally(() => { if (this.flights.get(state.requestId) === work) this.flights.delete(state.requestId) }).catch(() => {})
    return work
  }

  private async dispatch(state: NativeCreationState): Promise<void> {
    state.status = 'submitting'; state.message = null; state.updatedAt = Date.now()
    this.persist()
    try {
      const { machineId, ...input } = state.request
      const response = spawnSessionResponseSchema.parse(await this.transport.spawnSession(machineId, {
        requestId: input.requestId, directory: input.directory, agent: 'codex', startingMode: 'remote',
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: input.modelReasoningEffort }),
        ...(input.codexHome === undefined ? {} : { codexHome: input.codexHome }),
        ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
        ...(input.collaborationMode === undefined ? {} : { collaborationMode: input.collaborationMode }),
        ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
        ...(input.sessionType === undefined ? {} : { sessionType: input.sessionType }),
        ...(input.worktreeName === undefined ? {} : { worktreeName: input.worktreeName }),
      }))
      if (response.type === 'success') {
        state.sourceSessionId = response.sessionId
        state.status = 'accepted'
        state.sourceCode = null
        state.message = 'The Runner accepted this launch. Waiting for the original native thread metadata.'
      } else {
        state.sourceSessionId = response.sessionId ?? null
        state.sourceCode = response.code ?? null
        // childStarted:false is a source no-launch proof. Other generic
        // errors may follow dispatch and cannot authorize a fresh request.
        const rejected = response.code !== 'spawn_outcome_unknown' && (response.childStarted === false
          || response.code === 'runner_upgrade_required' || response.code === 'spawn_request_conflict')
        state.status = rejected ? 'rejected' : 'indeterminate'
        state.message = response.message
      }
    } catch (error) {
      state.status = error instanceof HapiRequestError && error.outcome === 'rejected' && [400, 403, 404].includes(error.status ?? 0) ? 'rejected' : 'indeterminate'
      state.message = text(error)
      state.sourceCode = error instanceof HapiRequestError ? error.code ?? null : null
    }
    state.updatedAt = Date.now()
    this.persist()
  }

  private async observe(state: NativeCreationState): Promise<void> {
    const sourceId = state.sourceSessionId
    if (!sourceId) return
    state.sessionId = null
    for (let attempt = 0; attempt < this.maxReads; attempt++) {
      try {
        const { session } = sourceSchema.parse(await this.transport.request(`/api/sessions/${encodeURIComponent(sourceId)}`, { timeoutMs: this.readTimeout }))
        if (session.id !== sourceId) throw new Error('The Hub returned a different source session for this launch')
        const metadata = session.metadata
        if (metadata?.machineId && metadata.machineId !== state.request.machineId) throw new Error('The launch source belongs to another machine')
        if (metadata?.flavor && metadata.flavor !== 'codex') throw new Error('The launch source is not a native Codex conversation')
        if (metadata?.codexNativeSession && metadata.codexSessionId) {
          if (state.nativeThreadId && metadata.codexSessionId !== state.nativeThreadId) throw new Error('The original native thread identity changed')
          if (state.request.codexHome && metadata.codexHome !== state.request.codexHome) throw new Error('The launch source did not confirm the requested native Codex home')
          if (metadata.machineId !== state.request.machineId) throw new Error('The native source did not confirm its Runner identity')
          state.nativeThreadId = metadata.codexSessionId
          state.status = 'accepted'
          state.updatedAt = Date.now()
          this.persist()
          const agent = await this.sessions.attach(sourceId)
          if (!agent || agent.binding.threadId !== state.nativeThreadId || agent.binding.machineId !== state.request.machineId
            || state.request.codexHome && agent.binding.home !== state.request.codexHome) throw new Error('The native thread exists, but its original display is not attached yet')
          state.sessionId = agent.id
          state.status = 'ready'
          state.message = null
          state.sourceCode = null
          state.updatedAt = Date.now()
          this.persist()
          return
        }
        state.message = 'The launch has a source session, but its original native Codex thread metadata is not ready. Keep this request ID and check again.'
      } catch (error) {
        state.message = `The original launch remains recorded; its native readiness is not confirmed: ${text(error)}`
      }
      if (attempt + 1 < this.maxReads && this.interval > 0) await delay(this.interval)
    }
    state.updatedAt = Date.now()
    this.persist()
  }

  async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }

  private persist(): void {
    writeDurableJson(this.filename, { version: 1, operations: [...this.entries.values()] })
  }
}
