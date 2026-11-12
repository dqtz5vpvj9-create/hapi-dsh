/** Codex's nonblocking question and explicit native user-message reply contract. */
import type { AskUserQuestionItem, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { SourceApproval } from '../remote/protocol.ts'

export const NATIVE_ASYNC_QUESTION = 'request_user_input_async'
export interface NativeAsyncQuestion { title: string; options?: string[] }
export const questionItemId = (itemId: string, index: number): string => JSON.stringify([NATIVE_ASYNC_QUESTION, itemId, index])
/** Presentation identity changes with an authoritative revision, invalidating stale drafts/callbacks. */
export const sourceQuestionCallId = (request: SourceApproval): string => JSON.stringify([request.id, request.params.revision])
export function nativeAsyncQuestions(value: unknown): NativeAsyncQuestion[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 100) return
  const questions: NativeAsyncQuestion[] = []
  for (const row of value) {
    if (!row || typeof row !== 'object' || typeof row.title !== 'string' || !row.title.trim()) return
    if (row.options != null && (!Array.isArray(row.options) || row.options.some((option: unknown) => typeof option !== 'string' || !option.trim()))) return
    questions.push({ title: row.title, ...(Array.isArray(row.options) ? { options: row.options } : {}) })
  }
  return questions
}
/** Each native question has its own identity and settlement, including siblings in one call. */
export function sourceQuestion(request: SourceApproval): AskUserQuestionItem | undefined {
  if (request.method !== NATIVE_ASYNC_QUESTION || !request.itemId || !Number.isSafeInteger(request.params.index)
    || (request.params.index as number) < 0 || request.id !== questionItemId(request.itemId, request.params.index as number)) return
  const question = nativeAsyncQuestions([request.params.question])?.[0]
  return question && { id: request.id, question: question.title, ...(question.options ? { options: question.options.map(label => ({ label })) } : {}) }
}
export function nativeQuestionReply(request: SourceApproval, response: unknown): string {
  const question = sourceQuestion(request), batch = response as AskUserQuestionAnswer | undefined
  if (!question || !Array.isArray(batch?.answers) || batch.answers.length !== 1) throw new Error('Answer the original native question.')
  const answer = batch.answers[0]!
  if (answer.id !== question.id || !Array.isArray(answer.selected) || answer.selected.length > 1
    || answer.selected.some(label => typeof label !== 'string' || !question.options?.some(option => option.label === label))
    || answer.custom !== undefined && typeof answer.custom !== 'string') throw new Error('The answer does not match the original native question.')
  const text = [...answer.selected, ...(answer.custom?.trim() ? [answer.custom.trim()] : [])].join('\n')
  // The official question composer's explicit Skip is selected: [], with no
  // custom text. Codex receives that decision as an empty answer, not silence.
  return `<send_user_message_question_reply>\n${JSON.stringify([{ answer: text, question: question.question, questionItemId: question.id }])}\n</send_user_message_question_reply>`
}
export function nativeQuestionReplies(text: unknown): Array<{ questionItemId: string; question: string; answer: string }> {
  if (typeof text !== 'string') return []
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text)
  if (!match) return []
  try {
    const rows: unknown = JSON.parse(match[1]!)
    if (!Array.isArray(rows)) return []
    return rows.filter((row): row is { questionItemId: string; question: string; answer: string } => row !== null && typeof row === 'object'
      && typeof row.questionItemId === 'string' && typeof row.question === 'string' && typeof row.answer === 'string')
  } catch { return [] }
}
