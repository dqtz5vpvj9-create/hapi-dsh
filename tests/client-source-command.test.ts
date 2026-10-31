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
import { sourceCommandModel, sourceToolSummary, sourceShellBlock, sourceToolBlocks, sourceToolView } from '../src/client/source-command-model.ts'

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
        { phase: 'start', block: call({ cmd: 'pwd' }), toolName: 'CodexBash', t: (key: string) => key } as unknown as ToolCallViewProps))
    assert.equal(html, '<span data-official-bash="bash">pwd</span>')
    const nativeAlias = slots.entriesOfSlot('tool.call.toolview').find(entry => entry.options.key === 'codex.commandExecution')!
    assert.ok(nativeAlias, 'native HHPI Codex calls must reach the same official Bash view')
    assert.equal(renderToStaticMarkup(createElement(nativeAlias.component as ComponentType<ToolCallViewProps>,
        { phase: 'start', block: { ...call({ command: 'npm test' }), name: 'codex.commandExecution' }, toolName: 'codex.commandExecution',
            t: (key: string) => key } as unknown as ToolCallViewProps)), '<span data-official-bash="bash">npm test</span>')
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
    assert.equal(unknown.args.text('description'), 'check')
    assert.equal(JSON.parse(unknown.call!.argsRaw).description, undefined, 'Missing exit stays on the official persistent-shell result path')
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

test('serialized POSIX shell envelopes reveal their command without evaluating substitutions', () => {
    const cases = [
        ["/usr/bin/zsh -lc 'cat AGENTS.md'", 'cat AGENTS.md'],
        ['bash -c "printf \\"hello\\""', 'printf "hello"'],
        ["/bin/sh -c 'printf '\\''hello'\\'''", "printf 'hello'"],
        ["/bin/zsh -lc 'cat a; rg b src'", 'cat a; rg b src'],
    ]
    for (const [wrapped, command] of cases) assert.equal(sourceCommandModel(call({ command: wrapped })).command, command)
    for (const command of ['other -c "keep me"', '/bin/sh -c "echo $SECRET"', "/bin/sh -c 'echo one'; echo two"])
        assert.equal(sourceCommandModel(call({ command })).command, command)
})

test('source action metadata supplies compact localized titles while original commands and outputs remain available', () => {
    const command = "/usr/bin/zsh -lc 'cat src/a.ts; rg needle src'"
    const original = result({ command, command_actions: [
        { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: '/repo/src/a.ts' },
        { type: 'search', command: 'rg needle src', query: 'needle', path: 'src' },
    ] }, { stdout: 'full output', exit_code: 0 })
    const before = JSON.stringify(original)
    const adapted = sourceShellBlock(original, { read: '读取', search: '搜索', listFiles: '查找文件' }) as ToolResultNode
    assert.equal(adapted.args.text('description'), '读取 a.ts · 搜索 needle')
    assert.equal(adapted.args.text('command'), 'cat src/a.ts; rg needle src')
    assert.equal(JSON.stringify(original), before)
    assert.deepEqual(adapted.content, [{ type: 'text', text: 'full output\n[exit code: 0]' }])
    const mixed = call({ command: 'cat a; npm test', command_actions: [{ type: 'read', name: 'a' }, { type: 'unknown', command: 'npm test' }] })
    assert.equal(sourceShellBlock(mixed).args.text('description'), 'cat a; npm test', 'Do not summarize a mixed command as only reading')
    const long = sourceShellBlock(call({ command: 'rg ' + 'x'.repeat(300) }))
    assert.ok(long.args.text('description')!.length <= 120)
    assert.equal(long.args.text('command'), 'rg ' + 'x'.repeat(300))
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

test('native Codex commands preserve action summaries, full output and explicit failure state', () => {
    const original = { ...result({ command: '/bin/bash -lc \'cat src/index.ts\'', cwd: '/repo', commandActions: [
        { type: 'read', name: 'index.ts', path: '/repo/src/index.ts' },
    ] }, { aggregatedOutput: 'export const value = 1\n', exitCode: 0 }), name: 'codex.commandExecution' }
    const before = JSON.stringify(original), adapted = sourceToolBlocks(original, 'bash', { read: '读取', search: '搜索', listFiles: '查找文件' })[0] as ToolResultNode
    assert.equal(adapted.args.text('description'), '读取 index.ts')
    assert.equal(adapted.args.text('command'), 'cat src/index.ts')
    assert.equal(adapted.args.text('workdir'), '/repo')
    assert.deepEqual(adapted.content, [{ type: 'text', text: 'export const value = 1\n\n[exit code: 0]' }])
    assert.equal(adapted.callId, original.callId)
    assert.equal(JSON.stringify(original), before)
    const failed = sourceShellBlock({ ...original, isError: true }) as ToolResultNode
    assert.equal(failed.isError, true, 'A source failure with a zero exit code must not become success')
})

test('native multi-file changes use official path and diff data without changing native identity', () => {
    const changes = [
        { path: '/repo/a.ts', kind: { type: 'update' }, diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' },
        { path: '/repo/b.ts', kind: { type: 'add' }, diff: 'added' },
    ]
    const original = { ...result({ changes }, changes), name: 'codex.fileChange' }
    const before = JSON.stringify(original), adapted = sourceToolBlocks(original, 'edit') as ToolResultNode[]
    assert.equal(adapted.length, 2)
    assert.equal(sourceToolSummary(original), '/repo/a.ts, /repo/b.ts')
    assert.equal(adapted[0]!.args.text('file_path'), '/repo/a.ts')
    assert.equal(adapted[0]!.args.text('old_string'), 'old\n')
    assert.equal(adapted[0]!.args.text('new_string'), 'new\n')
    assert.deepEqual(adapted[0]!.meta, { path: '/repo/a.ts', diffs: [{ path: '/repo/a.ts', oldText: 'old\n', newText: 'new\n' }] })
    assert.deepEqual(adapted[1]!.meta, { path: '/repo/b.ts', diffs: [{ path: '/repo/b.ts', oldText: null, newText: 'added' }] })
    assert.ok(adapted.every(block => block.callId === original.callId && block.seq === original.seq))
    assert.equal(JSON.stringify(original), before)
    for (const failed of sourceToolBlocks({ ...original, isError: true }, 'edit') as ToolResultNode[]) {
        assert.equal(failed.isError, true)
        assert.equal(failed.meta, undefined, 'A declined source patch cannot acquire a successful applied diff')
        assert.deepEqual(failed.content, original.content)
    }
})

test('native edit excerpts keep all hunks and opaque or incomplete patches stay inspectable', () => {
    const diff = '@@ -1 +1 @@\n-a\n+b\n@@ -9,2 +9,2 @@\n context\n-old\n+new\n'
    const original = { ...result({ changes: [{ path: '/a.ts', kind: { type: 'update' }, diff }] }, 'source output'), name: 'codex.fileChange' }
    const adapted = sourceToolBlocks(original, 'edit')[0] as ToolResultNode
    assert.deepEqual(adapted.meta, { path: '/a.ts', diffs: [
        { path: '/a.ts', oldText: 'a\n', newText: 'b\n' },
        { path: '/a.ts', oldText: 'context\nold\n', newText: 'context\nnew\n' },
    ] })
    for (const malformed of ['opaque source patch', '@@ -1,2 +1 @@\n-old\n+new\n']) {
        const block = { ...result({ changes: [{ path: '/a.ts', diff: malformed }] }, malformed), name: 'codex.fileChange' }
        const shown = sourceToolBlocks(block, 'edit')[0] as ToolResultNode
        assert.equal(shown.meta, undefined)
        assert.equal(shown.args.text('old_string'), undefined)
        assert.equal(shown.args.text('file_path'), '/a.ts')
        assert.deepEqual(shown.content, block.content)
    }
})

test('native additions, deletions and moves use their recorded file semantics', () => {
    const content = '@@ This is literal file content\n+including patch-like prefixes\n'
    const original = { ...result({ changes: [
        { path: '/new.txt', kind: { type: 'add' }, diff: content },
        { path: '/removed.txt', kind: { type: 'delete' }, diff: content },
        { path: '/old.ts', kind: { type: 'update', move_path: '/moved.ts' }, diff: '@@ -1 +1 @@\n-a\n+b\n\nMoved to: /moved.ts' },
    ] }, 'source changes'), name: 'codex.fileChange' }
    const [added, removed, moved] = sourceToolBlocks(original, 'edit') as ToolResultNode[]
    assert.deepEqual(added!.meta, { path: '/new.txt', diffs: [{ path: '/new.txt', oldText: null, newText: content }] })
    assert.deepEqual(removed!.meta, { path: '/removed.txt', diffs: [{ path: '/removed.txt', oldText: content, newText: '' }] })
    assert.equal(moved!.args.text('file_path'), '/moved.ts', 'The official file link names the recorded move target')
    assert.deepEqual(moved!.meta, { path: '/moved.ts', diffs: [{ path: '/moved.ts', oldText: 'a\n', newText: 'b\n' }] })
})

test('Codex web and legacy image calls select official semantic titles and paths', () => {
    const search = { ...call({ query: 'quantum compiler', action: { type: 'search', queries: ['quantum compiler', 'quantum routing'] } }), name: 'codex.webSearch' }
    const adapted = sourceToolBlocks(search, 'web_search')[0] as StartedToolCall
    assert.deepEqual(JSON.parse(adapted.argsRaw).queries, ['quantum compiler', 'quantum routing'])
    const open = { ...call({ action: { type: 'openPage', url: 'https://example.com/paper' } }), name: 'codex.webSearch' }
    assert.deepEqual(sourceToolView(open, 'web_search'), { renderer: 'web_fetch', toolName: 'web_fetch' })
    assert.equal(sourceToolBlocks(open, 'web_fetch')[0]!.args.text('url'), 'https://example.com/paper')
    const image = { ...call({ path: '/repo/chart.png' }), name: 'codex.imageView' }
    assert.deepEqual(sourceToolView(image, 'read'), { renderer: 'read', toolName: 'read_image' })
    assert.equal(sourceToolBlocks(image, 'read_image')[0]!.args.text('file_path'), '/repo/chart.png')
})

test('Codex collaboration records show activity without impersonating a DSH subagent reply', () => {
    const original = { ...result({ kind: 'running', agentThreadId: 'opaque-thread', agentPath: '/root/review' }, { status: 'running' }), name: 'codex.subAgentActivity' }
    original.call = { name: original.name, argsRaw: original.call!.argsRaw }
    const shown = sourceToolBlocks(original, 'subagent', { read: 'Read', search: 'Search', listFiles: 'List files', agentActivity: () => '运行中' })[0] as ToolResultNode
    assert.equal(shown.args.text('description'), '运行中 · /root/review')
    assert.equal(shown.name, 'codex.subAgentActivity')
    assert.equal(shown.call?.name, 'codex.subAgentActivity')
    assert.equal(shown.callId, original.callId)
    assert.deepEqual(shown.content, original.content)
    const spawned = { ...call({ tool: 'spawnAgent', prompt: 'Review source rendering' }), name: 'codex.collabAgentToolCall' }
    assert.deepEqual(sourceToolView(spawned, 'subagent'), { renderer: 'subagent', toolName: 'spawn_teammate' })
})

test('dynamic and MCP rows expose actual source tools and arguments without local execution aliases', () => {
    const dynamic = { ...call({ tool: 'functions.exec_command', arguments: { cmd: 'npm test', workdir: '/repo' } }), name: 'codex.dynamicToolCall' }
    assert.deepEqual(sourceToolView(dynamic, 'subagent'), { renderer: 'bash', toolName: 'bash' })
    assert.equal(sourceToolBlocks(dynamic, 'bash')[0]!.args.text('command'), 'npm test')
    const patch = { ...call({ tool: 'apply_patch', arguments: '*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n-a\n+b\n*** End Patch' }), name: 'codex.dynamicToolCall' }
    assert.equal(sourceToolBlocks(patch, 'edit')[0]!.args.text('file_path'), '/repo/a.ts')
    const mcp = { ...call({ server: 'docs', tool: 'find', arguments: { query: 'message schema' } }), name: 'codex.mcpToolCall' }
    const before = JSON.stringify(mcp)
    assert.deepEqual(sourceToolView(mcp, 'subagent'), { renderer: 'subagent', toolName: 'docs.find' })
    const shown = sourceToolBlocks(mcp, 'docs.find')[0]!
    assert.equal(shown.args.text('query'), 'message schema')
    assert.equal(shown.name, 'codex.mcpToolCall')
    assert.equal(JSON.stringify(mcp), before)
    const output = { ...result({ tool: 'functions.exec' }, 'Original tool output'), name: 'codex.functionCallOutput' }
    assert.deepEqual(sourceToolView(output, 'subagent'), { renderer: 'subagent', toolName: 'functions.exec' })
    assert.equal(sourceToolBlocks(output, 'functions.exec')[0], output, 'Output-only records do not fabricate missing call arguments')
})
