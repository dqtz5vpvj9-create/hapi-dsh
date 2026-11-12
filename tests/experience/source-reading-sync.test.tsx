/** Real account owner, reader-commit bus and read coordinator; only app RPC and catalog are fixtures. */
import { expect, onTestFinished, test, vi } from 'vitest'
import type { ConnectionState, ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { WorkspaceApplicationIdentity } from '../../src/client/application-identity.ts'
import { SourceReadCommits } from '../../src/client/source-reading-commit.ts'
import { installWorkspaceReadSync } from '../../src/client/source-reading-sync.ts'
import { sessionResourceId, type WorkspaceController } from '../../src/client/controller.ts'
import type { WorkspaceUiScope } from '../../src/client/workspace-ui.ts'
import { SidebarState } from '../../src/workspace/sidebar-state.ts'
import type { AppReadApi } from '../../src/workspace/read-sync.ts'
import type { AppReadState, AppServiceRequest } from '../../src/workspace/app-service-types.ts'

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const scope = { accountId: 'account', origin: 'https://experience.invalid' }
function fixture() {
    const application = new WorkspaceApplicationIdentity(), readCommits = new SourceReadCommits()
    const sidebar = new SidebarState(localStorage, 'read-test-sidebar'), notices: unknown[] = []
    const row = { id: sessionResourceId('local', 'original'), hostId: 'local', sourceSessionId: 'original', updatedAt: 20 }
    const controller = { sidebar, options: { storage: localStorage, storageKey: 'read-test-workspace' },
        store: { focusedPane: () => ({ resource: { kind: 'chat', sessionId: row.id } }) },
        subscribe: () => () => {}, getSnapshot: () => ({ catalog: { byId: { [row.id]: row } } }), report: (error: unknown) => notices.push(error),
    } as unknown as WorkspaceController
    const listeners = new Set<() => void>()
    let state: ConnectionState = 'connected'
    const connection: ConnectionStateSource = { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const transition = (value: ConnectionState) => { state = value; for (const listener of [...listeners]) listener() }
    const commit = () => readCommits.publish({ hostId: 'local', paneId: 'pane', sessionBinding: { sessionId: 'original' } as SessionBinding,
        position: { kind: 'dsh', seq: 20 }, at: 20 })
    const ui = { application, readCommits } as WorkspaceUiScope
    onTestFinished(() => { application.dispose(); readCommits.dispose() })
    return { application, sidebar, controller, connection, transition, commit, ui, notices, row }
}

test('the real DSH connection reconnect drains a retained reader intent without a global notice or browser online event', async () => {
    vi.useFakeTimers()
    const f = fixture(), writes: AppServiceRequest<'appReadStateWrite'>[] = []
    let reads = 0
    const api: AppReadApi = { appReadStates: async () => { reads++; return { ok: true, value: [null] } },
        appReadState: async () => ({ ok: true, value: null }), appReadStateWrite: async request => {
            writes.push(request)
            const state: AppReadState = { scope, source: request.source, revision: 1, seen: request.intent.kind === 'seen'
                ? { position: request.intent.position, at: request.intent.at } : null, manualUnreadAt: null, lastOperationId: request.operationId }
            return { ok: true, value: { applied: true, state } }
        } }
    f.application.set(scope, 'device')
    const stop = installWorkspaceReadSync(f.controller, api, f.ui, () => {}, f.connection)
    onTestFinished(stop)
    await settle(); expect(reads).toBe(1)
    f.transition('disconnected'); f.commit(); await settle()
    expect(writes).toHaveLength(0); expect(f.sidebar.getSnapshot().seen[f.row.id]).toBe(20)
    f.transition('connecting'); await vi.advanceTimersByTimeAsync(120000)
    expect(reads).toBe(1)
    f.transition('connected'); await settle()
    expect(reads).toBe(2); expect(writes).toHaveLength(1)
    expect(f.sidebar.getSnapshot().readStatus[f.row.id]).toBe('ready')
    expect(f.notices).toHaveLength(0)
    stop(); await vi.advanceTimersByTimeAsync(120000); f.transition('connected'); f.commit(); await settle()
    expect(reads).toBe(2); expect(writes).toHaveLength(1)
})

test('an account switch aborts the old read, keeps its outbox scoped, and rejects a late acknowledgement', async () => {
    const f = fixture(), old = Promise.withResolvers<Awaited<ReturnType<AppReadApi['appReadStates']>>>()
    let oldSignal: AbortSignal | undefined, reads = 0
    const writes: AppServiceRequest<'appReadStateWrite'>[] = []
    const api: AppReadApi = { appReadStates: async (_request, signal) => {
        reads++; if (reads === 1) { oldSignal = signal; return old.promise }; return { ok: true, value: [null] }
    }, appReadState: async () => ({ ok: true, value: null }), appReadStateWrite: async request => { writes.push(request); throw new Error('unexpected write') } }
    f.application.set(scope, 'device')
    const stop = installWorkspaceReadSync(f.controller, api, f.ui, () => {}, f.connection)
    onTestFinished(stop)
    f.commit(); await settle()
    const oldKey = Object.keys(localStorage).find(key => key.includes('app-read-outbox'))!
    const intent = localStorage.getItem(oldKey)
    f.application.set({ ...scope, accountId: 'other-account' }, 'device'); await settle()
    expect(oldSignal?.aborted).toBe(true); expect(writes).toHaveLength(0)
    const source = { kind: 'local-dsh' as const, hostId: 'local', sessionId: 'original' }
    old.resolve({ ok: true, value: [{ scope, source, revision: 1, seen: { position: { kind: 'dsh', seq: 99 }, at: 99 }, manualUnreadAt: null, lastOperationId: 'old' }] })
    await settle()
    expect(f.sidebar.getSnapshot().seen[f.row.id]).not.toBe(99)
    expect(localStorage.getItem(oldKey)).toBe(intent)
    expect(writes).toHaveLength(0); expect(f.notices).toHaveLength(0)
})
