/** Production artifact/navigation/selection. Remote reads and official document/Markdown presentation are explicit boundaries. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, onTestFinished, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { createElement, useSyncExternalStore, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArtifactContent } from '../../src/client/artifact-preview.tsx'
import { SourceChatFileCard } from '../../src/client/source-chat-files.tsx'
import { installSourceTranscript } from '../../src/client/source-transcript.tsx'
import { SourceMarkdown } from '../../src/client/source-markdown.tsx'
import { DocumentSelectionButton, documentSelectionKey, selectionQuote } from '../../src/client/document-selection.tsx'
import { workspaceDocumentAddress, parseWorkspaceDocumentAddress } from '../../src/workspace/artifacts.ts'
import { fileContext } from '../source-file-context-fixture.ts'
import type { WorkspaceResource } from '../../src/workbench-types.ts'
import type { WorkspaceDocument } from '../../src/workspace/service-types.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installDraftHandoffReceiver } from '../../src/client/draft-handoff-receiver.tsx'
import { WorkspaceDraftHandoffs } from '../../src/client/draft-handoff.ts'
import type { SourceComposerBridge } from '../../src/client/source-composer.tsx'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'

const markdown = vi.hoisted(() => ({ openFile: undefined as undefined | ((path: string, options?: { line?: number }) => void) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
    Button: ({ variant: _variant, size: _size, ...props }: ComponentProps<'button'> & { variant?: string; size?: string }) => <button {...props}/>,
    CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>, ImageLightbox: () => <div role="dialog"/>, languageForPath: () => 'text',
    MarkdownDelegateProvider: ({ children, openFile }: { children: ReactNode; openFile: typeof markdown.openFile }) => { markdown.openFile = openFile; return children },
    // The official parser/renderer is a presentation boundary. These fixed
    // decoded destinations exercise the production source navigation delegate.
    MarkdownText: ({ pathImages }: { pathImages: { resolve(path: string): string | undefined } }) => {
        const source = pathImages.resolve('图片%201.png')
        return <>{source && <img src={source} alt="source picture"/>}<button type="button" onClick={() => markdown.openFile?.('next%20page.md', { line: 3 })}>next page</button></>
    },
}))

const locale = { active: 'en' }, definitions: readonly [] = []
function fixture() {
    const context = fileContext(), sessionId = context.owner.binding.target.sessionId as SessionId, target = context.owner.binding.target
    const resource: WorkspaceResource = { target, document: { kind: 'artifact', id: 'original-receipt' } }, body = new Uint8Array([0,255,1])
    let authority = new AbortController(), metadataGate: Promise<void> | undefined, name = '报告 空格', scope = context.owner.scope
    const open = vi.fn(async (document: WorkspaceResource['document'], access: Parameters<typeof context.services.documents.open>[1]): Promise<WorkspaceDocument> => {
        access.signal.throwIfAborted(); await metadataGate; access.signal.throwIfAborted()
        return { resource: { target, document }, fileName: name, mimeType: 'application/pdf', bytes: body.length, version: 'source-version', text: null, writable: false }
    })
    const bytes = vi.fn(async () => ({ absolutePath: '', version: 'source-version', bytes: body.length, data: body, offset: 0, eof: true }))
    context.services.documents.open = open; context.services.documents.bytes = bytes
    const resolve = vi.fn(async () => ({ ...context, owner: { ...context.owner, scope } })), client = { resolve }, navigate = vi.fn()
    const ctx = { get: (key: string) => key === 'sourceWorkspaceTransport' ? { hostId: target.hostId } : undefined,
        sourceFiles: client, hhpiSessions: { captureWorkspaceAccess() { const captured = authority; return { scope, signal: captured.signal, assertCurrent() { captured.signal.throwIfAborted() } } } },
        locale: { subscribe: () => () => {}, getSnapshot: () => locale }, fileDrag: { actions: {} },
        documentPreviews: { subscribe: () => () => {}, getSnapshot: () => definitions, candidates: () => [] },
        sidebarRight: { openResourceIn: navigate, tabDomain: { navigate } }, resources: { pin: vi.fn() },
    } as unknown as Context
    const tab = { id: 'source-tab', contentId: workspaceDocumentAddress(resource), signal: new AbortController().signal, visible: true,
        navigation: { params: {} }, actions: { bindCommands: () => () => {}, openResource: navigate } }
    const renderSlot = vi.fn((_slot: string, props: { content: { kind: string; data?: Uint8Array } }, options: { entryKey: string }) => <div data-testid="official-body" data-official-entry={options.entryKey}>{props.content.kind}:{props.content.data?.join(',')}</div>)
    const props = { ctx, client, resource, sessionId, language: 'en', useTabInfo: () => ({ tab }), renderSlot } as unknown as ComponentProps<typeof ArtifactContent>
    return { context, sessionId, resource, ctx, client, resolve, open, bytes, navigate, tab, props, renderSlot,
        gate(value: Promise<void>) { metadataGate = value }, rename(value: string) { name = value },
        revoke() { authority.abort(); authority = new AbortController(); scope = 'another-account' } }
}

test('an uploaded file card opens only its exact Host/session receipt after an explicit click and keeps the official card', async () => {
    const f = fixture(), file = { attachmentId: 'opaque-attachment' as never, name: '中文 空格', bytes: 3 }
    render(<SourceChatFileCard ctx={f.ctx} client={f.client} sessionId={f.sessionId} file={file}><span>Official file card</span></SourceChatFileCard>)
    expect(screen.getByText('Official file card')).toBeVisible(); expect(f.resolve).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Open source file 中文 空格' }))
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.navigate).toHaveBeenCalledOnce()
    const resource = parseWorkspaceDocumentAddress(f.navigate.mock.calls[0]![1] as string)
    expect(resource).toEqual({ target: f.resource.target, document: { kind: 'artifact', id: 'attachment:opaque-attachment/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC' } })
    expect(f.open).not.toHaveBeenCalled(); expect(f.bytes).not.toHaveBeenCalled()
})

test('an unavailable source file card retains a visible retry and a closed card ignores a late source reply', async () => {
    const f = fixture(); f.resolve.mockRejectedValueOnce(new Error('Source service is not registered; original reference kept'))
    const view = render(<SourceChatFileCard ctx={f.ctx} client={f.client} sessionId={f.sessionId} file={{ attachmentId: 'opaque' as never, name: 'original', bytes: 1 }}><span>Official card</span></SourceChatFileCard>)
    await userEvent.click(screen.getByRole('button', { name: 'Open source file original' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not registered')
    expect(screen.getByRole('button', { name: 'Open source file original' })).toBeEnabled()
    const reply = Promise.withResolvers<typeof f.context>(); f.resolve.mockImplementationOnce(() => reply.promise)
    await userEvent.click(screen.getByRole('button', { name: 'Open source file original' })); view.unmount()
    await act(async () => reply.resolve(f.context)); expect(f.navigate).not.toHaveBeenCalled()
})

test.each(['ordinary DSH', 'source without a Files client'] as const)('%s keeps exactly the official image factory without source actions', mode => {
    const f = fixture(), image = { attachmentId: 'native-image', name: 'image.png', bytes: 3, width: 1, height: 1 }
    let Wrapped: ComponentType<Record<string, unknown>> | undefined
    const Official = (props: { renderSlot(name: string, owner: { images: unknown[] }): ReactNode }) => <section>{props.renderSlot('conversation.chat.message.images', { images: [{ attachment: image }] })}</section>
    Object.assign(f.ctx, { slots: { inject(_slot: string, install: () => () => void) { return install() },
        entries: () => [{ component: Official, options: { key: 'assistant-step' } }], subscribe: () => () => {},
        register(_options: unknown, component: ComponentType<Record<string, unknown>>) { Wrapped = component; return () => {} },
    } })
    const stop = installSourceTranscript(f.ctx, mode === 'ordinary DSH' ? f.client : undefined); onTestFinished(stop)
    expect(Wrapped).toBeDefined()
    const renderFactorySlot = vi.fn(() => <div data-testid="official-gallery">Official gallery</div>)
    render(createElement(Wrapped!, { sessionId: mode === 'ordinary DSH' ? 'ordinary-dsh-session' : f.sessionId,
        node: { key: 'assistant-image', data: { status: 'settled', blocks: [] } }, useDisclosure: () => ({}), renderFactorySlot }))
    expect(screen.getAllByTestId('official-gallery')).toHaveLength(1)
    expect(renderFactorySlot).toHaveBeenCalledExactlyOnceWith('conversation.images.content', { images: [{ attachment: image }] })
    expect(screen.queryByRole('button', { name: /Open source file/ })).not.toBeInTheDocument()
    expect(f.resolve).not.toHaveBeenCalled()
})

test('extensionless source PDF selects the official body key and downloads its original name and bytes', async () => {
    const f = fixture(), create = vi.fn(() => 'blob:original-source'), revoke = vi.fn(), click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
    render(<ArtifactContent {...f.props}/>)
    expect(await screen.findByText('报告 空格')).toBeVisible()
    expect(await screen.findByTestId('official-body')).toHaveAttribute('data-official-entry', '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf')
    expect(screen.getByTestId('official-body')).toHaveTextContent('bytes:0,255,1')
    await userEvent.click(screen.getByRole('button', { name: 'Download original' }))
    expect(click).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce()
    const link = click.mock.instances[0] as HTMLAnchorElement; expect(link.download).toBe('报告 空格'); expect(link.href).toBe('blob:original-source')
    expect(f.bytes).toHaveBeenCalledTimes(2)
})

test('account revocation clears an open document and requires an explicit reread before it can appear again', async () => {
    const f = fixture(); render(<ArtifactContent {...f.props}/>)
    await screen.findByTestId('official-body'); const previous = f.open.mock.calls.length
    act(() => f.revoke())
    expect(await screen.findByRole('alert')).toHaveTextContent('permission changed')
    expect(screen.queryByTestId('official-body')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download original' })).toBeDisabled()
    expect(f.open).toHaveBeenCalledTimes(previous)
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(await screen.findByTestId('official-body')).toBeVisible()
    expect(f.resolve).toHaveBeenCalledTimes(2)
})

test('source Markdown loads relative Unicode images and opens relative links through the same source owner', async () => {
    const f = fixture(), navigation = vi.fn(), create = vi.fn(() => 'blob:source-image'), revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
    const data = new Uint8Array([1,2,3])
    f.context.services.documents.open = vi.fn(async (document, access) => {
        await access.assertAllowed(f.resource.target, 'read')
        return { resource: { target: f.resource.target, document }, fileName: '图片 1.png', mimeType: 'image/png', bytes: 3, version: 'image-version', text: null, writable: false }
    })
    f.context.services.documents.bytes = vi.fn(async () => ({ absolutePath: '/source/docs/图片 1.png', version: 'image-version', bytes: 3, data, offset: 0, eof: true }))
    const view = render(<SourceMarkdown text={'![source picture](图片%201.png)\n\n[next page](next%20page.md#L3)'} complete context={f.context} documentPath="/source/docs/readme.md" language="en" fileDrag={{} as never} openFile={navigation}/>)
    expect(await screen.findByRole('img', { name: 'source picture' })).toHaveAttribute('src', 'blob:source-image')
    expect(f.context.services.documents.open).toHaveBeenCalledWith({ kind: 'file', path: '/source/docs/图片 1.png' }, expect.objectContaining({ scope: f.context.owner.scope }))
    await userEvent.click(screen.getByRole('button', { name: 'next page' }))
    expect(navigation).toHaveBeenCalledWith('/source/docs/next page.md', 3)
    view.unmount(); expect(revoke).toHaveBeenCalledWith('blob:source-image')
})


/** Real button, shared hand-off coordinator and production receiver. The public
 * InputState/SessionBinding/editor actions and file transport are test boundaries. */
function quoteFixture(savedSelection?: string) {
    const f = fixture(); if (savedSelection) localStorage.setItem(documentSelectionKey(f.context.owner), savedSelection);
    const listeners = new Set<() => void>(), navigation = vi.fn(), application = { scope: 'application-account', signal: new AbortController().signal };
    const handoffs = new WorkspaceDraftHandoffs('selection-test', { async read() { return null }, async write() { throw new Error('Text append does not write a successor transaction') } });
    onTestFinished(() => handoffs.dispose());
    let visible = { focused: false, visible: true }, hidden = { focused: false, visible: false };
    const paneState = (read: () => typeof visible) => ({ getSnapshot: read, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } });
    const chatPane = { paneId: 'original-chat', hostId: f.resource.target.hostId, state: paneState(() => visible), retainForDraftTransfer: () => () => {}, revealConversation: vi.fn() };
    const filePane = { ...chatPane, paneId: 'file-pane', state: paneState(() => hidden), focusConversation() {
        navigation(); visible = { visible: true, focused: true }; for (const notify of listeners) notify(); return chatPane.paneId;
    } };
    const ui = { handoffs, application: { getSnapshot: () => application, subscribe: () => () => {} } };
    function composer(pane: typeof chatPane, text: string) {
        const subscribers = new Set<() => void>(), attachment = new File(['original bytes'], 'original.txt');
        let state = { draft: text, draftRev: 2, phase: 'plain', occurrences: [], claim: null, attachmentIds: ['original-attachment'] } as unknown as InputState;
        let binding = { ctx: {} };
        const store = { getSnapshot: () => state, subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener) } } };
        const update = (patch: Partial<InputState>) => { state = { ...state, ...patch }; for (const notify of subscribers) notify() };
        const inputActions = { insertText: vi.fn((suffix: string, range: { start: number; end: number; draftRev: number }) => {
            if (range.draftRev !== state.draftRev) return false;
            update({ draft: state.draft.slice(0, range.start) + suffix + state.draft.slice(range.end), draftRev: state.draftRev + 1 }); return true;
        }), persistDraft: vi.fn(), submit: vi.fn() };
        const facade = { state: store, focus: vi.fn() }, additions = vi.fn(async () => () => {});
        const bridge = { captureFiles: () => [{ id: 'original-attachment', file: attachment }], addFiles: additions } as unknown as SourceComposerBridge;
        let Receiver!: (props: PropsRuntime<'conversation.input.dock'>) => ReactNode;
        const owner = { ...f.ctx, get: (name: string) => name === 'hapiWorkspacePane' ? pane : undefined,
            hapiWorkspaceUi: ui, sessions: { binding: () => binding },
            conversation: { input: { for: () => facade }, blocks: { storeFor: () => ({ getSnapshot: () => undefined }) } },
            slots: { inject(_name: string, install: () => () => void) { return install() }, register(_options: unknown, component: typeof Receiver) { Receiver = component; return () => {} } },
        } as unknown as Context;
        Object.assign(owner, { inject(_services: string[], apply: (owner: Context) => () => void) { const dispose = apply(owner); return { dispose } } });
        const stop = installDraftHandoffReceiver(owner, bridge); onTestFinished(stop);
        const props = { sessionId: f.sessionId, get sessionBinding() { return binding }, inputActions,
            useInput(select: (state: InputState) => unknown) { return select(useSyncExternalStore(store.subscribe, store.getSnapshot)) },
        } as unknown as PropsRuntime<'conversation.input.dock'>;
        function Editor() { const value = useSyncExternalStore(store.subscribe, store.getSnapshot); return <><textarea aria-label={pane.paneId} value={value.draft} readOnly/><Receiver {...props}/></> }
        return { Editor, inputActions, additions, attachment, update, state: () => state, replaceBinding() { binding = { ctx: {} }; update({}) } };
    }
    const chat = composer(chatPane, 'Existing original draft'), file = composer({ ...chatPane, ...filePane }, 'Hidden file graph draft');
    Object.assign(f.ctx, { hapiWorkspaceUi: ui, get: (name: string) => name === 'hapiWorkspacePane' ? filePane : name === 'sourceWorkspaceTransport' ? { hostId: f.resource.target.hostId } : undefined });
    const view = render(<><chat.Editor/><div hidden><file.Editor/></div><section className="hapi-artifact"><p data-testid="selection-text">source quote</p><DocumentSelectionButton ctx={f.ctx} sessionId={f.sessionId} owner={f.context.owner} path="artifact:original-receipt" version="source-version" zh={false}/></section></>);
    const select = () => { const range = document.createRange(); range.selectNodeContents(screen.getByTestId('selection-text')); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range) };
    return { ...f, view, chat, file, navigation, application, select };
}

test('one document quote focuses the original visible composer, appends once and preserves its draft and attachments', async () => {
    const f = quoteFixture(); f.select();
    await userEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'original-chat' })).toHaveValue('Existing original draft\n\n' + selectionQuote('artifact:original-receipt', 'source quote', 'source-version')));
    expect(f.navigation).toHaveBeenCalledOnce(); expect(f.chat.inputActions.insertText).toHaveBeenCalledOnce();
    expect(f.chat.state().draft).toBe('Existing original draft\n\n' + selectionQuote('artifact:original-receipt', 'source quote', 'source-version'));
    expect(f.chat.state().attachmentIds).toEqual(['original-attachment']); expect(f.file.inputActions.insertText).not.toHaveBeenCalled();
    expect(f.file.state().draft).toBe('Hidden file graph draft'); expect(f.chat.inputActions.submit).not.toHaveBeenCalled();
    expect(localStorage.getItem(documentSelectionKey(f.context.owner))).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry saved selection' })).not.toBeInTheDocument();
});

test('busy original input retains the quote without mount replay; only an explicit retry appends after it becomes writable', async () => {
    const f = quoteFixture(); act(() => f.chat.update({ phase: 'submitting' })); f.select();
    await userEvent.click(screen.getByRole('button', { name: 'Quote selection' }));
    expect(await screen.findByRole('status')).toHaveTextContent('busy or unavailable');
    expect(localStorage.getItem(documentSelectionKey(f.context.owner))).toContain('source quote'); expect(f.chat.inputActions.insertText).not.toHaveBeenCalled();
    act(() => f.chat.update({ phase: 'plain' }));
    expect(f.chat.inputActions.insertText).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry saved selection' }));
    await waitFor(() => expect(f.chat.inputActions.insertText).toHaveBeenCalledOnce());
    expect(localStorage.getItem(documentSelectionKey(f.context.owner))).toBeNull(); expect(f.file.inputActions.insertText).not.toHaveBeenCalled();
});

test('binding replacement during original composer acceptance keeps the exact saved quote and never mutates another generation', async () => {
    const f = quoteFixture(), gate = Promise.withResolvers<() => void>(); f.chat.additions.mockImplementationOnce(() => gate.promise); f.select();
    await userEvent.click(screen.getByRole('button', { name: 'Quote selection' })); await waitFor(() => expect(f.chat.additions).toHaveBeenCalledOnce());
    act(() => f.chat.replaceBinding()); await act(async () => { gate.resolve(() => {}) });
    expect(await screen.findByRole('status')).toHaveTextContent('changed');
    expect(f.chat.state().draft).toBe('Existing original draft'); expect(f.chat.inputActions.insertText).not.toHaveBeenCalled();
    expect(localStorage.getItem(documentSelectionKey(f.context.owner))).toContain('source quote'); expect(f.file.inputActions.insertText).not.toHaveBeenCalled();
});


test('a retained selection is never consumed just because a matching composer mounts', async () => {
    const f = quoteFixture('Previously retained selection');
    expect(await screen.findByRole('button', { name: 'Retry saved selection' })).toBeEnabled();
    expect(f.navigation).not.toHaveBeenCalled(); expect(f.chat.inputActions.insertText).not.toHaveBeenCalled();
    localStorage.removeItem(documentSelectionKey(f.context.owner));
    await userEvent.click(screen.getByRole('button', { name: 'Retry saved selection' }));
    expect(await screen.findByRole('status')).toHaveTextContent('handled or changed');
    expect(f.chat.inputActions.insertText).not.toHaveBeenCalled(); expect(f.navigation).not.toHaveBeenCalled();
});

test('source-account revocation while accepting a quote retains its original scoped copy and cannot write the new account', async () => {
    const f = quoteFixture(), gate = Promise.withResolvers<() => void>(); f.chat.additions.mockImplementationOnce(() => gate.promise); f.select();
    await userEvent.click(screen.getByRole('button', { name: 'Quote selection' })); await waitFor(() => expect(f.chat.additions).toHaveBeenCalledOnce());
    act(() => f.revoke()); await act(async () => { gate.resolve(() => {}) });
    expect(f.chat.state().draft).toBe('Existing original draft'); expect(f.chat.inputActions.insertText).not.toHaveBeenCalled();
    expect(localStorage.getItem(documentSelectionKey(f.context.owner))).toContain('source quote');
    expect(localStorage.getItem(documentSelectionKey({ ...f.context.owner, scope: 'another-account' }))).toBeNull();
});
