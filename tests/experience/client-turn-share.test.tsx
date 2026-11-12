/** Actual pinned Session/Chat assembly; slot registration, PNG capture and link transport are seats. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { installTurnSharing } from '../../src/client/turn-share.tsx'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import type { WorkspacePaneNavigation } from '../../src/client/pane-navigation.ts'
import type { AppShareTarget } from '../../src/workspace/app-service-types.ts'
import { officialChat } from '../official-conversation-fixture.ts'

vi.mock('../../src/client/turn-share-dom.ts', () => ({ captureShareTurn: vi.fn(async () => ({ html: '<p>original answer</p>', text: 'original answer', styles: {} })) }))
beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
        showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
        close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
    })
})

function fixture(hhpi: boolean) {
    const native = Session.create(SessionId('share-native')), chat = officialChat()
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'original question' }] })
    native.append('user/message', user, { surfaceOp: 'append' })
    native.append('turn/start', { turn: 1 }); native.append('step/start', { turn: 1, step: 1 })
    const message = createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'original answer' }] })
    const body = native.append('assistant/message', { turn: 1, step: 1, stream: [], message }, { surfaceOp: 'append' })
    native.append('step/end', { turn: 1, step: 1 }); const end = native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const entries: SessionEventLikeEntry[] = native.snapshotEvents().map(event => ({ type: 'event', event }))
    chat.assembler.replaceWindow(entries as Parameters<typeof chat.assembler.replaceWindow>[0], false)
    chat.assembler.activateTarget('chat'); chat.assembler.flush()
    const snapshot = chat.assembler.snapshot('chat') as unknown as ChatSnapshot
    let epoch = 'pane-epoch', removed = false, phase = 'ready'
    const sessionId = hhpi ? 'hhpi:machine:source:codex:native' : 'ordinary-session'
    const readingWindowPosition = vi.fn((version: string, seq: number) => version === 'accepted-pane-version' && seq === body.seq && phase === 'ready'
        ? { epoch, seq, at: body.time } : undefined)
    const binding = { sessionId, session: { getSnapshot: () => ({ removed }), sourceEpoch: 'new-canonical-epoch', readingWindowPosition },
        eventSource: { getSnapshot: () => ({ entries, hasMore: false, revision: 1 }) } } as unknown as SessionBinding
    const canonical = { ...binding, session: { ...binding.session, sourceEpoch: 'new-canonical-epoch' } }
    const bind = vi.fn(() => canonical), create = vi.fn(async (_target: AppShareTarget, _signal?: AbortSignal) => 'https://share.invalid/original')
    const conversation = { activate() {}, target: () => ({ getSnapshot: () => snapshot }),
        readingView: { snapshot: { getSnapshot: () => ({ phase, busy: false, version: 'accepted-pane-version', entries }) } } }
    let Action: ComponentType<Record<string, unknown>> | undefined
    const ctx = { locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) }, sessions: { binding: bind },
        uiConversation: { binding: vi.fn((candidate: SessionBinding) => { expect(candidate).toBe(binding); return conversation }) },
        get: (key: string) => key === 'sourceSharing' ? { create } : undefined,
        slots: { inject: (_name: string, callback: () => unknown) => callback(), register: (_definition: unknown, component: typeof Action) => { Action = component; return () => {} } },
    } as unknown as Context
    const stop = installTurnSharing(ctx)
    const props = { sessionId, sessionBinding: binding, messageId: message.id, useChat: (selector: (value: ChatSnapshot) => unknown) => selector(snapshot),
        useSessions: (selector: (value: unknown) => unknown) => selector({ byId: { [sessionId]: { displayTitle: 'Original source' } } }) }
    const pane = { hostId: 'original-host', paneId: 'original-pane' } as WorkspacePaneNavigation
    const ShareAction = Action!
    const View = ({ owner = binding }: { owner?: SessionBinding }) => <WorkspacePaneProvider value={pane}><section data-pane-id="original-pane"><ShareAction {...props} sessionBinding={owner}/></section></WorkspacePaneProvider>
    return { View, binding, body, end, create, bind, readingWindowPosition, ctx, changeEpoch: () => { epoch = 'replacement-epoch' },
        unaccept: () => { phase = 'loading' }, remove: () => { removed = true }, close: async () => { stop(); await chat.close() } }
}

for (const hhpi of [false, true]) test(`${hhpi ? 'HHPI' : 'DSH'} sharing uses the clicked Pane and readable assistant event, never turn/end`, async () => {
    const f = fixture(hhpi)
    try {
        const view = render(<f.View/>); fireEvent.click(screen.getByRole('button', { name: 'Share this turn' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Create account link' }))
        await waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
        expect(f.bind).not.toHaveBeenCalled()
        expect(f.create.mock.calls[0]?.[0]).toEqual({ kind: 'reading', source: expect.objectContaining({ hostId: 'original-host', sessionId: f.binding.sessionId }),
            position: hhpi ? { kind: 'hhpi', epoch: 'pane-epoch', seq: f.body.seq } : { kind: 'dsh', seq: f.body.seq } })
        expect(f.body.seq).not.toBe(f.end.seq)
        if (hhpi) expect(f.readingWindowPosition).toHaveBeenCalledWith('accepted-pane-version', f.body.seq)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save PNG' })).toBeEnabled())
        expect(screen.queryByRole('alert')).toBeNull()
        view.unmount()
    } finally { await f.close() }
})

test('a source epoch replacement cannot create a link from the previous share preview', async () => {
    const f = fixture(true)
    try {
        render(<f.View/>); fireEvent.click(screen.getByRole('button', { name: 'Share this turn' }))
        const button = await screen.findByRole('button', { name: 'Create account link' }); f.changeEpoch(); fireEvent.click(button)
        expect(f.create).not.toHaveBeenCalled()
        expect(await screen.findByRole('alert')).toHaveTextContent(/conversation changed|conversation has closed|no longer active/i)
    } finally { await f.close() }
})

test('replacing the Pane binding retires its open preview even when the session ID is unchanged', async () => {
    const f = fixture(true)
    try {
        const view = render(<f.View/>); fireEvent.click(screen.getByRole('button', { name: 'Share this turn' }))
        const button = await screen.findByRole('button', { name: 'Create account link' })
        view.rerender(<f.View owner={{ ...f.binding }}/>)
        fireEvent.click(button); expect(f.create).not.toHaveBeenCalled()
        expect(await screen.findByRole('alert')).toHaveTextContent(/conversation changed|conversation has closed|no longer active/i)
        expect(f.bind).not.toHaveBeenCalled()
    } finally { await f.close() }
})

test('an unaccepted HHPI window cannot substitute the canonical source epoch for a link', async () => {
    const f = fixture(true)
    try {
        f.unaccept(); render(<f.View/>); fireEvent.click(screen.getByRole('button', { name: 'Share this turn' }))
        expect(screen.queryByRole('button', { name: 'Create account link' })).toBeNull()
        expect(f.create).not.toHaveBeenCalled(); expect(f.bind).not.toHaveBeenCalled()
    } finally { await f.close() }
})
