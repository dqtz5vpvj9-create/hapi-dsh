import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Official DSH Client/Host and explicit original Claude wire fixtures; no provider credentials. */
import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.describe('original HAPI engines in the unified official Conversation', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment();
        environment.hapi.addObserved('claude', 'claude-alpha');
    });
    test.afterAll(async () => { await environment?.close(); });

    test('original Claude keeps source settings, approval finality, queue, pin, fork and launch ownership', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await acknowledgePreviewNotice(page, environment)
        const title = 'Source claude claude-alpha', sourceId = 'source-claude-alpha';
        await page.locator('.hapi-session-open').filter({ hasText: title }).click();
        const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true });
        await expect(pane.getByText('Original claude answer in the official DSH Conversation.', { exact: true })).toBeVisible();
        await pane.locator('.hapi-native-settings > summary').click();
        await pane.getByRole('combobox', { name: 'Model', exact: true }).selectOption(JSON.stringify('opus'));
        await expect.poll(() => environment.hapi.require(sourceId).session.model).toBe('opus');
        await expect(pane.locator('[data-source-setting-state="applied"]')).toBeVisible();
        expect(environment.hapi.settingChanges.at(-1)).toMatchObject({ sessionId: sourceId, route: 'model', body: { model: 'opus' } });

        environment.hapi.requestApproval(sourceId, 'original-claude-approval');
        const approval = pane.locator('[data-native-request="original-claude-approval"]');
        await approval.getByRole('button', { name: 'Approve', exact: true }).click();
        await expect(approval).toContainText('Answer sent; waiting for source confirmation');
        expect(environment.hapi.approvals.at(-1)?.sessionId).toBe(sourceId);
        await expect(approval.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
        environment.hapi.settleApproval(sourceId, 'original-claude-approval'); await expect(approval).toHaveCount(0);

        const composer = pane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true });
        await composer.fill('A real composer submission to the original Claude owner');
        await pane.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect.poll(() => environment.hapi.sent.length).toBe(1);
        expect(environment.hapi.sent[0]!.sessionId).toBe(sourceId);
        environment.hapi.consume(sourceId, environment.hapi.sent[0]!.message.localId);
        await expect(pane.getByText('Source response to: A real composer submission to the original Claude owner', { exact: true })).toBeVisible();

        await pane.getByRole('combobox', { name: 'Conversation tools', exact: true }).selectOption('hapi-session-tools');
        const tools = pane.getByRole('region', { name: 'Session tools', exact: true });
        await tools.getByRole('combobox', { name: 'Pin', exact: true }).selectOption('global');
        await expect.poll(() => environment.hapi.require(sourceId).session.globalPinned).toBe(true);
        await tools.getByRole('button', { name: 'Fork conversation', exact: true }).click();
        await tools.getByRole('group', { name: 'Confirm session operation', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Pane: Original source fork', exact: true })).toBeVisible();
        expect(environment.hapi.forkRequests).toHaveLength(1);
        // Legacy HAPI engines use the original non-native endpoint contract.
        expect(environment.hapi.forkRequests[0]).toEqual({ sessionId: sourceId, body: {} });

        await page.locator('.hapi-workspace-tools > details > summary').click();
        await page.getByRole('button', { name: 'HAPI engines · New conversation', exact: true }).click();
        const creation = page.getByRole('dialog', { name: 'HAPI engines · New conversation', exact: true });
        await creation.getByRole('combobox', { name: 'Engine', exact: true }).selectOption('claude');
        await creation.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('machine-beta');
        await creation.getByLabel('Working directory', { exact: true }).fill('/workspace/original-claude');
        await creation.getByRole('combobox', { name: 'Model', exact: true }).selectOption('sonnet');
        await creation.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Pane: Source claude created-0', exact: true })).toBeVisible();
        expect(environment.hapi.require('source-created-0').session.metadata).toMatchObject({ flavor: 'claude', machineId: 'machine-beta', path: '/workspace/original-claude' });
        expect(environment.hapi.require('source-created-0').session.metadata?.codexNativeSession).toBeUndefined();
        expect(environment.hapi.require('source-created-0').rows).toHaveLength(0);
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1); await expect(page.locator('iframe')).toHaveCount(0);
        expect(errors).toEqual([]);
    });
});
