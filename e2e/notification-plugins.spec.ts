/** Real official DSH shell, original HAPI SSE and real worker registration.
 * Browser-issued Push endpoints and OS badging below are explicit protocol fixtures. */
import { test, expect, type Page } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

async function admit(page: Page, environment: OfficialEnvironment) {
    await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
    const preview = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
    if (await preview.isVisible()) await preview.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function settings(page: Page) {
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: false }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('button', { name: 'Notifications and installation', exact: true }).click();
    return dialog;
}

test.describe('original source notifications through one official workspace owner', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });

    test('unconfigured Push does not prevent real SSE toasts, exact source navigation or worker registration and never prompts on page load', async ({ page }, info) => {
        environment.hapi.notifications.pushConfigured = false;
        expect(environment.hapi.notifications.opened[0]?.visibility).toBe('hidden');
        await page.addInitScript(() => {
            const facts = { permissionRequests: 0 }; Object.assign(window, { __hapiNotificationPermission: facts });
            const original = Notification.requestPermission.bind(Notification);
            Notification.requestPermission = (...args) => { facts.permissionRequests++; return original(...args); };
        });
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await admit(page, environment);
        await expect.poll(() => environment.hapi.notifications.isVisible()).toBe(true);
        await expect.poll(() => page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration(new URL('.', document.baseURI));
            return registration?.active?.scriptURL ?? null;
        })).toContain('/hapi-dsh/notifications-worker.js');
        expect(await page.evaluate(() => (window as unknown as { __hapiNotificationPermission: { permissionRequests: number } }).__hapiNotificationPermission.permissionRequests)).toBe(0);
        expect(environment.hapi.notifications.subscriptions).toHaveLength(0);
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        environment.hapi.emit({ type: 'toast', data: { title: 'Original beta task ready', body: 'Notification from the original source event stream',
            sessionId: 'native-beta', url: 'https://foreign.invalid/not-a-navigation-target' } });
        const overlay = page.locator('.hapi-notification-stack'); await expect(overlay.getByText('Original beta task ready', { exact: true })).toBeVisible();
        await overlay.getByRole('button', { name: 'Open conversation', exact: true }).click();
        const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
        await expect(beta.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toBeVisible();
        expect(new URL(page.url()).origin).toBe(environment.origin);
        expect(environment.hapi.sent).toHaveLength(0);
        const dialog = await settings(page);
        await expect(dialog.getByText('The original Hub could not provide a Push public key. Check its Push configuration or connection, then explicitly enable notifications again.', { exact: true })).toBeVisible();
        await expect(dialog.getByText('Original Hub notification stream connected.', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __hapiNotificationPermission: { permissionRequests: number } }).__hapiNotificationPermission.permissionRequests)).toBe(0);
        await page.screenshot({ path: `${info.outputDir}/official-notification-source.png`, fullPage: true });
        expect(errors).toEqual([]); await page.close();
        await expect.poll(() => environment.hapi.notifications.isVisible()).toBe(false);
    });

    test('explicit Push admission preserves an unknown write and uses actual worker identity while badge preferences drive the shared unread count', async ({ page }, info) => {
        environment.hapi.notifications.pushConfigured = true;
        const oldRead = environment.hapi.readStates['native-alpha']!;
        environment.hapi.readStates['native-alpha'] = { ...oldRead, manualUnreadAt: Date.now(), version: oldRead.version + 1 };
        // Only the external browser Push service and OS badge APIs are fixtures.
        // The service worker, public DSH slots, original HTTP and SSE stay real.
        await page.addInitScript(() => {
            const facts = { permission: 'default' as NotificationPermission, permissions: 0, subscribes: 0, unsubscribes: 0, badges: [] as number[] };
            Object.assign(window, { __hapiNotificationBrowser: facts });
            let subscription: PushSubscription | null = null;
            Object.defineProperty(Notification, 'permission', { configurable: true, get: () => facts.permission });
            Notification.requestPermission = async () => { facts.permissions++; facts.permission = 'granted'; return 'granted'; };
            PushManager.prototype.getSubscription = async () => subscription;
            PushManager.prototype.subscribe = async function (options) {
                facts.subscribes++; const endpoint = `https://push.fixture.invalid/browser-${facts.subscribes}`;
                const value = { endpoint, options,
                    toJSON: () => ({ endpoint, keys: { p256dh: 'P'.repeat(88), auth: 'A'.repeat(24) } }),
                    unsubscribe: async () => { facts.unsubscribes++; if (subscription === value) subscription = null; return true; },
                } as unknown as PushSubscription;
                subscription = value; return value;
            };
            Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
            Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: async (value = 0) => { facts.badges.push(value); } });
            Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: async () => { facts.badges.push(0); } });
        });
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await admit(page, environment); const dialog = await settings(page);
        const before = environment.hapi.notifications.subscriptions.length;
        expect(await page.evaluate(() => (window as unknown as { __hapiNotificationBrowser: { permissions: number } }).__hapiNotificationBrowser.permissions)).toBe(0);
        environment.hapi.notifications.dropNextSubscribeReply = true;
        await dialog.getByRole('button', { name: 'Enable Push notifications', exact: true }).click();
        await expect.poll(() => environment.hapi.notifications.subscriptions.length).toBe(before + 1);
        await expect(dialog.getByText('A browser subscription may exist, but Hub registration is not confirmed. No request has been automatically repeated.', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Refresh browser status', exact: true }).click();
        expect(environment.hapi.notifications.subscriptions).toHaveLength(before + 1);
        await dialog.getByRole('button', { name: 'Register this browser explicitly', exact: true }).click();
        await expect(dialog.getByText('This browser subscription was accepted by the original Hub.', { exact: true })).toBeVisible();
        expect(environment.hapi.notifications.subscriptions).toHaveLength(before + 2);
        expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('push.fixture.invalid') || value.includes('P'.repeat(32)) || value.includes('A'.repeat(24))))).toBe(false);
        const badge = dialog.getByLabel('Show the unified sidebar unread count', { exact: true }); await badge.check();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __hapiNotificationBrowser: { badges: number[] } }).__hapiNotificationBrowser.badges.some(value => value > 0))).toBe(true);
        await badge.uncheck();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __hapiNotificationBrowser: { badges: number[] } }).__hapiNotificationBrowser.badges.at(-1))).toBe(0);
        await dialog.getByRole('button', { name: 'Disable Push notifications', exact: true }).click();
        await expect(dialog.getByText('Push notifications are off for this browser.', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __hapiNotificationBrowser: { permissions: number } }).__hapiNotificationBrowser.permissions)).toBe(1);
        await page.screenshot({ path: `${info.outputDir}/official-notification-admission.png`, fullPage: true }); expect(errors).toEqual([]);
    });
});
