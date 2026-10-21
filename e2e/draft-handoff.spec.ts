/** Real official DSH inputs, attachment callbacks and IDB; HAPI reopen is an
 * explicit wire fixture returning a different, catalogued original source id. */
import { test, expect, type Page } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

const inputName = 'Message or run a task, / commands, @ files or sessions';
const sourceRow = (page: Page, name: string) => page.locator('.hapi-session-row').filter({ has: page.locator('.hapi-session-open').filter({ hasText: name }) });
const pane = (page: Page, name: string) => page.getByRole('region', { name: `Pane: ${name}`, exact: true });
async function admit(page: Page, environment: OfficialEnvironment) {
    await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
}
function archive(environment: OfficialEnvironment) {
    const source = environment.hapi.require('native-alpha').session;
    source.active = false; source.metadata!.codexNativeConnection = 'history'; source.metadata!.lifecycleState = 'archived'; source.metadataVersion++;
    environment.hapi.emit({ type: 'session-updated', sessionId: source.id });
}
async function reopen(page: Page) {
    await sourceRow(page, 'Native Codex alpha').locator('.hapi-session-open').click({ button: 'right' });
    await page.getByRole('menu', { name: 'Native Codex alpha · Conversation actions', exact: true }).getByRole('menuitem', { name: 'Restore conversation', exact: true }).click();
    const tools = page.getByRole('dialog', { name: 'Session tools', exact: true });
    const confirm = tools.getByRole('group', { name: 'Confirm session operation', exact: true }).getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm).toBeEnabled(); await confirm.click();
    const handoff = page.getByRole('dialog', { name: 'Move draft to recovered conversation', exact: true });
    await expect(handoff).toBeVisible(); return handoff;
}

test.describe('confirmed source successor draft hand-off', () => {
    let environment: OfficialEnvironment;
    test.beforeEach(async () => {
        environment = await startOfficialEnvironment();
        const target = environment.hapi.add('reopened', 'Laptop', 'machine-alpha');
        environment.hapi.emit({ type: 'session-added', sessionId: target.session.id });
        environment.hapi.history.reopenSuccessors.set('native-alpha', 'native-reopened');
    });
    test.afterEach(async () => { await environment?.close(); });

    test('accepted official input retains exact original bytes across refresh and clears only its unchanged predecessor', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await admit(page, environment); await sourceRow(page, 'Native Codex alpha').locator('.hapi-session-open').click();
        const original = pane(page, 'Native Codex alpha');
        await original.getByRole('textbox', { name: inputName, exact: true }).fill('Original unsent text before native reopen');
        await original.locator('input[type="file"]').first().setInputFiles({ name: 'original-handoff.txt', mimeType: 'text/plain', buffer: Buffer.from('Original attachment hand-off bytes') });
        await expect(original.getByRole('group', { name: 'Pending attachments', exact: true })).toContainText('original-handoff.txt');
        archive(environment);
        const handoff = await reopen(page);
        await expect(handoff).toContainText('native-alpha'); await expect(handoff).toContainText('native-reopened'); await expect(handoff).toContainText('original-handoff.txt');
        await handoff.getByRole('button', { name: 'Move captured content to the empty target', exact: true }).click();
        await expect(handoff).toContainText('The target accepted the draft and the unchanged original was cleared.');
        const recovered = pane(page, 'Native Codex reopened');
        await expect(recovered.getByRole('textbox', { name: inputName, exact: true })).toHaveText('Original unsent text before native reopen');
        await expect(recovered.getByRole('group', { name: 'Pending attachments', exact: true })).toContainText('original-handoff.txt');
        await handoff.getByRole('button', { name: 'Done', exact: true }).click(); await expect(handoff).not.toBeVisible();
        await page.reload();
        await expect(recovered.getByRole('textbox', { name: inputName, exact: true })).toHaveText('Original unsent text before native reopen');
        await expect(recovered.getByRole('group', { name: 'Pending attachments', exact: true })).toContainText('original-handoff.txt');
        const stored = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('hapi-dsh-composer-attachments', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
            const rows = await new Promise<Array<{ value: { files: { name: string; blob: Blob }[] } | null }>>(resolve => { const read = db.transaction('drafts').objectStore('drafts').getAll(); read.onsuccess = () => resolve(read.result); }); db.close();
            const copy = rows.flatMap(row => row.value?.files ?? []).find(file => file.name === 'original-handoff.txt'); return copy ? copy.blob.text() : null;
        });
        expect(stored).toBe('Original attachment hand-off bytes');
        await sourceRow(page, 'Native Codex alpha').locator('.hapi-session-open').click();
        await expect(original.getByRole('textbox')).toHaveText('');
        await expect(original.getByRole('group', { name: 'Pending attachments', exact: true })).toHaveCount(0);
        expect(environment.hapi.history.reopens).toEqual(['native-alpha']); expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([]);
    });

    test('existing target text needs explicit append and only an untouched pending share follows the confirmed new source', async ({ page }) => {
        await admit(page, environment);
        await sourceRow(page, 'Native Codex reopened').locator('.hapi-session-open').click();
        const recovered = pane(page, 'Native Codex reopened');
        await recovered.getByRole('textbox', { name: inputName, exact: true }).fill('Already existing target draft');
        await sourceRow(page, 'Native Codex alpha').locator('.hapi-session-open').click();
        await pane(page, 'Native Codex alpha').getByRole('textbox', { name: inputName, exact: true }).fill('Original draft to move');
        archive(environment);
        await page.goto(`${environment.origin}/share#text=Pending%20share%20for%20the%20original%20source`);
        const sharing = page.getByRole('dialog', { name: 'Incoming share', exact: true });
        await sharing.getByRole('button').filter({ hasText: 'Native Codex alpha' }).click();
        await expect(pane(page, 'Native Codex alpha').locator('[data-share-delivery]')).toHaveAttribute('data-share-delivery', 'waiting');
        const handoff = await reopen(page);
        await expect(handoff).toContainText('Already existing target draft');
        await expect(recovered.getByRole('textbox', { name: inputName, exact: true })).toHaveText('Already existing target draft');
        await handoff.getByRole('button', { name: 'Append captured content to the target draft', exact: true }).click();
        await expect(handoff).toContainText('The target accepted the draft and the unchanged original was cleared.');
        await expect(recovered.getByRole('textbox', { name: inputName, exact: true })).toHaveText('Already existing target draft\n\nOriginal draft to move\n\nPending share for the original source', { useInnerText: true });
        await expect(recovered.locator('[data-share-delivery]')).toHaveAttribute('data-share-delivery', 'inserted');
        await handoff.getByRole('button', { name: 'Done', exact: true }).click(); await expect(handoff).not.toBeVisible();
        await page.reload();
        await expect(recovered.getByRole('textbox', { name: inputName, exact: true })).toHaveText('Already existing target draft\n\nOriginal draft to move\n\nPending share for the original source', { useInnerText: true });
        expect(environment.hapi.history.reopens).toEqual(['native-alpha']); expect(environment.hapi.sent).toHaveLength(0);
    });
});
