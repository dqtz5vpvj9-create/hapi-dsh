/** Local presentation choices never settle or write a native question. */
import type { SourceApproval, SourceEntry, SourceSession } from '../remote/protocol.ts'
import { sourceQuestion, sourceQuestionCallId } from '../shared/native-async-questions.ts'
import type { SourceStorage } from './remote-storage.ts'

export const nativeQuestionPresentationPrefix = 'hhpi:question-presentation:v1:'

/** Native history message identity contains the thread, turn and item identities. */
export function nativeMessageIdentity(id: unknown, nativeId: string): { turnId: string; itemId: string } | undefined {
  if (typeof id !== 'string') return
  const parts = id.split(':')
  if (parts.length !== 4 || parts[0] !== 'codex') return
  try { return decodeURIComponent(parts[1]!) === nativeId ? { turnId: decodeURIComponent(parts[2]!), itemId: decodeURIComponent(parts[3]!) } : undefined } catch { return }
}
export function nativeMessageTurn(entry: SourceEntry, nativeId: string): string | undefined {
  const event = entry.event
  const id = event.type === 'assistant/message' ? event.data.message.id : event.type === 'user/message' ? event.data.id : undefined
  return nativeMessageIdentity(id, nativeId)?.turnId
}

export function automaticQuestion(session: SourceSession, latestTurn: string | undefined): SourceApproval | undefined {
  const turn = session.activeTurnId ?? latestTurn
  if (!turn) return
  const questions = session.pendingRequests.filter(request => request.turnId === turn && sourceQuestion(request))
  const itemId = questions.at(-1)?.itemId
  if (!itemId) return
  return questions.filter(request => request.itemId === itemId)
    .sort((a, b) => Number(a.params.index) - Number(b.params.index))[0]
}

export interface NativeQuestionHead {
  turnId?: string | undefined
  lastUserSeq: number
  positions: ReadonlyMap<string, number>
}

function presentationKey(request: SourceApproval): string | undefined {
  const question = sourceQuestion(request)
  return question && JSON.stringify([request.id, question.question, question.options?.map(option => option.label) ?? []])
}

export class NativeQuestionPresentation {
  private readonly dismissed = new Map<string, Set<string>>()
  constructor(private readonly access: () => SourceStorage | undefined) {}
  private key(sessionId: string, scope: string): string { return `${nativeQuestionPresentationPrefix}${scope}:${encodeURIComponent(sessionId)}` }
  private entries(sessionId: string): Set<string> {
    const existing = this.dismissed.get(sessionId)
    if (existing) return existing
    const saved = new Set<string>(), access = this.access()
    if (access) try {
      const value: unknown = JSON.parse(access.storage.getItem(this.key(sessionId, access.scope)) ?? '[]')
      if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') saved.add(id)
    } catch { /* Optional local state must not prevent the conversation opening. */ }
    this.dismissed.set(sessionId, saved)
    return saved
  }
  isVisible(session: SourceSession, head: NativeQuestionHead, callId: string): boolean {
    const question = automaticQuestion(session, head.turnId)
    const position = question?.itemId ? head.positions.get(question.itemId) : undefined
    const key = question && presentationKey(question)
    return !!question && !!key && position !== undefined && position > head.lastUserSeq
      && sourceQuestionCallId(question) === callId && !this.entries(session.id).has(key)
  }
  dismiss(session: SourceSession, callId: string): void {
    const request = session.pendingRequests.find(row => sourceQuestionCallId(row) === callId)
    const key = request && presentationKey(request)
    if (!key) return
    const entries = this.entries(session.id)
    entries.add(key)
    while (entries.size > 2000) entries.delete(entries.values().next().value!)
    const access = this.access()
    if (access) try { access.storage.setItem(this.key(session.id, access.scope), JSON.stringify([...entries])) } catch { /* Memory still preserves this view's decision. */ }
  }
  clear(): void { this.dismissed.clear() }
}
