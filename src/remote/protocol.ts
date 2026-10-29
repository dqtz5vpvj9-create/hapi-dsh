/** Browser-safe HHPI source contracts. DSH sources continue using native federation. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface SourceEntry { type: 'event'; event: SessionEvent }
export interface SourceCapabilities {
  send: boolean; steer: boolean; cancel: boolean; approve: boolean; files: boolean
}
export interface SourceApproval {
  id: string; method: string; turnId: string | null; itemId: string | null
  params: Record<string, unknown>
}
export interface SourceSession {
  id: string; sourceId: string; machineId: string; engine: string; nativeId: string
  title: string; cwd: string; updatedAt: number; status: 'idle' | 'running' | 'waiting' | 'offline'
  activeTurnId: string | null; capabilities: SourceCapabilities; pendingRequests: SourceApproval[]
}
export interface SourceReadRequest {
  sessionId: string; before?: number; after?: number; limit?: number; epoch?: string
}
export interface SourcePage {
  session: SourceSession; epoch: string; version: number; entries: SourceEntry[]
  /** Exclusive source event boundaries. Context entries do not move these cursors. */
  before: number | null; after: number | null; hasBefore: boolean; hasAfter: boolean
  /** Stable lifecycle/tool dependencies outside the requested interval. */
  context: number[]
}
export interface SourceChanges {
  session: SourceSession; epoch: string; base: number; version: number; reset: boolean
  upserts: SourceEntry[]; removed: number[]
}
export interface SourceChangesRequest { sessionId: string; epoch: string; version: number }
export interface SourceOperation {
  sessionId: string; operationId: string; kind: 'send' | 'steer' | 'cancel' | 'approve'
  text?: string; turnId?: string; requestId?: string
  decision?: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
}
export interface SourceReceipt {
  operationId: string; sessionId: string; status: 'accepted' | 'rejected' | 'indeterminate'
  message: string; turnId?: string
}
export interface SourceResourceRequest { sessionId: string; path: string }
export interface SourceResource { encoding: 'base64'; content: string; mimeType: string }

/** Other engines implement their own native read and operation boundaries. */
export interface SourceAdapter {
  readonly id: string
  list(): Promise<SourceSession[]>
  read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage>
  changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges>
  operate(request: SourceOperation): Promise<SourceReceipt>
  readResource?(request: SourceResourceRequest, signal?: AbortSignal): Promise<SourceResource>
  dispose(): void | Promise<void>
}

export interface DirectCodexConfig {
  id: string; machineId: string; endpoint?: string; command?: string; args?: string[]
  cwd?: string; codexHome?: string
}
