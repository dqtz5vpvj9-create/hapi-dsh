import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableJson } from './durable-file.ts'
import { z } from 'zod'
import { HapiRequestError, type HapiAgentState, type HapiApprovalAnswer, type HapiTransport } from './contracts.js'
import type { ApprovalView } from './projection-types.js'
import { record } from './native.js'

const candidateSchema = z.object({
  requestId: z.string(), fingerprint: z.string(), stage: z.enum(['submitted', 'indeterminate']), error: z.string().nullable(),
})
type Candidate = z.infer<typeof candidateSchema>

/** Candidate answers remain pending until the native completed-request map settles them. */
export class NativeApprovals {
  private source: HapiAgentState = {}
  private readonly candidates = new Map<string, Candidate>()
  private readonly filename: string

  constructor(
    stateDirectory: string,
    sessionId: string,
    private readonly hapiSessionId: string,
    private readonly transport: HapiTransport,
    private readonly changed: () => void,
  ) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
    this.filename = join(stateDirectory, `${sessionId}.approvals.json`)
    try {
      const parsed = z.array(candidateSchema).parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const candidate of parsed) this.candidates.set(candidate.requestId, {
        ...candidate, stage: 'indeterminate',
        error: candidate.error ?? 'The observer restarted before native approval resolution was observed',
      })
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }

  observe(source: HapiAgentState | null): void {
    this.source = source ?? {}
    let changed = false
    for (const id of Object.keys(this.source.completedRequests ?? {})) changed = this.candidates.delete(id) || changed
    // Disappearance without a completed native fact does not approve anything.
    if (changed) this.persist()
  }

  pending(): ApprovalView[] {
    return Object.entries(this.source.requests ?? {}).map(([requestId, request]) => {
      const candidate = this.candidates.get(requestId)
      return {
        requestId, tool: request.tool, toolCallId: request.toolCallId ?? null,
        arguments: request.arguments, blocking: request.blocking !== false,
        createdAt: request.createdAt ?? null, stage: candidate?.stage ?? 'pending', error: candidate?.error ?? null,
      }
    })
  }

  resolved(): Array<{ requestId: string; status: 'canceled' | 'denied' | 'approved' | 'resolved'; completedAt: number | null }> {
    return Object.entries(this.source.completedRequests ?? {}).map(([requestId, request]) => ({
      requestId, status: request.status, completedAt: request.completedAt ?? null,
    })).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)).slice(0, 50)
  }

  async answer(requestId: string, answer: HapiApprovalAnswer, deny = false): Promise<{ stage: 'submitted' | 'resolved' }> {
    if (this.source.completedRequests?.[requestId]) return { stage: 'resolved' }
    if (!this.source.requests?.[requestId]) throw new Error('The native approval request is no longer pending')
    const fingerprint = JSON.stringify({ deny, answer })
    const previous = this.candidates.get(requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('An answer is already awaiting native resolution; a different answer cannot replace it')
      if (previous.stage === 'indeterminate') throw new Error('The approval outcome is unknown; wait for native reconciliation before answering again')
      return { stage: 'submitted' }
    }
    this.candidates.set(requestId, { requestId, fingerprint, stage: 'submitted', error: null })
    try { this.persist() } catch (error) { this.candidates.delete(requestId); throw error }
    this.changed()
    try {
      if (deny) await this.transport.deny(this.hapiSessionId, requestId, answer)
      else await this.transport.approve(this.hapiSessionId, requestId, answer)
      return { stage: this.source.completedRequests?.[requestId] ? 'resolved' : 'submitted' }
    } catch (error) {
      if (this.source.completedRequests?.[requestId]) return { stage: 'resolved' }
      if (error instanceof HapiRequestError && error.outcome === 'rejected') this.candidates.delete(requestId)
      else this.candidates.set(requestId, { requestId, fingerprint, stage: 'indeterminate',
        error: error instanceof Error ? error.message : 'Native approval resolution is unknown' })
      this.persist()
      this.changed()
      throw error
    }
  }

  private persist(): void {
    writeDurableJson(this.filename, [...this.candidates.values()])
  }
}
