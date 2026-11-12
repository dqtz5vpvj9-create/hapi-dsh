/** Production menu and compact composer controls; editor verbs/source metadata are explicit boundaries. */
import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { Context } from '@deepseek-ai/cordis'
import type { SourceInputProps } from '../../src/client/composer-picker/slots.ts'
import { CompactComposerTools, ComposerSteerAction } from '../../src/client/compact-composer.tsx'
import { installWorkspaceMenus } from '../../src/client/menus.ts'
import { compactComposerStyles } from '../../src/client/compact-composer-styles.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const stop of cleanups.splice(0)) stop() })

test('portaled input, label and disabled action keep the original menu open; a real action closes it', async () => {
    cleanups.push(installWorkspaceMenus(document))
    const user = userEvent.setup()
    render(<><details id="owned-menu" className="hapi-menu" open><summary>Source actions</summary></details>
        <div data-hapi-menu-owner="owned-menu"><label>Filter<input aria-label="Filter"/></label><button disabled>Unavailable</button><button><span>Open exact source</span></button></div></>)
    const menu = document.getElementById('owned-menu') as HTMLDetailsElement
    await user.click(screen.getByRole('textbox', { name: 'Filter' })); await user.keyboard('中文 search')
    expect(menu.open).toBe(true); expect(screen.getByRole('textbox')).toHaveValue('中文 search')
    await user.click(screen.getByRole('button', { name: 'Unavailable' })); expect(menu.open).toBe(true)
    await user.click(screen.getByText('Open exact source')); expect(menu.open).toBe(false)
})

test('menu Escape returns focus, composition keeps the menu, and outside cancellation preserves ordinary disclosures', () => {
    cleanups.push(installWorkspaceMenus(document))
    render(<><details id="owned-menu" className="hapi-menu" open><summary>Source actions</summary></details>
        <div data-hapi-menu-owner="owned-menu"><input aria-label="Filter"/></div><details open><summary>Historical process</summary><p>Retained result</p></details></>)
    const menu = document.getElementById('owned-menu') as HTMLDetailsElement, filter = screen.getByRole('textbox')
    filter.focus(); fireEvent.keyDown(filter, { key: 'Escape', isComposing: true }); expect(menu.open).toBe(true)
    fireEvent.keyDown(filter, { key: 'Escape' }); expect(menu.open).toBe(false); expect(screen.getByText('Source actions')).toHaveFocus()
    menu.open = true; fireEvent.pointerDown(document.body); expect(menu.open).toBe(false)
    expect(screen.getByText('Retained result')).toBeVisible()
})

function editorProps(id: string, label: string, options: { draft?: string; attachments?: string[]; phase?: string } = {}) {
    const binding = { ctx: { id: label }, session: { metadata: { getSnapshot: () => ({ capabilities: { steer: true }, activeTurnId: 'exact-turn', sourceOnline: true, nativeConnection: 'attached' }) } } }
    const input = { draft: options.draft ?? '', attachmentIds: options.attachments ?? [], phase: options.phase ?? 'plain' }
    const captureInsertion = vi.fn(() => ({ start: label === 'left' ? 1 : 9, end: label === 'left' ? 1 : 9, draftRev: 0 })), insertText = vi.fn(() => true)
    return { binding, captureInsertion, insertText, props: { sessionId: id, sessionBinding: binding, inputActions: { captureInsertion, insertText },
        useInput: (select: (value: typeof input) => unknown) => select(input), useSession: (select: (value: { running: boolean }) => unknown) => select({ running: true }) } as unknown as SourceInputProps }
}

test('the reference button discards a captured insertion when the same rendered control changes Pane owners', () => {
    const first = editorProps('hhpi:machine:source:codex:thread', 'left'), next = editorProps('hhpi:machine:source:codex:thread', 'right')
    const focus = vi.fn(), forInput = vi.fn(() => ({ focus })), ctx = { conversation: { input: { for: forInput } } } as unknown as Context
    const view = render(<div data-composer-card=""><CompactComposerTools ctx={ctx} props={first.props} zh={false}/></div>)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Reference a file' }))
    view.rerender(<div data-composer-card=""><CompactComposerTools ctx={ctx} props={next.props} zh={false}/></div>)
    fireEvent.click(screen.getByRole('button', { name: 'Reference a file' }))
    expect(first.insertText).not.toHaveBeenCalled(); expect(next.insertText).toHaveBeenCalledWith('@', { start: 9, end: 9, draftRev: 0 })
    expect(forInput).toHaveBeenCalledWith(next.binding.ctx)
})

test('attachment-only interruption uses the rendered Pane input and an empty or submitting composer stays disabled', async () => {
    const current = editorProps('hhpi:machine:source:codex:thread', 'right', { attachments: ['original-image'] }), submit = vi.fn(), close = vi.fn()
    const forInput = vi.fn(() => ({ submit })), ctx = { conversation: { input: { for: forInput } } } as unknown as Context, user = userEvent.setup()
    const view = render(<ComposerSteerAction ctx={ctx} props={current.props} zh={false} close={close}/>)
    await user.click(screen.getByRole('button', { name: 'Send as an interruption' }))
    expect(submit).toHaveBeenCalledWith('steer', 'click'); expect(forInput).toHaveBeenCalledWith(current.binding.ctx); expect(close).toHaveBeenCalledOnce()
    const empty = editorProps('hhpi:machine:source:codex:thread', 'right')
    view.rerender(<ComposerSteerAction ctx={ctx} props={empty.props} zh={false} close={close}/>); expect(screen.getByRole('button')).toBeDisabled()
    const pending = editorProps('hhpi:machine:source:codex:thread', 'right', { draft: 'long draft\n'.repeat(300), phase: 'submitting' })
    view.rerender(<ComposerSteerAction ctx={ctx} props={pending.props} zh={false} close={close}/>); expect(screen.getByRole('button')).toBeDisabled()
})

test('compact composer keeps its draft, complete attachment and frequent controls mounted when the editor expands', async () => {
    const current = editorProps('hhpi:machine:source:codex:thread', 'right'), focus = vi.fn(), ctx = { conversation: { input: { for: () => ({ focus }) } } } as unknown as Context
    const style = document.createElement('style')
    // The official attachment rail compensates for the native flex gap. Our
    // production zero-gap grid must neutralize that negative margin.
    style.textContent = '.fixture_attachment_rail{margin-bottom:-6px}' + compactComposerStyles
    document.head.append(style); cleanups.push(() => style.remove())
    const user = userEvent.setup()
    render(<div className="hapi-workspace-mobile"><div className="hapi-pane"><div className="hapi-pane-body"><div data-composer-card="">
        <button className="hapi-compact-attach">Attachment fixture</button>
        <div className="hapi-composer-files"><div className="hapi-composer-file-list"><div className="fixture_attachment_rail">
            <span>Retained attachment.txt · TXT 105B</span></div></div></div>
        <div data-input-scroll=""><textarea aria-label="Retained native input" defaultValue={'中文 long draft\n'.repeat(300)}/></div>
        <button className="fixture_primary">Send</button>
        <div className="hapi-source-controls"><button>Model</button><CompactComposerTools ctx={ctx} props={current.props} zh={false}/><button>More</button></div></div>
        <div data-composer-dock=""><button>Official plugin action</button></div></div></div></div>)
    const input = screen.getByRole('textbox'), card = input.closest('[data-composer-card]')!
    const attachment = screen.getByText('Retained attachment.txt · TXT 105B')
    expect(getComputedStyle(attachment.parentElement!).marginBottom).toBe('0px')
    await user.click(screen.getByRole('button', { name: 'Expand editor' })); expect(card).toHaveAttribute('data-hapi-composer-expanded')
    expect(screen.getByRole('textbox')).toBe(input); expect(input).toHaveValue('中文 long draft\n'.repeat(300))
    await user.click(screen.getByRole('button', { name: 'Collapse editor' })); expect(card).not.toHaveAttribute('data-hapi-composer-expanded')
    expect(screen.getByText('Retained attachment.txt · TXT 105B')).toBe(attachment)
    for (const name of ['Attachment fixture', 'Send', 'Model', 'More']) expect(screen.getByRole('button', { name })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Official plugin action' })).toBeVisible()
})


/** Real menu DOM; only the browser's asynchronous history traversal is controlled. */
function menuHistory() {
    const history = window.history, original = { state: history.state, url: location.href }
    const actualPush = history.pushState.bind(history), actualReplace = history.replaceState.bind(history)
    const previous = { state: { route: 'previous' }, url: new URL('/before-menu', location.href).href }
    const chat = { state: { route: 'draft', pane: 'original-pane' }, url: new URL('/owned-chat?target=original', location.href).href }
    const entries: Array<{ state: unknown; url: string }> = [previous, chat]
    let position = 1
    const pending: number[] = []
    actualReplace(chat.state, '', chat.url)
    const push = vi.spyOn(history, 'pushState').mockImplementation((state, unused, url) => {
        const next = { state, url: url == null ? location.href : new URL(url, location.href).href }
        entries.splice(position + 1); entries.push(next); position++
        actualPush(state, unused, next.url)
    })
    const replace = vi.spyOn(history, 'replaceState').mockImplementation((state, unused, url) => {
        const next = { state, url: url == null ? location.href : new URL(url, location.href).href }
        entries[position] = next; actualReplace(state, unused, next.url)
    })
    const back = vi.spyOn(history, 'back').mockImplementation(() => { if (position > 0) pending.push(position - 1) })
    return {
        chat, previous,
        get position() { return position }, get pending() { return pending.length },
        completeBack() {
            const next = pending.shift()
            if (next === undefined) throw new Error('No browser traversal was requested')
            position = next
            const entry = entries[position]!
            actualReplace(entry.state, '', entry.url)
            window.dispatchEvent(new PopStateEvent('popstate', { state: entry.state }))
        },
        restore() { back.mockRestore(); replace.mockRestore(); push.mockRestore(); actualReplace(original.state, '', original.url) },
    }
}

function installHistoryMenus(platform: ReturnType<typeof menuHistory>) {
    const stop = installWorkspaceMenus(document)
    cleanups.push(stop, () => platform.restore())
    return stop
}

test('browser Back closes the current plugin menu at the same draft URL and preserves unrelated disclosures', async () => {
    const platform = menuHistory(); installHistoryMenus(platform)
    render(<><details className="hapi-menu"><summary>Pane actions</summary><button>Open project files</button></details>
        <details open><summary>Retained process</summary><p>Original process</p></details><textarea aria-label="Original draft" defaultValue="Retained long draft"/></>)
    await userEvent.click(screen.getByText('Pane actions'))
    await waitFor(() => expect(platform.position).toBe(2))
    expect(location.href).toBe(platform.chat.url); expect(history.state).toMatchObject(platform.chat.state)
    history.back(); platform.completeBack()
    expect(screen.getByText('Pane actions').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('Pane actions')).toHaveFocus()
    expect(location.href).toBe(platform.chat.url); expect(history.state).toEqual(platform.chat.state)
    expect(screen.getByText('Original process')).toBeVisible(); expect(screen.getByRole('textbox')).toHaveValue('Retained long draft')
})

test('outside dismissal removes the menu layer so the next browser Back leaves normally', async () => {
    const platform = menuHistory(); installHistoryMenus(platform)
    render(<><details className="hapi-menu"><summary>Pane actions</summary><button>Open project files</button></details><button>Outside</button></>)
    await userEvent.click(screen.getByText('Pane actions')); await waitFor(() => expect(platform.position).toBe(2))
    await userEvent.click(screen.getByText('Outside')); await waitFor(() => expect(platform.pending).toBe(1))
    platform.completeBack()
    expect(platform.position).toBe(1); expect(history.state).toEqual(platform.chat.state)
    history.back(); platform.completeBack()
    expect(location.href).toBe(platform.previous.url); expect(history.state).toEqual(platform.previous.state)
})

test('switching menus during a delayed traversal keeps one current layer and ignores an old popstate', async () => {
    const platform = menuHistory(); installHistoryMenus(platform)
    render(<><details className="hapi-menu"><summary>First menu</summary><button>First action</button></details>
        <details className="hapi-menu"><summary>Second menu</summary><button>Second action</button></details><button>Outside</button></>)
    await userEvent.click(screen.getByText('First menu')); await waitFor(() => expect(platform.position).toBe(2))
    await userEvent.click(screen.getByText('Outside')); await waitFor(() => expect(platform.pending).toBe(1))
    await userEvent.click(screen.getByText('Second menu'))
    expect(screen.getByText('Second menu').closest('details')).toHaveAttribute('open')
    platform.completeBack()
    expect(platform.position).toBe(2); expect(screen.getByText('Second menu').closest('details')).toHaveAttribute('open')
    window.dispatchEvent(new PopStateEvent('popstate', { state: platform.chat.state }))
    expect(screen.getByText('Second menu').closest('details')).toHaveAttribute('open')
    history.back(); platform.completeBack()
    expect(platform.position).toBe(1); expect(screen.getByText('Second menu').closest('details')).not.toHaveAttribute('open')
})

test('an action route and installer disposal retain the route owner state without navigating backwards', async () => {
    const platform = menuHistory(), stop = installHistoryMenus(platform), next = { route: 'actual-files', file: 'owned-document' }
    render(<details className="hapi-menu"><summary>Pane actions</summary><button onClick={() => history.pushState(next, '', '/owned-file')}>Open project files</button></details>)
    await userEvent.click(screen.getByText('Pane actions')); await waitFor(() => expect(platform.position).toBe(2))
    await userEvent.click(screen.getByText('Open project files'))
    await waitFor(() => expect(screen.getByText('Pane actions').closest('details')).not.toHaveAttribute('open'))
    stop()
    expect(location.pathname).toBe('/owned-file'); expect(history.state).toEqual(next); expect(platform.pending).toBe(0)
})

test('disposal restores an owned menu state without leaving its draft or handling later Back events', async () => {
    const platform = menuHistory(), stop = installHistoryMenus(platform)
    const view = render(<details className="hapi-menu"><summary>Pane actions</summary><button>Open project files</button></details>)
    await userEvent.click(screen.getByText('Pane actions')); await waitFor(() => expect(platform.position).toBe(2))
    stop(); view.unmount()
    expect(history.state).toEqual(platform.chat.state); expect(location.href).toBe(platform.chat.url); expect(platform.pending).toBe(0)
    history.back(); platform.completeBack()
    expect(platform.pending).toBe(0)
})


test('same-URL route replacement remains authoritative even when it carries the menu marker', async () => {
    const platform = menuHistory(), stop = installHistoryMenus(platform)
    render(<details className="hapi-menu"><summary>Pane actions</summary><button>Open project files</button></details>)
    await userEvent.click(screen.getByText('Pane actions')); await waitFor(() => expect(platform.position).toBe(2))
    const route = { ...history.state, route: 'different-pane-at-same-url' }
    history.replaceState(route, '', location.href)
    stop()
    expect(history.state).toEqual(route); expect(platform.pending).toBe(0); expect(location.href).toBe(platform.chat.url)
})
