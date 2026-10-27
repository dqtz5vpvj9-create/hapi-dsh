import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export const COMMAND_DIRECTORY_CONSUMER = '@deepseek-ai/dsh-client-ui-commands'
export const COMMAND_DIRECTORY_REALM = 'hapi-dsh:command-directory'
const service = 'remote.commands'

interface Round<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function round<T>(): Round<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

interface Pending<T> {
  current: Round<T>
  started: boolean
  queued?: Round<T>
}

/** Merge reads before dispatch and reserve one subsequent read for callers
 * arriving in flight. Each caller waits at most the current and next RPC;
 * continuous invalidations never postpone an older caller until quiescence.
 * The official CommandDirectory still owns publication and its epoch guard. */
export class CommandListReads<Key, Value> {
  private readonly pending = new Map<Key, Pending<Value>>()
  private disposed = false
  constructor(private readonly pull: (key: Key) => Promise<Value>) {}

  read(key: Key): Promise<Value> {
    if (this.disposed) return Promise.reject(new Error('Command directory provider was disposed'))
    const existing = this.pending.get(key)
    if (existing) return existing.started ? (existing.queued ??= round<Value>()).promise : existing.current.promise
    const entry: Pending<Value> = { current: round<Value>(), started: false }
    this.pending.set(key, entry)
    // The pinned UI issues a pull for each synchronous registration event.
    // Dispatch after those callers can join, without a timer or cached value.
    queueMicrotask(() => { void this.run(key, entry) })
    return entry.current.promise
  }

  reset(reason = new Error('Command directory connection changed')): void {
    for (const entry of this.pending.values()) {
      entry.current.reject(reason)
      entry.queued?.reject(reason)
    }
    this.pending.clear()
  }

  dispose(): void {
    this.disposed = true
    this.reset(new Error('Command directory provider was disposed'))
  }

  private async run(key: Key, entry: Pending<Value>): Promise<void> {
    if (this.pending.get(key) !== entry) return
    entry.started = true
    try { entry.current.resolve(await this.pull(key)) }
    catch (error) { entry.current.reject(error) }
    if (this.pending.get(key) !== entry) return
    if (!entry.queued) { this.pending.delete(key); return }
    entry.current = entry.queued
    delete entry.queued
    entry.started = false
    queueMicrotask(() => { void this.run(key, entry) })
  }
}

/** Install a namespace provider only for the official command UI. The original
 * generated namespace continues to validate/transport every actual RPC, and
 * execute is delegated unchanged. Other Remote namespaces and consumers keep
 * their original owner. Each Host graph owns its own rounds and generation. */
export async function installCommandDirectoryProvider(ctx: Context): Promise<() => Promise<void>> {
  const providers = new Map<symbol, Fiber>()
  const prior = new Map<Entry, Record<string, true | string> | null>()
  let stopped = false
  const isolate = (entry: Entry): void => {
    if (entry.options.isolate?.[service] === COMMAND_DIRECTORY_REALM) return
    if (!prior.has(entry)) prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null)
    entry.options.isolate = { ...entry.options.isolate, [service]: COMMAND_DIRECTORY_REALM }
  }
  const provide = (entry: Entry): void => {
    const symbol = entry.context[Context.isolate][service]
    if (stopped || !symbol || providers.has(symbol)) return
    providers.set(symbol, ctx.inject(['remote', service], async owner => {
      const original = owner.remote.commands
      const reads = new CommandListReads(original.list.bind(original))
      owner.on('connection/reset', () => { reads.reset() })
      owner.effect(() => () => { reads.dispose() })
      const provider = owner.isolate(service, symbol).plugin({ name: 'hapi-command-directory', apply(scope: Context) {
        scope.reflect.provide(service, {
          list: (id: Parameters<typeof original.list>[0]) => reads.read(id),
          execute: (...args: Parameters<typeof original.execute>) => original.execute(...args),
        } satisfies typeof original)
      } })
      await provider
      return async () => { reads.dispose(); await provider.dispose() }
    }))
  }
  const stopHook = ctx.on('loader/patch-context', (entry, next) => {
    if (entry.options.name !== COMMAND_DIRECTORY_CONSUMER) { next(); return }
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
      if (current.has(entry) && entry.options.isolate?.[service] === COMMAND_DIRECTORY_REALM) {
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
      if (entry.options.name !== COMMAND_DIRECTORY_CONSUMER) continue
      // A pending import will reach the hook before its first activation.
      // Do not make the source-session provider wait for that unrelated bundle.
      if (!entry.fiber) { isolate(entry); continue }
      if (entry.options.isolate?.[service] !== COMMAND_DIRECTORY_REALM) {
        prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null)
        await entry.update({ isolate: { ...entry.options.isolate, [service]: COMMAND_DIRECTORY_REALM } })
      }
      provide(entry)
    }
    return stop
  } catch (error) { await stop(); throw error }
}
