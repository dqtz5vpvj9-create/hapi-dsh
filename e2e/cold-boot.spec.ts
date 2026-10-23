import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';
import { acknowledgePreviewNotice } from './preview-notice.ts';

test.use({ screenshot: 'off' });

test('repeat navigation reuses versioned official shell assets from the browser cache', async ({ page }) => {
    const environment = await startOfficialEnvironment();
    try {
        await page.goto(environment.launchUrl);
        await acknowledgePreviewNotice(page, environment);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        const scripts = () => page.evaluate(() => performance.getEntriesByType('resource')
            .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
            .filter(entry => /\/assets\/(index|vendor)-[\w-]+\.js$/.test(new URL(entry.name).pathname))
            .map(entry => ({ path: new URL(entry.name).pathname, bytes: entry.transferSize })));
        const first = await scripts();
        expect(first.length).toBeGreaterThanOrEqual(2);
        expect(first.every(entry => entry.bytes > 0)).toBe(true);
        await page.reload();
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        const cached = await scripts();
        expect(cached.map(entry => entry.path).sort()).toEqual(first.map(entry => entry.path).sort());
        expect(cached.every(entry => entry.bytes === 0)).toBe(true);
        expect(environment.hapi.sent).toHaveLength(0);
    } finally { await environment.close(); }
});

test('cold conversation does not wait for account assets; full official plugins resume without remounting the editor', async ({ page }) => {
    let environment: OfficialEnvironment | undefined;
    let releaseAccount!: () => void;
    const accountGate = new Promise<void>(resolve => { releaseAccount = resolve; });
    let accountRequested = false;
    const errors: string[] = [];
    const sockets: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => sockets.push(new URL(socket.url()).pathname));
    await page.route('**/plugins/**', async route => {
        if (decodeURIComponent(route.request().url()).includes('dsh-client-ui-settings-account')) {
            accountRequested = true;
            await accountGate;
        }
        await route.continue();
    });
    try {
        environment = await startOfficialEnvironment();
        await page.goto(environment.launchUrl);
        await acknowledgePreviewNotice(page, environment);
        await page.locator('.hapi-session-open, .hapi-discovery-open').filter({ hasText: 'Native Codex alpha' }).click();
        const pane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        const editor = pane.locator('[data-composer-input][contenteditable="true"]');
        await expect(pane.locator('[data-chat-node-key]').first()).toBeVisible();
        await expect(editor).toBeVisible();
        // An intentionally stalled optional plugin cannot gate real chat.
        await editor.fill('Keep my draft through deferred plugin activation');
        await editor.evaluate(element => { element.setAttribute('data-cold-editor', 'original'); });
        await expect.poll(() => accountRequested).toBe(true);
        releaseAccount();
        await page.waitForFunction(() => performance.getEntriesByName('hapi:deferred-plugins-ready').length > 0);
        await expect(editor).toHaveAttribute('data-cold-editor', 'original');
        await expect(editor).toHaveText('Keep my draft through deferred plugin activation');
        expect(errors).toEqual([]);
        expect(sockets).toContain('/hapi-dsh/remote.mux');
        expect(sockets).not.toContain('/api/remote.mux');
        // The ready mark is only emitted after the official per-entry failure
        // inventory is empty, not merely after the sync promise resolves.
        expect(await page.evaluate(() => performance.getEntriesByName('hapi:deferred-plugins-ready').length)).toBe(1);
        expect(environment.hapi.sent).toHaveLength(0);
    } finally {
        releaseAccount();
        await page.unrouteAll({ behavior: 'wait' });
        await environment?.close();
    }
});
