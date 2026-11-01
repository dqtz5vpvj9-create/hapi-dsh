/** Original HAPI owner bridge for native DSH identities and writes. */
import { HapiClient } from '../hapi/client.ts'
import { HapiRequestError, type HapiSession, type HapiSessionSummary, type HapiApprovalAnswer } from '../codex/contracts.ts'
import { SourceError, waitFor } from './errors.ts'
import { sourceIsOffline, sourceOffline, sourceOnlineConnection } from '../shared/source-connectivity.ts'
import { parseSourceSessionId, sourceSessionId, type DirectDshConfig, type SourceOperation, type SourceReceipt, type SourceSession } from './protocol.ts'

export interface DshOwnerConnectionOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => number
}

/** An owner identity may authorize cached local reading for a bounded outage. */
const READING_IDENTITY_LEASE_MS = 15 * 60_000
interface KnownOwner { session: SourceSession; verifiedAt: number }

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

function toSourceSession(config: DirectDshConfig, session: HapiSession, previous?: SourceSession, now = Date.now()): SourceSession | undefined {
  const nativeId = nativeDshId(session)
  if (!nativeId || session.metadata?.machineId !== config.machineId) return undefined
  const id = sourceSessionId({ sourceId: config.id, machineId: config.machineId, engine: 'dsh', nativeId })
  // The same HAPI locator can later refer to a different native conversation.
  // Availability observations must never transfer its old turn or approvals.
  if (previous?.id !== id) previous = undefined

  const execution = session.execution ?? null
  const disconnected = execution?.status === 'disconnected' || execution?.status === 'systemError'
  const activeTurnId = session.active && execution?.status === 'active' ? execution.turnId : null
  const requests = session.agentState?.requests ?? {}
  const pendingRequests = Object.entries(requests).map(([id, request]) => ({
    id,
    method: request.tool,
    turnId: null,
    itemId: request.toolCallId ?? null,
    params: { tool: request.tool, arguments: request.arguments, ...(request.blocking === undefined ? {} : { blocking: request.blocking }) },
  }))
  const status: SourceSession['status'] = disconnected ? previous?.status ?? 'idle' : !session.active ? 'idle'
    : execution?.waitingOn.length ? 'waiting'
      : activeTurnId || session.thinking ? 'running' : 'idle'

  const descriptor: SourceSession = {
    id, sourceId: config.id, machineId: config.machineId, engine: 'dsh', nativeId,
    title: session.metadata?.name?.trim() || session.metadata?.summary?.text?.trim() || nativeId,
    cwd: session.metadata?.path ?? '', updatedAt: session.updatedAt,
    status, activeTurnId: disconnected ? previous?.activeTurnId ?? activeTurnId : activeTurnId,
    connection: disconnected && previous?.connection?.state === 'offline' ? previous.connection : sourceOnlineConnection(previous, now),
    // HAPI's Hub normalizes DSH deliveryMode="steer" to "queue". Advertising
    // steer here would report support for a different operation than DSH's
    // live-turn followup protocol.
    capabilities: disconnected && previous ? previous.capabilities : {
      send: disconnected || session.active,
      steer: false,
      cancel: session.active && activeTurnId !== null,
      approve: session.active && pendingRequests.length > 0,
      files: false,
    },
    pendingRequests: disconnected && previous ? previous.pendingRequests : pendingRequests,
    legacyOrigin: { hubId: config.owner.hubId, sessionId: session.id },
  }
  return disconnected ? sourceOffline(descriptor, now) : descriptor
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
  private readonly now: () => number
  private readonly knownOwners = new Map<string, KnownOwner>()
  private readonly readable = new Map<string, KnownOwner>()
  private catalogRead: Promise<SourceSession[]> | undefined
  private disposed = false

  constructor(private readonly config: DirectDshConfig, options: DshOwnerConnectionOptions = {}) {
    this.id = config.id
    this.machineId = config.machineId
    this.now = options.now ?? Date.now
    const env = options.env ?? process.env
    const token = env[config.owner.tokenEnv]
    if (!token?.trim()) throw new Error(`Set ${config.owner.tokenEnv} to the HAPI access token before starting`)
    if (token.includes('\0') || /[\r\n]/.test(token)) throw new Error('HAPI access token must be a single line')
    this.client = new HapiClient({ hubId: config.owner.hubId, url: config.owner.url, token, ...(options.fetch ? { fetch: options.fetch } : {}) })
  }

  async catalog(): Promise<SourceSession[]> {
    if (this.disposed) throw new SourceError('DISPOSED', 'The original DSH owner connection is closed.')
    if (!this.catalogRead) {
      const work = this.readCatalog().finally(() => { if (this.catalogRead === work) this.catalogRead = undefined })
      this.catalogRead = work
    }
    return this.catalogRead
  }

  private revoke(): void { this.knownOwners.clear(); this.readable.clear() }

  private forgetOwner(ownerId: string): void {
    const known = this.knownOwners.get(ownerId)
    this.knownOwners.delete(ownerId)
    if (known && this.readable.get(known.session.nativeId)?.session.legacyOrigin?.sessionId === ownerId) this.readable.delete(known.session.nativeId)
  }

  private async readCatalog(): Promise<SourceSession[]> {
    // HAPI summaries intentionally omit some native locators. Filter on the
    // stable summary fields, then confirm dshSessionId from the detail endpoint.
    let rows: Array<{ ownerId: string; known: KnownOwner } | undefined>
    try {
      const candidates = (await this.client.listSessions()).filter(summary => dshOwnerCandidate(summary, this.machineId))
      const advertised = new Set(candidates.map(summary => summary.id))
      // The owner list is authoritative for deletion, even when a different
      // session's detail endpoint is temporarily unreachable.
      for (const id of this.knownOwners.keys()) if (!advertised.has(id)) this.forgetOwner(id)
      rows = await Promise.all(candidates.map(async summary => {
        try {
          const session = toSourceSession(this.config, await this.client.getSession(summary.id), this.knownOwners.get(summary.id)?.session, this.now())
          if (!session || this.knownOwners.get(summary.id)?.session.nativeId !== session.nativeId) this.forgetOwner(summary.id)
          return session ? { ownerId: summary.id, known: { session, verifiedAt: this.now() } } : undefined
        } catch (error) {
          if (error instanceof HapiRequestError && error.status === 404) { this.forgetOwner(summary.id); return undefined }
          if (error instanceof HapiRequestError && (error.status === 401 || error.status === 403)) throw error
          const known = this.knownOwners.get(summary.id)
          if (known) known.session = sourceOffline(known.session, this.now())
          return known && this.now() - known.verifiedAt < READING_IDENTITY_LEASE_MS ? { ownerId: summary.id, known } : undefined
        }
      }))
    } catch (error) {
      if (error instanceof HapiRequestError && (error.status === 401 || error.status === 403)) {
        this.revoke()
        throw new SourceError('UNSUPPORTED', 'The original DSH owner revoked access to its sessions.')
      }
      for (const known of this.knownOwners.values()) known.session = sourceOffline(known.session, this.now())
      throw error
    }
    if (this.disposed) throw new SourceError('DISPOSED', 'The original DSH owner connection is closed.')

    const byNativeId = new Map<string, KnownOwner>()
    const ambiguous = new Set<string>()
    this.knownOwners.clear()
    for (const row of rows) {
      if (!row) continue
      this.knownOwners.set(row.ownerId, row.known)
      const nativeId = row.known.session.nativeId
      if (byNativeId.has(nativeId)) ambiguous.add(nativeId)
      else byNativeId.set(nativeId, row.known)
    }
    this.readable.clear()
    for (const [id, known] of byNativeId) if (!ambiguous.has(id)) this.readable.set(id, known)
    return [...this.readable.values()].map(value => value.session).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  }

  /** Existing history uses a previously verified native identity, never a guessed path. */
  async readingSession(nativeId: string, signal?: AbortSignal): Promise<SourceSession> {
    if (this.disposed) throw new SourceError('DISPOSED', 'The original DSH owner connection is closed.')
    signal?.throwIfAborted()
    let known = this.readable.get(nativeId)
    if (!known || this.now() - known.verifiedAt >= READING_IDENTITY_LEASE_MS) {
      await waitFor(this.catalog(), signal)
      known = this.readable.get(nativeId)
    }
    if (!known || this.now() - known.verifiedAt >= READING_IDENTITY_LEASE_MS) {
      throw new SourceError('TARGET_UNAVAILABLE', 'The original DSH owner must confirm this native session before more history can be read.')
    }
    return known.session
  }

  /** Recheck deletion/revocation after local IO before publishing another page. */
  assertReadingSession(nativeId: string): void {
    const known = this.readable.get(nativeId)
    if (this.disposed) throw new SourceError('DISPOSED', 'The original DSH owner connection is closed.')
    if (!known || this.now() - known.verifiedAt >= READING_IDENTITY_LEASE_MS) {
      throw new SourceError('TARGET_UNAVAILABLE', 'The original DSH owner no longer authorizes this cached reading identity.')
    }
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

  /**
   * Read an exact durable owner queue row, without dispatching or resuming it.
   * This is a handoff receipt, not a native DSH message coordinate. The owner's
   * consumed marker can precede ACP prompt admission (and is also set during
   * session-end cleanup), so none of these states proves native execution.
   */
  async readAdmission(nativeId: string, operation: SourceOperation, signal?: AbortSignal): Promise<SourceReceipt['ownerAdmission']> {
    if (this.disposed) throw new SourceError('DISPOSED', 'The original DSH owner connection is closed.')
    signal?.throwIfAborted()
    this.assertOperation(nativeId, operation)
    if (operation.kind !== 'send') return undefined
    // A reading lease cannot identify a current write owner. Resolve its exact
    // native identity again, including machine membership and ambiguity checks.
    const owner = await waitFor(this.ownerSession(nativeId), signal)
    if (this.disposed) throw new SourceError('DISPOSED', 'The original DSH owner connection is closed.')
    signal?.throwIfAborted()
    const state = await waitFor(this.client.getQueuedState(owner.id, [operation.operationId]), signal)
    if (this.disposed) throw new SourceError('DISPOSED', 'The original DSH owner connection is closed.')
    signal?.throwIfAborted()
    const matches: NonNullable<SourceReceipt['ownerAdmission']>['state'][] = [
      ...state.queuedLocalIds.filter(id => id === operation.operationId).map(() => 'queued' as const),
      ...(state.dispatchingLocalIds ?? []).filter(id => id === operation.operationId).map(() => 'dispatching' as const),
      ...(state.indeterminateLocalIds ?? []).filter(id => id === operation.operationId).map(() => 'indeterminate' as const),
      ...state.invokedLocalMessages.filter(row => row.localId === operation.operationId).map(() => 'consumed' as const),
    ]
    // Missing or contradictory evidence never authorizes either handoff or replay.
    return matches.length === 1 ? { localId: operation.operationId, state: matches[0]! } : undefined
  }

  async operate(nativeId: string, operation: SourceOperation): Promise<SourceReceipt> {
    this.assertOperation(nativeId, operation)
    let session: HapiSession
    try { session = await this.ownerSession(nativeId) }
    catch (error) {
      if (error instanceof HapiRequestError && (error.status === 401 || error.status === 403)) throw new SourceError('UNSUPPORTED', 'The original DSH owner revoked this operation access.')
      if (error instanceof SourceError && ['INVALID_REQUEST', 'UNSUPPORTED'].includes(error.code)) throw error
      throw new SourceError('TARGET_UNAVAILABLE', error instanceof SourceError ? error.message : 'The original DSH owner could not be checked. Nothing was dispatched.', 'not-dispatched')
    }
    const current = toSourceSession(this.config, session)
    if (!current) throw new SourceError('INVALID_REQUEST', 'The HAPI session no longer matches this native DSH source.')
    // Retained display capabilities are not authorization to write through an
    // unavailable owner. Every control uses this fresh execution observation.
    if (sourceIsOffline(current)) throw new SourceError('TARGET_UNAVAILABLE', 'The original DSH owner is temporarily disconnected. Nothing was sent.', 'not-dispatched')
    if (operation.kind === 'send') {
      if (!operation.text?.trim()) throw new SourceError('INVALID_REQUEST', 'The source prompt is empty.')
      if (!current.capabilities.send) throw new SourceError('TARGET_UNAVAILABLE', 'The original DSH owner is inactive; it will not be resumed.', 'not-dispatched')
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
    if (!current.capabilities.approve) throw new SourceError('TARGET_UNAVAILABLE', 'The original HAPI owner cannot accept this approval now.', 'not-dispatched')
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

  async dispose(): Promise<void> { this.disposed = true; this.revoke(); await this.client.close() }
}
