import { openConversationTool } from './conversation-tools.ts';
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';
import { visualReview } from './visual-review.ts';

test.describe('HAPI capabilities in ordinary official DSH plugin tabs', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });

    test('notes use the actual composer, history anchors the official row, and schedules recover without another send', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        try {
            await page.goto(environment.launchUrl);
            await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
            await acknowledgePreviewNotice(page, environment)
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
            const pane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
            await pane.getByRole('textbox', { name: /Message or run a task/ }).fill('Keep the existing conversation draft');
            const tool = (label: string) => openConversationTool(page, 'Native Codex alpha', label);
            const notesPane = await tool('Scratchlist');
            const notes = notesPane.getByRole('region', { name: 'Scratchlist', exact: true });
            await notes.getByLabel('New note', { exact: true }).fill('A parked note from the original HAPI source');
            await notes.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'original-note.txt', mimeType: 'text/plain', buffer: Buffer.from('Source note attachment bytes') });
            await expect(notes).toContainText('original-note.txt');
            await notes.getByRole('button', { name: 'Save note', exact: true }).click();
            await expect.poll(() => environment.hapi.extras.notes.get('native-alpha')?.size ?? 0).toBe(1);
            expect(environment.hapi.sent).toHaveLength(0);
            const savedNote = notes.locator('.hapi-source-notes > li');
            await savedNote.getByRole('button', { name: 'Use in composer', exact: true }).click();
            const composer = pane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true });
            await expect(composer).toHaveText('Keep the existing conversation draft\n\nA parked note from the original HAPI source');
            await expect(pane.getByRole('group', { name: 'Pending attachments', exact: true }).getByText('original-note.txt', { exact: true })).toBeVisible();
            expect(environment.hapi.sent).toHaveLength(0);
            expect(environment.hapi.extras.notes.get('native-alpha')?.size).toBe(1);

            const historyPane = await tool('History & export');
            const history = historyPane.getByRole('region', { name: 'Conversation history', exact: true });
            await history.getByRole('button', { name: /Question from Codex TUI — alpha/ }).click();
            await expect(pane.locator('[data-conversation-scroll] :focus')).toContainText('Question from Codex TUI — alpha');
            await tool('History & export');
            await history.getByRole('combobox', { name: 'Export format', exact: true }).selectOption('json');
            await history.getByRole('button', { name: 'Prepare download', exact: true }).click();
            const downloading = page.waitForEvent('download');
            await history.getByRole('link', { name: /Download/ }).click();
            const download = await downloading; const path = await download.path(); expect(path).toBeTruthy();
            const exported = JSON.parse(await readFile(path!, 'utf8'));
            expect(exported.session.id).toBe('native-alpha');
            expect(exported.messages).toHaveLength(environment.hapi.require('native-alpha').rows.length);
            expect(exported.scratchlist[0].attachments[0].filename).toBe('original-note.txt');

            const schedulePane = await tool('Scheduled messages');
            const schedule = schedulePane.getByRole('region', { name: 'Scheduled messages', exact: true });
            await schedule.getByRole('textbox', { name: 'Message', exact: true }).fill('A source-owned scheduled message');
            await schedule.getByRole('button', { name: 'Schedule message', exact: true }).click();
            await expect.poll(() => environment.hapi.sent.length).toBe(1);
            expect(environment.hapi.sent[0]?.sessionId).toBe('native-alpha');
            expect(environment.hapi.sent[0]?.message.scheduledAt).toBeGreaterThan(Date.now());
            await expect(schedule.getByRole('button', { name: 'New scheduled message', exact: true })).toBeVisible();
            await page.reload();
            await expect(schedulePane).toBeVisible();
            await expect(schedule.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('A source-owned scheduled message');
            await expect(schedule.getByRole('button', { name: 'New scheduled message', exact: true })).toBeVisible();
            expect(environment.hapi.sent).toHaveLength(1);
            await schedule.getByRole('button', { name: 'Cancel scheduled message', exact: true }).click();
            await expect.poll(() => environment.hapi.cancelled).toContain(environment.hapi.sent[0]!.message.localId);
            expect(errors).toEqual([]);
            await expect(page.locator('iframe')).toHaveCount(0);
            await expect(page.locator('.hapi-pane')).toHaveCount(2);
            await page.close();
            for (const viewport of ['1440x900', '390x844']) for (const [tab, panel] of [
                ['Scratchlist', 'Scratchlist'], ['History & export', 'Conversation history'], ['Scheduled messages', 'Scheduled messages'],
            ]) {
                const ready = `(() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    if (dialog) [...dialog.querySelectorAll('button')].find(b => /^(Continue|继续)$/.test(b.textContent.trim()))?.click();
                    const panel = document.querySelector(${JSON.stringify(`.hapi-source-panel[aria-label="${panel}"]`)});
                    if (panel?.checkVisibility()) return !panel.querySelector('[role="status"]');
                    if (window.__openingTool) return false;
                    const chat = document.querySelector('[aria-label="Pane: Native Codex alpha"]');
                    if (!chat || !chat.checkVisibility()) { document.querySelector('.hapi-pane-tabs button[title="Native Codex alpha"]')?.click(); return false; }
                    chat.focus();
                    const menu = document.querySelector('[role="dialog"][aria-label="More input controls"]');
                    if (menu) {
                        const button = [...menu.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(tab)});
                        if (button) { window.__openingTool = true; button.click(); }
                    } else chat.querySelector('button[aria-label="More input controls"]')?.click();
                    return false;
                })()`;
                const path = await visualReview(environment.launchUrl, `tools-${tab!.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`, viewport, ready);
                if (path) await info.attach(`visual-${tab}-${viewport}`, { path, contentType: 'image/png' });
            }
        } finally {
            if (errors.length) await info.attach('session-tools-errors', { body: errors.join('\n'), contentType: 'text/plain' });
        }
    });
});
