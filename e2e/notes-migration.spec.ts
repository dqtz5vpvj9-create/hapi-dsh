import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.describe('original browser notes inside the official DSH workspace', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });
    test('nonempty Hub notes, attachments, conflicting IDs and a lost reply migrate without overwriting or sending chat', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        const bytes = Buffer.from('Original retained scratchlist bytes');
        const attachment = environment.hapi.extras.seedAttachment('native-alpha', 'legacy-kept.txt', bytes);
        environment.hapi.extras.notes.set('native-alpha', new Map([['same-note-id', { entryId: 'same-note-id', text: 'The current Hub note', createdAt: 1234, updatedAt: 5678, attachments: [] }]]));
        const raw = JSON.stringify([
            { id: 'old-local-note', text: '  Preserve my original local note  ', createdAt: 1000, attachments: [attachment] },
            { id: 'same-note-id', text: 'The independent local version', createdAt: 1234 },
            { id: 'unrepaired', text: 'Keep this broken attachment in backup', createdAt: 2000, attachments: [{ filename: 'invalid-metadata.png' }] },
        ]);
        await page.addInitScript(value => { localStorage.setItem('hapi.scratchlist.v1.native-alpha', value); }, raw);
        await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
        if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        const pane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        const tools = pane.getByRole('combobox', { name: 'Conversation tools', exact: true }); await tools.selectOption('hapi-notes');
        const notes = pane.getByRole('region', { name: 'Scratchlist', exact: true });
        const migration = notes.getByRole('region', { name: 'Original notes migration', exact: true });
        await expect(migration).toContainText('e2e-native-hub / native-alpha');
        await expect(migration).toContainText('Some entries need manual repair');
        await migration.getByRole('button', { name: 'Import remaining notes', exact: true }).click();
        await expect(migration).toContainText('1 / 2 resolved');
        await expect(migration).toContainText('The Hub already has a different note');
        expect(environment.hapi.extras.notes.get('native-alpha')?.get('same-note-id')?.text).toBe('The current Hub note');
        expect(environment.hapi.extras.notes.get('native-alpha')?.get('old-local-note')?.createdAt).toBe(1000);
        expect(environment.hapi.sent).toHaveLength(0);
        const downloading = page.waitForEvent('download');
        await notes.getByRole('link', { name: 'legacy-kept.txt', exact: true }).click();
        const file = await downloading; expect(await readFile((await file.path())!)).toEqual(bytes);
        await migration.getByText('Compare existing Hub version', { exact: true }).click();
        await expect(migration).toContainText('The current Hub note');
        await migration.getByRole('button', { name: 'Keep both as separate notes', exact: true }).click();
        environment.hapi.extras.dropNextNoteReply = true;
        await migration.getByRole('button', { name: 'Import remaining notes', exact: true }).click();
        await expect(migration).toContainText('2 / 2 resolved');
        expect(environment.hapi.extras.notes.get('native-alpha')?.size).toBe(3);
        expect(environment.hapi.extras.mutations.filter(row => row.method === 'POST' && row.tail === 'scratchlist')).toHaveLength(2);
        const downloadingBackup = page.waitForEvent('download');
        await migration.getByRole('button', { name: 'Download original backup', exact: true }).click();
        const backup = await downloadingBackup; expect(await readFile((await backup.path())!, 'utf8')).toBe(raw);
        expect(await page.evaluate(() => localStorage.getItem('hapi.scratchlist.v1.native-alpha'))).toBe(raw);
        await page.reload(); await expect(pane).toBeVisible(); await tools.selectOption('hapi-notes');
        await expect(migration).toContainText('2 / 2 resolved');
        expect(environment.hapi.extras.mutations.filter(row => row.method === 'POST' && row.tail === 'scratchlist')).toHaveLength(2);
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([]);
        await expect(page.locator('iframe')).toHaveCount(0);
    });
});
