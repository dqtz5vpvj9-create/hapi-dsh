/** Real ServiceWorker/IndexedDB and official DSH composer; source sessions are explicit HAPI fixtures. */
import { test, expect, type Page } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

const composerName = 'Message or run a task, / commands, @ files or sessions';
async function openWorkspace(page: Page, environment: OfficialEnvironment) {
    await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
}
test.describe('incoming share through the unified workspace', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });
    test('legacy fragment picker appends only to its chosen source and reload does not duplicate it', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await openWorkspace(page, environment);
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        const alpha = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        await alpha.getByRole('textbox', { name: composerName }).fill('Existing alpha draft');
        await page.getByRole('button', { name: 'Split left / right', exact: true }).click();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click();
        const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
        await beta.getByRole('textbox', { name: composerName }).fill('Keep beta untouched');
        const requests: string[] = []; page.on('request', request => requests.push(request.url()));
        await page.goto(`${environment.origin}/share#title=Incoming%20title&text=Fragment%20private%20content&url=https%3A%2F%2Fexample.invalid%2Fread`);
        const dialog = page.getByRole('dialog', { name: 'Incoming share', exact: true }); await expect(dialog).toBeVisible();
        await expect(page).toHaveURL(/hapiShare=[^#]+$/u);
        await expect(dialog).toContainText('Fragment private content');
        await dialog.getByRole('button').filter({ hasText: 'Native Codex alpha' }).click();
        await expect(alpha.getByRole('textbox', { name: composerName })).toHaveText('Existing alpha draft\n\nIncoming title\nFragment private content\nhttps://example.invalid/read', { useInnerText: true });
        await expect(beta.getByRole('textbox', { name: composerName })).toHaveText('Keep beta untouched');
        await expect(alpha.locator('[data-share-delivery]')).toHaveAttribute('data-share-delivery', 'inserted');
        await page.reload(); await expect(alpha.getByRole('textbox', { name: composerName })).toHaveText('Existing alpha draft\n\nIncoming title\nFragment private content\nhttps://example.invalid/read', { useInnerText: true });
        await expect(dialog).not.toBeVisible();
        expect(requests.some(url => url.includes('Fragment%20private') || url.includes('Fragment+private'))).toBe(false);
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([]);
    });
    test('installed real worker receives multipart bytes locally and seeds original files through official attachment callbacks', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await openWorkspace(page, environment);
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
        expect(manifest.share_target).toMatchObject({ action: 'hapi-dsh/share', method: 'POST' });
        const destination = await page.evaluate(async () => {
            const form = new FormData(); form.set('title', 'Shared file'); form.set('text', 'Review these bytes');
            form.append('files', new File(['Original share bytes'], 'share-original.txt', { type: 'text/plain' }));
            const response = await fetch('/hapi-dsh/share', { method: 'POST', body: form });
            if (!response.ok) throw new Error(`Share response ${response.status}`); return response.url;
        });
        expect(destination).toMatch(/\?hapiShare=/u); await page.goto(destination);
        const dialog = page.getByRole('dialog', { name: 'Incoming share', exact: true }); await expect(dialog).toContainText('share-original.txt');
        await dialog.getByRole('button').filter({ hasText: 'Native Codex alpha' }).click();
        const alpha = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        await expect(alpha.getByRole('textbox', { name: composerName })).toHaveText('Shared file\nReview these bytes', { useInnerText: true });
        await expect(alpha).toContainText('share-original.txt');
        const stored = await page.evaluate(async () => {
            const id = new URL(location.href).searchParams.get('hapiShare')!;
            const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('hapi-share-transfers', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
            const row = await new Promise<{ files: { blob: Blob }[]; hapiDshDelivery: { status: string } }>(resolve => { const read = db.transaction('transfers').objectStore('transfers').get(id); read.onsuccess = () => resolve(read.result); });
            db.close(); return { bytes: await row.files[0]!.blob.text(), status: row.hapiDshDelivery.status };
        });
        expect(stored).toEqual({ bytes: 'Original share bytes', status: 'inserted' });
        await page.getByRole('button', { name: 'Split left / right', exact: true }).click();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click();
        const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
        await beta.getByRole('textbox', { name: composerName }).fill('Independent beta draft before update');
        await page.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: false }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('button', { name: 'Notifications and installation', exact: true }).click();
        await Promise.all([page.waitForEvent('load', { timeout: 30_000 }), settings.getByRole('button', { name: 'Save drafts and reload workspace', exact: true }).click()]);
        await expect(alpha.getByRole('textbox', { name: composerName })).toHaveText('Shared file\nReview these bytes', { useInnerText: true });
        await expect(alpha).toContainText('share-original.txt');
        await expect(beta.getByRole('textbox', { name: composerName })).toHaveText('Independent beta draft before update');
        const restored = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('hapi-dsh-composer-attachments', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
            const rows = await new Promise<Array<{ value: { text: string; files: { name: string; blob: Blob }[] } | null }>>(resolve => { const read = db.transaction('drafts').objectStore('drafts').getAll(); read.onsuccess = () => resolve(read.result); });
            db.close(); const copy = rows.find(row => row.value?.files.some(file => file.name === 'share-original.txt'))?.value;
            return copy ? { text: copy.text, bytes: await copy.files[0]!.blob.text() } : null;
        });
        expect(restored).toEqual({ text: 'Shared file\nReview these bytes', bytes: 'Original share bytes' });
        await expect(alpha.locator('.hapi-attachment-recovery')).toHaveCount(0);
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([]);
    });
    test('cancelled create retains the share; the eventual exact new native session receives a draft without autosending', async ({ page }) => {
        await openWorkspace(page, environment);
        await page.goto(`${environment.origin}/share#text=Shared%20new%20conversation%20draft`);
        const share = page.getByRole('dialog', { name: 'Incoming share', exact: true });
        await share.getByRole('button', { name: 'Create a conversation for this share', exact: true }).click();
        const chooser = page.getByRole('dialog', { name: 'New conversation', exact: true }); await expect(chooser).toBeVisible();
        await page.keyboard.press('Escape'); await expect(share).toBeVisible(); await expect(share).toContainText('Shared new conversation draft');
        await share.getByRole('button', { name: 'Create a conversation for this share', exact: true }).click();
        await chooser.getByRole('button').filter({ hasText: 'Codex' }).click();
        const creation = page.getByRole('dialog', { name: 'New Codex session', exact: true });
        await creation.getByLabel('Working directory', { exact: true }).fill('/workspace/share-target');
        await creation.getByRole('button', { name: 'Create', exact: true }).click();
        const created = page.getByRole('region', { name: 'Pane: Native Codex created-0', exact: true });
        await expect(created.getByRole('textbox', { name: composerName })).toHaveText('Shared new conversation draft');
        await expect(created.locator('[data-share-delivery]')).toHaveAttribute('data-share-delivery', 'inserted');
        expect(environment.hapi.sent).toHaveLength(0); expect(environment.hapi.spawnRequests).toHaveLength(1);
    });
});
