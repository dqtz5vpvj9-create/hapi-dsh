import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HapiRequestError, type HapiQueuedState } from '../codex/contracts.ts'
import { assertBinding, canonicalJson, nativeSessionId, record, type NativeBinding } from '../codex/native.ts'
import { writeDurableJson } from '../codex/durable-file.ts'
import {
  nativeImplementPlanSchema, nativePlanReceiptSchema, type NativeImplementPlan, type NativePlanReceipt, type NativePlanState,
} from '../codex/control-types.ts'
import type { NativeControlAgent, NativeControlSessions, NativeControlTransport } from './native-control.ts'
import { queuedStateSchema } from './schemas.ts'

export interface NativePlanTransport extends NativeControlTransport {
  getQueuedState(sessionId: string, localIds: string[]): Promise<HapiQueuedState>
}

const entrySchema = z.object({
  binding: z.object({ hubId: z.string(), hapiSessionId: z.string(), threadId: z.string(),
    home: z.string().nullable(), homeId: z.string().nullable(), machineId: z.string().nullable() }),
  receipt: nativePlanReceiptSchema,
}).refine(value => value.receipt.localId === `${value.receipt.planId}:implement`, 'Native plan input identity changed')
type PlanEntry = z.infer<typeof entrySchema>
const journalSchema = z.object({ version: z.literal(1), operations: z.array(entrySchema) })
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.enum(['stale_plan', 'unavailable', 'indeterminate', 'failed']), error: z.string() }),
])
const sameBinding = (left: NativeBinding, right: NativeBinding): boolean => canonicalJson(left) === canonicalJson(right)
const text = (error: unknown): string => error instanceof Error ? error.message : 'Native plan implementation is not confirmed'
const positive = (receipt: NativePlanReceipt): boolean => receipt.status === 'queued' || receipt.status === 'invoked'
const owned = (receipt: NativePlanReceipt): boolean => positive(receipt)
  || receipt.sourceCode === 'native_queue_indeterminate' || receipt.sourceCode === 'native_queue_dispatching'

/** The plan operation belongs to HAPI's native owner, including its stable native queue input. */
export class NativePlan {
  private readonly filename: string
  private readonly entries = new Map<string, PlanEntry>()
  private readonly flights = new Map<string, Promise<NativePlanReceipt>>()

  constructor(private readonly transport: NativePlanTransport, private readonly sessions: NativeControlSessions, directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${nativeSessionId(transport.hubId, 'native-plans')}.json`)
    try {
      const journal = journalSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const entry of journal.operations) {
        if (entry.receipt.status === 'submitting') entry.receipt = { ...entry.receipt, status: 'indeterminate',
          message: 'The observer restarted before the native plan implementation response was recorded' }
        this.entries.set(entry.receipt.operationId, entry)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }

  private agent(sessionId: string): NativeControlAgent {
    const agent = this.sessions.get(sessionId)
    if (!agent || agent.binding.hubId !== this.transport.hubId) throw new HapiRequestError('The native conversation is unavailable', 'rejected', 404)
    assertBinding(agent.binding, agent.sourceSession)
    return agent
  }

  private planId(agent: NativeControlAgent): string | null {
    const value = agent.sourceSession.agentState?.codexPlanProposalId
    return typeof value === 'string' && value ? value : null
  }

  async state(sessionId: string): Promise<NativePlanState> {
    const agent = this.agent(sessionId)
    await agent.refresh()
    await this.reconcile(agent)
    return { planId: this.planId(agent), readOnly: agent.projection.readOnly,
      operations: structuredClone([...this.entries.values()].filter(entry => sameBinding(entry.binding, agent.binding))
        .map(entry => entry.receipt).sort((left, right) => right.createdAt - left.createdAt)) }
  }

  async implement(input: NativeImplementPlan): Promise<NativePlanReceipt> {
    const request = nativeImplementPlanSchema.parse(input)
    const agent = this.agent(request.sessionId)
    const previous = this.entries.get(request.operationId)
    if (previous) {
      if (!sameBinding(previous.binding, agent.binding) || previous.receipt.planId !== request.planId) {
        throw new HapiRequestError('A plan operation ID cannot be reused for another native proposal', 'rejected')
      }
      const pending = this.flights.get(request.operationId)
      if (pending) return pending
      await this.reconcile(agent)
      return structuredClone(previous.receipt)
    }
    // Reserve the attempt before awaiting a refresh so simultaneous clicks
    // cannot both reach the native owner. An explicit proven rejection can
    // later use a new UUID; unknown outcomes must only be observed.
    const held = [...this.entries.values()].find(entry => sameBinding(entry.binding, agent.binding)
      && entry.receipt.planId === request.planId && entry.receipt.status !== 'rejected')
    if (held) throw new HapiRequestError(`This native plan already has operation ${held.receipt.operationId}; inspect its queue result before taking another action`, 'indeterminate', undefined, 'native_plan_already_submitted')
    const entry: PlanEntry = { binding: agent.binding, receipt: {
      operationId: request.operationId, planId: request.planId, localId: `${request.planId}:implement`,
      status: 'submitting', createdAt: Date.now(), updatedAt: Date.now(), message: null, sourceCode: null,
    } }
    this.entries.set(request.operationId, entry)
    try { this.persist() } catch (error) { this.entries.delete(request.operationId); throw error }
    const work = this.dispatch(agent, entry)
    this.flights.set(request.operationId, work)
    try { return await work } finally { this.flights.delete(request.operationId) }
  }

  private async dispatch(agent: NativeControlAgent, entry: PlanEntry): Promise<NativePlanReceipt> {
    try {
      await agent.refresh()
      this.agent(agent.id)
      // Another observer can discover this stable native input while the
      // source refresh is in flight. Its queue proof wins over this attempt.
      if (owned(entry.receipt)) return structuredClone(entry.receipt)
      if (agent.projection.readOnly) throw new Error('Reconnect the original native owner before implementing this plan')
      if (this.planId(agent) !== entry.receipt.planId) throw new Error('The source no longer advertises this native plan as actionable')
    } catch (error) {
      // No implementation request has crossed the transport boundary.
      if (!owned(entry.receipt)) entry.receipt = { ...entry.receipt, status: 'rejected', updatedAt: Date.now(), message: text(error), sourceCode: 'native_plan_not_actionable' }
      this.persist()
      return structuredClone(entry.receipt)
    }
    try {
      const response = responseSchema.parse(await this.transport.request(`/api/sessions/${encodeURIComponent(agent.binding.hapiSessionId)}/codex/plan/implement`, {
        method: 'POST', body: { planId: entry.receipt.planId }, timeoutMs: 75_000,
      }))
      if (response.ok) {
        if (!owned(entry.receipt)) entry.receipt = { ...entry.receipt, status: 'submitted', message: null, sourceCode: null }
      } else if (!owned(entry.receipt)) {
        entry.receipt = { ...entry.receipt,
          status: response.code === 'stale_plan' || response.code === 'unavailable' ? 'rejected' : 'indeterminate',
          message: response.error, sourceCode: response.code }
      }
    } catch (error) {
      if (!owned(entry.receipt)) {
        const rejected = error instanceof HapiRequestError && error.outcome === 'rejected' && error.status !== 401
          && ([400, 403, 404].includes(error.status ?? 0) || error.status === 409 && (error.code === 'stale_plan' || error.code === 'unavailable'))
        entry.receipt = { ...entry.receipt, status: rejected ? 'rejected' : 'indeterminate',
          message: text(error), sourceCode: error instanceof HapiRequestError ? error.code ?? null : null }
      }
    }
    entry.receipt.updatedAt = Date.now()
    this.persist()
    await this.reconcile(agent)
    return structuredClone(entry.receipt)
  }

  private async reconcile(agent: NativeControlAgent): Promise<void> {
    const pending = [...this.entries.values()].filter(entry => sameBinding(entry.binding, agent.binding)
      && entry.receipt.status !== 'rejected' && entry.receipt.status !== 'invoked')
    for (let offset = 0; offset < pending.length; offset += 1000) {
      const batch = pending.slice(offset, offset + 1000)
      try {
        const state = queuedStateSchema.parse(await this.transport.getQueuedState(agent.binding.hapiSessionId, batch.map(entry => entry.receipt.localId)))
        const invoked = new Set(state.invokedLocalMessages.map(message => message.localId))
        const queued = new Set(state.queuedLocalIds)
        const indeterminate = new Set(state.indeterminateLocalIds ?? [])
        const dispatching = new Set(state.dispatchingLocalIds ?? [])
        for (const entry of batch) {
          if (invoked.has(entry.receipt.localId) || queued.has(entry.receipt.localId) && entry.receipt.status !== 'invoked') {
            entry.receipt = { ...entry.receipt, status: invoked.has(entry.receipt.localId) ? 'invoked' : 'queued',
              updatedAt: Date.now(), message: null, sourceCode: null }
          } else if (indeterminate.has(entry.receipt.localId) && entry.receipt.status !== 'invoked') {
            entry.receipt = { ...entry.receipt, status: 'indeterminate', updatedAt: Date.now(),
              message: 'The native owner cannot yet confirm whether the implementation input was invoked', sourceCode: 'native_queue_indeterminate' }
          } else if (dispatching.has(entry.receipt.localId) && entry.receipt.status !== 'invoked') {
            entry.receipt = { ...entry.receipt, status: 'submitted', updatedAt: Date.now(),
              message: 'The native owner is dispatching the implementation input', sourceCode: 'native_queue_dispatching' }
          }
          // Missing input or a disappeared plan proposal proves neither
          // execution nor rejection. Keep the known submission state.
        }
      } catch (error) {
        for (const entry of batch) entry.receipt = { ...entry.receipt, message: `Native queue observation is unavailable: ${text(error)}` }
      }
    }
    if (pending.length) this.persist()
  }

  async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }
  private persist(): void { writeDurableJson(this.filename, { version: 1, operations: [...this.entries.values()] }) }
}
