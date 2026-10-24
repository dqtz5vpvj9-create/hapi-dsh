import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';
import { acknowledgePreviewNotice } from './preview-notice.ts';
import { visualReview, conversationReady } from './visual-review.ts';

test.use({ screenshot: 'off', hasTouch: true });

test('repeat navigation reuses versioned official shell assets from the browser cache', async ({ page }) => {
    const environment = await startOfficialEnvironment();
    try {
        await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
                document.documentElement.dataset.bootScrollBoundary = [document.documentElement, document.body]
                    .map(node => getComputedStyle(node).overscrollBehaviorY).join('/');
            }, { once: true });
        });
        await page.goto(environment.launchUrl);
        await acknowledgePreviewNotice(page, environment);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        // The HTML carrier must establish this boundary before large Client
        // modules arrive, including while the workspace preview is showing.
        await expect(page.locator('html')).toHaveAttribute('data-boot-scroll-boundary', 'none/none');
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

test('cold conversation keeps account assets on demand; opening native Settings loads them without losing the draft', async ({ page }, info) => {
    let environment: OfficialEnvironment | undefined;
    let primaryFailure: unknown;
    let releaseAccount!: () => void;
    const accountGate = new Promise<void>(resolve => { releaseAccount = resolve; });
    let accountRequests = 0;
    let hmrRequests = 0;
    await page.addInitScript(() => {
        Reflect.set(window, '__coldAccountLoads', 0);
        document.addEventListener('load', event => {
            if (event.target instanceof HTMLScriptElement && decodeURIComponent(event.target.src).includes('dsh-client-ui-settings-account')) {
                Reflect.set(window, '__coldAccountLoads', Reflect.get(window, '__coldAccountLoads') + 1);
            }
        }, true);
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        const url = decodeURIComponent(request.url());
        if (url.includes('dsh-client-hmr/client.js')) hmrRequests++;
    });
    await page.route('**/plugins/**', async route => {
        if (decodeURIComponent(route.request().url()).includes('dsh-client-ui-settings-account/client.js')) {
            accountRequests++;
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
        await editor.fill('Keep my draft through explicit account activation');
        await editor.evaluate(element => { element.setAttribute('data-cold-editor', 'original'); });
        await page.waitForFunction(() => performance.getEntriesByName('hapi:conversation-plugins-ready').length > 0);
        // Surpass the old 600 ms quiet-reader trigger. Neither account nor HMR
        // may bring late global locale updates back into a resting transcript.
        await page.waitForTimeout(1500);
        expect(accountRequests).toBe(0);
        expect(hmrRequests).toBe(0);
        expect(await page.evaluate(() => performance.getEntriesByName('hapi:deferred-plugins-ready').length)).toBe(0);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const settings = page.locator('[data-shortcut-modal="settings"]');
        await expect(settings).toBeVisible();
        await expect.poll(() => accountRequests).toBe(1);
        await expect(editor).toHaveAttribute('data-cold-editor', 'original');
        await expect(editor).toHaveText('Keep my draft through explicit account activation');
        await page.keyboard.press('Escape');
        await expect(settings).not.toBeVisible();
        releaseAccount();
        await page.waitForTimeout(1000);
        expect(await page.evaluate(() => Reflect.get(window, '__coldAccountLoads')),
            'closing Settings while its download is pending must not activate Account over the reader').toBe(0);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(settings).toBeVisible();
        await page.waitForFunction(() => performance.getEntriesByName('hapi:deferred-plugins-ready').length > 0);
        expect(accountRequests, 'official activation reuses its preloaded account bundle').toBe(1);
        await page.keyboard.press('Escape');
        await expect(settings).not.toBeVisible();
        await page.getByRole('button', { name: 'Account menu', exact: true }).click();
        await expect(page.getByRole('menuitem', { name: 'Sign in', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(editor).toHaveAttribute('data-cold-editor', 'original');
        await expect(editor).toHaveText('Keep my draft through explicit account activation');
        expect(errors).toEqual([]);
        expect(environment.hapi.sent).toHaveLength(0);
    } catch (error) { primaryFailure = error; throw error; }
    finally {
        releaseAccount();
        try {
            if (!page.isClosed()) { await page.unrouteAll({ behavior: 'wait' }); await page.close(); }
            if (environment) for (const viewport of ['1440x900', '390x844']) {
                const path = await visualReview(environment.launchUrl, 'cold-conversation', viewport, conversationReady('Native Codex alpha'));
                if (path) await info.attach(`visual-${viewport}`, { path, contentType: 'image/png' });
            }
        } catch (error) {
            if (!primaryFailure) throw error;
            await info.attach('visual-cleanup-error', { body: String(error), contentType: 'text/plain' });
        } finally { await environment?.close(); }
    }
});
