import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';
import { acknowledgePreviewNotice } from './preview-notice.ts';
import { visualReview, conversationReady } from './visual-review.ts';
import { deferredBootStages } from '../src/shared/boot-graph.ts';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules';

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

test('cold conversation does not wait for account assets; deferred activation yields to the reader without remounting the editor', async ({ page }, info) => {
    let environment: OfficialEnvironment | undefined;
    let primaryFailure: unknown;
    let releaseAccount!: () => void;
    const accountGate = new Promise<void>(resolve => { releaseAccount = resolve; });
    let accountRequested = false;
    let accountReceived = false;
    let watchedEntries: string[] = [];
    const requestedEntries: string[] = [];
    const errors: string[] = [];
    const sockets: string[] = [];
    const panelRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => sockets.push(new URL(socket.url()).pathname));
    page.on('request', request => {
        const url = decodeURIComponent(request.url());
        if (/client\.(native-panels|session-panels|administration)\.js/.test(url)) panelRequests.push(url);
        for (const id of watchedEntries) if (url.includes(id)) requestedEntries.push(id);
    });
    page.on('response', response => { if (decodeURIComponent(response.url()).includes('dsh-client-ui-settings-account')) accountReceived = true; });
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
        // Hold while the selected conversation is still opening; awaiting
        // several locator round trips can let the optional work start first.
        await page.mouse.move(700, 300);
        await page.mouse.down();
        const pane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        const editor = pane.locator('[data-composer-input][contenteditable="true"]');
        await expect(pane.locator('[data-chat-node-key]').first()).toBeVisible();
        await expect(editor).toBeVisible();
        // An intentionally stalled optional plugin cannot gate real chat.
        await editor.fill('Keep my draft through deferred plugin activation');
        await editor.evaluate(element => { element.setAttribute('data-cold-editor', 'original'); });
        await page.waitForTimeout(900);
        expect(accountRequested, 'optional plugin evaluation must yield to a held reader gesture').toBe(false);
        const bootstrap = await page.request.get(`${environment.origin}/hapi-dsh/bootstrap`);
        const { graph } = await bootstrap.json() as { graph: WebBootGraph };
        const stages = deferredBootStages(graph);
        const accountStage = stages.find(stage => stage.entries.some(entry => entry.id === '@deepseek-ai/dsh-client-ui-settings-account'));
        expect(accountStage, 'the account plugin must have a deferred activation stage').toBeDefined();
        const allowed = new Set(accountStage!.entries.map(entry => entry.id));
        const laterEntries = graph.entries.filter(entry => !allowed.has(entry.id)).map(entry => entry.id);
        expect(laterEntries.length, 'the fixture must include stages after the held account request').toBeGreaterThan(0);
        watchedEntries = graph.entries.map(entry => entry.id);
        await page.mouse.up();
        await expect.poll(() => accountRequested).toBe(true);
        // A new reader gesture begins after reconciliation already issued its
        // first request. That in-flight dependency closure may finish, but the
        // next optional stage must yield until this finger leaves the page.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 700, y: 300, id: 1 }] });
        releaseAccount();
        await expect.poll(() => accountReceived).toBe(true);
        await page.waitForTimeout(900);
        expect(requestedEntries.filter(id => laterEntries.includes(id)), 'a gesture during one module load must pause later activation stages').toEqual([]);
        await expect(editor).toHaveAttribute('data-cold-editor', 'original');
        await expect(editor).toHaveText('Keep my draft through deferred plugin activation');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForFunction(() => performance.getEntriesByName('hapi:deferred-plugins-ready').length > 0);
        await expect(editor).toHaveAttribute('data-cold-editor', 'original');
        await expect(editor).toHaveText('Keep my draft through deferred plugin activation');
        expect(errors).toEqual([]);
        expect(sockets).toContain('/hapi-dsh/remote.mux');
        expect(sockets).not.toContain('/api/remote.mux');
        // The ready mark is only emitted after the official per-entry failure
        // inventory is empty, not merely after the sync promise resolves.
        expect(await page.evaluate(() => performance.getEntriesByName('hapi:deferred-plugins-ready').length)).toBe(1);
        expect(panelRequests).toEqual([]);
        expect(environment.hapi.sent).toHaveLength(0);
    } catch (error) {
        primaryFailure = error;
        throw error;
    } finally {
        releaseAccount();
        try {
            if (!page.isClosed()) {
                await page.unrouteAll({ behavior: 'wait' });
                await page.close();
            }
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
