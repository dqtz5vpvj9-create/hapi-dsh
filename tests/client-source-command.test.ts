/** Synthetic source records exercise presentation only; no source execution or browser is used. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import { installSourceCommandViews } from '../src/client/source-command-view.tsx'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sourceCommandModel, sourceToolSummary, sourceShellBlock, sourceToolBlocks } from '../src/client/source-command-model.ts'

test('source shell aliases render the registered official component and leave specialized providers intact', () => {
    const slots = new SlotCore()
    const root = slots.register({ name: 'root', children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } } as never, (() => null) as never)
    const Official = (props: ToolCallViewProps) => createElement('span', { 'data-official-bash': props.toolName }, props.block.args.text('command'))
    const native = slots.register({ name: 'tool.call.toolview', key: 'bash', locale: 'conversation' } as never, Official as never)
    const facade = { register: slots.register.bind(slots), subscribe: slots.subscribe.bind(slots), entriesOfSlot: slots.entriesOfSlot.bind(slots),
        inject: (_name: string, install: () => () => void) => install() }
    const stop = installSourceCommandViews({ slots: facade } as unknown as Context)
    const alias = slots.entriesOfSlot('tool.call.toolview').find(entry => entry.options.key === 'CodexBash')!
    assert.ok(alias); assert.equal(alias.locale, 'conversation')
    const html = renderToStaticMarkup(createElement(alias.component as ComponentType<ToolCallViewProps>,
        { phase: 'start', block: call({ cmd: 'pwd' }), toolName: 'CodexBash' } as ToolCallViewProps))
    assert.equal(html, '<span data-official-bash="bash">pwd</span>')
    const Specialized = () => null
    const remove = slots.register({ name: 'tool.call.toolview', key: 'CodexBash', priority: 0 } as never, Specialized as never)
    assert.equal(slots.entriesOfSlot('tool.call.toolview').find(entry => entry.options.key === 'CodexBash')!.component, Specialized)
    stop(); remove(); native(); root()
})

test('source shell calls adapt to official Bash data without rewriting the original record', () => {
    const original = call({ command: ['/bin/bash', '-lc', 'printf hello'], cwd: '/work', description: 'Read greeting' })
    const before = JSON.stringify(original), adapted = sourceShellBlock(original)
    assert.equal(adapted.name, 'bash')
    assert.equal(adapted.args.text('command'), 'printf hello')
    assert.equal(adapted.args.text('description'), 'Read greeting')
    assert.equal(adapted.args.text('workdir'), '/work')
    assert.equal(JSON.stringify(original), before)
})

test('official shell exit markers reflect real source codes and missing codes stay unknown', () => {
    const adapted = sourceShellBlock(result({ cmd: 'check' }, { output: 'failure details', exit_code: 2 }, true)) as ToolResultNode
    assert.equal(adapted.call?.name, 'bash')
    assert.deepEqual(adapted.content, [{ type: 'text', text: 'failure details\n[exit code: 2]' }])
    const unknown = sourceShellBlock(result({ cmd: 'check' }, 'unknown process status')) as ToolResultNode
    assert.deepEqual(unknown.content, [{ type: 'text', text: 'unknown process status' }])
    assert.equal(unknown.args.text('description'), undefined)
})

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


test('PowerShell summaries unwrap only a recognized command invocation', () => {
    assert.equal(sourceCommandModel(call({ command: ['C:\\Windows\\pwsh.exe', '-NoProfile', '-Command', 'Get-Item .'] })).command, 'Get-Item .')
    assert.equal(sourceCommandModel(call({ command: 'pwsh -NoLogo -NoProfile -c Get-Item .' })).command, 'Get-Item .')
    assert.equal(sourceCommandModel(call({ command: 'other -c preserve' })).command, 'other -c preserve')
})

test('patch and file aliases retain source errors and never fabricate an applied diff', () => {
    const original = { ...result({ changes: { '/a.ts': { old_string: 'a', new_string: 'b' }, '/b.ts': {} } }, 'denied', true), name: 'CodexPatch' }
    const before = JSON.stringify(original), blocks = sourceToolBlocks(original, 'edit')
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]!.args.text('file_path'), '/a.ts')
    assert.equal(blocks[0]!.args.text('new_string'), 'b')
    assert.equal((blocks[0] as ToolResultNode).isError, true)
    assert.deepEqual((blocks[0] as ToolResultNode).content, original.content)
    assert.equal((blocks[0] as ToolResultNode).meta, original.meta)
    assert.equal(JSON.stringify(original), before)
    const edits = sourceToolBlocks({ ...call({ file_path: '/a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }), name: 'MultiEdit' }, 'edit')
    assert.equal(edits[1]!.args.text('file_path'), '/a')
    assert.equal(edits[1]!.args.text('new_string'), 'd')
    assert.equal(sourceToolBlocks({ ...call({ path: '/read' }), name: 'read_file' }, 'read')[0]!.args.text('file_path'), '/read')
})
