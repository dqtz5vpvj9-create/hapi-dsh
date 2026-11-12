/** Production share entry and navigation; only remote service and public slot registry are fixtures. */
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { onTestFinished, test, expect } from 'vitest'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceController } from '../../src/client/controller.ts'
import { WorkspaceApplicationIdentity } from '../../src/client/application-identity.ts'
import { installWorkspaceSharing } from '../../src/client/source-share-navigation.tsx'
import type { AppShareRecord } from '../../src/workspace/app-service-types.ts'

function fixture() {
    const application = new WorkspaceApplicationIdentity(), scope = { accountId: 'synthetic', origin: location.origin }
    const record: AppShareRecord = { id: 'share-id', scope, visibility: 'account', createdAt: 1,
        target: { kind: 'session', source: { kind: 'local-dsh', hostId: 'local', sessionId: 'original' } } }
    const pending: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = []
    const original = location.href
    const url = new URL(original); url.searchParams.set('hhpiShare', record.id); url.searchParams.set('hhpiShareAccount', scope.accountId); url.searchParams.set('hhpiShareOrigin', scope.origin)
    history.replaceState(null, '', url.href)
    let Overlay!: ComponentType, layout = {}, opened = '', available = true
    const host = { id: 'local' }
    const controller = { host: () => available ? host : undefined, store: { getSnapshot: () => layout,
        focusedPane: () => ({ resource: { kind: 'chat', sessionId: opened } }) },
        openSession(id: string) { opened = id; layout = {} } } as unknown as WorkspaceController
    const ctx = { hapiWorkspaceUi: { application }, remote: { appServices: { appShareResolve: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } },
        locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} }, reflect: { provide: () => () => {} },
        slots: { inject(_name: string, callback: () => () => void) { return callback() }, register(_options: unknown, component: ComponentType) { Overlay = component; return () => {} } },
    } as unknown as Context
    application.set(scope, 'device')
    const dispose = installWorkspaceSharing(ctx, controller), view = render(<Overlay/>)
    onTestFinished(() => { view.unmount(); dispose(); application.dispose(); history.replaceState(null, '', original) })
    return { application, scope, record, pending, opened: () => opened, navigateElsewhere: () => { layout = {} }, offline: () => { available = false }, online: () => { available = true } }
}

test('offline shared target retains its original URL and retries from the visible error', async () => {
    const f = fixture(); f.offline()
    await act(async () => { f.pending.shift()!.resolve({ ok: true, value: f.record }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open this share')
    expect(new URL(location.href).searchParams.get('hhpiShare')).toBe('share-id')
    f.online(); await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { f.pending.shift()!.resolve({ ok: true, value: f.record }) })
    await waitFor(() => expect(f.opened()).toBe('original'))
    expect(new URL(location.href).searchParams.has('hhpiShare')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
})

test('late share resolution cannot replace manual navigation or survive an account change', async () => {
    const f = fixture(); f.navigateElsewhere()
    await act(async () => { f.pending.shift()!.resolve({ ok: true, value: f.record }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('You changed pages')
    expect(f.opened()).toBe('')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const old = f.pending.shift()!
    act(() => { f.application.set({ ...f.scope, accountId: 'another-account' }, 'device') })
    await act(async () => { old.resolve({ ok: true, value: f.record }) })
    expect(f.opened()).toBe('')
    expect(new URL(location.href).searchParams.get('hhpiShare')).toBe('share-id')
    expect(await screen.findByRole('alert')).toHaveTextContent('another authenticated account')
})
