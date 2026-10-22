/** Synthetic source records exercise presentation only; no source execution or browser is used. */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sourceCommandModel, sourceToolSummary } from '../src/client/source-command-model.ts'

function call(input: Record<string, unknown>): StartedToolCall {
    return { phase: 'start', name: 'CodexBash', callId: 'call-1', turn: 1, step: 1, time: 1, subCalls: [],
        argsRaw: JSON.stringify(input), args: { text: (key: string) => typeof input[key] === 'string' ? input[key] : undefined } as StartedToolCall['args'] }
}
function result(input: Record<string, unknown>, output: unknown, isError = false): ToolResultNode {
    const start = call(input)
    return { kind: 'tool-result', seq: 3, time: 2, callId: start.callId, name: start.name, args: start.args,
        call: { name: start.name, argsRaw: start.argsRaw }, callTime: 1, subCalls: [], isError,
        content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }] }
}

test('Codex command summaries select the command even when native thread IDs precede it', () => {
    const model = sourceCommandModel(call({ thread_id: 'native-thread', turn_id: 'native-turn', type: 'exec_command_begin',
        call_id: 'source-call', command: 'git status\nprintf done', cwd: '/workspace' }))
    assert.equal(model.command, 'git status\nprintf done')
    assert.equal(model.status, 'running')
    assert.equal(model.description, null)
    assert.ok(model.raw.includes('native-thread'), 'original fields remain available in expanded details')
})

test('shell argv and other engines cmd arguments preserve the actual command body', () => {
    assert.equal(sourceCommandModel(call({ command: ['/bin/bash', '-lc', 'printf "hello world"'] })).command, 'printf "hello world"')
    assert.equal(sourceCommandModel(call({ command: ['python', 'file with spaces.py'] })).command, 'python "file with spaces.py"')
    assert.equal(sourceCommandModel(call({ cmd: 'pwd', description: 'Current directory' })).command, 'pwd')
})

test('structured stdout, stderr and exit status remain one result even when isError is absent', () => {
    const model = sourceCommandModel(result({ command: 'run-tests' }, { stdout: 'test log', stderr: 'failure detail', exit_code: 1 }))
    assert.equal(model.output, 'test log\nfailure detail')
    assert.equal(model.exitCode, 1)
    assert.equal(model.status, 'error')
    const success = sourceCommandModel(result({ command: 'pwd' }, { output: '/workspace', exitCode: 0 }))
    assert.equal(success.output, '/workspace')
    assert.equal(success.status, 'done')
})

test('plain output and explicit source failures are preserved without invented exit codes', () => {
    const model = sourceCommandModel(result({ command: 'pwd' }, 'plain\noutput', true))
    assert.equal(model.output, 'plain\noutput')
    assert.equal(model.exitCode, null)
    assert.equal(model.status, 'error')
    const stopped = result({ command: 'sleep 60' }, '', true)
    stopped.error = { name: 'Interrupted', code: 'interrupted' }
    assert.equal(sourceCommandModel(stopped).status, 'stopped')
})

test('missing command fields never substitute transport IDs and windowless results retain output', () => {
    assert.equal(sourceCommandModel(call({ thread_id: 'native-thread', call_id: 'source-call' })).command, null)
    const windowless = result({}, 'retained result'); windowless.call = null
    assert.equal(sourceCommandModel(windowless).command, null)
    assert.equal(sourceCommandModel(windowless).output, 'retained result')
})

test('preparing calls use the public live argument reader', () => {
    const { argsRaw: _raw, ...preparing } = call({ command: 'printf' })
    const model = sourceCommandModel({ ...preparing, phase: 'preparing' })
    assert.equal(model.command, 'printf')
    assert.equal(model.status, 'preparing')
})

test('compact tools show semantic paths and patches without leaking transport IDs into summaries', () => {
    assert.equal(sourceToolSummary(call({ thread_id: 'opaque', file_path: '/repo/a.ts' })), '/repo/a.ts')
    assert.equal(sourceToolSummary(call({ changes: { '/repo/a.ts': {}, '/repo/b.ts': {} } })), '/repo/a.ts, /repo/b.ts')
    assert.equal(sourceToolSummary(call({ call_id: 'opaque' })), null)
})
