/** Actual settings/slot contribution; locale, browser and authenticated RPC are explicit boundaries. */
import type { ComponentType } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, onTestFinished, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { AppNotificationsApi } from '../../src/notification-types.ts';
import { installSourceNotifications } from '../../src/client/source-notifications/index.tsx';

test.each(['en', 'zh'])('application notification settings mount without any legacy engine catalog (%s)', async language => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const sockets: Array<{ onmessage?: (event: { data: string }) => void }> = [];
    vi.stubGlobal('WebSocket', class {
        static OPEN = 1;
        readyState = 0;
        onclose?: () => void;
        onmessage?: (event: { data: string }) => void;
        constructor() { sockets.push(this); }
        close() { this.onclose?.(); }
    });
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const components = new Map<string, ComponentType>();
    const ctx = { locale: { getSnapshot: () => ({ active: language }), subscribe: () => () => {} }, slots: {
        inject(_name: string, register: () => () => void) { return register(); },
        register(meta: { name: string }, component: ComponentType) { components.set(meta.name, component); return () => components.delete(meta.name); },
    } } as unknown as Context;
    let settings = 0;
    const api: AppNotificationsApi = {
        async appNotificationSettings(request) { settings++; return { ok: true, value: { scope: { accountId: 'synthetic', origin: 'https://workspace.example' },
            deviceId: request.deviceId, vapidPublicKey: null, workerPath: '/hapi-dsh/notifications-worker.js', streamPath: '/hapi-dsh/notifications' } }; },
        async appPushSubscribe() { throw new Error('No browser permission was requested'); },
        async appPushUnsubscribe() { throw new Error('No browser subscription exists'); },
        async appNotificationResolve() { throw new Error('The original machine is offline.'); },
    };
    const dispose = installSourceNotifications(ctx, api, { getUnreadCount: () => 0, subscribeUnread: () => () => {}, openSource() {} });
    onTestFinished(dispose);
    const Settings = components.get('settings.section')!;
    const Overlay = components.get('shell.overlay')!;
    const view = render(<><Settings/><Overlay/></>); onTestFinished(() => view.unmount());
    await waitFor(() => expect(settings).toBe(1));
    expect(screen.getByRole('heading', { name: language === 'zh' ? '通知与安装' : 'Notifications and installation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: language === 'zh' ? '启用 Push 通知' : 'Enable Push notifications' })).toBeDisabled();
    expect(screen.queryByText(/original HAPI task|原 HAPI 任务/u)).not.toBeInTheDocument();
    await waitFor(() => expect(sockets.length).toBe(1));
    act(() => sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'notification', notification: {
        id: 'synthetic-notice', scope: { accountId: 'synthetic', origin: 'https://workspace.example' }, kind: 'completed',
        title: 'Task completed', body: '', createdAt: Date.now(), target: { kind: 'reading',
            source: { kind: 'local-dsh', hostId: 'local', sessionId: 'unopened-task' }, position: { kind: 'dsh', seq: 8 } },
    } }) }));
    await userEvent.click(screen.getByRole('button', { name: language === 'zh' ? '打开会话' : 'Open conversation' }));
    await waitFor(() => expect(screen.getByText(language === 'zh' ? '暂时无法打开这条通知' : 'Could not open this notification')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: language === 'zh' ? '重试' : 'Retry' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: language === 'zh' ? '关闭跳转提示' : 'Dismiss navigation error' }));
    expect(screen.queryByText(language === 'zh' ? '暂时无法打开这条通知' : 'Could not open this notification')).not.toBeInTheDocument();
    dispose(); expect(components.size).toBe(0);
});
