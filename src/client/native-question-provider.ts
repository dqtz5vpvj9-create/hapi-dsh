/** Official question UI namespace adapter; ordinary DSH calls retain their owner. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { isSourceSessionId } from '../remote/protocol.ts'
import type {} from './source-sessions-provider.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
export const NATIVE_QUESTION_CONSUMER = '@deepseek-ai/dsh-client-ui-user-questions'
export const NATIVE_QUESTION_REALM = 'hhpi:native-questions'
const service = 'remote.userQuestions'

export async function installNativeQuestionProvider(ctx: Context): Promise<() => Promise<void>> {
  const providers = new Map<symbol, Fiber>()
  const prior = new Map<Entry, Record<string, true | string> | null>()
  let stopped = false
  const isolate = (entry: Entry): void => {
    if (entry.options.isolate?.[service] === NATIVE_QUESTION_REALM) return
    if (!prior.has(entry)) prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null)
    entry.options.isolate = { ...entry.options.isolate, [service]: NATIVE_QUESTION_REALM }
  }
  const provide = (entry: Entry): void => {
    const symbol = entry.context[Context.isolate][service]
    if (stopped || !symbol || providers.has(symbol)) return
    providers.set(symbol, ctx.inject(['remote', service, 'hhpiSessions'], async owner => {
      const original = owner.remote.userQuestions
      const provider = owner.isolate(service, symbol).plugin({ name: 'hhpi-native-questions', apply(scope: Context) {
        scope.reflect.provide(service, {
          answer: async (sessionId, callId, answer) => {
            if (!isSourceSessionId(sessionId)) return original.answer(sessionId, callId, answer)
            const binding = owner.hhpiSessions.binding(sessionId)
            if (!binding) throw new Error('The original native question Session is no longer retained.')
            const value = await (binding.session as RemoteSourceSession).answerQuestion(callId, answer)
            return { ok: true as const, value }
          },
          attachWait: (sessionId, callId, signal) => {
            if (isSourceSessionId(sessionId)) throw new Error('Native async questions have no DSH foreground wait.')
            return original.attachWait(sessionId, callId, signal)
          },
        } satisfies typeof original)
      } })
      await provider
      return async () => { await provider.dispose() }
    }))
  }
  const stopHook = ctx.on('loader/patch-context', (entry, next) => {
    if (entry.options.name !== NATIVE_QUESTION_CONSUMER) { next(); return }
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
      if (current.has(entry) && entry.options.isolate?.[service] === NATIVE_QUESTION_REALM) {
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
      if (entry.options.name !== NATIVE_QUESTION_CONSUMER) continue
      // A pending import will reach the hook before its first activation.
      // Do not make the source-session provider wait for that unrelated bundle.
      if (!entry.fiber) { isolate(entry); continue }
      if (entry.options.isolate?.[service] !== NATIVE_QUESTION_REALM) {
        prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null)
        await entry.update({ isolate: { ...entry.options.isolate, [service]: NATIVE_QUESTION_REALM } })
      }
      provide(entry)
    }
    return stop
  } catch (error) { await stop(); throw error }
}
