/** Production source navigation/tickets/memory; mounted reader and source IO are explicit boundaries. */
import { Context } from '@deepseek-ai/cordis'
import { expect, onTestFinished, test } from 'vitest'
import { userEvent } from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MountedChatControlV1 } from '../../src/client/mounted-chat-control.ts'
import { publishPaneMountedChat } from '../../src/client/mounted-chat-control.ts'
import { bindRemotePaneReading } from '../../src/client/remote-reading.ts'
import { installRemoteReadingMemory } from '../../src/client/remote-reading-memory.ts'
import { SourceReadingCache } from '../../src/client/remote-reading-cache.ts'
import { registerSourceUpdateReadingCheckpoint, armOrdinaryReadingForReload } from '../../src/client/ordinary-reading-checkpoint.ts'
import { WorkspaceApplicationIdentity } from '../../src/client/application-identity.ts'
import { createWorkspaceUpdatePreparations } from '../../src/client/update-preparation.ts'
import type { SourcePage, SourceSession } from '../../src/remote/protocol.ts'
import type { PaneReadingIntent } from '../../src/client/reading-intent.ts'
import type { WorkspacePaneNavigation } from '../../src/client/pane-navigation.ts'

async function fixture(armed = true) {
    const ctx = new Context(), application = new WorkspaceApplicationIdentity(), updates = createWorkspaceUpdatePreparations()
    application.set({ accountId: 'account', origin: location.origin }, 'device')
    const cache = new SourceReadingCache({ storage: localStorage, scope: application.getSnapshot()!.scope })
    const session: SourceSession = { id: 'hhpi:machine:source:codex:native', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native',
        cwd: '/native', title: 'Source', updatedAt: 50, status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
    const page: SourcePage = { session, epoch: 'original-epoch', version: 1, before: 12, after: 20, hasBefore: true, hasAfter: false, context: [], entries: [
        { type: 'event', event: { type: 'turn/end', seq: 12, time: 30, data: {} } } as SourcePage['entries'][number],
    ] }
    cache.write({ session, epoch: page.epoch, version: 1, head: page, windows: [{ viewId: 'pane', page }] })
    const makeBinding = () => ({ sessionId: session.id, viewId: 'pane', session: { sourceEpoch: 'original-epoch', readingView: {} } }) as unknown as SessionBinding
    let binding = makeBinding(), current = binding, read: (signal: AbortSignal) => Promise<void> = async () => {}
    const requests: unknown[] = [], reveals: unknown[] = [], latest: unknown[] = []
    const nodes = new Map([['original-body', { key: 'original-body', anchorSeq: 12 }]])
    ctx.reflect.provide('uiConversation', { binding: () => ({ target: () => ({ getSnapshot: () => ({ nodes, order: [...nodes.keys()] }) }),
        readingView: { read: async (request: unknown, signal: AbortSignal) => { requests.push(request); await read(signal) } } }) } as unknown as Context['uiConversation'])
    ctx.reflect.provide('sessions', { ownsBinding: (value: SessionBinding) => value === current } as unknown as Context['sessions'])
    const stopMemory = installRemoteReadingMemory(ctx, () => cache, value => value === current)
    const control = { version: 1, read: () => ({ revision: 1, following: false, busy: false }), subscribe: () => () => {},
        checkpointReading: () => ctx.chatScrollMemory.forBinding(current)!.save({ anchorKey: 'original-body', anchorTop: -44, scrollTop: 173 }),
        reveal: async (target: unknown) => { reveals.push(target) }, toLatest: async () => { latest.push(true) } } as unknown as MountedChatControlV1
    if (armed) {
        const before = createWorkspaceUpdatePreparations(), checkpoint = registerSourceUpdateReadingCheckpoint(ctx, binding, { updates: before, application,
            target: { hostId: 'host', sessionId: session.id, paneId: 'pane' }, storage: sessionStorage, reload: false, reader: () => control, current: () => true })
        await before.checkpoint(); armOrdinaryReadingForReload(before); checkpoint.dispose(); before.dispose()
    }
    binding = makeBinding(); current = binding
    const root = document.createElement('section'); document.body.append(root); publishPaneMountedChat(root, control)
    const reading = createSnapshotStore<PaneReadingIntent | undefined>({ revision: 1, sessionId: session.id, target: { kind: 'latest' } })
    const navigation = { hostId: 'host', paneId: 'pane', application, updates, reading,
        state: createSnapshotStore({ visible: true, focused: true }) } as unknown as WorkspacePaneNavigation
    const beforeTiming = Object.getOwnPropertyDescriptor(window.performance, 'getEntriesByType')
    Object.defineProperty(window.performance, 'getEntriesByType', { configurable: true, value: () => [{ type: 'reload' }] })
    let stop = () => {}
    onTestFinished(async () => { stop(); root.remove(); stopMemory(); cache.dispose(); updates.dispose(); application.dispose(); await ctx.fiber.dispose()
        if (beforeTiming) Object.defineProperty(window.performance, 'getEntriesByType', beforeTiming)
        else delete (window.performance as unknown as Record<string, unknown>).getEntriesByType })
    return { requests, reveals, latest, root, reading, session,
        empty() { nodes.clear(); publishPaneMountedChat(root, null) },
        setRead: (value: typeof read) => { read = value }, start() { stop = bindRemotePaneReading(ctx, root,
            { sessionId: binding.sessionId, binding, ready: Promise.resolve(binding), release() {}, [Symbol.dispose]() {} } satisfies SessionReference, navigation) } }
}

test('the actual HHPI pane restores an armed update body instead of its startup default latest; ordinary opens keep latest', async () => {
    const f = await fixture(); f.start()
    await waitFor(() => expect(f.root.dataset.hapiReading).toBe('ready'))
    expect(f.requests).toEqual([{ kind: 'around', target: { key: 'original-body', seq: 12 } }])
    expect(f.reveals).toEqual([{ key: 'original-body', seq: 12 }]); expect(f.latest).toEqual([])
})

test('an unarmed HHPI pane never restores a cached old body on ordinary startup', async () => {
    const f = await fixture(false); f.start()
    await waitFor(() => expect(f.root.dataset.hapiReading).toBe('ready'))
    expect(f.requests).toEqual([]); expect(f.reveals).toEqual([]); expect(f.latest).toHaveLength(1)
})

test('an unarmed welcome view without mounted Chat still reads its normal latest window', async () => {
    const f = await fixture(false); f.empty(); f.start()
    await waitFor(() => expect(f.root.dataset.hapiReading).toBe('ready'))
    expect(f.requests).toEqual([{ kind: 'latest' }]); expect(f.reveals).toEqual([]); expect(f.latest).toEqual([])
})

test('a later explicit latest wins over a pending controlled update restore and ignores its late response', async () => {
    const f = await fixture(), pending = Promise.withResolvers<void>()
    f.setRead(() => pending.promise); f.start()
    await waitFor(() => expect(f.requests).toHaveLength(1))
    f.reading.set({ revision: 2, sessionId: f.session.id, target: { kind: 'latest' } })
    pending.resolve()
    await waitFor(() => expect(f.latest).toHaveLength(1))
    expect(f.reveals).toEqual([])
})

test('failed HHPI update positioning retains its ticket and exposes an explicit retry', async () => {
    const f = await fixture(); f.setRead(async () => { throw Error('Temporary source read failure') }); f.start()
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary source read failure')
    expect(f.reveals).toEqual([])
    f.setRead(async () => {})
    await userEvent.click(screen.getByRole('button', { name: 'Retry reading position' }))
    await waitFor(() => expect(f.root.dataset.hapiReading).toBe('ready'))
    expect(f.requests).toHaveLength(2); expect(f.reveals).toHaveLength(1)
})
