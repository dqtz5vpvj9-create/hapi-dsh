import type { EntryOptions, Loader } from '@deepseek-ai/cordis-plugin-loader'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from './source-sessions.ts'
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
 * ClientEntries keeps ownership of initial creation, later sync and HMR. */
export function sourceSessionsLoader(OfficialLoader: typeof Loader): typeof Loader {
  return class SourceSessionsLoader extends OfficialLoader {
    override create(options: Omit<EntryOptions, 'id'>, parent: string | null = null, position = Infinity): Promise<string> {
      const selected = options.name === COMMAND_DIRECTORY_CONSUMER
        ? { ...options, isolate: { ...options.isolate, 'remote.commands': COMMAND_DIRECTORY_REALM } }
        : options
      return super.create(consumers.has(selected.name)
        ? { ...selected, isolate: { ...selected.isolate, sessions: SOURCE_SESSIONS_REALM } }
        : selected, parent, position)
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
