/** Real public Cordis/Loader isolation; only the two namespace owners are fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { installNativeQuestionProvider, NATIVE_QUESTION_CONSUMER, NATIVE_QUESTION_REALM } from '../src/client/native-question-provider.ts'
import { sourceSessionsLoader } from '../src/client/source-sessions-composition.ts'

test('official question UI routes source answers to the retained source owner and leaves ordinary DSH calls unchanged', async () => {
  const ctx = new Context(), ordinary: unknown[][] = [], native: unknown[][] = []
  await ctx.plugin(sourceSessionsLoader(Loader))
  class Remote extends Service { constructor(owner: Context) { super(owner, 'remote') } }
  await ctx.plugin(Remote)
  ctx.reflect.provide('remote.userQuestions', {
    answer: async (...args: unknown[]) => { ordinary.push(args); return { ok: true as const, value: true } },
    attachWait: (...args: unknown[]) => { ordinary.push(args); return { dispose() {} } },
  } as unknown as Context['remote']['userQuestions'])
  const source = 'hhpi:fixture:source:codex:thread' as SessionId
  ctx.reflect.provide('hhpiSessions', { binding: (id: SessionId) => id === source ? { session: {
    answerQuestion: async (...args: unknown[]) => { native.push(args); return true },
  } } : undefined } as unknown as Context['hhpiSessions'])
  const consumers: Context[] = []
  ctx.loader.internal = { version: 'client', import: () => ({ inject: ['remote', 'remote.userQuestions'], apply(owner: Context) { consumers.push(owner) } }) } as unknown as NonNullable<Loader['internal']>
  const stop = await installNativeQuestionProvider(ctx)
  try {
    const entry = ctx.loader.resolve(await ctx.loader.create({ name: NATIVE_QUESTION_CONSUMER }))
    await entry.fiber
    const consumer = consumers.at(-1)!, callId = 'question-revision' as ToolCallId, answer = { answers: [{ id: 'question', selected: ['Blue'] }] }
    assert.equal(entry.options.isolate?.['remote.userQuestions'], NATIVE_QUESTION_REALM)
    assert.notEqual(consumer.remote.userQuestions, ctx.remote.userQuestions)
    assert.deepEqual(await consumer.remote.userQuestions.answer(source, callId, answer), { ok: true, value: true })
    assert.deepEqual(native, [[callId, answer]]); assert.equal(ordinary.length, 0)
    await consumer.remote.userQuestions.answer('ordinary' as SessionId, callId, answer)
    assert.deepEqual(ordinary, [['ordinary', callId, answer]])
    await assert.rejects(consumer.remote.userQuestions.answer('hhpi:fixture:source:codex:removed' as SessionId, callId, answer), /no longer retained/)
    assert.equal(ordinary.length, 1, 'an unknown source never falls through to the DSH Agent owner')
    assert.throws(() => consumer.remote.userQuestions.attachWait(source, callId), /no DSH foreground wait/)
  } finally { await stop(); await ctx.fiber.dispose() }
})
