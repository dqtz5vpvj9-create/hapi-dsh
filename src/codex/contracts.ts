/**
 * The subset of HAPI's public Hub contract consumed by the Codex adapter.
 * Source: HAPI 0f8ef697, shared/src/{schemas,apiTypes,sessionSummary}.ts.
 * Native message bodies stay unknown until the projector validates them.
 */
export interface HapiNativeRuntime {
  owner: string
  generation: string
  sequence: number
  status: 'active' | 'idle' | 'notLoaded' | 'systemError' | 'disconnected'
  waitingOn: Array<'approval' | 'input'>
  compacting?: boolean
  turnId: string | null
  startedAt: number | null
  completedAt: number | null
}

export interface HapiMetadata {
  path: string
  host?: string
  name?: string
  summary?: { text: string; updatedAt?: number }
  machineId?: string
  flavor?: string | null
  codexSessionId?: string
  codexStoreId?: string
  codexHome?: string
  codexHomeId?: string
  codexProvider?: string
  codexModel?: string
  codexNativeSession?: boolean
  codexNativeConnection?: 'attached' | 'history'
  codexSourceSessionId?: string
  codexParentThreadId?: string
  forkedFrom?: string
  lifecycleState?: string
  migrationInProgress?: { id: string; sourceHome: string; targetHome: string; startedAt: number }
}

export interface HapiApprovalRequest {
  tool: string
  toolCallId?: string
  blocking?: boolean
  arguments: unknown
  createdAt?: number | null
}

export type HapiApprovalDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort'
export type HapiInputAnswers = Record<string, string[]> | Record<string, { answers: string[] }>

export interface HapiApprovalAnswer {
  decision?: HapiApprovalDecision
  mode?: string
  allowTools?: string[]
  answers?: HapiInputAnswers
}

export interface HapiCompletedRequest extends HapiApprovalRequest, HapiApprovalAnswer {
  completedAt?: number | null
  status: 'canceled' | 'denied' | 'approved' | 'resolved'
  reason?: string
}

export interface HapiAgentState {
  requests?: Record<string, HapiApprovalRequest> | null
  completedRequests?: Record<string, HapiCompletedRequest> | null
  steeringActive?: boolean | null
  codexPlanProposalId?: string | null
}

export interface HapiSessionSummary {
  id: string
  active: boolean
  thinking: boolean
  activeAt: number
  updatedAt: number
  metadata: HapiMetadata | null
  metadataVersion: number
  agentStateVersion: number
  model?: string | null
  modelReasoningEffort?: string | null
  permissionMode?: string
  collaborationMode?: 'default' | 'plan'
  serviceTier?: string | null
  execution?: HapiNativeRuntime | null
  executionVersion?: number
}

export interface HapiSession extends HapiSessionSummary {
  namespace: string
  seq: number
  createdAt: number
  thinkingAt: number
  agentState: HapiAgentState | null
  activeTurnStartedAt?: number | null
}

export interface HapiMessage {
  id: string
  seq: number | null
  localId: string | null
  content: unknown
  createdAt: number
  invokedAt?: number | null
  scheduledAt?: number | null
  deliveryState?: 'dispatching' | 'indeterminate'
  steered?: boolean
}

export interface HapiMessagesQuery {
  limit?: number
  beforeAt?: number
  beforeSeq?: number
  afterAt?: number
  afterSeq?: number
  untilAt?: number
  untilSeq?: number
  epoch?: number
  bounded?: boolean
}

export interface HapiMessagesPage {
  messages: HapiMessage[]
  page: {
    direction: 'latest' | 'before' | 'after'
    limit: number
    epoch: number
    reset: boolean
    nextBeforeSeq: number | null
    nextBeforeAt: number | null
    nextAfterSeq: number | null
    nextAfterAt: number | null
    snapshotHeadSeq: number | null
    snapshotHeadAt: number | null
    hasMore: boolean
  }
}

/** File paths are runner paths produced by HAPI uploads, never local DSH paths. */
export interface HapiAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  path: string
  previewUrl?: string
}

/** Authorized native item resource, as published by HAPI's ChatContentPart. */
export interface HapiArtifactRef {
  id: string
  fileName: string
  mimeType: string
  size?: number
  label?: string
  externalUrl?: string
}

export interface HapiSendMessage {
  text: string
  localId: string
  deliveryMode: 'queue' | 'steer'
  attachments?: HapiAttachment[]
  scheduledAt?: number | null
}

export interface HapiQueuedState {
  queuedLocalIds: string[]
  indeterminateLocalIds?: string[]
  dispatchingLocalIds?: string[]
  invokedLocalMessages: Array<{ localId: string; invokedAt: number }>
}

export type HapiCancelResult =
  | { status: 'cancelled'; localId: string | null }
  | { status: 'invoked'; message: HapiMessage }
  | { status: 'busy'; localId: string }

export type HapiSteerResult =
  | { status: 'steered'; localId: string }
  | { status: 'invoked'; message: HapiMessage }
  | { status: 'failed'; error: string; localId: string | null }

export type HapiRetryResult =
  | { status: 'retried'; localId: string }
  | { status: 'already-queued'; localId: string | null }
  | { status: 'retry-unavailable'; localId: string }
  | { status: 'invoked'; message: HapiMessage }
  | { status: 'not-found' }

/**
 * Relevant Hub SSE notifications. Session patches intentionally act as
 * invalidations: getSession supplies the atomically versioned source facts.
 * A gap requires REST reconciliation; an SSE transport must never fabricate
 * a completed turn or replay a mutating request when reconnecting.
 */
export type HapiEvent =
  | { type: 'session-added' | 'session-updated' | 'session-removed' | 'session-ended' | 'message-updated' | 'scheduled-matured'; sessionId: string }
  | { type: 'message-received'; sessionId: string; message: HapiMessage }
  | { type: 'messages-invalidated'; sessionId: string; reason?: 'rewind' | 'native-history'; truncateFromLocalId?: string }
  | { type: 'messages-consumed'; sessionId: string; localIds: string[]; invokedAt: number; steered?: boolean }
  | { type: 'messages-indeterminate' | 'messages-dispatching' | 'messages-requeued'; sessionId: string; localIds: string[] }
  | { type: 'message-cancelled'; sessionId: string; messageId: string; localId?: string }
  | { type: 'connection-changed'; data?: { status: string; subscriptionId?: string; resume?: 'ok' | 'gap' } }

export interface HapiTransport {
  /** Stable configured Hub identity, independent of a changing URL or token. */
  readonly hubId: string
  listSessions(): Promise<readonly HapiSessionSummary[]>
  getSession(sessionId: string): Promise<HapiSession>
  /** This very same REST route reads native history for codexNativeSession. */
  readMessages(sessionId: string, query?: HapiMessagesQuery): Promise<HapiMessagesPage>
  /** One dispatch only. A successful response means accepted, not invoked. */
  sendMessage(sessionId: string, message: HapiSendMessage): Promise<void>
  getQueuedState(sessionId: string, localIds: string[]): Promise<HapiQueuedState>
  cancelQueuedMessage(sessionId: string, messageId: string): Promise<HapiCancelResult>
  steerQueuedMessage(sessionId: string, messageId: string): Promise<HapiSteerResult>
  /** Explicit user resolution of a source-native indeterminate queue row. */
  retryIndeterminateMessage(sessionId: string, messageId: string): Promise<HapiRetryResult>
  abortSession(sessionId: string): Promise<void>
  /** An answer is a candidate; only completedRequests is final resolution. */
  approve(sessionId: string, requestId: string, answer: HapiApprovalAnswer): Promise<void>
  deny(sessionId: string, requestId: string, answer?: HapiApprovalAnswer): Promise<void>
  subscribe(listener: (event: HapiEvent) => void): () => void
}

/** Only an explicit HTTP rejection can prove that a mutation was rejected. */
export class HapiRequestError extends Error {
  override readonly name = 'HapiRequestError'
  constructor(
    message: string,
    readonly outcome: 'rejected' | 'indeterminate',
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
  }
}
