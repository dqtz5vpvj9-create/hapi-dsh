/** Production receiver/inbox/React lifecycle. Storage, native input actions and unrelated composer seats are boundaries. */
import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, onTestFinished, test, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installShareReceiver } from '../../src/client/share-receiver.tsx'
import { WorkspaceShareInbox } from '../../src/client/share-inbox-state.ts'
import type { SharePayload, ShareRecord, ShareTransfers } from '../../src/client/share-transfer.ts'
import type { SourceComposerBridge } from '../../src/client/source-composer.tsx'
import { sourceRoute } from '../../src/shared/source-capability.ts'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import { context, input, pane, slots } from './fixtures.tsx'

vi.mock('../../src/client/composer-enter/index.tsx', () => ({ installComposerEnter: () => () => {} }))
vi.mock('../../src/client/composer-autosave-seat.tsx', () => ({ installComposerAutosave: () => () => {} }))
vi.mock('../../src/client/composer-attachment-recovery.tsx', () => ({ installComposerAttachmentRecovery: () => () => {} }))
vi.mock('../../src/client/draft-handoff-receiver.tsx', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/client/draft-handoff-receiver.tsx')>(), installDraftHandoffReceiver: () => () => {},
}))

class Transfers implements ShareTransfers {
    record: ShareRecord | null = null
    async put(payload: SharePayload) { this.record = { ...payload, id: 'share' }; return 'share' }
    async read() { return this.record }
    async delete() { this.record = null }
    async update(_id: string, change: (record: ShareRecord) => ShareRecord) { return this.record = change(this.record!) }
}
function editor(text: string, revision: number) {
    const current = input(text)
    current.composer.state.set({ ...current.composer.state.getSnapshot(), draftRev: revision })
    const actions: InputActions = { ...current.actions, insertText: vi.fn((text, span) => {
        const state = current.composer.state.getSnapshot()
        if (span.draftRev !== state.draftRev) return false
        current.composer.state.set({ ...state, draft: state.draft.slice(0, span.start) + text + state.draft.slice(span.end), draftRev: state.draftRev + 1 })
        return true
    }) }
    return { ...current, actions, binding: { ctx: current.composer } as unknown as SessionBinding }
}
function fixture(fallback = false) {
    const registered = slots(), transfers = new Transfers(), inbox = new WorkspaceShareInbox(transfers, undefined,
        { accountId: 'account', origin: 'https://experience.invalid' })
    const actual = editor('Original pane draft', 7), catalog = fallback ? actual : editor('Different catalog draft', 1)
    const navigation = { ...pane('original-pane'), revealConversation: vi.fn() }
    const sessionId = (fallback ? 'ordinary-source' : 'hhpi:machine:source:codex:thread') as SessionId
    let prepare: Promise<() => void> | undefined
    const bridge = { addFiles: vi.fn(async () => prepare ? await prepare : () => {}) } as unknown as SourceComposerBridge
    const ctx = context({ slots: registered.registry, get: () => undefined,
        inject(_names: unknown, apply: (owner: unknown) => () => void) { const stop = apply(ctx); return { dispose: async () => stop() } },
        hapiWorkspaceUi: { shareInbox: inbox, handoffs: { subscribe: () => () => {} } },
        sessions: { binding: () => catalog.binding }, conversation: { input: { for: (value: unknown) => value } },
        locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    })
    const stop = installShareReceiver(ctx, bridge), Receiver = registered.component('hapi.share-receiver')
    const props = (current = actual): PropsRuntime<'conversation.input.dock'> => ({ sessionId, useInput: current.useInput,
        inputActions: current.actions, ...(!fallback ? { sessionBinding: current.binding } : {}) } as PropsRuntime<'conversation.input.dock'>)
    const tree = (current = actual) => <WorkspacePaneProvider value={navigation}><Receiver {...props(current)}/><current.Editor label="Actual pane draft"/></WorkspacePaneProvider>
    const view = render(tree())
    onTestFinished(() => { view.unmount(); stop(); inbox.dispose() })
    const select = async (files: SharePayload['files'] = []) => { await act(async () => {
        await inbox.ingest({ text: 'Shared original text', title: '', url: '', files, createdAt: Date.now() })
        await inbox.select(sourceRoute(navigation.hostId, sessionId, 'local'))
    }) }
    return { actual, catalog, transfers, inbox, select, view, tree, hold: (value: Promise<() => void>) => { prepare = value } }
}

test('incoming share uses the rendered SessionBinding draft and revision instead of the catalog binding', async () => {
    const f = fixture()
    await f.select()
    await waitFor(() => expect(f.inbox.getSnapshot().phase).toBe('inserted'))
    expect(screen.getByRole('textbox', { name: 'Actual pane draft' })).toHaveValue('Original pane draft\n\nShared original text')
    expect(f.catalog.composer.state.getSnapshot().draft).toBe('Different catalog draft')
    expect(f.actual.actions.insertText).toHaveBeenCalledWith('\n\nShared original text', { start: 19, end: 19, draftRev: 7 })
    expect(f.actual.actions.submit).not.toHaveBeenCalled()
})

test('ordinary DSH without a supplied SessionBinding retains its existing binding fallback', async () => {
    const f = fixture(true)
    await f.select()
    await waitFor(() => expect(f.inbox.getSnapshot().phase).toBe('inserted'))
    expect(screen.getByRole('textbox', { name: 'Actual pane draft' })).toHaveValue('Original pane draft\n\nShared original text')
})

test('a replaced rendered binding during file preparation cannot mutate either composer', async () => {
    const f = fixture(), pending = Promise.withResolvers<() => void>(), undo = vi.fn()
    f.hold(pending.promise)
    await f.select([{ name: 'original.txt', type: 'text/plain', blob: new Blob(['original bytes']) }])
    await waitFor(() => expect(f.inbox.getSnapshot().phase).toBe('inserting'))
    const next = editor('Replacement pane draft', 7)
    f.view.rerender(f.tree(next))
    await act(async () => pending.resolve(undo))
    await waitFor(() => expect(f.inbox.getSnapshot().phase).toBe('unknown'))
    expect(f.actual.actions.insertText).not.toHaveBeenCalled(); expect(next.actions.insertText).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Actual pane draft' })).toHaveValue('Replacement pane draft')
    expect(undo).toHaveBeenCalledOnce(); expect(f.transfers.record?.files[0]?.name).toBe('original.txt')
})

test('a genuine draft revision change during shared file preparation retains the share for review', async () => {
    const f = fixture(), pending = Promise.withResolvers<() => void>()
    f.hold(pending.promise)
    await f.select([{ name: 'original.txt', type: 'text/plain', blob: new Blob(['original bytes']) }])
    await waitFor(() => expect(f.inbox.getSnapshot().phase).toBe('inserting'))
    await act(async () => { f.actual.composer.setDraft('New local edit'); pending.resolve(() => {}) })
    await waitFor(() => expect(f.inbox.getSnapshot().phase).toBe('unknown'))
    expect(f.actual.actions.insertText).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Actual pane draft' })).toHaveValue('New local edit')
    expect(f.transfers.record?.hapiDshDelivery?.status).toBe('unknown')
})
