import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import { WorkspacePaneProvider, useWorkspacePane } from '../src/client/surface/pane-context.tsx'

/** Only the navigation capability is synthetic; React context propagation is real. */
function navigation(paneId: string, opened: string[]): WorkspacePaneNavigation {
    return { paneId, openSession: (sessionId: string) => { opened.push(`${paneId}:${sessionId}`) } } as WorkspacePaneNavigation
}

test('shared session trees keep originating pane callbacks after another pane receives focus', () => {
    const opened: string[] = []
    const alpha = navigation('alpha', opened), beta = navigation('beta', opened)
    let focused = alpha, fallbacks = 0
    const ctx = { get: () => { fallbacks++; return focused } } as Pick<Context, 'get'>
    const callbacks = new Map<string, () => void>()
    function Action({ name }: { name: string }) {
        const pane = useWorkspacePane(ctx)
        callbacks.set(name, () => pane?.openSession(`${name}-successor`))
        return createElement('span', null, pane?.paneId)
    }
    const output = renderToStaticMarkup(createElement(Fragment, null,
        createElement(WorkspacePaneProvider, { value: alpha }, createElement(Action, { name: 'first' })),
        createElement(WorkspacePaneProvider, { value: beta }, createElement(Action, { name: 'second' })),
    ))
    assert.equal(output, '<span>alpha</span><span>beta</span>')
    focused = beta
    callbacks.get('first')!()
    callbacks.get('second')!()
    assert.deepEqual(opened, ['alpha:first-successor', 'beta:second-successor'])
    assert.equal(fallbacks, 0, 'shared trees never consult the mutable graph-wide pane')
})

test('nested session trees resolve the nearest pane and isolated graphs retain their own fallback', () => {
    const opened: string[] = []
    const outer = navigation('outer', opened), inner = navigation('inner', opened), legacy = navigation('legacy', opened)
    const ctx = { get: () => legacy } as Pick<Context, 'get'>
    function Identity() { return createElement('span', null, useWorkspacePane(ctx)?.paneId ?? 'root') }
    const output = renderToStaticMarkup(createElement(Fragment, null,
        createElement(Identity),
        createElement(WorkspacePaneProvider, { value: outer },
            createElement(Identity),
            createElement(WorkspacePaneProvider, { value: inner }, createElement(Identity)),
            createElement(Identity)),
        createElement(Identity),
    ))
    assert.equal(output, '<span>legacy</span><span>outer</span><span>inner</span><span>outer</span><span>legacy</span>')
})

test('ordinary root chrome has no invented pane identity', () => {
    const ctx = { get: () => undefined } as Pick<Context, 'get'>
    function Identity() { return createElement('span', null, useWorkspacePane(ctx)?.paneId ?? 'root') }
    assert.equal(renderToStaticMarkup(createElement(Identity)), '<span>root</span>')
})
