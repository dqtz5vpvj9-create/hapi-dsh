/** Official DSH launch/attachment UI with an explicit HAPI protocol fixture, not model execution. */
import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.describe('durable original HAPI launch and first task', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });

    test('native launch keeps draft files through reload, sends once after a lost reply, and remembers successful options', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
        await notice.waitFor({ state: 'visible', timeout: 2000 }).catch(() => undefined);
        if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
        const showCreate = async () => {
            await page.locator('.hapi-workspace-tools > details > summary').click();
            await page.getByRole('button', { name: 'Codex · New conversation', exact: true }).click();
        };
        await showCreate();
        const creation = page.getByRole('dialog', { name: 'New Codex session', exact: true });
        await creation.getByLabel('Working directory', { exact: true }).fill('/workspace/first-task');
        await creation.getByRole('combobox', { name: 'Permissions', exact: true }).selectOption('read-only');
        await creation.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('plan');
        await creation.getByRole('combobox', { name: 'Service tier', exact: true }).selectOption('fast');
        await creation.getByRole('textbox', { name: 'First task', exact: true }).fill('Inspect the attached original task');
        await creation.getByLabel('Task attachments', { exact: true }).setInputFiles({ name: 'first-task.txt', mimeType: 'text/plain', buffer: Buffer.from('Original draft bytes before reload') });
        await expect(creation.locator('.hapi-initial-task li')).toContainText('first-task.txt');
        await creation.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.reload(); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await showCreate();
        await expect(creation.getByRole('textbox', { name: 'First task', exact: true })).toHaveValue('Inspect the attached original task');
        await expect(creation.getByLabel('Working directory', { exact: true })).toHaveValue('/workspace/first-task');
        await expect(creation.getByRole('combobox', { name: 'Mode', exact: true })).toHaveValue('plan');
        await expect(creation.locator('.hapi-initial-task li')).toContainText('first-task.txt');
        environment.hapi.dropNextMessageReply = true;
        await creation.getByRole('button', { name: 'Create', exact: true }).click();
        await expect.poll(() => environment.hapi.sent.length).toBe(1);
        await expect(creation).toHaveCount(0);
        expect(environment.hapi.spawnRequests).toHaveLength(1);
        expect(environment.hapi.spawnRequests[0]!.body).toMatchObject({ permissionMode: 'read-only', collaborationMode: 'plan', serviceTier: 'fast' });
        expect(environment.hapi.sent[0]!.sessionId).toBe('native-created-0');
        expect(environment.hapi.sent[0]!.message.localId).toMatch(/^dsh:initial-task:/);
        expect(environment.hapi.sent[0]!.message.attachments).toHaveLength(1);
        expect(environment.hapi.uploads).toHaveLength(1);
        expect(JSON.stringify(environment.hapi.uploads[0])).toContain(Buffer.from('Original draft bytes before reload').toString('base64'));
        await page.reload(); await expect(page.getByRole('region', { name: 'Pane: Native Codex created-0', exact: true })).toBeVisible();
        expect(environment.hapi.sent).toHaveLength(1); expect(environment.hapi.spawnRequests).toHaveLength(1);
        await showCreate();
        await expect(creation.getByRole('textbox', { name: 'First task', exact: true })).toHaveValue('');
        await expect(creation.locator('.hapi-initial-task li')).toHaveCount(0);
        await expect(creation.getByRole('combobox', { name: 'Service tier', exact: true })).toHaveValue('fast');
        await creation.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(errors).toEqual([]);
    });

    test('attachment-only source task uses its chosen machine and requires confirmation before creating a missing directory', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
        await notice.waitFor({ state: 'visible', timeout: 2000 }).catch(() => undefined);
        if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.locator('.hapi-workspace-tools > details > summary').click();
        await page.getByRole('button', { name: 'HAPI engines · New conversation', exact: true }).click();
        const creation = page.getByRole('dialog', { name: 'HAPI engines · New conversation', exact: true });
        await creation.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('machine-beta');
        await creation.getByLabel('Working directory', { exact: true }).fill('/workspace/new-folder');
        await creation.getByLabel('Task attachments', { exact: true }).setInputFiles({ name: 'attachment-only.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment-only source task') });
        const before = environment.hapi.spawnRequests.length; const sentBefore = environment.hapi.sent.length;
        await creation.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(creation.getByText('This directory does not exist. Select Create again to allow the Runner to create it.', { exact: true })).toBeVisible();
        expect(environment.hapi.spawnRequests).toHaveLength(before);
        await creation.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(creation).toHaveCount(0);
        await expect.poll(() => environment.hapi.sent.length).toBe(sentBefore + 1);
        expect(environment.hapi.spawnRequests).toHaveLength(before + 1);
        const message = environment.hapi.sent.at(-1)!;
        expect(message.sessionId).toMatch(/^source-created-/); expect(message.message.text).toBe(''); expect(message.message.attachments).toHaveLength(1);
        expect(environment.hapi.require(message.sessionId).session.metadata?.machineId).toBe('machine-beta');
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1); await expect(page.locator('iframe')).toHaveCount(0);
        expect(errors).toEqual([]);
    });
});
