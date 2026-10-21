/** Real React and official shortcut resolution; explicit source API doubles. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { effectiveShortcuts, initialShortcutConfig, type ShortcutCommandId, type ShortcutDocument } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutFixedInput } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { HapiRemoteApi } from '../src/client-api.ts'
import { downloadSourceFile, guardedPathAction, sourceOpenShortcutMatches, sourcePathAddress } from '../src/client/source-path-actions.tsx'

const source = { engine: 'codex', hapiSessionId: 'source-thread', hubId: 'real-hub', machineId: 'linux' }

test('source controls never mount Host path openers; ordinary DSH retains its original component and face', () => {
    let mounted = 0
    const official = (props: { absolutePath?: string; marker?: string }) => { mounted++; return createElement('button', null, `${props.marker}:${props.absolutePath}`) }
    const api = { nativeDocument: async () => { throw new Error('Downloads require an explicit click') } }
    const render = (kind: 'document' | 'directory' | 'delivery', projection: unknown, catalogProjection: unknown = null, known = true, sessionId = 'display') => {
        const Component = guardedPathAction(official, kind, api, key => key)
        return renderToStaticMarkup(createElement(Component, { sessionId, absolutePath: '/same/name.txt', marker: 'original-face',
            useSessions: (select: (value: unknown) => unknown) => select({ byId: known ? { [sessionId]: { projectionValues: { hapi: catalogProjection } } } : {} }),
            useProjection: (key: string) => key === 'hapi' ? projection : null } as never))
    }
    assert.match(render('document', null), /original-face:\/same\/name.txt/)
    assert.equal(mounted, 1)
    assert.match(render('document', source), /sourceDownload/)
    assert.equal(render('directory', source), '')
    assert.equal(render('delivery', source), '')
    assert.equal(render('document', { engine: 'codex' }), '', 'An incomplete source address cannot fall through to the Host')
    assert.equal(render('directory', null, source), '', 'Catalog source identity protects the projection hydration interval')
    assert.match(render('document', null, source), /sourceDownload/)
    assert.equal(render('directory', null, null, false), '', 'An unknown/departing Session cannot open a Host path')
    for (const id of [`hapi-codex-${'a'.repeat(32)}`, `hapi-observed-${'b'.repeat(32)}-r2`, `hapi-codex-${'c'.repeat(32)}-child-${'d'.repeat(24)}`]) {
        assert.equal(render('directory', null, null, true, id), '', 'Reserved source displays cannot mount Host openers while both projections rehydrate')
        assert.equal(render('document', null, null, true, id), '', 'Unknown source addresses cannot invent a download or fall back to Host paths')
    }
    assert.equal(mounted, 1)
    assert.deepEqual(sourcePathAddress({ ownership: 'hapi-runner', ...source, sidechain: { scopeId: 'child' } }), { sourceSessionId: 'source-thread', sourceHubId: 'real-hub', machineId: 'linux' })
})

test('downloads carry exact source identity and path, use authenticated bytes, and reject an external URL', async () => {
    const requests: unknown[] = [], fetches: Array<[string, RequestInit | undefined]> = []
    let downloadUrl = '/hapi-dsh/workbench/document?source=opaque'
    const api: Pick<HapiRemoteApi, 'nativeDocument'> = { nativeDocument: async request => {
        requests.push(request)
        return { ok: true, value: { document: request.document, fileName: 'name.txt', mimeType: 'text/plain', size: 6, writable: true, text: null, downloadUrl, officePreview: false } }
    } }
    const fetcher: typeof fetch = async (input, init) => { fetches.push([String(input), init]); return new Response('SOURCE') }
    const result = await downloadSourceFile(api, sourcePathAddress(source)!, '/same/name.txt', 'https://hub.test/dsh/', fetcher)
    assert.equal(await result.blob.text(), 'SOURCE')
    assert.equal(result.fileName, 'name.txt')
    assert.deepEqual(requests, [{ source: { sourceSessionId: 'source-thread', sourceHubId: 'real-hub', machineId: 'linux' }, document: { kind: 'file', path: '/same/name.txt', machineId: 'linux' } }])
    assert.equal(fetches[0]?.[0], 'https://hub.test/hapi-dsh/workbench/document?source=opaque')
    assert.equal(fetches[0]?.[1]?.credentials, 'same-origin')
    assert.equal(fetches[0]?.[1]?.redirect, 'error')
    downloadUrl = 'https://other.test/private-file'
    await assert.rejects(downloadSourceFile(api, sourcePathAddress(source)!, '/same/name.txt', 'https://hub.test/', fetcher), /authenticated Host/)
    assert.equal(fetches.length, 1)
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
