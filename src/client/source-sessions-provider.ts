/**
 * Pre-UI client composition for the public source-session facade.
 *
 * This is a separate client graph row (own package manifest) so it activates
 * independently of the HAPI client and of the official UI consumers. It
 * isolates only the `sessions` service for every consumer that renders or
 * addresses a Session, installs one facade provider in that realm, and
 * exposes the same facade to the HAPI client through `hapiSourceSessions`.
 *
 * One-time boot composition: no per-pane teardown, remount, or upstream edit.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Loader, Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { SourceSessions } from './source-sessions.ts'
import { RemoteSessions } from './remote-sessions.ts'
import { HHPI_REMOTE } from '../hhpi-api.ts'
import { SOURCE_SESSION_CONSUMERS, SOURCE_SESSIONS_REALM, sourceSessionsContext } from './source-sessions-composition.ts'
import { installCommandDirectoryProvider } from './command-directory-provider.ts'

function diagnosticMark(name: string): void {
  try { performance.clearMarks(name); performance.mark(name) } catch { /* diagnostics are optional */ }
}


export const name = 'hapi-dsh-session-provider'
export const inject = ['loader']

const REQUIRED = ['hapi-dsh', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation'] as const

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
  const stopCommands = await installCommandDirectoryProvider(ctx)
  const label = SOURCE_SESSIONS_REALM
  const consumers = new Set<string>(SOURCE_SESSION_CONSUMERS)
  const prior = new Map<Entry, Record<string, true | string> | null>()
  const remember = (entry: Entry): void => {
    if (!prior.has(entry)) prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null)
  }
  // The official Loader calls this public waterfall after importing a row
  // and before creating its fiber. Register before waiting for the original
  // sessions service, so later consumers never activate in the owner realm.
  const stopHook = ctx.on('loader/patch-context', (entry, next) => {
    if (consumers.has(entry.options.name) && entry.options.isolate?.sessions !== label) {
      remember(entry)
      entry.options.isolate = isolation(entry, label)
    }
    next()
  }, { prepend: true })
  let originalOwner: Fiber | undefined
  let released = false
  const restore = async (): Promise<void> => {
    const current = new Set(ctx.loader.entries())
    for (const [entry, isolate] of prior) {
      if (!current.has(entry) || entry.options.isolate?.sessions !== label) continue
      await entry.update({ isolate: isolate && Object.keys(isolate).length ? isolate : null })
    }
  }
  try {
    const entries = await waitForEntries(ctx.loader, 10_000)
    diagnosticMark('hapi-dsh:provider:entries')
    // Entry imports are concurrent in the primary shell. A row whose fiber
    // already exists missed our hook; move it through the public update path.
    // Pending imports will pass through the hook before their first fiber.
    await Promise.all([...entries.values()].map(async entry => {
      if (!entry.fiber || entry.options.isolate?.sessions === label) return
      remember(entry)
      await entry.update({ isolate: isolation(entry, label) })
    }))
    diagnosticMark('hapi-dsh:provider:isolated')
    originalOwner = ctx.inject(['sessions', 'remote'], async owner => {
      // Install HHPI independently of HAPI. The official DSH Session owner
      // keeps native execution and leases; HHPI adds only source-owned views.
      const unmountHhpi = await owner.remote.$mount(HHPI_REMOTE)
      const remote = new RemoteSessions(owner, owner.sessions, owner.remote.hhpi)
      const facade = new SourceSessions(remote)
      let provider: Fiber | undefined
      let unprovideRemote: (() => void) | undefined
      try {
        const scope = await sourceSessionsContext(owner)
        provider = scope.plugin({ name: 'hapi-source-sessions-provider', apply(providerContext: Context) {
          providerContext.reflect.provide('sessions', facade)
          // G4 compatibility probe: count real session-provider registrations
          // when the sampler installed the counter. Absent in production.
          const probe = Reflect.get(globalThis, '__hapiDshG4Probe') as { providers?: number } | undefined
          if (probe !== undefined) probe.providers = (probe.providers ?? 0) + 1
        } })
        await provider
        owner.reflect.provide('hapiSourceSessions', facade)
        unprovideRemote = owner.reflect.provide('hhpiSessions', remote)
        diagnosticMark('hapi-dsh:provider:ready')
      } catch (error) {
        unprovideRemote?.()
        await provider?.dispose()
        facade.dispose()
        remote.dispose()
        await unmountHhpi?.()
        throw error
      }
      return async () => {
        unprovideRemote?.()
        await provider?.dispose()
        facade.dispose()
        remote.dispose()
        await unmountHhpi?.()
      }
    })
    await originalOwner
  } catch (error) {
    stopHook()
    await stopCommands()
    await originalOwner?.dispose()
    await restore()
    throw error
  }
  return async () => {
    if (released) return
    released = true
    stopHook()
    await stopCommands()
    await originalOwner?.dispose()
    await restore()
  }
}
