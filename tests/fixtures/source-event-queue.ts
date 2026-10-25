import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { HapiEvent, HapiMessage, HapiSession } from '../../src/codex/contracts.js'
import type { HapiObservedTransport } from '../../src/hapi-agent/agent.js'
import { CodexService } from '../../src/codex/service.js'
import { HapiAgentService } from '../../src/hapi-agent/service.js'

export function cumulativeEvent(index: number, width = 512, item = 'item'): HapiEvent & { type: 'message-received' } {
  // Parse independently allocated JSON as the actual wire does. Fresh transport
  // IDs must neither prevent safe item coalescing nor become semantic identity.
  return JSON.parse(JSON.stringify({ type: 'message-received', sessionId: 'queue-source', message: {
    id: `transport-${item}-${index}`, seq: index, localId: null, createdAt: index,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: item,
      message: 'q'.repeat(index * width), nativeExecution: { threadId: 'thread', turnId: 'turn', itemId: item } } } },
  } })) as HapiEvent & { type: 'message-received' }
}
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
export async function sourceQueueFixture(kind: 'native' | 'observed') {
  const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hapi-source-queue-'))
  const listeners = new Set<(event: HapiEvent) => void | Promise<void>>()
  const source: HapiSession = { id: 'queue-source', namespace: 'fixture', seq: 1, createdAt: 1, updatedAt: 1,
    active: true, activeAt: 1, thinking: false, thinkingAt: 1, metadataVersion: 1, agentStateVersion: 1,
    metadata: { flavor: 'codex', codexNativeSession: kind === 'native', codexSessionId: 'thread',
      machineId: 'fixture-machine', path: '/fixture', name: 'Synthetic queue' },
    agentState: { requests: {}, completedRequests: {} }, model: 'fixture-model' }
  const transport: HapiObservedTransport = { hubId: 'queue-fixture',
    async request() { throw new Error('Unsupported read-only fixture route') },
    async listSessions() { return [structuredClone(source)] }, async getSession() { return structuredClone(source) },
    async readMessages() { return { messages: [] as HapiMessage[], page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
      nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } } },
    async getQueuedState() { return { queuedLocalIds: [], invokedLocalMessages: [] } },
    async sendMessage() { throw new Error('Read-only fixture') }, async abortSession() { throw new Error('Read-only fixture') },
    async cancelQueuedMessage() { throw new Error('Read-only fixture') }, async steerQueuedMessage() { throw new Error('Read-only fixture') },
    async retryIndeterminateMessage() { throw new Error('Read-only fixture') },
    async approve() { throw new Error('Read-only fixture') }, async deny() { throw new Error('Read-only fixture') },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime)
  let service!: CodexService | HapiAgentService
  await ctx.plugin(Object.assign(async (owner: Context) => {
    service = kind === 'native' ? new CodexService(owner, transport, { stateDirectory: directory })
      : new HapiAgentService(owner, transport, { stateDirectory: directory })
    await service.start()
  }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
  const agent = service.byHapiSession(source.id)
  if (!agent) {
    const failures = [...service.failures().values()].join('; ')
    await service.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true })
    throw new Error(`Synthetic source did not attach: ${failures}`)
  }
  return { service, agent, source, transport,
    emit(event: HapiEvent): void | Promise<void> {
      const pressure = [...listeners].map(listener => listener(event)).filter(Boolean)
      if (pressure.length) return Promise.all(pressure).then(() => {})
    },
    async close() { await service.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) },
  }
}
