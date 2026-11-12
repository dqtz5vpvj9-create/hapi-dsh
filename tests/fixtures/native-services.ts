/** Real source-directory and account operation owner; native RPC is the controlled boundary. */
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { CodexCall, CodexCallResult } from '../../src/remote/codex-access.ts'
import type { SourceSession } from '../../src/remote/protocol.ts'
import type { RemoteSourceSession } from '../../src/client/remote-sessions.ts'
import { NativeActionOwner } from '../../src/client/remote-native-actions.ts'
import { SourceDirectory } from '../../src/client/source-capabilities.ts'
import { BrowserStorage } from './browser-storage.ts'
import { WorkspaceApplicationIdentity } from '../../src/client/application-identity.ts'

export const mcpServer = (name = 'Repository service') => ({ name, authStatus: 'bearerToken', runtimeStatus: 'connected',
  tools: { search: { name: 'search', inputSchema: {} } }, resources: [], resourceTemplates: [], toolsError: null })
export function nativeServicesFixture(nativeId = 'original-thread', sourceId = 'original-source') {
  let metadata = { id: `hhpi:machine:${sourceId}:codex:${nativeId}`, sourceId, nativeId, engine: 'codex', title: 'Original coding task',
    machineId: 'machine', cwd: '/original', status: 'idle', updatedAt: 1, activeTurnId: null, pendingRequests: [],
    capabilities: { send: true, steer: false, cancel: true, approve: false, files: true },
    codex: { model: 'fixture', reasoningEffort: null, parentThreadId: null, agentNickname: null } } as SourceSession
  const calls: CodexCall[] = [], writes: CodexCall[] = [], listeners = new Set<() => void>()
  let read: (request: CodexCall, signal?: AbortSignal) => Promise<CodexCallResult> = async request => ({
    status: 'accepted', message: 'Source read accepted', result: { data: request.method === 'mcpServerStatus/list' ? [mcpServer()] : [], nextCursor: null },
  })
  const api = {
    async nativeCapabilities() { return { ok: true, value: { protocolVersion: '0.165.0', runtime: 'test-boundary',
      methods: { 'mcpServerStatus/list': 'read', 'thread/backgroundTerminals/list': 'read' }, unavailable: {} } } },
    async nativeCall(request: CodexCall, signal?: AbortSignal) { calls.push(request); return { ok: true, value: await read(request, signal) } },
  } as unknown as HhpiRemoteApi
  const directory = new SourceDirectory(api, sourceId), storage = new BrowserStorage()
  const actions = new NativeActionOwner({ async call(request) { writes.push(request); throw new Error('Unexpected native write') },
    async receipt() { throw new Error('Unexpected write receipt query') } })
  actions.setStorage({ storage, scope: `account:${nativeId}` })
  const application = new WorkspaceApplicationIdentity()
  application.set({ accountId: 'original-account', origin: 'https://fixture.invalid' }, 'device')
  const captureAccess = () => {
    const identity = application.getSnapshot()
    if (!identity) throw new Error('No authenticated account')
    return { signal: identity.signal, assertCurrent() { identity.signal.throwIfAborted() } }
  }
  const session = { sessionId: metadata.id, metadata: { getSnapshot: () => metadata,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }, nativeActions: actions,
    sourceDirectory: () => directory } as unknown as RemoteSourceSession
  return { session, api, calls, writes, actions, storage, application, captureAccess,
    onRead(next: typeof read) { read = next },
    offline() { metadata = { ...metadata, status: 'offline' }; for (const listener of listeners) listener() },
    online() { metadata = { ...metadata, status: 'idle' }; for (const listener of listeners) listener() },
    close() { application.dispose(); actions.dispose(); directory.dispose() },
  }
}
