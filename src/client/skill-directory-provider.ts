import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { isSourceSessionId } from '../remote/protocol.ts'
export const SKILL_DIRECTORY_CONSUMER = '@deepseek-ai/dsh-client-ui-skill'
export const SKILL_DIRECTORY_REALM = 'hhpi:skill-directory'
const service = 'remote.skills'

export async function installSkillDirectoryProvider(ctx: Context): Promise<() => Promise<void>> {
  const providers = new Map<symbol, Fiber>()
  const prior = new Map<Entry, Record<string, true | string> | null>()
  let stopped = false
  const isolate = (entry: Entry): void => {
    if (entry.options.isolate?.[service] === SKILL_DIRECTORY_REALM) return
    if (!prior.has(entry)) prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null)
    entry.options.isolate = { ...entry.options.isolate, [service]: SKILL_DIRECTORY_REALM }
  }
  const provide = (entry: Entry): void => {
    const symbol = entry.context[Context.isolate][service]
    if (stopped || !symbol || providers.has(symbol)) return
    providers.set(symbol, ctx.inject(['remote', service], async owner => {
      const original = owner.remote.skills
      const provider = owner.isolate(service, symbol).plugin({ name: 'hhpi-skill-directory', apply(scope: Context) {
        scope.reflect.provide(service, {
          // DSH skill tokens have a different owner and serialization contract.
          // HHPI native command sources register alongside this unchanged UI.
          list: (request: Parameters<typeof original.list>[0], signal?: AbortSignal) => isSourceSessionId(request.sessionId)
            ? Promise.resolve({ ok: true as const, value: { skills: [] } })
            : original.list(request, signal),
        } satisfies typeof original)
      } })
      await provider
      return async () => { await provider.dispose() }
    }))
  }
  const stopHook = ctx.on('loader/patch-context', (entry, next) => {
    if (entry.options.name !== SKILL_DIRECTORY_CONSUMER) { next(); return }
    isolate(entry)
    next()
    provide(entry)
  }, { prepend: true })
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    stopHook()
    await Promise.all([...providers.values()].map(provider => provider.dispose()))
    const current = new Set(ctx.loader.entries())
    for (const [entry, isolation] of prior) {
      if (current.has(entry) && entry.options.isolate?.[service] === SKILL_DIRECTORY_REALM) {
        if (!entry.fiber) {
          if (isolation) entry.options.isolate = isolation
          else delete entry.options.isolate
          continue
        }
        await entry.update({ isolate: isolation && Object.keys(isolation).length ? isolation : null })
      }
    }
  }
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name !== SKILL_DIRECTORY_CONSUMER) continue
      // A pending import will reach the hook before its first activation.
      // Do not make the source-session provider wait for that unrelated bundle.
      if (!entry.fiber) { isolate(entry); continue }
      if (entry.options.isolate?.[service] !== SKILL_DIRECTORY_REALM) {
        prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null)
        await entry.update({ isolate: { ...entry.options.isolate, [service]: SKILL_DIRECTORY_REALM } })
      }
      provide(entry)
    }
    return stop
  } catch (error) { await stop(); throw error }
}
