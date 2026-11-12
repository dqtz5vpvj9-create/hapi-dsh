/** Internal product routing. These facts do not extend HHPI v1 or authorize a write. */
import type { CodexCapabilities } from '../remote/codex-access.ts'
import type { SourceIdentity, SourceSession } from '../remote/protocol.ts'
import { isSourceSessionId, parseSourceSessionId } from '../remote/protocol.ts'
import { sourceIsOffline } from './source-connectivity.ts'
import { isSourceDisplayId } from './source-display-id.ts'

export type SourceRoute =
  | { kind: 'local-dsh'; hostId: string; sessionId: string }
  | { kind: 'federated-dsh'; hostId: string; sessionId: string }
  | { kind: 'hhpi'; hostId: string; sessionId: string; identity: SourceIdentity }

/** The caller supplies the binding's Host, never the currently focused pane's Host. */
export function sourceRoute(hostId: string, sessionId: string, localHostId: string): SourceRoute {
  if (isSourceSessionId(sessionId)) return { kind: 'hhpi', hostId, sessionId, identity: parseSourceSessionId(sessionId) }
  if (isSourceDisplayId(sessionId)) throw new Error('Resolve the saved source identity before choosing a native provider.')
  return { kind: hostId === localHostId ? 'local-dsh' : 'federated-dsh', hostId, sessionId }
}

/** Include the authenticated connection generation; source IDs are not globally unique. */
export function sourceDirectoryKey(scope: string, generation: number, route: SourceRoute): string {
  return JSON.stringify([scope, generation, route.hostId, route.kind,
    ...(route.kind === 'hhpi' ? [route.identity.machineId, route.identity.sourceId, route.identity.engine] : [])])
}

export const nativeFeatureMethods = {
  settings: ['thread/settings/update'],
  rename: ['thread/name/set'],
  fork: ['thread/fork'],
  compact: ['thread/compact/start'],
  review: ['review/start'],
  queue: ['thread/queue/list'],
  goal: ['thread/goal/get'],
  backgroundTasks: ['thread/backgroundTerminals/list'],
  search: ['thread/search'],
  skills: ['skills/list'],
  plugins: ['plugin/list'],
  mcp: ['mcpServerStatus/list'],
} as const
export type NativeFeature = keyof typeof nativeFeatureMethods
export type SourceFeature = NativeFeature | 'create' | 'send' | 'steer' | 'cancel' | 'approve'
  | 'attachments' | 'files' | 'terminal' | 'attention' | 'sharing'
export type FeatureProvider = 'agent' | 'workspace' | 'application'
export type FeatureAvailability = 'ready' | 'discovering' | 'offline' | 'unauthorized' | 'unconfigured' | 'not-integrated' | 'unsupported'
export interface SourceFeatureState {
  provider: FeatureProvider
  /** Registration, connection and authorization remain independent facts. */
  registered: boolean | undefined
  online: boolean
  authorized: boolean | undefined
  availability: FeatureAvailability
  reason?: string
}
export interface SourceFeatureInput {
  session?: SourceSession
  online: boolean
  authorized?: boolean
  integrated: boolean
  configured?: boolean
  native?: CodexCapabilities
  create?: boolean
  /** Explicit service/official DSH registration, never inferred from attachment support. */
  registered?: boolean
}

/** No reads, resumes, fallback execution, or capability inference from unrelated operations. */
export function sourceFeature(feature: SourceFeature, input: SourceFeatureInput): SourceFeatureState {
  const provider: FeatureProvider = feature === 'files' || feature === 'terminal' ? 'workspace'
    : feature === 'attention' || feature === 'sharing' ? 'application' : 'agent'
  let registered = input.registered, unsupportedReason: string | undefined
  if (provider === 'agent' && input.session) {
    if (feature === 'attachments') registered = input.session.capabilities.files || input.session.capabilities.images === true
    else if (feature === 'send' || feature === 'steer' || feature === 'cancel' || feature === 'approve') registered = input.session.capabilities[feature]
  }
  if (feature === 'create') registered = input.create
  if (input.native && Object.hasOwn(nativeFeatureMethods, feature)) {
    const methods = nativeFeatureMethods[feature as NativeFeature]
    registered = methods.every(method => Object.hasOwn(input.native!.methods, method))
    unsupportedReason = methods.map(method => input.native!.unavailable[method]).find(Boolean)
  }
  const online = input.online && (!input.session || !sourceIsOffline(input.session))
  const facts = { provider, registered, online, authorized: input.authorized }
  if (input.authorized === false) return { ...facts, availability: 'unauthorized', reason: 'This source has not authorized this operation.' }
  if (input.configured === false) return { ...facts, availability: 'unconfigured', reason: 'Set up the service on the source machine.' }
  if (!input.integrated) return { ...facts, availability: 'not-integrated', reason: 'This workflow is not connected yet.' }
  if (!online) return { ...facts, availability: 'offline', reason: 'Reconnect to the source to continue.' }
  if (registered === false) return { ...facts, availability: 'unsupported', reason: unsupportedReason ?? 'The source does not expose this capability.' }
  if (registered === undefined || input.authorized === undefined) return { ...facts, availability: 'discovering', reason: 'Checking this source capability.' }
  return { ...facts, availability: 'ready' }
}
