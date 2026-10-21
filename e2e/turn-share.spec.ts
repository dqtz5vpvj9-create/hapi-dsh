/** Actual official DSH DOM, browser canvas, PNG and clipboard. Source rows are fixtures. */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.describe('turn sharing through the official Conversation message action', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });
    test('the selected source turn becomes a real PNG without another pane or its unsent draft', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.origin });
        await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
        await notice.waitFor({ state: 'visible', timeout: 2000 }).catch(() => undefined);
        if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        const alpha = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        const composer = alpha.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true });
        await composer.fill('Private unsent text must not enter the image');
        await page.getByRole('button', { name: 'Split left / right', exact: true }).click();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click();
        const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
        await expect(beta.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toBeVisible();
        await alpha.getByRole('button', { name: 'Share this turn', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Share this turn', exact: true });
        const preview = dialog.locator('[data-hapi-share-preview]');
        await expect(preview).toContainText('Question from Codex TUI — alpha');
        await expect(preview).toContainText('Native history alpha in the official DSH Conversation.');
        await expect(preview).not.toContainText('beta'); await expect(preview).not.toContainText('Private unsent text');
        await expect(preview).not.toContainText('Rewind here');
        await expect(preview.locator('button,input,textarea,iframe,[contenteditable]')).toHaveCount(0);
        await dialog.getByLabel('Machine', { exact: true }).check(); await expect(preview).toContainText('Laptop');
        await dialog.getByLabel('Image width', { exact: true }).selectOption('720');
        const downloaded = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Save PNG', exact: true }).click();
        const file = await downloaded, bytes = await readFile((await file.path())!);
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(bytes.readUInt32BE(16)).toBe(1440); expect(bytes.readUInt32BE(20)).toBeGreaterThan(100);
        expect(file.suggestedFilename()).toMatch(/^hapi-turn-.*\.png$/u);
        await dialog.getByRole('button', { name: 'Copy image', exact: true }).click();
        await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read()).some(value => value.types.includes('image/png')))).toBe(true);
        await dialog.getByRole('button', { name: 'Close share preview', exact: true }).click();
        await expect(composer).toHaveText('Private unsent text must not enter the image');
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([]);
        expect(environment.hapi.require('native-alpha').session.metadata?.codexSessionId).toBe('codex-thread-alpha');
    });
});
