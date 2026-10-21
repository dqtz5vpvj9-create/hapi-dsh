import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

/** Original package roots remain active, preserving official Client and Typert discovery. */
export const OFFICIAL_PROVIDERS = {
  'session-controller': 'sessionController',
  'workspace-files': 'workspaceFiles',
  'terminal-controller': 'terminalController',
  'file-reference-local': 'fileReferences',
  subagent: 'subagents',
} as const
export type OfficialProviderId = keyof typeof OFFICIAL_PROVIDERS

/** Package roots and routing entry points are explicit; not every API uses an api-* package. */
export const OFFICIAL_PROVIDER_PACKAGES = {
  'session-controller': '@deepseek-ai/dsh-api-session-controller',
  'workspace-files': '@deepseek-ai/dsh-api-workspace-files',
  'terminal-controller': '@deepseek-ai/dsh-api-terminal-controller',
  'file-reference-local': '@deepseek-ai/dsh-file-reference-local',
  subagent: '@deepseek-ai/dsh-subagent',
} as const satisfies Record<OfficialProviderId, string>
export const ROUTING_PROVIDERS = {
  'session-controller': 'session-controller',
  'workspace-files': 'workspace-files',
  'terminal-controller': 'terminal-controller',
  'file-reference-local': 'file-references',
  subagent: 'subagent-controller',
} as const satisfies Record<OfficialProviderId, string>

function officialEntry(ctx: Context, id: OfficialProviderId, requireActive = true): Entry {
  const matches = [...ctx.loader.entries()].filter(entry => entry.options.id === id
    && entry.options.name === OFFICIAL_PROVIDER_PACKAGES[id])
  const entry = matches[0]
  if (matches.length !== 1 || !entry || entry.disabled || (requireActive && !entry.fiber) || !entry.realm
    || entry.options.isolate?.[OFFICIAL_PROVIDERS[id]] !== true) {
    throw new Error(`The official ${id} delegate is unavailable; the profile must retain its active isolated package-root entry`)
  }
  return entry
}

/**
 * Registration-time readiness scope. A routing plugin may wait with public
 * Context.inject for the original isolated service before publishing itself.
 * Merely finding this scope does not claim that the original provider is live.
 */
export function officialProviderScope(ctx: Context, id: OfficialProviderId): Context {
  const entry = officialEntry(ctx, id, false)
  const service = OFFICIAL_PROVIDERS[id]
  return ctx.isolate(service, entry.realm.access(service))
}

/**
 * Derive from the current call Context, never from the Loader entry Context:
 * Gateway Invocation, peer grants and stream uplink stay attached to the call.
 * The symbol comes from Cordis' public entry-local isolation realm.
 * Resolve the service with Context.get(): property access may select the
 * current provider fiber's tracked service instead of the requested realm.
 */
export function officialProviderContext(ctx: Context, id: OfficialProviderId): Context {
  const entry = officialEntry(ctx, id)
  const service = OFFICIAL_PROVIDERS[id]
  return ctx.isolate(service, entry.realm.access(service))
}

/** The original active plugin owns validation and existing user configuration. */
export function officialProviderConfig(ctx: Context, id: OfficialProviderId): unknown {
  return officialEntry(ctx, id).fiber!.config
}
