import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteSourceSession } from '../../src/client/remote-sessions.ts'
import { NativeQuestionHistoryActions } from '../../src/client/source-transcript.tsx'
import { questionItemId, sourceQuestionCallId } from '../../src/shared/native-async-questions.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives)

test('the original history message reopens its question without submitting an answer', async () => {
  const user = userEvent.setup(), reveal = vi.fn(() => true)
  const question = { id: questionItemId('item', 0), itemId: 'item', turnId: 'turn', method: 'request_user_input_async',
    params: { index: 0, revision: 5, question: { title: 'Choose a route' } } }
  const metadata = { nativeId: 'native', pendingRequests: [question] }
  const session = { metadata: { subscribe: () => () => {}, getSnapshot: () => metadata } } as unknown as RemoteSourceSession
  const ctx = { locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh-CN' }) },
    get: () => ({ reveal }) } as unknown as Context
  const sessionId = 'hhpi:machine:source:codex:native' as SessionId
  const view = render(<NativeQuestionHistoryActions ctx={ctx} sessionId={sessionId} session={session} messageId="codex:native:turn:item" />)
  await user.click(screen.getByRole('button', { name: '回答问题' }))
  expect(reveal).toHaveBeenCalledOnce()
  expect(reveal).toHaveBeenCalledWith(sessionId, sourceQuestionCallId(question))
  view.rerender(<NativeQuestionHistoryActions ctx={ctx} sessionId={sessionId} session={session} messageId="codex:native:turn:another" />)
  expect(screen.queryByRole('button')).toBeNull()
})
