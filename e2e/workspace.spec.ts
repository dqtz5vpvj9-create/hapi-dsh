import { acknowledgePreviewNotice } from './preview-notice.ts'
import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.describe('unchanged official DSH Web + HAPI plugins', () => {
    let environment: OfficialEnvironment;
    let diagnostics: string[] = [];
    test.beforeAll(async () => { environment = await startOfficialEnvironment(true); });
    test.afterAll(async () => { await environment?.close(); });
    test.beforeEach(async ({ page }) => {
        diagnostics = [];
        page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') diagnostics.push(message.text()); });
        page.on('response', response => {
            if (new URL(response.url()).pathname.endsWith('/api/session/prompt')) {
                void response.text().then(body => diagnostics.push(`Prompt HTTP ${response.status()}: ${body.slice(0,2000)}`), () => {});
            }
        });
        const promptRequests = new Set<string>();
        page.on('websocket', socket => {
            socket.on('framesent', frame => {
                try {
                    const message = JSON.parse(frame.payload.toString()) as { method?: string; rpcId?: string };
                    if (message.method === 'session/prompt') {
                        if (message.rpcId) promptRequests.add(message.rpcId);
                        diagnostics.push(`Prompt sent: ${frame.payload.toString().slice(0,2000)}`);
                    }
                } catch { /* Binary frames and unrelated runtime traffic are not diagnostics. */ }
            });
            socket.on('framereceived', frame => {
                try {
                    const message = JSON.parse(frame.payload.toString()) as { rpcId?: string; result?: { ok?: boolean } };
                    if (message.rpcId && promptRequests.has(message.rpcId) || message.result?.ok === false) diagnostics.push(`RPC response: ${frame.payload.toString().slice(0,2000)}`);
                } catch { /* Non-JSON runtime traffic is not an RPC. */ }
            });
        });
    });
    test.afterEach(async ({}, info) => {
        if (info.status !== info.expectedStatus && diagnostics.length) {
            await info.attach('browser-diagnostics', { body: diagnostics.join('\n\n').replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'), contentType: 'text/plain' });
            process.stderr.write(`${diagnostics.join('\n\n').replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')}\n`);
        }
    });

    test('one sidebar, native and DSH official conversations, tmux geometry, persistence and native finality', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl);
        await acknowledgePreviewNotice(page, environment)
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1);
        await expect(page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' })).toBeVisible();
        await expect(page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' })).toBeVisible();
        await expect(page.locator('.hapi-session-open').filter({ hasText: 'DSH remote conversation' })).toBeVisible();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        await expect(page.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Split left / right', exact: true }).click();
        await page.locator('.hapi-session-open').filter({ hasText: 'DSH remote conversation' }).click();
        await expect(page.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible();
        await expect(page.locator('.hapi-pane')).toHaveCount(2);
        await expect(page.locator('iframe')).toHaveCount(0);
        const divider = page.getByRole('separator', { name: 'Resize split', exact: true });
        const previous = await divider.getAttribute('aria-valuenow');
        await divider.focus(); await divider.press('ArrowRight');
        await expect(divider).not.toHaveAttribute('aria-valuenow', previous!);
        await expect(page.locator('.hapi-persistence-saved')).toBeVisible();
        await page.reload();
        await expect(page.locator('.hapi-pane')).toHaveCount(2);
        await expect(page.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible();
        await expect(page.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible();
        environment.hapi.requestApproval('native-alpha');
        const approval = page.locator('[data-native-request="approval-e2e"]');
        await expect(approval).toBeVisible();
        await approval.getByRole('button', { name: 'Approve', exact: true }).click();
        await expect(approval).toContainText('Answer sent; waiting for source confirmation');
        expect(environment.hapi.approvals).toHaveLength(1);
        await expect(approval.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
        environment.hapi.settleApproval('native-alpha');
        await expect(approval).toHaveCount(0);
        const connectionsBefore = environment.hapi.eventConnections;
        environment.hapi.disconnectEvents();
        await expect(page.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible();
        await expect.poll(() => environment.hapi.eventConnections).toBeGreaterThan(connectionsBefore);
        const catalog = await environment.rpc<{ sessions: Array<{ id: string; hapiSessionId: string }> }>('hapi/catalog');
        const alphaId = catalog.sessions.find(row => row.hapiSessionId === 'native-alpha')!.id;
        await expect.poll(async () => (await environment.rpc<{ readOnly: boolean }>('hapi/nativeSettings', { sessionId: alphaId })).readOnly).toBe(false);
        const nativePane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        const composer = nativePane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions' });
        const sentBefore = environment.hapi.sent.length;
        await composer.fill('Native queue cancellation from the official composer');
        await nativePane.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect.poll(() => environment.hapi.sent.length).toBe(sentBefore + 1);
        const cancelledId = environment.hapi.sent.at(-1)!.message.localId;
        const deliveries = nativePane.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Native delivery' }) });
        await deliveries.locator('summary').click();
        await deliveries.getByRole('button', { name: 'Cancel queued message', exact: true }).click();
        await expect.poll(() => environment.hapi.cancelled).toContain(cancelledId);
        await expect(nativePane.locator('.hapi-native-delivery')).toHaveCount(0);
        await composer.fill('Native execution from the official composer');
        await nativePane.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect.poll(() => environment.hapi.sent.length).toBe(sentBefore + 2);
        environment.hapi.consume('native-alpha', environment.hapi.sent.at(-1)!.message.localId);
        await expect(nativePane.getByText('Native response to: Native execution from the official composer', { exact: true })).toBeVisible();
        expect(environment.hapi.sent.slice(sentBefore).every(row => row.sessionId === 'native-alpha')).toBe(true);
        await page.screenshot({ path: 'test-results/official-workspace.png', fullPage: true });
        expect(errors).toEqual([]);
    });

    test('remote official plugin graph provides a working conversation and its own settings', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await acknowledgePreviewNotice(page, environment)
        await page.locator('.hapi-session-open').filter({ hasText: 'DSH remote conversation' }).click();
        const remotePane = page.getByRole('region', { name: 'Pane: DSH remote conversation', exact: true });
        await expect(remotePane.locator('.hapi-remote-shell')).toBeVisible();
        await acknowledgePreviewNotice(page, environment)
        await expect(remotePane.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible();
        const composer = remotePane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions' });
        await expect(composer).toBeVisible();
        await composer.fill('A real remote DSH composer turn');
        await remotePane.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(remotePane.getByText('A real remote DSH composer turn', { exact: true })).toBeVisible();
        await expect(remotePane.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toHaveCount(2);
        await remotePane.getByRole('button', { name: 'Host settings', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await remotePane.getByRole('combobox', { name: 'Host tools', exact: true }).selectOption({ label: 'Plugins' });
        await expect(remotePane).toContainText('Plugins');
        await remotePane.getByRole('combobox', { name: 'Host tools', exact: true }).selectOption('');
        await expect(composer).toBeVisible();
        await page.screenshot({ path: 'test-results/official-remote.png', fullPage: true });
        expect(errors).toEqual([]);
    });

    test('native settings, source-bound fork, and creation stay in the unified workspace', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await acknowledgePreviewNotice(page, environment)
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click();
        const nativePane = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
        // R8b: routine native-settings metadata row removed from the pane UI.
        await expect(nativePane.locator('.hapi-native-settings, .hapi-native-routine, .hapi-native-usage')).toHaveCount(0);
        await nativePane.locator('.hapi-native-fork-action').click();
        const fork = page.getByRole('dialog', { name: 'Fork conversation', exact: true });
        await fork.getByRole('button', { name: 'Fork conversation', exact: true }).click();
        await expect(page.locator('.hapi-session-open').filter({ hasText: 'Native fork created' })).toBeVisible();
        await expect(page.getByText('Forked native answer', { exact: true })).toBeVisible();
        expect(environment.hapi.forkRequests).toHaveLength(1);
        expect(environment.hapi.forkRequests[0]!.body.nativeBoundary).toMatchObject({ threadId: 'codex-thread-beta', turnId: 'turn-1', itemId: 'answer-beta' });
        await page.locator('.hapi-workspace-tools > details > summary').click();
        await page.getByRole('button', { name: 'Codex · New conversation', exact: true }).click();
        const creation = page.getByRole('dialog', { name: 'New Codex session', exact: true });
        await creation.getByLabel('Working directory', { exact: true }).fill('/workspace/new-native');
        await creation.getByRole('combobox', { name: 'Codex home', exact: true }).selectOption('/home/alpha/.codex');
        await creation.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fixture-model');
        await creation.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('high');
        await creation.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(page.locator('.hapi-session-open').filter({ hasText: 'Native Codex created-0' })).toBeVisible();
        const createdPane = page.getByRole('region', { name: 'Pane: Native Codex created-0', exact: true });
        await expect(createdPane).toBeVisible();
        expect(environment.hapi.require('native-created-0').session.metadata).toMatchObject({ path: '/workspace/new-native', codexHome: '/home/alpha/.codex', machineId: 'machine-alpha' });
        expect(environment.hapi.require('native-created-0').rows).toHaveLength(0);
        const sentBefore = environment.hapi.sent.length;
        await createdPane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions' }).fill('First message in an empty native Codex thread');
        await createdPane.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect.poll(() => environment.hapi.sent.length).toBe(sentBefore + 1);
        environment.hapi.consume('native-created-0', environment.hapi.sent.at(-1)!.message.localId);
        await expect(createdPane.getByText('Native response to: First message in an empty native Codex thread', { exact: true })).toBeVisible();
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1);
        await expect(page.locator('iframe')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('the official New session action creates an ordinary DSH conversation in the same workspace', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await acknowledgePreviewNotice(page, environment)
        await page.getByRole('button', { name: 'New session', exact: true }).last().click();
        const choice = page.getByRole('dialog', { name: 'New conversation', exact: true });
        await choice.getByRole('button', { name: /^DSH/ }).click();
        const creation = page.getByRole('dialog', { name: 'DSH · New conversation', exact: true });
        await creation.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('local');
        await creation.getByLabel('Working directory', { exact: true }).fill(environment.directory);
        await creation.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(creation).toHaveCount(0);
        const pane = page.locator('.hapi-pane-focused');
        await expect(pane).toBeVisible();
        const model = pane.getByRole('button', { name: /^Select model/ });
        await model.click();
        const modelChoice = page.getByRole('menuitem', { name: /^Model/ });
        if (await modelChoice.isVisible()) await modelChoice.click();
        await page.getByRole('menuitemradio', { name: 'E2E fixture model', exact: true }).click();
        await pane.getByRole('textbox', { name: 'Describe what you want to build, / commands, @ files or sessions' }).fill('A local DSH session created from the unified sidebar');
        await pane.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(pane.locator('[data-conversation-content]').getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible();
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1);
        await expect(page.locator('iframe')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('native plan implementation preserves its source identity and never resubmits on reload', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await acknowledgePreviewNotice(page, environment)
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click();
        const pane = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
        const planId = 'e2e-source-plan-proposal';
        environment.hapi.proposePlan('native-beta', planId);
        const controls = pane.getByRole('region', { name: 'Codex plan', exact: true });
        await controls.getByRole('button', { name: 'Implement plan', exact: true }).click();
        await expect.poll(() => environment.hapi.planRequests).toEqual([{ sessionId: 'native-beta', planId }]);
        await expect(controls.locator('[data-plan-operation]')).toHaveAttribute('data-plan-state', 'queued');
        await page.reload();
        await expect(controls.locator('[data-plan-operation]')).toHaveAttribute('data-plan-state', 'queued');
        expect(environment.hapi.planRequests).toHaveLength(1);
        environment.hapi.consume('native-beta', `${planId}:implement`);
        await expect(controls.locator('[data-plan-operation]')).toHaveAttribute('data-plan-state', 'invoked');
        await expect(pane.getByText('Native response to: Implement the plan.', { exact: true })).toBeVisible();
        expect(environment.hapi.planRequests).toHaveLength(1);
        expect(errors).toEqual([]);
    });
});
