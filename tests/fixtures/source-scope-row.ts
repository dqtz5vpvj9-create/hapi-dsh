import type { HapiMessage } from '../../src/codex/contracts.js'

/** Fresh Hub transport IDs, one stable child stream, independently decoded payloads. */
export function sourceScopeRow(index: number, width: number, kind: 'agent-run' | 'sdk'): HapiMessage {
  const id = 'codex:child:turn:item:agent_message', text = 'x'.repeat(index * width)
  const data = kind === 'agent-run'
    ? { type: 'agent-run-trace', agentId: 'child', cardId: 'card', id,
      message: { type: 'message', id, message: text, streamSnapshot: true } }
    : { type: 'assistant', uuid: `sdk-${index}`, parentToolUseId: 'task-child', isSidechain: true,
      message: { content: [{ type: 'text', text }] } }
  return JSON.parse(JSON.stringify({ id: `fresh-row-${index}`, seq: index, createdAt: index,
    localId: kind === 'agent-run' ? `hapi:codex-text-snapshot:${JSON.stringify(['child', 'card', id])}` : null,
    content: { role: 'agent', content: { type: kind === 'agent-run' ? 'codex' : 'output', data } } })) as HapiMessage
}
