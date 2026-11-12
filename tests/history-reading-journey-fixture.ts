/** Current native projection, RemoteSessions owner and installed official reader/Chat.
 * Source RPC is in memory. This fixture never renders browser primitives or runs an Agent. */
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { CodexHistory } from '../src/remote/codex-history.ts'
import type { NativeTurn } from '../src/remote/codex-native.ts'
import type { RemotePaneSession } from '../src/client/remote-reading-session.ts'
import { fixture } from './contracts/hhpi-reading-fixture.ts'

function turn(number: number, tools: number): NativeTurn {
  return { id: `turn-${number}`, status: 'completed', startedAt: number, completedAt: number + .5,
    items: [{ id: `question-${number}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${number}` }] },
      ...Array.from({ length: tools }, (_, index) => ({ id: `tool-${number}-${index}`, type: 'commandExecution',
        command: `cat /synthetic/file-${index}`, aggregatedOutput: `Synthetic file ${index}`, exitCode: 0 })),
      { id: `answer-${number}`, type: 'agentMessage', text: `Answer ${number}`, phase: 'final_answer' }] }
}

export async function readingJourney(t: TestContext, tailTools = 8, turnCount = 30) {
  let history!: CodexHistory
  const h = await fixture(t, { rendering: false, seed(index, session) {
    history = new CodexHistory(index)
    for (let number = 1; number <= turnCount; number++) history.acceptTurn(session, turn(number, number === turnCount ? tailTools : 8), true)
  } })
  const pane = await h.open('history-journey'), session = pane.binding.session as RemotePaneSession
  const snapshot = () => pane.reading.snapshot.getSnapshot()
  const nodes = () => {
    const value = pane.conversation.target('chat').getSnapshot()
    assert.ok(value)
    return value.order.map(key => value.nodes.get(key)!)
  }
  const nodeText = (node: ReturnType<typeof nodes>[number], text: string): boolean => {
    const data = node.data as { content?: readonly { text?: string }[]; blocks?: readonly { text?: string }[] }
    return [...(data.content ?? []), ...(data.blocks ?? [])].some(part => part.text === text)
  }
  const node = (text: string) => nodes().find(value => nodeText(value, text))
  const entries = () => snapshot().entries
  const seqs = () => new Set(entries().map(entry => entry.event.seq))
  const seq = (number: number, item: 'question' | 'answer') => {
    const value = history.locatePosition(`turn-${number}`, `${item}-${number}`)
    assert.ok(value !== undefined)
    return SessionSeq(value)
  }
  return { ...h, pane, session, snapshot, nodes, node, entries, seqs, seq, body: () => h.body(pane), bodyOfOther: h.body,
    around: (value: number) => pane.reading.read({ kind: 'around', target: { key: String(value), seq: SessionSeq(value) } }) }
}
