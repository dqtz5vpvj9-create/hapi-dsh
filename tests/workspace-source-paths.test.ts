/** Real React/routing and official shortcuts; source API and Button presentation are explicit boundaries. */
import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { effectiveShortcuts, initialShortcutConfig, type ShortcutCommandId, type ShortcutDocument } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutFixedInput } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SourceFileClient } from '../src/client/source-workspace-provider.ts'
import { fileContext } from './source-file-context-fixture.ts'
import { deferred } from './source-file-mutation-fixture.ts'
type Actions = typeof import('../src/client/source-path-actions.tsx')
let downloadSourceFile: Actions['downloadSourceFile'], guardedPathAction: Actions['guardedPathAction'], sourceOpenShortcutMatches: Actions['sourceOpenShortcutMatches']
before(async () => {
    const root = resolve(import.meta.dirname, '..'), module = { exports: {} as Actions }
    const result = await build({ entryPoints: [resolve(root, 'src/client/source-path-actions.tsx')],
        alias: { '@deepseek-ai/dsh-client-ui-primitives': resolve(root, 'tests/fixtures/source-path-primitives.tsx') },
        bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
    new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports)
    ;({ downloadSourceFile, guardedPathAction, sourceOpenShortcutMatches } = module.exports)
})

const source = fileContext()

test('canonical source controls never mount Host openers while ordinary DSH retains its original component and face', () => {
    let mounted = 0
    const official = (props: { absolutePath?: string; marker?: string }) => { mounted++; return createElement('button', null, `${props.marker}:${props.absolutePath}`) }
    const client: SourceFileClient = { async resolve() { throw new Error('Downloads require an explicit click') } }
    const render = (kind: 'document' | 'directory' | 'delivery', sessionId = 'ordinary-session') => {
        const Component = guardedPathAction(official, kind, client, key => key)
        return renderToStaticMarkup(createElement(Component, { sessionId, absolutePath: '/same/name.txt', marker: 'original-face' } as never))
    }
    assert.match(render('document'), /original-face:\/same\/name.txt/)
    assert.equal(mounted, 1)
    assert.match(render('document', source.owner.binding.target.sessionId), /sourceDownload/)
    assert.equal(render('directory', source.owner.binding.target.sessionId), '')
    assert.equal(render('delivery', source.owner.binding.target.sessionId), '')
    assert.equal(render('directory', 'hhpi:malformed'), '', 'An incomplete source address cannot fall through to Host paths')
    for (const id of [`hapi-codex-${'a'.repeat(32)}`, `hapi-observed-${'b'.repeat(32)}-r2`, `hapi-codex-${'c'.repeat(32)}-child-${'d'.repeat(24)}`]) {
        assert.equal(render('directory', id), ''); assert.equal(render('document', id), '')
    }
    assert.equal(mounted, 1)
})

test('downloads use the exact authenticated source binary service and refuse a resolver for another session', async () => {
    const requests: unknown[] = [], sessionId = source.owner.binding.target.sessionId
    source.services.files.readBytes = async (path, options, access) => {
        requests.push({ path, options, scope: access.scope }); await access.assertAllowed(source.owner.binding.target, 'read')
        return { absolutePath: '/same/name.txt', version: 'opaque:version', bytes: 6, offset: 0, data: new TextEncoder().encode('SOURCE'), eof: true }
    }
    const client: SourceFileClient = { async resolve(id) { requests.push(id); return source } }
    const result = await downloadSourceFile(client, sessionId, '/same/name.txt')
    assert.equal(await result.blob.text(), 'SOURCE'); assert.equal(result.fileName, 'name.txt')
    assert.deepEqual(requests, [sessionId, { path: '/same/name.txt', options: {}, scope: source.owner.scope }])
    await assert.rejects(downloadSourceFile(client, 'another-session', '/same/name.txt'), /another source session/)
    assert.equal(requests.length, 3)
})

test('cancelled downloads never accept a late binary response', async () => {
    const context = fileContext(), controller = new AbortController(), entered = deferred<void>(), release = deferred<void>()
    context.services.files.readBytes = async () => { entered.resolve(); await release.promise; return { absolutePath: '/source/file', version: 'opaque', offset: 0, data: new Uint8Array([1]), eof: true } }
    const promise = downloadSourceFile({ async resolve() { return context } }, context.owner.binding.target.sessionId, '/source/file', controller.signal)
    await entered.promise; controller.abort(); release.resolve(); await assert.rejects(promise, { name: 'AbortError' })
})

test('source open-local guard follows official remapped shortcuts without intercepting other commands or input', () => {
    const definitions = [{ id: 'workspace.openLocal' as ShortcutCommandId, defaults: { 'web:windows': { code: 'KeyO', modifiers: ['primary', 'shift'] as const } } }]
    let document: ShortcutDocument = { schemaVersion: 2, profiles: {} }
    const shortcuts = {
        catalog: { getSnapshot: () => effectiveShortcuts(definitions, document, 'web', 'windows').map(row => ({ ...row, label: 'Open', aliases: [], keys: [], aria: undefined })), subscribe: () => () => {} },
        config: { getSnapshot: () => ({ ...initialShortcutConfig(), document, status: 'ready' as const }), subscribe: () => () => {} },
    }
    const input: Extract<ShortcutFixedInput, { type: 'keydown' }> = { type: 'keydown', gesture: { code: 'KeyO', control: true, alt: false, shift: true, meta: false, repeat: false, composing: false, defaultPrevented: false }, context: { region: 'editable', modal: null, target: null }, consume() {} }
    assert.equal(sourceOpenShortcutMatches(shortcuts, input), true)
    assert.equal(sourceOpenShortcutMatches(shortcuts, { ...input, gesture: { ...input.gesture, code: 'KeyP' } }), false)
    assert.equal(sourceOpenShortcutMatches(shortcuts, { ...input, context: { ...input.context, region: 'terminal' } }), false)
    document = { schemaVersion: 2, profiles: { 'web:windows': { 'workspace.openLocal': { code: 'KeyL', modifiers: ['control', 'shift'] } } } }
    assert.equal(sourceOpenShortcutMatches(shortcuts, input), false)
    assert.equal(sourceOpenShortcutMatches(shortcuts, { ...input, gesture: { ...input.gesture, code: 'KeyL' } }), true)
    document = { schemaVersion: 2, profiles: { 'web:windows': { 'workspace.openLocal': null } } }
    assert.equal(sourceOpenShortcutMatches(shortcuts, input), false)
})
