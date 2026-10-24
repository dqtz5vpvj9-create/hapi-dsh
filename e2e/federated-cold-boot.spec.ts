import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';
import { acknowledgePreviewNotice } from './preview-notice.ts';
import { conversationReady, visualReview } from './visual-review.ts';

test.use({ screenshot: 'off' });
test.setTimeout(180_000);

test('a restored remote conversation skips Account and reuses immutable artifacts after reload', async ({ page }, info) => {
    let environment: OfficialEnvironment | undefined;
    const errors: string[] = [];
    const optional: string[] = [];
    const timings: number[] = [];
    let catalogRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        const url = decodeURIComponent(request.url());
        if (url.endsWith('/hapi-dsh/machine/runner-one/api/session/list')) catalogRequests++;
        if (url.includes('/machine/runner-one/plugins/') && /dsh-client-(ui-settings-account|hmr)\//.test(url)) optional.push(url);
    });
    try {
        environment = await startOfficialEnvironment(true);
        const sessionId = `hapi-remote:runner-one:${environment.remoteSessionId}`;
        await page.addInitScript(sessionId => {
            // The official web Settings shortcut is declared for Windows/macOS,
            // not Linux. Exercise its Windows mapping on this Linux test host.
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            const state = { schemaVersion: 1, revision: 0, windows: [{ id: 'cold-window', name: 'W1', autoName: true,
                root: { type: 'pane', id: 'cold-pane', resource: { kind: 'chat', sessionId } } }],
                activeWindowId: 'cold-window', focused: { 'cold-window': 'cold-pane' }, zoomed: {} };
            localStorage.setItem(`hapi-dsh:workspace:v1:${location.origin}${location.pathname}`, JSON.stringify(state));
            performance.setResourceTimingBufferSize(2000);
        }, sessionId);
        await page.goto(environment.launchUrl);
        await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' });
        const pane = page.getByRole('region', { name: 'Pane: DSH remote conversation', exact: true });
        const editor = pane.locator('[data-composer-input][contenteditable="true"]');
        const ready = async () => {
            await expect(pane.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible();
            await expect(editor).toBeVisible();
            timings.push(await page.evaluate(() => performance.now()));
        };
        const artifacts = () => page.evaluate(() => performance.getEntriesByType('resource')
            .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
            .filter(entry => new URL(entry.name).pathname.startsWith('/hapi-dsh/machine/runner-one/plugins/'))
            .map(entry => ({ path: entry.name, bytes: entry.transferSize })));
        await ready();
        expect(optional).toEqual([]);
        expect(catalogRequests, 'one connection generation owns the initial remote catalog pull').toBe(1);
        const first = await artifacts();
        expect(first.length).toBeGreaterThan(10);
        expect(first.every(entry => entry.bytes > 0)).toBe(true);
        await editor.fill('Remote draft survives cached reload');
        await expect(page.locator('.hapi-persistence-saved')).toBeVisible();
        catalogRequests = 0;
        await page.reload();
        await ready();
        await expect(editor).toHaveText('Remote draft survives cached reload');
        expect(optional).toEqual([]);
        expect(catalogRequests).toBe(1);
        const cached = await artifacts();
        expect(cached.map(entry => entry.path).sort()).toEqual(first.map(entry => entry.path).sort());
        expect(cached.every(entry => entry.bytes === 0), 'remote versioned plugins must use the browser HTTP cache').toBe(true);
        expect(errors).toEqual([]);
        expect(environment.hapi.sent).toHaveLength(0);
        await info.attach('remote-navigation', { body: JSON.stringify({ coldMs: timings[0], cachedMs: timings[1],
            firstBytes: first.reduce((sum, row) => sum + row.bytes, 0), cachedBytes: cached.reduce((sum, row) => sum + row.bytes, 0) }), contentType: 'application/json' });
        // A shortcut from the remote editor belongs to that Host's official
        // Settings shell. Its deferred graph must use the remote transport too.
        await editor.press('Control+Alt+Comma');
        const settings = page.locator('[data-shortcut-modal="settings"]');
        await expect(settings).toBeVisible();
        await expect.poll(() => optional.some(url => url.includes('dsh-client-ui-settings-account/'))).toBe(true);
        await expect.poll(() => page.evaluate(() => performance.getEntriesByName('hapi:deferred-plugins-ready').length)).toBeGreaterThan(0);
        await page.keyboard.press('Escape');
        await expect(settings).toBeHidden();
        await expect(editor).toHaveText('Remote draft survives cached reload');
        expect(errors).toEqual([]);
        for (const viewport of ['1440x900', '390x844']) {
            const path = await visualReview(environment.launchUrl, 'federated-cold', viewport, conversationReady('DSH remote conversation'));
            if (path) await info.attach(`visual-${viewport}`, { path, contentType: 'image/png' });
        }
    } finally {
        if (environment) await info.attach('host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' });
        await environment?.close();
    }
});

test('remote viewport opening keeps older paging, live updates and reconnect history intact', async ({ page }, info) => {
    const environment = await startOfficialEnvironment(true);
    const sessionId = environment.remoteSessionId!;
    const followLimits: number[] = [];
    page.on('websocket', socket => {
        if (new URL(socket.url()).searchParams.get('machine') !== 'runner-one') return;
        socket.on('framesent', frame => {
            const wire = JSON.parse(frame.payload.toString());
            if (wire.type === 'open' && wire.endpoint === 'session/follow' && wire.payload.args.request.address.sessionId === sessionId) {
                followLimits.push(wire.payload.args.request.maxMessages);
            }
        });
    });
    const idle = async () => expect.poll(async () => {
        const result = await environment.remoteRpc!<{ items: Array<{ sessionId: string; running: boolean }> }>('session/list');
        return result.items.find(row => row.sessionId === sessionId)?.running;
    }).toBe(false);
    try {
        await idle();
        for (let i = 0; i < 12; i++) {
            await environment.remoteRpc!('session/prompt', { sessionId, requestId: `cold-history-${i}`, mode: 'queue',
                content: [{ type: 'text', text: `Remote history ${i}` }] });
            await idle();
        }
        await page.goto(environment.launchUrl);
        await acknowledgePreviewNotice(page, environment);
        await page.locator('.hapi-session-open').filter({ hasText: 'DSH remote conversation' }).click();
        const pane = page.getByRole('region', { name: 'Pane: DSH remote conversation', exact: true });
        const editor = pane.locator('[data-composer-input][contenteditable="true"]');
        await expect(pane.getByText('Remote history 11', { exact: true })).toBeVisible();
        expect(followLimits).toEqual([20]);
        await expect(pane.getByText('Remote DSH seed prompt', { exact: true })).toHaveCount(0);
        await editor.fill('Draft survives remote history and reconnection');
        const port = pane.locator('[data-conversation-scroll]');
        const box = await port.boundingBox();
        if (!box) throw new Error('Remote conversation has no scrollport');
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
        // Continue reader input across the tail-to-history transition; one
        // giant wheel event can precede the official reader releasing its tail.
        await expect.poll(async () => {
            await page.mouse.wheel(0, -400);
            return pane.getByText('Remote DSH seed prompt', { exact: true }).count();
        }, { intervals: [200], timeout: 20_000 }).toBe(1);
        const before = followLimits.length;
        await page.context().setOffline(true);
        await page.waitForTimeout(500);
        await page.context().setOffline(false);
        await expect.poll(() => followLimits.length).toBeGreaterThan(before);
        expect(followLimits.at(-1)).toBe(500);
        await expect(pane.getByText('Remote DSH seed prompt', { exact: true })).toBeAttached();
        await expect(editor).toHaveText('Draft survives remote history and reconnection');
        await environment.remoteRpc!('session/prompt', { sessionId, requestId: 'cold-history-live', mode: 'queue',
            content: [{ type: 'text', text: 'Remote live update after reconnect' }] });
        await expect(pane.getByText('Remote live update after reconnect', { exact: true })).toBeAttached();
        expect(environment.hapi.sent).toHaveLength(0);
    } finally {
        await info.attach('host-diagnostics', { body: environment.diagnostics(), contentType: 'text/plain' });
        await environment.close();
    }
});
