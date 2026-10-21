import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Real official Web/QR/clipboard integration; the HAPI wire and HTTPS alias are explicit fixtures. */
import { test, expect, type Page } from '@playwright/test';
import { sourceCompanionInfoSchema } from '../src/source-companion-types.ts';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

const companionUrl = 'https://companion-fixture.invalid';
const revealRoute = '**/api/hapi/sourceCompanionReveal';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function openSettings(page: Page) {
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: false }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Companion', exact: true }).click();
    const panel = settings.getByRole('region', { name: 'HAPI Companion pairing', exact: true });
    await expect(panel.getByRole('button', { name: 'Refresh pairing details', exact: true })).toBeEnabled();
    return { settings, panel };
}
async function launch(page: Page, environment: OfficialEnvironment) {
    await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
    await acknowledgePreviewNotice(page, environment)
}

test.describe('original Companion pairing in the official Settings shell', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(false, { companionUrl }); });
    test.afterAll(async () => { await environment?.close(); });

    test('explicit owner reveal uses a local QR and exact original token, copy works, and hiding or changing sections removes the link', async ({ page, context }) => {
        const errors: string[] = [], external: string[] = []; let reveals = 0;
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (new URL(request.url()).pathname === '/api/hapi/sourceCompanionReveal') reveals++;
            if (request.url().startsWith(companionUrl)) external.push(request.url());
        });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.origin });
        await launch(page, environment);
        const metadataResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/hapi/sourceCompanionInfo');
        const { settings, panel } = await openSettings(page);
        const metadataText = await (await metadataResponse).text();
        const metadataWire = JSON.parse(metadataText) as { result: { value: unknown } };
        const metadata = sourceCompanionInfoSchema.parse(metadataWire.result.value);
        expect(metadata.sourceUrl).toBe(environment.hapi.url); expect(metadata.endpoint).toEqual({ url: companionUrl, origin: 'configured' });
        expect(metadataText).not.toContain(environment.hapi.accessToken); expect(metadataText).not.toContain('hapicompanion://');
        expect(reveals).toBe(0); await expect(panel.getByRole('textbox', { name: 'Companion pairing link', exact: true })).toHaveCount(0);
        await panel.getByRole('button', { name: 'Show pairing QR', exact: true }).click();
        const input = panel.getByRole('textbox', { name: 'Companion pairing link', exact: true });
        await expect(input).toBeVisible(); const value = await input.inputValue(), link = new URL(value);
        expect(link.protocol).toBe('hapicompanion:'); expect(link.hostname).toBe('bind');
        expect(link.searchParams.get('hub')).toBe(companionUrl); expect(link.searchParams.get('code')).toBe(environment.hapi.accessToken);
        const image = panel.getByRole('img', { name: 'Companion pairing QR code', exact: true });
        await expect(image).toBeVisible(); expect(await image.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
        await expect.poll(() => image.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
        await panel.getByRole('button', { name: 'Copy pairing link', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Link copied', exact: true })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);
        const persisted = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
        expect(persisted).not.toContain(environment.hapi.accessToken); expect(persisted).not.toContain('hapicompanion://');
        await panel.getByRole('button', { name: 'Hide pairing link', exact: true }).click();
        await expect(input).toHaveCount(0); await expect(image).toHaveCount(0); expect(reveals).toBe(1);
        await panel.getByRole('button', { name: 'Show pairing QR', exact: true }).click(); await expect(input).toBeVisible();
        await settings.getByRole('button', { name: 'General', exact: true }).click(); await expect(input).toHaveCount(0);
        await settings.getByRole('button', { name: 'Companion', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Show pairing QR', exact: true })).toBeEnabled();
        await expect(input).toHaveCount(0); expect(reveals).toBe(2); expect(external).toEqual([]); expect(errors).toEqual([]);
    });

    test('hiding and closing Settings while an actual reveal response is delayed cannot resurrect its credential', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await launch(page, environment); let view = await openSettings(page);
        for (const close of ['hide', 'close'] as const) {
            const ready = deferred(), release = deferred();
            await page.route(revealRoute, async route => {
                const response = await route.fetch(); ready.resolve(); await release.promise;
                await route.fulfill({ response });
            });
            await view.panel.getByRole('button', { name: 'Show pairing QR', exact: true }).click(); await ready.promise;
            if (close === 'hide') await view.panel.getByRole('button', { name: 'Hide pairing link', exact: true }).click();
            else await view.settings.getByRole('button', { name: 'Close', exact: true }).click();
            const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/hapi/sourceCompanionReveal');
            release.resolve(); await received; await page.unroute(revealRoute);
            if (close === 'close') view = await openSettings(page);
            await expect(view.panel.getByRole('button', { name: 'Show pairing QR', exact: true })).toBeEnabled();
            await expect(view.panel.getByRole('textbox', { name: 'Companion pairing link', exact: true })).toHaveCount(0);
            await expect(view.panel.getByRole('img', { name: 'Companion pairing QR code', exact: true })).toHaveCount(0);
        }
        expect(errors).toEqual([]);
    });
});

test('an HTTP source without a configured HTTPS origin explains the native limitation and never exports a credential', async ({ page }) => {
    const environment = await startOfficialEnvironment(); let reveals = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/hapi/sourceCompanionReveal') reveals++; });
    try {
        await launch(page, environment); const { panel } = await openSettings(page);
        await expect(panel).toContainText('The source connection uses HTTP.');
        await expect(panel).toContainText('hapi.companionUrl');
        await expect(panel.getByRole('button', { name: 'Show pairing QR', exact: true })).toBeDisabled();
        await expect(panel.getByRole('textbox', { name: 'Companion pairing link', exact: true })).toHaveCount(0);
        await panel.getByRole('button', { name: 'Refresh pairing details', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Refresh pairing details', exact: true })).toBeEnabled();
        expect(reveals).toBe(0); expect(await panel.textContent()).not.toContain(environment.hapi.accessToken);
    } finally { await environment.close(); }
});
