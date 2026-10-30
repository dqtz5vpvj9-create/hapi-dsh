/** Original HAPI owner bridge for native DSH identities and writes. */
import { HapiClient } from '../hapi/client.ts'
import { HapiRequestError, type HapiSession, type HapiSessionSummary, type HapiApprovalAnswer } from '../codex/contracts.ts'
import { SourceError } from './errors.ts'
import { parseSourceSessionId, sourceSessionId, type DirectDshConfig, type SourceOperation, type SourceReceipt, type SourceSession } from './protocol.ts'

export interface DshOwnerConnectionOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
}

function nativeDshId(session: Pick<HapiSessionSummary, 'metadata'>): string | undefined {
  const metadata = session.metadata
  const id = metadata?.dshSessionId
  if (metadata?.flavor !== 'dsh' || typeof id !== 'string' || !id.trim() || id.includes('\0')) return undefined
  return id
}

function dshOwnerCandidate(session: HapiSessionSummary, machineId: string): boolean {
  return session.metadata?.flavor === 'dsh' && session.metadata.machineId === machineId
}

function ownerMatches(session: HapiSession, machineId: string, nativeId: string): boolean {
  return session.metadata?.flavor === 'dsh'
    && session.metadata.machineId === machineId
    && session.metadata.dshSessionId === nativeId
}

function toSourceSession(config: DirectDshConfig, session: HapiSession): SourceSession | undefined {
  const nativeId = nativeDshId(session)
  if (!nativeId || session.metadata?.machineId !== config.machineId) return undefined

  const execution = session.execution ?? null
  const activeTurnId = session.active && execution?.status === 'active' ? execution.turnId : null
  const requests = session.agentState?.requests ?? {}
  const pendingRequests = Object.entries(requests).map(([id, request]) => ({
    id,
    method: request.tool,
    turnId: null,
    itemId: request.toolCallId ?? null,
    params: { tool: request.tool, arguments: request.arguments, ...(request.blocking === undefined ? {} : { blocking: request.blocking }) },
  }))
  const status: SourceSession['status'] = !session.active || execution?.status === 'disconnected' || execution?.status === 'systemError'
    ? execution?.status === 'disconnected' || execution?.status === 'systemError' ? 'offline' : 'idle'
    : execution?.waitingOn.length ? 'waiting'
      : activeTurnId || session.thinking ? 'running' : 'idle'
  const id = sourceSessionId({ sourceId: config.id, machineId: config.machineId, engine: 'dsh', nativeId })

  return {
    id, sourceId: config.id, machineId: config.machineId, engine: 'dsh', nativeId,
    title: session.metadata?.name?.trim() || session.metadata?.summary?.text?.trim() || nativeId,
    cwd: session.metadata?.path ?? '', updatedAt: session.updatedAt,
    status, activeTurnId,
    // HAPI's Hub normalizes DSH deliveryMode="steer" to "queue". Advertising
    // steer here would report support for a different operation than DSH's
    // live-turn followup protocol.
    capabilities: {
      send: session.active,
      steer: false,
      cancel: session.active && activeTurnId !== null,
      approve: session.active && pendingRequests.length > 0,
      files: false,
    },
    pendingRequests,
    legacyOrigin: { hubId: config.owner.hubId, sessionId: session.id },
  }
}

/**
 * Keeps the exact pre-cutover HAPI owner for writes while native DSH owns the
 * event log. This class never reads `/messages`, resumes, or creates a session.
 */
export class DshOwnerConnection {
  readonly id: string
  readonly machineId: string
  readonly engine = 'dsh' as const
  private readonly client: HapiClient

  constructor(private readonly config: DirectDshConfig, options: DshOwnerConnectionOptions = {}) {
    this.id = config.id
    this.machineId = config.machineId
    const env = options.env ?? process.env
    const token = env[config.owner.tokenEnv]
    if (!token?.trim()) throw new Error(`Set ${config.owner.tokenEnv} to the HAPI access token before starting`)
    if (token.includes('\0') || /[\r\n]/.test(token)) throw new Error('HAPI access token must be a single line')
    this.client = new HapiClient({ hubId: config.owner.hubId, url: config.owner.url, token, ...(options.fetch ? { fetch: options.fetch } : {}) })
  }

  async catalog(): Promise<SourceSession[]> {
    // HAPI summaries intentionally omit some native locators. Filter on the
    // stable summary fields, then confirm dshSessionId from the detail endpoint.
    const candidates = (await this.client.listSessions()).filter(summary => dshOwnerCandidate(summary, this.machineId))
    const rows = await Promise.all(candidates.map(async summary => {
      let session: HapiSession
      try { session = await this.client.getSession(summary.id) }
      catch (error) {
        if (error instanceof HapiRequestError && error.status === 404) return undefined
        throw error
      }
      return toSourceSession(this.config, session)
    }))

    const byNativeId = new Map<string, SourceSession>()
    const ambiguous = new Set<string>()
    for (const row of rows) {
      if (!row) continue
      if (byNativeId.has(row.nativeId)) ambiguous.add(row.nativeId)
      else byNativeId.set(row.nativeId, row)
    }
    return [...byNativeId.values()].filter(row => !ambiguous.has(row.nativeId)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  }

  private async ownerSession(nativeId: string): Promise<HapiSession> {
    const candidates = (await this.client.listSessions()).filter(summary => dshOwnerCandidate(summary, this.machineId))
    const details = await Promise.all(candidates.map(async summary => {
      try { return await this.client.getSession(summary.id) }
      catch (error) {
        if (error instanceof HapiRequestError && error.status === 404) return undefined
        throw error
      }
    }))
    const matches = details.filter((session): session is HapiSession => Boolean(session && ownerMatches(session, this.machineId, nativeId)))
    if (matches.length !== 1) throw new SourceError('TARGET_UNAVAILABLE', matches.length ? 'The native DSH identity has multiple HAPI owners.' : 'The original HAPI owner no longer advertises this DSH session.')
    return matches[0]!
  }

  private assertOperation(nativeId: string, operation: SourceOperation): void {
    let identity
    try { identity = parseSourceSessionId(operation.sessionId) }
    catch { throw new SourceError('INVALID_REQUEST', 'The source session identity is invalid.') }
    if (identity.sourceId !== this.id || identity.machineId !== this.machineId || identity.engine !== this.engine
      || identity.nativeId !== nativeId) throw new SourceError('INVALID_REQUEST', 'The operation does not belong to this native DSH owner.')
    if (!operation.operationId || operation.operationId.length > 256 || /[\0\r\n]/.test(operation.operationId)) throw new SourceError('INVALID_REQUEST', 'A stable operation ID is required.')
  }

  private receipt(operation: SourceOperation, status: SourceReceipt['status'], message: string): SourceReceipt {
    return { sessionId: operation.sessionId, operationId: operation.operationId, status, message,
      ...(operation.kind === 'cancel' && operation.turnId ? { turnId: operation.turnId } : {}) }
  }

  async operate(nativeId: string, operation: SourceOperation): Promise<SourceReceipt> {
    this.assertOperation(nativeId, operation)
    const session = await this.ownerSession(nativeId)
    const current = toSourceSession(this.config, session)
    if (!current) throw new SourceError('INVALID_REQUEST', 'The HAPI session no longer matches this native DSH source.')
    if (operation.kind === 'send') {
      if (!operation.text?.trim()) throw new SourceError('INVALID_REQUEST', 'The source prompt is empty.')
      if (!current.capabilities.send) throw new SourceError('TARGET_UNAVAILABLE', 'The original DSH owner is inactive; it will not be resumed.')
      try {
        await this.client.sendMessage(session.id, { text: operation.text, localId: operation.operationId, deliveryMode: 'queue' })
        return this.receipt(operation, 'accepted', 'The original HAPI owner accepted the message into its queue; this does not mean the DSH turn completed.')
      } catch (error) {
        if (error instanceof HapiRequestError) return this.receipt(operation, error.outcome, error.message)
        throw error
      }
    }
    if (operation.kind === 'steer') {
      // HAPI currently downgrades DSH deliveryMode="steer" to "queue". Its
      // queued-message steer RPC requires an HAPI message ID and is not DSH's
      // exact-active-turn steer operation, so this bridge must fail closed.
      throw new SourceError('UNSUPPORTED', 'The original HAPI owner cannot safely steer this exact DSH turn.')
    }
    if (operation.kind === 'cancel') {
      if (!operation.turnId || current.activeTurnId !== operation.turnId || !current.capabilities.cancel) {
        throw new SourceError('INVALID_REQUEST', 'The active DSH turn changed or is no longer cancellable.')
      }
      try {
        await this.client.abortSession(session.id)
        return this.receipt(operation, 'accepted', 'The original HAPI owner accepted the abort request for the current DSH turn.')
      } catch (error) {
        if (error instanceof HapiRequestError) return this.receipt(operation, error.outcome, error.message)
        throw error
      }
    }

    if (!operation.requestId || !operation.decision || !session.agentState?.requests?.[operation.requestId]) {
      throw new SourceError('INVALID_REQUEST', 'The DSH approval request is no longer pending.')
    }
    if (!current.capabilities.approve) throw new SourceError('TARGET_UNAVAILABLE', 'The original HAPI owner cannot accept this approval now.')
    const decision = ({
      accept: 'approved',
      acceptForSession: 'approved_for_session',
      decline: 'denied',
      cancel: 'abort',
    } as const)[operation.decision]
    const answer: HapiApprovalAnswer = { decision }
    try {
      if (decision === 'approved' || decision === 'approved_for_session') await this.client.approve(session.id, operation.requestId, answer)
      else await this.client.deny(session.id, operation.requestId, answer)
      return this.receipt(operation, 'accepted', 'The original HAPI owner accepted the DSH approval response.')
    } catch (error) {
      if (error instanceof HapiRequestError) return this.receipt(operation, error.outcome, error.message)
      throw error
    }
  }

  async dispose(): Promise<void> { await this.client.close() }
}
