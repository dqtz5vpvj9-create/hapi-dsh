import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { HapiMessage } from '../src/codex/contracts.js'
import { ObservedScopeIndex } from '../src/hapi-agent/scopes.js'

function row(id: string, seq: number, type: 'codex' | 'output', data: Record<string, unknown>): HapiMessage {
  return { id, seq, localId: null, createdAt: seq, content: { role: 'agent', content: { type, data } } }
}

test('derived scope facts preserve exact SDK prompts, tool-result errors and terminal records', () => {
  const call = row('call', 1, 'output', { type: 'assistant', uuid: 'call', message: { content: [
    { type: 'tool_use', id: 'task', name: 'Agent:research', input: { prompt: 'first\n\nsecond', description: 'Research' } },
  ] } })
  const user = row('user', 2, 'output', { type: 'user', uuid: 'user', isSidechain: true,
    message: { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } })
  const answer = row('answer', 3, 'output', { type: 'assistant', uuid: 'answer', parentUuid: 'user', isSidechain: true,
    message: { content: [{ type: 'text', text: 'Only the transcript owns this answer' }] } })
  const result = row('result', 4, 'output', { type: 'user', uuid: 'result', message: { content: [
    { type: 'tool_result', tool_use_id: 'task', is_error: true, content: [{ type: 'text', text: 'failed' }, { type: 'text', text: 'details' }] },
    { type: 'tool_result', tool_use_id: 'unrelated-shell', content: 'Not a subagent completion' },
  ] } })
  const index = new ObservedScopeIndex(); index.update([call, user, answer, result], true)
  assert.deepEqual(index.forRow(answer), { scopeId: 'sdk-tool:task', parentToolCallId: 'task' })
  assert.equal(index.scopes()[0]?.label, 'Research')
  assert.equal(index.scopes()[0]?.status, 'error')
  assert.deepEqual(index.completionsForRow(result).map(({ scopeId, parentToolCallId, key, reason, error }) => ({ scopeId, parentToolCallId, key, reason, error })), [{ scopeId: 'sdk-tool:task', parentToolCallId: 'task',
    key: 'sdk-end:task:result', reason: 'error', error: 'failed\n\ndetails' }])
  const done = row('done', 5, 'output', { type: 'system', subtype: 'turn_duration', uuid: 'done', parentToolUseId: 'another-task' })
  const failed = row('failed', 6, 'output', { type: 'result', uuid: 'failed', parentToolUseId: 'third-task', is_error: true })
  index.update([done, failed])
  assert.equal(index.scopes().find(scope => scope.scopeId === 'sdk-tool:another-task')?.status, 'completed')
  assert.equal(index.scopes().find(scope => scope.scopeId === 'sdk-tool:third-task')?.status, 'error')
})

test('derived agent facts preserve card aliases, nested lineage and terminal protection during cleanup', () => {
  const rows = [
    row('parent', 1, 'codex', { type: 'agent-run-start', agentId: 'parent', status: 'running' }),
    row('card', 2, 'codex', { type: 'agent-run-start', card_id: 'child-card', status: 'pending' }),
    row('child', 3, 'codex', { type: 'agent-run-update', agent_id: 'child', card_id: 'child-card',
      scope: { parentThreadId: 'parent' }, nickname: 'Named child', status: 'running' }),
    row('completed', 4, 'codex', { type: 'agent-run-update', agentId: 'child', id: 'completion', status: 'completed', error: 'Source annotation' }),
    row('wait', 5, 'codex', { type: 'agent-run-update', agentId: 'child', status: 'running', activity_kind: 'wait_agent' }),
    row('closed', 6, 'codex', { type: 'agent-run-update', agentId: 'child', status: 'canceled', activityKind: 'canceled',
      status_text: 'Closed', result: { previousStatus: { status: 'completed', transcript: 'Not needed for scope ownership' } } }),
  ]
  const index = new ObservedScopeIndex(); index.update(rows, true)
  assert.equal(index.forRow(rows[1]!).scopeId, 'run:child')
  assert.deepEqual(index.scopes().find(scope => scope.scopeId === 'run:child'), {
    scopeId: 'run:child', parentToolCallId: null, kind: 'agent-run', parentScopeId: 'run:parent', sourceAgentId: 'child',
    label: 'Named child', status: 'completed', createdAt: 2, updatedAt: 6,
  })
  assert.deepEqual(index.completionsForRow(rows[3]!), [{ scopeId: 'run:child', parentToolCallId: null,
    key: 'run-end:run:child:completion', reason: 'completed', error: 'Source annotation' }])
  assert.deepEqual(index.completionsForRow(rows[5]!), [])
  const failure = row('failure', 7, 'codex', { type: 'agent-run-update', agentId: 'child', status: 'failed',
    activityKind: 'close_agent', summary: 'The source failed during cleanup' })
  index.update([failure])
  assert.equal(index.scopes().find(scope => scope.scopeId === 'run:child')?.status, 'error')
  assert.equal(index.completionsForRow(failure)[0]?.error, 'The source failed during cleanup')
})

interface MemorySample { mode: string; snapshots: number; finalTextBytes: number; cumulativeTextBytes: number; growthBytes: number }
test('fresh child snapshot IDs retain scope metadata without cumulative transcript bodies', { timeout: 30_000 }, t => {
  const samples: MemorySample[] = []
  for (const snapshots of [512, 1024]) for (const mode of ['raw-control', 'agent-run', 'sdk']) {
    const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx',
      fileURLToPath(new URL('./fixtures/source-scope-memory.ts', import.meta.url)), mode, String(snapshots)],
    { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, `${mode}: ${result.error?.message ?? result.stderr}`)
    samples.push(JSON.parse(result.stdout) as MemorySample)
  }
  t.diagnostic(JSON.stringify(samples))
  const controls = samples.filter(sample => sample.mode === 'raw-control')
  assert.ok(controls[1]!.growthBytes > 200 * 1024 * 1024, 'negative control must retain the cumulative source snapshots')
  assert.ok(controls[1]!.growthBytes > 2.5 * controls[0]!.growthBytes, 'doubling snapshots exposes superlinear raw-payload retention')
  for (const sample of samples.filter(value => value.mode !== 'raw-control')) {
    const budget = 4 * 1024 * 1024 + sample.snapshots * 2048
    assert.ok(sample.growthBytes < budget, `${sample.mode} retained ${sample.growthBytes} bytes; scope metadata budget ${budget}`)
  }
})
