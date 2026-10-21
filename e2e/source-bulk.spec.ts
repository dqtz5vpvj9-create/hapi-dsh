/** Real official Settings and plugin transport; HAPI execution replies are explicit wire fixtures. */
import { test, expect, type Page } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.describe('original source bulk actions in the unified Settings', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });
    async function settings(page: Page) {
        await page.goto(environment.launchUrl);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
        if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: false }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        await dialog.getByRole('button', { name: 'HAPI Hub', exact: true }).click();
        return dialog.getByRole('region', { name: 'Session bulk actions', exact: true });
    }
    test('fresh source selection, per-session receipt and reload preserve execution ownership', async ({ page }) => {
        const alpha = environment.hapi.require('native-alpha').session, beta = environment.hapi.require('native-beta').session;
        const panel = await settings(page);
        // Update after opening Settings: the click must not use a cached count.
        alpha.serviceTier = 'priority'; beta.serviceTier = 'standard';
        await panel.getByRole('button', { name: 'Set all Fast Codex sessions to Standard', exact: true }).click();
        await expect(panel.locator('[data-bulk-session="native-alpha"]')).toContainText('Source accepted');
        await expect(panel.locator('[data-bulk-session="native-beta"]')).toHaveCount(0);
        expect(environment.hapi.settingChanges.filter(row => row.route === 'service-tier').map(row => row.sessionId)).toEqual(['native-alpha']);
        expect(alpha.serviceTier).toBe('standard');

        alpha.thinking = true; alpha.execution = { ...alpha.execution!, status: 'active', waitingOn: [] };
        beta.thinking = true; beta.execution = { ...beta.execution!, status: 'active', waitingOn: ['approval'] };
        beta.agentState = { requests: { keep: { tool: 'exec_command', arguments: { command: 'source approval' } } } };
        environment.hapi.dropNextAbortReply = true;
        await panel.getByRole('button', { name: 'Pause all running source sessions', exact: true }).click();
        await expect(panel.locator('[data-bulk-session="native-alpha"]')).toContainText('Result unknown; not replayed');
        await expect(panel.locator('[data-bulk-session="native-beta"]')).toHaveCount(0);
        expect(environment.hapi.aborted).toEqual(['native-alpha']);
        expect(beta.agentState.requests?.keep).toBeTruthy();
        expect(alpha.execution.status).toBe('active'); // No invented completion after an uncertain reply.
        const recovered = await settings(page);
        await expect(recovered.locator('[data-bulk-session="native-alpha"]')).toContainText('Result unknown; not replayed');
        await recovered.getByRole('button', { name: 'Check saved bulk operation', exact: true }).click();
        await expect(recovered.locator('[data-bulk-session="native-alpha"]')).toContainText('Result unknown; not replayed');
        expect(environment.hapi.aborted).toEqual(['native-alpha']);
        expect(environment.hapi.sent).toHaveLength(0);
    });
});
