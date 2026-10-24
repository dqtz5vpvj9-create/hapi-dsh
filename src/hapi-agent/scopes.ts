import type { HapiMessage } from '../codex/contracts.js'
import { envelopeFor, record } from '../codex/native.js'
import { NativeHistoryChangedError } from '../codex/projector.js'

export interface ObservedScope {
  scopeId: string | null
  parentToolCallId: string | null
}
export interface ObservedScopeInfo extends ObservedScope {
  scopeId: string
  kind: 'sdk' | 'agent-run'
  parentScopeId: string | null
  sourceAgentId: string | null
  label: string
  status: 'observed' | 'running' | 'completed' | 'error' | 'aborted'
  createdAt: number
  updatedAt: number
}
interface FactIdentity {
  rowId: string; createdAt: number; seq: number | null
  uuid: string; parentUuid: string | null; direct: string | null; sidechain: boolean; prompt: string | null
}
interface Tool { rowId: string; id: string; prompt: string | null; label: string }
interface SdkFact extends FactIdentity {
  kind: 'sdk'; stringContent: boolean; tools: readonly Tool[]
  results: readonly { id: string; reason: 'completed' | 'error'; error: string | null }[]
  terminal: 'completed' | 'error' | null
  label: string | null
}
interface AgentRunFact extends FactIdentity {
  kind: 'agent-run'; type: 'agent-run-start' | 'agent-run-update' | 'agent-run-trace'
  agentId: string | null; cardId: string | null; parentAgentId: string | null
  label: string | null; status: string | null; activity: string | null; closing: boolean
  eventId: string | null; error: string | null
}
type Fact = SdkFact | AgentRunFact
export interface ObservedScopeCompletion {
  scopeId: string; parentToolCallId: string | null; key: string
  reason: 'completed' | 'error' | 'aborted'; error: string | null
}
const string = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null
const root: ObservedScope = { scopeId: null, parentToolCallId: null }
const subagentTool = (name: unknown): boolean => typeof name === 'string'
  && (name === 'Task' || name === 'Agent' || name.startsWith('Task:') || name.startsWith('Agent:'))
function prompt(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const blocks = content.flatMap(value => {
    const block = record(value); return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  })
  return blocks.length ? blocks.join('\n\n') : null
}
function fact(row: HapiMessage): Fact | undefined {
  const envelope = envelopeFor(row.content), content = record(envelope?.content), data = record(content?.data)
  if (envelope?.role !== 'agent' || !data) return
  const identity = { rowId: row.id, createdAt: row.createdAt, seq: row.seq }
  const label = string(data.nickname ?? data.name ?? data.summary)
  // Keep lineage, prompt matching and completion facts without owning the
  // source message. Live child snapshots get fresh transport row IDs; raw
  // data would retain every cumulative text after the Hub replaces its row.
  if (content?.type === 'output') {
    const messageContent = record(data.message)?.content, tools: Tool[] = [], results: SdkFact['results'][number][] = []
    if (Array.isArray(messageContent)) for (const raw of messageContent) {
      const block = record(raw), input = record(block?.input)
      if (block?.type === 'tool_use' && string(block.id) && subagentTool(block.name)) {
        tools.push({ rowId: row.id, id: String(block.id), prompt: string(input?.prompt),
          label: string(input?.description) ?? string(input?.subagent_type) ?? String(block.name) })
      }
      const id = string(block?.tool_use_id)
      if (block?.type === 'tool_result' && id) results.push({ id, reason: block.is_error === true ? 'error' : 'completed',
        error: block.is_error === true ? prompt(block.content) ?? 'The source subagent tool failed' : null })
    }
    return { ...identity, kind: 'sdk', uuid: string(data.uuid) ?? row.id,
      parentUuid: string(data.parentUuid), direct: string(data.parentToolUseId),
      sidechain: data.isSidechain === true || typeof data.parentToolUseId === 'string',
      prompt: data.type === 'user' ? prompt(messageContent) : null, stringContent: typeof messageContent === 'string',
      tools, results, label, terminal: data.type === 'result' || data.type === 'system' && data.subtype === 'turn_duration'
        ? data.is_error === true ? 'error' : 'completed' : null }
  }
  const type = data.type
  if ((content?.type === 'codex' || content?.type === 'event')
    && (type === 'agent-run-start' || type === 'agent-run-update' || type === 'agent-run-trace')) {
    const agent = string(data.agentId ?? data.agent_id), card = string(data.cardId ?? data.card_id)
    if (!agent && !card) return // An unidentified start is still visible as a source notice.
    const activity = string(data.activityKind ?? data.activity_kind), status = string(data.status)
    return { ...identity, kind: 'agent-run', uuid: row.id, parentUuid: null, direct: agent ?? card, sidechain: true, prompt: null,
      type, agentId: agent, cardId: card, parentAgentId: string(record(data.scope)?.parentThreadId ?? data.parentAgentId),
      label, status, activity,
      closing: activity === 'close_agent' || activity === 'closed'
        || activity === 'canceled' && (data.activity === 'Closed' || data.statusText === 'Closed' || data.status_text === 'Closed')
          && (record(record(data.result)?.previous_status) !== undefined || record(record(data.result)?.previousStatus) !== undefined),
      eventId: string(data.id), error: string(data.error)
        ?? (status === 'failed' || status === 'error' || status === 'notFound' || status === 'not_found'
          ? string(data.summary) ?? 'The source agent reported an error' : null) }
  }
  return
}

/**
 * Exact SDK parent-tool/UUID links and source agent identities. Legacy prompt
 * matching is allowed only for one exact Task/Agent prompt. Unknown children
 * remain separate observations; they are never folded into the parent answer.
 */
export class ObservedScopeIndex {
  private readonly facts = new Map<string, Fact>()
  private resolved = new Map<string, ObservedScope>()
  private metadata: ObservedScopeInfo[] = []
  private completions = new Map<string, ObservedScopeCompletion[]>()
  update(rows: readonly HapiMessage[], authoritative = false): void {
    const facts = authoritative ? new Map<string, Fact>() : new Map(this.facts)
    for (const row of rows) { const value = fact(row); if (value) facts.set(row.id, value); else facts.delete(row.id) }
    const byUuid = new Map<string, Fact[]>(), tools = new Map<string, Tool[]>(), prompts = new Map<string, Tool[]>()
    const cardAgents = new Map<string, Set<string>>()
    for (const value of facts.values()) {
      if (value.kind === 'agent-run') {
        const agent = value.agentId, card = value.cardId
        if (agent && card) { const set = cardAgents.get(card) ?? new Set(); set.add(agent); cardAgents.set(card, set) }
        continue
      }
      const known = byUuid.get(value.uuid) ?? []; known.push(value); byUuid.set(value.uuid, known)
      for (const tool of value.tools) {
        const same = tools.get(tool.id) ?? []; same.push(tool); tools.set(tool.id, same)
        if (tool.prompt !== null) { const samePrompt = prompts.get(tool.prompt) ?? []; samePrompt.push(tool); prompts.set(tool.prompt, samePrompt) }
      }
    }
    const resolved = new Map<string, ObservedScope>()
    const resolve = (value: Fact, ancestry: string[] = []): ObservedScope => {
      const found = resolved.get(value.rowId); if (found) return found
      let scope: ObservedScope
      if (value.kind === 'agent-run') {
        const agent = value.agentId, card = value.cardId
        const matches = card ? [...(cardAgents.get(card) ?? [])] : []
        const identity = agent ?? (matches.length === 1 ? matches[0]! : card!)
        scope = { scopeId: `run:${identity}`, parentToolCallId: null }
      } else if (value.direct) scope = { scopeId: `sdk-tool:${value.direct}`, parentToolCallId: value.direct }
      else {
        const matching = value.prompt === null ? [] : prompts.get(value.prompt) ?? []
        const exact = new Map(matching.map(tool => [tool.id, tool]))
        if (exact.size === 1 && (value.sidechain || value.stringContent)) {
          const id = [...exact.keys()][0]!
          scope = { scopeId: `sdk-tool:${id}`, parentToolCallId: id }
        } else if (!value.sidechain) scope = root
        else if (ancestry.includes(value.rowId)) scope = { scopeId: `sdk-orphan:${[...ancestry, value.rowId].sort()[0]}`, parentToolCallId: null }
        else {
          const parents = value.parentUuid === null ? [] : byUuid.get(value.parentUuid) ?? []
          const parent = parents.length === 1 ? resolve(parents[0]!, [...ancestry, value.rowId]) : root
          scope = parent.scopeId ? parent : { scopeId: `sdk-orphan:${parents.length === 0 && value.parentUuid ? value.parentUuid : value.uuid}`, parentToolCallId: null }
        }
      }
      resolved.set(value.rowId, scope); return scope
    }
    for (const value of facts.values()) resolve(value)
    for (const [id, previous] of this.resolved) {
      const next = resolved.get(id)
      if (next && (previous.scopeId !== next.scopeId || previous.parentToolCallId !== next.parentToolCallId)) {
        throw new NativeHistoryChangedError('The source resolved a different child-message identity; acquire its current history generation')
      }
    }
    const metadata = new Map<string, ObservedScopeInfo>(), completions = new Map<string, ObservedScopeCompletion[]>()
    const ordered = [...facts.values()].sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0) || a.rowId.localeCompare(b.rowId))
    const complete = (value: Fact, scope: ObservedScope, key: string, reason: ObservedScopeCompletion['reason'], error: string | null): void => {
      if (!scope.scopeId) return
      const values = completions.get(value.rowId) ?? []
      values.push({ ...scope, scopeId: scope.scopeId, key, reason, error }); completions.set(value.rowId, values)
    }
    for (const value of ordered) {
      const scope = resolved.get(value.rowId)!
      if (!scope.scopeId) continue
      const call = scope.parentToolCallId ? tools.get(scope.parentToolCallId) : undefined
      const owners = new Set(call?.map(tool => resolved.get(tool.rowId)?.scopeId ?? null))
      const ownerScope = owners.size === 1 ? [...owners][0] ?? null : null
      const sourceAgentId = value.kind === 'agent-run' ? value.agentId : null
      const sourceParent = value.kind === 'agent-run' ? value.parentAgentId : null
      const previous = metadata.get(scope.scopeId)
      const parentScopeId = ownerScope ?? (sourceParent && [...resolved.values()].some(item => item.scopeId === `run:${sourceParent}`)
        ? `run:${sourceParent}` : previous?.parentScopeId ?? null)
      const info: ObservedScopeInfo = { ...scope, scopeId: scope.scopeId, kind: value.kind,
        parentScopeId: parentScopeId === scope.scopeId ? null : parentScopeId, sourceAgentId: sourceAgentId ?? previous?.sourceAgentId ?? null,
        label: call?.length ? call[0]!.label : value.label ?? previous?.label ?? (value.kind === 'sdk' ? 'Source subagent' : sourceAgentId ?? 'Source agent'),
        status: previous?.status ?? 'observed', createdAt: previous?.createdAt ?? value.createdAt, updatedAt: value.createdAt }
      if (value.kind === 'sdk' && value.terminal) {
        info.status = value.terminal
      } else if (value.kind === 'agent-run') {
        const status = value.status, activity = value.activity
        const terminal = info.status === 'completed' || info.status === 'error' || info.status === 'aborted'
        const closing = value.closing
        const nonterminal = status === 'running' || status === 'pending' || value.type === 'agent-run-start'
        // Source wait/close cleanup does not undo an observed finished task.
        const ignored = terminal && ((nonterminal && (activity === 'wait_agent' || closing))
          || closing && status !== 'failed' && status !== 'error')
        if (!ignored) {
          if (status === 'completed') info.status = 'completed'
          else if (status === 'failed' || status === 'error' || status === 'notFound' || status === 'not_found') info.status = 'error'
          else if (status === 'cancelled' || status === 'canceled') info.status = 'aborted'
          else if (nonterminal) info.status = 'running'
          if (value.type !== 'agent-run-trace' && ['completed', 'failed', 'error', 'notFound', 'not_found', 'cancelled', 'canceled'].includes(String(status))) {
            complete(value, scope, `run-end:${scope.scopeId}:${value.eventId ?? value.rowId}`,
              info.status as ObservedScopeCompletion['reason'], value.error)
          }
        }
      }
      metadata.set(scope.scopeId, info)
    }
    // A completed Task/Agent tool result is source evidence that its child has
    // ended, including SDK versions without a separate child result message.
    for (const value of ordered) {
      if (value.kind !== 'sdk') continue
      for (const { id, reason, error } of value.results) {
        if (!tools.has(id)) continue
        const info = metadata.get(`sdk-tool:${id}`)
        if (!info || value.createdAt < info.createdAt) continue
        complete(value, info, `sdk-end:${id}:${value.rowId}`, reason, error)
        info.status = reason; info.updatedAt = Math.max(info.updatedAt, value.createdAt)
      }
    }
    // Cyclic lineage is malformed source data, not permission to fabricate an
    // owner chain. Keep each child visible under the source observation root.
    for (const value of metadata.values()) {
      const seen = new Set([value.scopeId]); let cursor = value.parentScopeId
      while (cursor) {
        if (seen.has(cursor)) { value.parentScopeId = null; break }
        seen.add(cursor); cursor = metadata.get(cursor)?.parentScopeId ?? null
      }
    }
    this.facts.clear(); for (const [id, value] of facts) this.facts.set(id, value)
    this.resolved = resolved; this.metadata = [...metadata.values()]; this.completions = completions
  }
  forRow(row: HapiMessage): ObservedScope { return this.resolved.get(row.id) ?? root }
  completionsForRow(row: HapiMessage): readonly ObservedScopeCompletion[] { return this.completions.get(row.id) ?? [] }
  scopes(): readonly ObservedScopeInfo[] { return this.metadata }
}
