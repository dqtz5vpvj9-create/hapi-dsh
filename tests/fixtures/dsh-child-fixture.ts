/** Explicit original HAPI DSH-child wire fixture. No live model or DSH child
 * process is implied; the browser uses the unmodified official DSH runtime. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { HapiSession } from '../src/codex/contracts.ts'
import type { SourceDshChildDescriptor, SourceDshChildMessage } from '../src/hapi-agent/dsh-child-types.ts'
import type { HapiWireFixture, NativeFixture } from './hapi-fixture.ts'

interface Child {
  parent: NativeFixture; descriptor: SourceDshChildDescriptor; rows: SourceDshChildMessage[]; epoch: string
  dropPromptReply: boolean; dropInterruptReply: boolean
  accepted: Map<string, { text: string; delivery: 'queue' | 'steer'; messageId: string }>
}
const promptSchema = z.object({ text: z.string().min(1).max(100_000), delivery: z.enum(['queue', 'steer']), requestId: z.string().min(1).max(128) })
export class DshChildWireFixture {
  readonly prompts: Array<{ parentId: string; parentDshId: string; childId: string; machineId: string; text: string; delivery: 'queue' | 'steer'; requestId: string }> = []
  readonly interrupts: Array<{ parentId: string; childId: string; machineId: string }> = []
  readonly reads: Array<{ parentId: string; childId: string }> = []
  private readonly children = new Map<string, Child>()
  private key(parent: string, child: string) { return JSON.stringify([parent, child]) }

  seed(owner: HapiWireFixture, key: string, machineId: string): NativeFixture {
    const at = Date.now(), id = `source-dsh-${key}`
    const session: HapiSession = { id, namespace: 'e2e', seq: 1, createdAt: at, updatedAt: at, active: true, activeAt: at,
      thinking: false, thinkingAt: at, metadataVersion: 1, agentStateVersion: 1, model: 'fixture-parent-model',
      metadata: { flavor: 'dsh', name: `Source DSH parent ${key}`, path: `/workspace/dsh-${key}`,
        machineId, host: machineId === 'machine-alpha' ? 'Laptop' : 'Linux workstation', dshSessionId: `original-dsh-parent-${key}`,
        dshCapabilities: { control: true, steering: true, images: true, resume: true, subagents: true } },
      agentState: { requests: {}, completedRequests: {}, controlledByUser: false } }
    const parent: NativeFixture = { session, rows: [] }
    Object.assign(session.metadata!, { dshSubagents: [] })
    owner.sessions.set(id, parent); owner.readStates[id] = { seenAt: 0, manualUnreadAt: null, version: 0 }; owner.workbench.seed(session)
    return parent
  }
  add(parent: NativeFixture, id: string, name: string, mode: SourceDshChildDescriptor['mode'] = 'continuable'): Child {
    const at = parent.session.createdAt + this.children.size + 1
    const descriptor: SourceDshChildDescriptor = { sessionId: id, name, label: name, mode, activity: 'inactive', createdAt: at, lastTurnCompleted: true, settledMs: 20 }
    const child: Child = { parent, descriptor, epoch: `${id}:${at}`, rows: [
      { id: `${id}:0`, role: 'user', kind: 'message', text: `Original task for ${name}`, createdAt: at },
      { id: `${id}:1`, role: 'assistant', kind: 'message', text: `Original answer from ${name}`, createdAt: at + 1 },
    ], dropPromptReply: false, dropInterruptReply: false, accepted: new Map() }
    this.children.set(this.key(parent.session.id, id), child); this.publishCatalog(parent); return child
  }
  require(parentId: string, childId: string): Child {
    const child = this.children.get(this.key(parentId, childId)); if (!child) throw new Error('Unknown fixture child'); return child
  }
  change(owner: HapiWireFixture, parentId: string, childId: string, update: Partial<SourceDshChildDescriptor>) {
    const child = this.require(parentId, childId); Object.assign(child.descriptor, update); this.publishCatalog(child.parent)
    owner.emit({ type: 'session-updated', sessionId: parentId })
  }
  private publishCatalog(parent: NativeFixture) {
    Object.assign(parent.session.metadata!, { dshSubagents: [...this.children.values()].filter(child => child.parent === parent).map(child => structuredClone(child.descriptor)) })
    parent.session.metadataVersion++; parent.session.updatedAt = Date.now()
  }
  handle(owner: HapiWireFixture, source: HapiSession, tail: string, url: URL, request: IncomingMessage, response: ServerResponse, body: unknown): boolean {
    const match = /^dsh-subagents\/(.+)\/(messages|prompt|interrupt)$/.exec(tail)
    if (!match) return false
    const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    const id = match[1]!, operation = match[2]!, child = this.children.get(this.key(source.id, id))
    if (!child || source.metadata?.flavor !== 'dsh' || !source.active) { send({ error: 'The original parent or child is unavailable' }, 409); return true }
    if (operation === 'messages' && request.method === 'GET') {
      this.reads.push({ parentId: source.id, childId: id })
      const limit = Number(url.searchParams.get('limit') ?? 40), before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
      const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || before !== undefined && after !== undefined || after !== undefined && !url.searchParams.has('epoch')) { send({ error: 'Invalid original cursor query' }, 400); return true }
      const reset = url.searchParams.has('epoch') && url.searchParams.get('epoch') !== child.epoch || after !== undefined && after > child.rows.length
      const start = after !== undefined && !reset ? after : Math.max(0, (before ?? child.rows.length) - limit)
      const end = after !== undefined && !reset ? Math.min(child.rows.length, after + limit) : before ?? child.rows.length
      send({ sessionId: id, messages: child.rows.slice(start, end), epoch: child.epoch,
        before: start > 0 ? start : null, hasMore: start > 0, after: after !== undefined && !reset ? end : child.rows.length,
        hasLater: after !== undefined && !reset && end < child.rows.length, reset, truncated: child.rows.some(row => row.truncated === true) }); return true
    }
    if (request.method !== 'POST' || child.descriptor.mode !== 'continuable') { send({ error: 'Only continuable source children accept input' }, 409); return true }
    if (operation === 'interrupt') {
      this.interrupts.push({ parentId: source.id, childId: id, machineId: source.metadata!.machineId! })
      // The wire acknowledgement does not change the catalog activity. Tests
      // explicitly publish the later original source idle observation.
      if (child.dropInterruptReply) { child.dropInterruptReply = false; response.destroy(); return true }
      send({ accepted: true }); return true
    }
    if (operation === 'prompt') {
      const parsed = promptSchema.safeParse(body)
      if (!parsed.success) { send({ error: 'Invalid original child prompt' }, 400); return true }
      const input = parsed.data, prior = child.accepted.get(input.requestId)
      this.prompts.push({ parentId: source.id, parentDshId: source.metadata!.dshSessionId!, childId: id, machineId: source.metadata!.machineId!, ...input })
      if (prior && (prior.text !== input.text || prior.delivery !== input.delivery)) { send({ error: 'requestId payload conflict' }, 409); return true }
      if (prior) { send({ messageId: prior.messageId }); return true }
      const messageId = `original-child-message-${this.prompts.length}`
      child.accepted.set(input.requestId, { ...input, messageId })
      const at = Date.now(), ordinal = child.rows.length
      child.rows.push({ id: `${id}:${ordinal}`, role: 'user', kind: 'message', text: input.text, createdAt: at },
        { id: `${id}:${ordinal + 1}`, role: 'assistant', kind: 'message', text: `Original fixture child response: ${input.text}`, createdAt: at + 1 })
      owner.emit({ type: 'session-updated', sessionId: source.id })
      if (child.dropPromptReply) { child.dropPromptReply = false; response.destroy(); return true }
      send({ messageId }); return true
    }
    send({ error: 'Unknown original child route' }, 404); return true
  }
}
