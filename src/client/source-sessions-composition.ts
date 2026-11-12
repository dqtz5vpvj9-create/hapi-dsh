import type { EntryOptions, Loader } from '@deepseek-ai/cordis-plugin-loader'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from './source-sessions-provider.ts'
import { waitForCatalogSession } from './catalog-readiness.ts'
import { COMMAND_DIRECTORY_CONSUMER, COMMAND_DIRECTORY_REALM } from './command-directory-provider.ts'

/** Named realms belong to each Loader instance, so separate Host graphs share
 * this configuration label without sharing a service or Context symbol. */
export const SOURCE_SESSIONS_REALM = 'hapi-dsh:source-sessions'

/** Official Client rows that resolve sessions and can see a source display. */
export const SOURCE_SESSION_CONSUMERS = [
  'hapi-dsh',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-open-in-app',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-schedule',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-user-questions',
] as const

const consumers = new Set<string>(SOURCE_SESSION_CONSUMERS)

/** Compose public entry options before the official Loader starts a consumer.
 * ClientEntries keeps ownership of initial creation, later sync and HMR.
 * HHPI owns startup navigation even for paired ordinary DSH graphs. Only
 * graphs carrying its source provider join the facade service realms. */
export function sourceSessionsLoader(OfficialLoader: typeof Loader, sourceFacade = true): typeof Loader {
  return class SourceSessionsLoader extends OfficialLoader {
    override create(options: Omit<EntryOptions, 'id'>, parent: string | null = null, position = Infinity): Promise<string> {
      const selected = sourceFacade && options.name === COMMAND_DIRECTORY_CONSUMER
        ? { ...options, isolate: { ...options.isolate, 'remote.commands': COMMAND_DIRECTORY_REALM } }
        : options
      const managed = selected.name === '@deepseek-ai/dsh-client-ui-workspace'
        ? { ...selected, config: { ...selected.config, restoreSelection: false } }
        : selected
      return super.create(sourceFacade && consumers.has(managed.name)
        ? { ...managed, isolate: { ...managed.isolate, sessions: SOURCE_SESSIONS_REALM } }
        : managed, parent, position)
    }
  }
}

/** Join the same public service realm as the official Session consumers. The
 * graph root keeps the original owner for the facade provider and transport. */
export async function sourceSessionsContext(ctx: Context): Promise<Context> {
  const entries = [...ctx.loader.entries()]
  const sample = entries.find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-session')
    ?? entries.find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-conversation')
  if (!sample) throw new Error('No official Session consumer is loaded for the source facade')
  // Options are visible before an async import finishes. Refresh establishes
  // the consumer's realm without waiting for its sessions injection to resolve.
  await sample.refresh()
  const symbol = sample.context[Context.isolate].sessions
  if (!symbol) throw new Error('The Loader did not establish Session isolation')
  return ctx.isolate('sessions', symbol)
}

/** Navigation and the Workspace consumer wait for the same source facade;
 * the root sessions service remains the original official owner. */
export function sourceInitialNavigation(ctx: Context, sessionId: SessionId, signal: AbortSignal, ready: () => void, sourceFacade = true): Fiber {
  return ctx.inject(['uiWorkspace', sourceFacade ? 'hapiSourceSessions' : 'sessions'], async owner => {
    await waitForCatalogSession(sourceFacade ? owner.hapiSourceSessions : owner.sessions, sessionId, signal)
    owner.uiWorkspace.openSession(sessionId)
    ready()
  })
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { hapiWorkspaceOpening: unknown }
}

/** Prepare an exact foreground source when its real provider becomes ready,
 * without holding the official whole-roster activation barrier. The eventual
 * Pane retains this same provider/binding before releasing the preparation. */
export function prepareSourceSession(ctx: Context, demand: {
  current(): SessionId | undefined
  subscribe(listener: () => void): () => void
}, signal: AbortSignal): { release(id: SessionId): void; dispose(): void } {
  let disposed = false, desired: SessionId | undefined, handedOff: SessionId | undefined
  let request: AbortController | undefined
  let reference: import('@deepseek-ai/dsh-api-session-controller/client').SessionReference | undefined
  const clear = (): void => { request?.abort(); request = undefined; reference?.release(); reference = undefined }
  let provider: Context['hhpiSessions'] | undefined
  const update = (): void => {
    const next = demand.current()
    if (disposed || signal.aborted || next === desired) return
    clear(); desired = next; handedOff = undefined
    start()
  }
  const start = (): void => {
    if (disposed || signal.aborted || !provider || !desired || handedOff === desired || request) return
    const id = desired, sessions = provider, lifetime = request = new AbortController()
    const currentSignal = AbortSignal.any([signal, lifetime.signal])
    // Do not return this read promise from a Cordis service activation callback:
    // a slow source read must not become another all-plugin startup barrier.
    void (async () => {
      await waitForCatalogSession(sessions, id, currentSignal)
      if (disposed || currentSignal.aborted || desired !== id || handedOff === id) return
      const retained = sessions.retain(id, { source: 'hapiWorkspaceOpening', signal: currentSignal })
      if (disposed || currentSignal.aborted || desired !== id || handedOff === id) {
        retained.release(); void retained.ready.catch(() => {}); return
      }
      reference = retained
      await retained.ready
    })().catch(() => {
      if (request !== lifetime) return
      clear()
      // The normal Pane owns visible read errors and explicit retry.
    })
  }
  const scope = ctx.inject(['hhpiSessions'], owner => {
    provider = owner.hhpiSessions; start()
    return () => { provider = undefined; clear() }
  })
  const unsubscribe = demand.subscribe(update)
  const result = {
    release(id: SessionId): void {
      if (desired !== id) return
      handedOff = id; clear()
    },
    dispose(): void {
      if (disposed) return
      disposed = true; clear(); unsubscribe(); signal.removeEventListener('abort', result.dispose)
      void scope.dispose()
    },
  }
  signal.addEventListener('abort', result.dispose, { once: true })
  update()
  return result
}
