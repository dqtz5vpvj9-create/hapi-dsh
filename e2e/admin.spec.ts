import { acknowledgePreviewNotice } from './preview-notice.ts'
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.describe('original HAPI administration in the unchanged official Settings shell', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });

    test('settings, machine profile, lost restart receipt, source usage and SQLite download stay in one workspace', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        let panelRequests = 0;
        page.on('request', request => { if (request.url().includes('client.administration.js')) panelRequests++; });
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        try {
            environment.hapi.admin.machines[0]!.health = { collectedAt: Date.now(), cpuCount: 8, load1m: 2.4, cpuPercent: 72, memoryPercent: 91, uptimeSeconds: 6540 };
            await page.goto(environment.launchUrl);
            await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
            await acknowledgePreviewNotice(page, environment)
            await page.getByRole('button', { name: 'List options', exact: true }).click();
            await page.locator('.hapi-sidebar-native > details > summary').click();
            const machineRow = page.locator('[data-source-machine="machine-alpha"]');
            await expect(machineRow).toContainText('CPU 72%'); await expect(machineRow).toContainText('RAM 91%');
            await machineRow.locator('summary').click();
            await expect(machineRow).toContainText('High load'); await expect(machineRow).toContainText('2.4/8');
            await expect(machineRow).toContainText('1h 49m'); await expect(machineRow).toContainText('fixture-1.0');
            expect(panelRequests).toBe(0);
            await page.getByRole('dialog', { name: 'List options', exact: true }).press('Escape');
            await page.getByRole('button', { name: 'Account menu', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Settings', exact: false }).click();
            const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
            await settings.getByRole('button', { name: 'HAPI Hub', exact: true }).click();
            const panel = settings.getByRole('region', { name: 'HAPI Hub and Runners', exact: true });
            await panel.getByLabel('Ask agents for compact task summaries', { exact: false }).click();
            await expect.poll(() => environment.hapi.admin.settings.sessionSummaryContract).toBe(true);
            await expect(panel.getByLabel('Ask agents for compact task summaries', { exact: false })).toBeChecked();
            expect(panelRequests).toBe(1);

            await panel.getByRole('tab', { name: 'Machines', exact: true }).click();
            await panel.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('machine-alpha');
            await expect(panel.locator('.hapi-machine-health')).toContainText('High load');
            await panel.getByRole('textbox', { name: 'Machine display name', exact: true }).fill('Original development laptop');
            await panel.getByRole('button', { name: 'Save machine name', exact: true }).click();
            await expect.poll(() => environment.hapi.admin.machines[0]!.metadata!.displayName).toBe('Original development laptop');
            await panel.getByRole('button', { name: 'Show source profile', exact: true }).click();
            await expect(panel.getByLabel('foundation', { exact: false })).toBeDisabled();
            await panel.getByLabel('source-tools', { exact: false }).click();
            await expect(panel).toContainText('Profile changed. Start a new DSH session');
            expect(environment.hapi.admin.bundles.get('machine-beta')!.available[1]!.enabled).toBe(false);

            environment.hapi.admin.dropNextRestartReply = true;
            await panel.getByRole('button', { name: 'Restart Runner', exact: true }).click();
            await panel.getByRole('button', { name: 'Confirm Runner restart', exact: true }).click();
            await expect.poll(() => environment.hapi.admin.mutations.filter(row => row.path.endsWith('/restart-runner')).length).toBe(1);
            await panel.getByText(/Operation history \(/).click();
            const receipt = panel.locator('.hapi-admin-receipts article').filter({ hasText: 'restart-runner' });
            await expect(receipt).toContainText(/indeterminate|observed/);
            const checkSource = receipt.getByRole('button', { name: 'Check original source', exact: true });
            if (await checkSource.isVisible()) await checkSource.click();
            await expect(receipt).toContainText('observed');
            expect(environment.hapi.admin.mutations.filter(row => row.path.endsWith('/restart-runner'))).toHaveLength(1);
            await panel.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('machine-beta');
            await expect(panel.getByRole('button', { name: 'Restart Runner', exact: true })).toBeDisabled();
            await expect(panel).toContainText('The Runner has not reported a health sample.');

            await panel.getByRole('tab', { name: 'Usage', exact: true }).click();
            await expect(panel.locator('.hapi-admin-metrics')).toContainText('1,400');
            await panel.getByRole('radio', { name: '30 days', exact: true }).click();
            await panel.getByRole('combobox', { name: 'Time zone', exact: true }).selectOption('UTC');
            await expect.poll(() => environment.hapi.admin.usageQueries.at(-1)).toEqual({ range: '30d', timeZone: 'UTC' });

            await panel.getByRole('tab', { name: 'Storage', exact: true }).click();
            await expect(panel).toContainText('/fixture/hapi.db');
            const downloading = page.waitForEvent('download');
            await panel.getByRole('button', { name: 'Download database backup', exact: true }).click();
            const file = await downloading; const path = await file.path(); expect(path).toBeTruthy();
            expect(await readFile(path!)).toEqual(environment.hapi.admin.backupBytes); expect(environment.hapi.admin.backups).toBe(1);
            await expect(page.locator('iframe')).toHaveCount(0); expect(errors).toEqual([]);
            expect(await panel.textContent()).not.toContain('fixture-never-expose');
        } finally { if (errors.length) await info.attach('administration-errors', { body: errors.join('\n'), contentType: 'text/plain' }); }
    });
});
