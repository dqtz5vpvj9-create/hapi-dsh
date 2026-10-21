import { acknowledgePreviewNotice } from './preview-notice.ts'
import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.describe('original source titles inside official DSH Session plugins', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });
    test('a generated title requires review and uses the original Session while preserving the draft and native thread', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await acknowledgePreviewNotice(page, environment)
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        const original = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        const paneId = await original.getAttribute('data-pane-id'); expect(paneId).toBeTruthy();
        const pane = page.locator(`[data-pane-id="${paneId}"]`);
        const originalThread = environment.hapi.require('native-alpha').session.metadata!.codexSessionId;
        const composer = pane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true });
        await composer.fill('This unsent task stays in its original composer');
        await pane.getByRole('combobox', { name: 'Conversation tools', exact: true }).selectOption('hapi-session-tools');
        const title = pane.getByRole('region', { name: 'Conversation title', exact: true });
        await title.getByRole('button', { name: 'Suggest a title', exact: true }).click();
        await expect(title.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('A suggested source title');
        expect(environment.hapi.require('native-alpha').session.metadata!.name).toBe('Native Codex alpha');
        await title.getByRole('textbox', { name: 'Title', exact: true }).fill('Reviewed original native title');
        await title.getByRole('button', { name: 'Save title', exact: true }).click();
        await expect(title).toContainText('Title saved by the original Hub.');
        await expect.poll(() => environment.hapi.require('native-alpha').session.metadata!.name).toBe('Reviewed original native title');
        await expect(composer).toHaveText('This unsent task stays in its original composer');
        expect(environment.hapi.require('native-alpha').session.metadata!.codexSessionId).toBe(originalThread);
        environment.hapi.extras.dropNextTitleSuggestionReply = true;
        await title.getByRole('button', { name: 'Suggest a title', exact: true }).click();
        await expect(title.getByRole('alert')).toBeVisible();
        expect(environment.hapi.extras.mutations.filter(row => row.tail === 'title-suggestion')).toHaveLength(2);
        await page.reload(); await expect(pane).toBeVisible();
        await pane.getByRole('combobox', { name: 'Conversation tools', exact: true }).selectOption('hapi-session-tools');
        await expect(title.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Reviewed original native title');
        await expect(composer).toHaveText('This unsent task stays in its original composer');
        expect(environment.hapi.extras.mutations.filter(row => row.tail === 'title-suggestion')).toHaveLength(2);
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([]);
    });
});
