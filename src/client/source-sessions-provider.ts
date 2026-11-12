import type {} from '@deepseek-ai/dsh-api-session-controller/client'
/**
 * Pre-UI client composition for the public source-session facade.
 *
 * This is a separate client graph row (own package manifest) so it activates
 * independently of the HAPI client and of the official UI consumers. It
 * isolates only the `sessions` service for every consumer that renders or
 * addresses a Session, installs one facade provider in that realm, and
 * exposes the same provider through the existing `hapiSourceSessions` service key.
 *
 * One-time boot composition: no per-pane teardown, remount, or upstream edit.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Loader, Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteSessions } from './remote-sessions.ts'
import { browserSourceStorage } from './remote-storage.ts'
import { HAPI_DSH_REMOTE } from '../shared/client-remote.ts'
import { SOURCE_SESSION_CONSUMERS, SOURCE_SESSIONS_REALM, sourceSessionsContext } from './source-sessions-composition.ts'
import { installNativeQuestionProvider } from './native-question-provider.ts'
import { installCommandDirectoryProvider } from './command-directory-provider.ts'
import { installSourceTerminalProvider } from './source-terminal-provider.ts'
import { installSourceWorkspaceFilesProvider } from './source-workspace-provider.ts'
import { createSourceFileClient } from './source-workspace-client.ts'

function diagnosticMark(name: string): void {
  try { performance.clearMarks(name); performance.mark(name) } catch { /* diagnostics are optional */ }
}


declare module '@deepseek-ai/cordis' { interface Context { hapiSourceSessions: RemoteSessions } }

export const name = 'hapi-dsh-session-provider'
export const inject = ['loader']

// Files/Document/Terminal panes omit the workspace shell but still need the
// source identity and resource providers before their official consumers boot.
const REQUIRED = ['@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation'] as const

function waitForEntries(loader: Loader, timeoutMs: number): Promise<Map<string, Entry>> {
  const wanted = new Set<string>(SOURCE_SESSION_CONSUMERS)
  const deadline = Date.now() + timeoutMs
  return new Promise(resolve => {
    const read = (): Map<string, Entry> => new Map([...loader.entries()]
      .filter(entry => wanted.has(entry.options.name))
      .map(entry => [entry.options.name, entry]))
    const check = (): boolean => {
      const found = read()
      if (REQUIRED.every(name => found.has(name))) { resolve(found); return true }
      if (Date.now() >= deadline) { resolve(found); return true }
      return false
    }
    if (check()) return
    const timer = setInterval(() => { if (check()) clearInterval(timer) }, 20)
  })
}

function isolation(entry: Entry, label: string): Record<string, true | string> {
  return { ...(entry.options.isolate ?? {}), sessions: label }
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  diagnosticMark('hapi-dsh:provider:start')
  const label = SOURCE_SESSIONS_REALM
  const consumers = new Set<string>(SOURCE_SESSION_CONSUMERS)
  const prior = new Map<Entry, { isolate: Record<string, true | string> | null; config: Entry['options']['config'] }>()
  let stopQuestions: () => Promise<void> = async () => {}
  let stopCommands: () => Promise<void> = async () => {}
  let stopFiles: () => Promise<void> = async () => {}
  let stopTerminals: () => Promise<void> = async () => {}
  const remember = (entry: Entry): void => {
    if (!prior.has(entry)) prior.set(entry, { isolate: entry.options.isolate ? { ...entry.options.isolate } : null, config: entry.options.config })
  }
  // The official Loader calls this public waterfall after importing a row
  // and before creating its fiber. Register before waiting for the original
  // sessions service, so later consumers never activate in the owner realm.
  const stopHook = ctx.on('loader/patch-context', (entry, next) => {
    const workspace = entry.options.name === '@deepseek-ai/dsh-client-ui-workspace'
    if (consumers.has(entry.options.name) && (entry.options.isolate?.sessions !== label || workspace && entry.options.config?.restoreSelection !== false)) {
      remember(entry)
      entry.options.isolate = isolation(entry, label)
      if (workspace) entry.options.config = { ...entry.options.config, restoreSelection: false }
    }
    next()
  }, { prepend: true })
  let originalOwner: Fiber | undefined
  let released = false
  const restore = async (): Promise<void> => {
    const current = new Set(ctx.loader.entries())
    for (const [entry, { isolate, config }] of prior) {
      if (!current.has(entry) || entry.options.isolate?.sessions !== label) continue
      await entry.update({ isolate: isolate && Object.keys(isolate).length ? isolate : null, config })
    }
  }
  try {
    // Install the sessions boundary synchronously before any await. On a fresh
    // workspace ui-workspace can otherwise restore its default DSH session in
    // the microtask gap while command-directory setup is still pending.
    stopQuestions = await installNativeQuestionProvider(ctx)
    stopCommands = await installCommandDirectoryProvider(ctx)
    const entries = await waitForEntries(ctx.loader, 10_000)
    diagnosticMark('hapi-dsh:provider:entries')
    // Entry imports are concurrent in the primary shell. A row whose fiber
    // already exists missed our hook; move it through the public update path.
    // Pending imports will pass through the hook before their first fiber.
    await Promise.all([...entries.values()].map(async entry => {
      const workspace = entry.options.name === '@deepseek-ai/dsh-client-ui-workspace'
      if (!entry.fiber || entry.options.isolate?.sessions === label && (!workspace || entry.options.config?.restoreSelection === false)) return
      remember(entry)
      await entry.update({ isolate: isolation(entry, label),
        ...(workspace ? { config: { ...entry.options.config, restoreSelection: false } } : {}) })
    }))
    diagnosticMark('hapi-dsh:provider:isolated')
    originalOwner = ctx.inject(['sessions', 'remote'], async owner => {
      // Install both API namespaces through one package contribution. The
      // official DSH Session owner keeps native execution and leases; source
      // sessions add the HHPI views through their one public provider.
      const unmountRemote = await owner.remote.$mount(HAPI_DSH_REMOTE)
      let remote: RemoteSessions | undefined
      let provider: Fiber | undefined
      let hhpiOwner: Fiber | undefined
      let unprovideFiles: (() => void) | undefined
      let unprovideRemote: (() => void) | undefined
      try {
        // The adapter consumes the mounted source namespace. Installing it
        // earlier can suspend an already active official terminal row while
        // that row is still waiting for this contribution to be mounted.
        stopTerminals = await installSourceTerminalProvider(ctx)
        // $mount installs the official Cordis service `remote.hhpi`. Wait on
        // that dotted service through Cordis injection instead of reading an
        // undeclared nested service from the root Remote service.
        hhpiOwner = owner.inject(['remote.hhpi', 'remote.sourceWorkspace'], async hhpiContext => {
          // Session-scoped Conversation controls resolve services through this
          // same realm; the root retains the original execution owner.
          const scope = await sourceSessionsContext(owner)
          remote = new RemoteSessions(scope, owner.sessions, hhpiContext.remote.hhpi, browserSourceStorage(), undefined, hhpiContext.remote.sourceWorkspace)
          const transport = owner.get('sourceWorkspaceTransport') ?? { hostId: 'local', fetch: globalThis.fetch.bind(globalThis) }
          unprovideFiles = owner.reflect.provide('sourceFiles', createSourceFileClient(hhpiContext.remote.sourceWorkspace, remote, transport))
          stopFiles = await installSourceWorkspaceFilesProvider(ctx)
          provider = scope.plugin({ name: 'hapi-source-sessions-provider', apply(providerContext: Context) {
            providerContext.reflect.provide('sessions', remote!)
            // G4 compatibility probe: count real session-provider registrations
            // when the sampler installed the counter. Absent in production.
            const probe = Reflect.get(globalThis, '__hapiDshG4Probe') as { providers?: number } | undefined
            if (probe !== undefined) probe.providers = (probe.providers ?? 0) + 1
          } })
          await provider
          owner.reflect.provide('hapiSourceSessions', remote)
          unprovideRemote = owner.reflect.provide('hhpiSessions', remote)
        })
        await hhpiOwner
        diagnosticMark('hapi-dsh:provider:ready')
      } catch (error) {
        unprovideFiles?.()
        unprovideRemote?.()
        await hhpiOwner?.dispose()
        await provider?.dispose()
        remote?.dispose()
        await unmountRemote?.()
        throw error
      }
      return async () => {
        unprovideFiles?.()
        unprovideRemote?.()
        await hhpiOwner?.dispose()
        await provider?.dispose()
        remote?.dispose()
        await unmountRemote?.()
      }
    })
    await originalOwner
  } catch (error) {
    stopHook()
    await stopQuestions()
    await stopCommands()
    await stopFiles()
    await stopTerminals()
    await originalOwner?.dispose()
    await restore()
    throw error
  }
  return async () => {
    if (released) return
    released = true
    stopHook()
    await stopQuestions()
    await stopCommands()
    await stopFiles()
    await stopTerminals()
    await originalOwner?.dispose()
    await restore()
  }
}
