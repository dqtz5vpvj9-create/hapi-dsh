import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Real pinned DSH UI with an explicit HAPI wire fixture, never a real Runner restart. */
import { test, expect, type Page } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

const capabilities = ['agent-availability', 'cursor-chat-store-status', 'stop-runner', 'machine-terminal'];
async function enterWorkspace(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.goto(environment.launchUrl);
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
    await acknowledgePreviewNotice(page, environment)
}

test.describe('Runner capability compatibility in the single official workspace', () => {
    let environment: OfficialEnvironment;
    const pageErrors = new WeakMap<Page, string[]>();
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });
    test.beforeEach(({ page }) => {
        const errors: string[] = []; pageErrors.set(page, errors);
        page.on('pageerror', error => errors.push(error.message));
        environment.hapi.admin.mutations.length = 0;
        environment.hapi.admin.dropNextRestartReply = false; environment.hapi.admin.deferRestartObservation = false;
        for (const machine of environment.hapi.admin.machines) {
            machine.active = true; machine.metadata!.capabilities = [...capabilities];
            machine.metadata!.startedCliMtimeMs = 200; machine.metadata!.installedCliMtimeMs = 100;
        }
    });
    test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

    test('capabilities, online filtering, unobstructed panes, original minimize and dismissal keys', async ({ page }) => {
        const [alpha, beta] = environment.hapi.admin.machines;
        alpha!.metadata!.capabilities = ['agent-availability'];
        alpha!.metadata!.installedCliMtimeMs = alpha!.metadata!.startedCliMtimeMs;
        // A high version string cannot compensate for a missing RPC; an offline peer is not warned about.
        alpha!.metadata!.happyCliVersion = '999.0'; beta!.metadata!.capabilities = []; beta!.active = false;
        await enterWorkspace(page, environment);
        const banner = page.locator('[data-hapi-runner-skew]');
        await expect(banner).toHaveAttribute('data-hapi-runner-skew', 'expanded');
        await expect(banner).toContainText('cursor-chat-store-status'); await expect(banner).toContainText('CLI 999.0');
        await expect(banner.getByRole('button', { name: 'Restart Runner', exact: true })).toHaveCount(0);
        await expect(banner.locator('[data-source-runner-skew="machine-beta"]')).toHaveCount(0);
        const bannerBox = await banner.boundingBox(), stageBox = await page.locator('.hapi-workspace-stage').boundingBox();
        expect(bannerBox).toBeTruthy(); expect(stageBox).toBeTruthy();
        expect(stageBox!.y).toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height - 1); expect(stageBox!.height).toBeGreaterThan(200);
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        await expect(page.locator('[data-hapi-workspace]')).toContainText('Native history alpha');
        await banner.getByRole('button', { name: 'Minimize', exact: true }).click();
        await expect(banner).toHaveAttribute('data-hapi-runner-skew', 'minimized');
        expect(await page.evaluate(() => sessionStorage.getItem('hapi.runnerSkew.minimized.v1'))).toBe('1');
        await page.reload(); await expect(banner).toHaveAttribute('data-hapi-runner-skew', 'minimized');
        await banner.getByRole('button').click(); await expect(banner).toHaveAttribute('data-hapi-runner-skew', 'expanded');
        expect(await page.evaluate(() => sessionStorage.getItem('hapi.runnerSkew.minimized.v1'))).toBeNull();
        await banner.getByRole('button', { name: 'Dismiss for 1 hour', exact: true }).click(); await expect(banner).toHaveCount(0);
        const remaining = await page.evaluate(() => Number(sessionStorage.getItem('hapi.runnerSkew.dismissUntil.v1')) - Date.now());
        expect(remaining).toBeGreaterThan(59 * 60_000); expect(remaining).toBeLessThanOrEqual(60 * 60_000);
        await page.reload(); await expect(page.locator('[data-hapi-workspace]')).toBeVisible(); await expect(banner).toHaveCount(0);
        await page.evaluate(() => sessionStorage.setItem('hapi.runnerSkew.dismissUntil.v1', String(Date.now() - 1)));
        await page.reload(); await expect(banner).toHaveAttribute('data-hapi-runner-skew', 'expanded');
        await page.setViewportSize({ width: 390, height: 844 });
        const mobileBanner = await banner.boundingBox(), mobileStage = await page.locator('.hapi-workspace-stage').boundingBox();
        expect(mobileStage!.y).toBeGreaterThanOrEqual(mobileBanner!.y + mobileBanner!.height - 1);
        expect(mobileStage!.height).toBeGreaterThan(150);
        await banner.getByRole('button', { name: 'Minimize', exact: true }).click();
        await expect(banner).toHaveAttribute('data-hapi-runner-skew', 'minimized');
        expect(environment.hapi.admin.mutations).toHaveLength(0);
    });

    test('rollback restart uses the same durable owner in the banner and Settings; unknown results only read', async ({ page }) => {
        const [alpha, beta] = environment.hapi.admin.machines;
        alpha!.metadata!.capabilities = []; beta!.metadata!.capabilities = [];
        environment.hapi.admin.dropNextRestartReply = true; environment.hapi.admin.deferRestartObservation = true;
        await enterWorkspace(page, environment);
        const banner = page.locator('[data-hapi-runner-skew]'), alphaRow = banner.locator('[data-source-runner-skew="machine-alpha"]');
        await expect(alphaRow.getByRole('button', { name: 'Restart Runner', exact: true })).toBeEnabled();
        await expect(banner.locator('[data-source-runner-skew="machine-beta"]').getByRole('button', { name: 'Restart Runner', exact: true })).toHaveCount(0);
        await expect(alphaRow).toContainText('installed CLI differs');
        await alphaRow.getByRole('button', { name: 'Restart Runner', exact: true }).click();
        await expect.poll(() => environment.hapi.admin.mutations.filter(row => row.path.endsWith('/restart-runner')).length).toBe(1);
        await expect(alphaRow).toContainText('original restart result is not confirmed');
        await expect(alphaRow.getByRole('button', { name: 'Restart Runner', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: false }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('button', { name: 'HAPI Hub', exact: true }).click();
        const panel = settings.getByRole('region', { name: 'HAPI Hub and Runners', exact: true });
        await panel.getByRole('tab', { name: 'Machines', exact: true }).click();
        await panel.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('machine-alpha');
        await expect(panel.getByRole('button', { name: 'Restart Runner', exact: true })).toBeDisabled();
        await panel.getByText(/Operation history \(/).click();
        await expect(panel.locator('.hapi-admin-receipts article').filter({ hasText: 'restart-runner' })).toContainText('indeterminate');
        await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0);
        await alphaRow.getByRole('button', { name: 'Read original restart', exact: true }).click();
        await expect(alphaRow).toContainText('original restart result is not confirmed');
        await page.reload(); await expect(alphaRow).toContainText('original restart result is not confirmed');
        await expect(alphaRow.getByRole('button', { name: 'Restart Runner', exact: true })).toBeDisabled();
        alpha!.runnerState = { status: 'running', pid: 103, startedAt: Date.now() };
        await alphaRow.getByRole('button', { name: 'Read original restart', exact: true }).click();
        await expect(alphaRow).toContainText('original response remains unknown');
        await expect(alphaRow.getByRole('button', { name: 'Read original restart', exact: true })).toHaveCount(0);
        expect(environment.hapi.admin.mutations.filter(row => row.path.endsWith('/restart-runner'))).toHaveLength(1);
        alpha!.metadata!.capabilities = [...capabilities]; beta!.metadata!.capabilities = [...capabilities];
        await banner.getByRole('button', { name: 'Refresh Runner state', exact: true }).click(); await expect(banner).toHaveCount(0);
        await expect(page.locator('iframe')).toHaveCount(0);
    });
});
