/** Production slot installer, task panel/state/ledger; slots/RPC/IDB and primitive presentation are boundaries. jsdom does not verify layout or native Modal focus. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { ComponentType } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts';
import type { SourceSession } from '../../src/remote/protocol.ts';
import type { CodexCall } from '../../src/remote/codex-access.ts';
import type { RemoteSourceSession } from '../../src/client/remote-sessions.ts';
import { NativeActionOwner } from '../../src/client/remote-native-actions.ts';
import { SourceDirectory } from '../../src/client/source-capabilities.ts';
import { installSourceTaskEntry } from '../../src/client/source-task-entry.tsx';
import { memoryOperations } from '../fixtures/operation-transactions.ts';
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives);

test('the native task entry uses its rendered binding, submits to that thread and closes when its Pane is hidden', async () => {
    const calls = vi.fn(async (_call: CodexCall) => ({ status: 'accepted' as const, message: 'Applied by native source' }));
    const actions = new NativeActionOwner({ call: calls, receipt: calls }, { createLedger: memoryOperations });
    actions.setStorage({ scope: 'task-entry-account', storage: localStorage });
    const api = { async nativeCapabilities() { return { ok: true, value: { methods: { 'thread/queue/list': 'read', 'thread/goal/get': 'read', 'thread/goal/set': 'write' }, unavailable: {} } }; },
        async nativeCall(request: CodexCall) { return { ok: true, value: { status: 'accepted', result: request.method === 'thread/queue/list' ? { data: [], nextCursor: null }
            : { goal: { threadId: request.params?.threadId, objective: 'Pane objective', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null } } } }; } } as unknown as HhpiRemoteApi;
    const directory = new SourceDirectory(api, 'source');
    const metadata = { id: 'hhpi:machine:source:codex:rendered-pane', sourceId: 'source', nativeId: 'rendered-pane', status: 'idle' } as SourceSession;
    const session = { sessionId: metadata.id, nativeActions: actions, metadata: { getSnapshot: () => metadata, subscribe: () => () => {} }, sourceDirectory: () => directory } as unknown as RemoteSourceSession;
    const binding = vi.fn(() => { throw new Error('The canonical lookup must not replace a rendered binding'); });
    let Entry!: ComponentType<PropsRuntime<'hapi.source.composer-tools'>>;
    let paneState = { visible: true, focused: true }; const listeners = new Set<() => void>();
    const pane = { state: { getSnapshot: () => paneState, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } };
    const ctx = { get: () => pane, remote: { hhpi: api }, sessions: { binding }, locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
        slots: { inject: (_name: string, setup: () => () => void) => setup(), register: (_options: unknown, component: typeof Entry) => { Entry = component; return () => {}; } } } as unknown as Context;
    const stop = installSourceTaskEntry(ctx);
    const props = { source: { sessionId: metadata.id, sessionBinding: { session } } } as unknown as PropsRuntime<'hapi.source.composer-tools'>;
    const view = render(<Entry {...props}/>);
    try {
        fireEvent.click(screen.getByRole('button', { name: 'Queue & Goal' }));
        expect(await screen.findByRole('dialog', { name: 'Queue & Goal' })).toBeVisible();
        await screen.findByText('Pane objective');
        expect(screen.queryByRole('textbox', { name: 'Goal objective' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }));
        await waitFor(() => expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveValue('Pane objective'));
        fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), { target: { value: 'User objective' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
        await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
        expect(calls.mock.calls[0]?.[0].params).toMatchObject({ threadId: 'rendered-pane', objective: 'User objective' });
        expect(binding).not.toHaveBeenCalled();
        act(() => actions.setStorage({ scope: 'replacement-account', storage: localStorage }));
        expect(await screen.findByText(/This account or source changed/)).toBeVisible();
        expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
        expect(screen.queryByRole('textbox', { name: 'Goal objective' })).toBeNull();
        act(() => { paneState = { visible: false, focused: false }; listeners.forEach(listener => listener()); });
        expect(screen.queryByRole('dialog', { name: 'Queue & Goal' })).toBeNull();
    } finally { view.unmount(); stop(); directory.dispose(); actions.dispose(); }
});
