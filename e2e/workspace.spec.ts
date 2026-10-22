import { acknowledgePreviewNotice } from './preview-notice.ts'
import { test, expect, type Locator, type Page } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

/** Use the focused pane's visible menu; never call a hidden graph's controls. */
async function paneActions(page: Page, pane: Locator): Promise<Locator> {
    await pane.click({ position: { x: 4, y: 4 } });
    const menu = page.locator('.hapi-statusbar .hapi-pane-actions');
    if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
    return menu;
}

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
        const resized = await divider.getAttribute('aria-valuenow');
        await expect(page.locator('.hapi-persistence-saved')).toBeVisible();
        await page.reload();
        await expect(page.locator('.hapi-pane')).toHaveCount(2);
        await expect(divider).toHaveAttribute('aria-valuenow', resized!);
        await expect(page.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible();
        await expect(page.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible();
        await expect(page.locator('[data-hapi-graph="shared"]')).toHaveCount(2);
        environment.hapi.requestApproval('native-alpha');
        const approval = page.locator('[data-native-request="approval-e2e"]');
        await expect(approval).toBeVisible();
        await approval.getByRole('button', { name: 'Approve once', exact: true }).click();
        await expect(approval).toContainText('Answer sent; waiting for source confirmation');
        expect(environment.hapi.approvals).toHaveLength(1);
        await expect(approval.getByRole('button', { name: 'Approve once', exact: true })).toBeDisabled();
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
        // Current operations remain inline beside the composer. Historical
        // diagnostic disclosures must not hide this message's recovery action.
        const delivery = nativePane.locator(`[data-hapi-current-deliveries] [data-hapi-delivery-id="${cancelledId}"]`);
        await expect(delivery).toBeVisible();
        await expect(delivery).toHaveAttribute('data-hapi-delivery-status', 'queued');
        await delivery.getByRole('button', { name: 'Cancel queued message', exact: true }).click();
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

    test('remote shared conversation keeps its source while focused plugin tools open the remote Host settings', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl);
        await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        await acknowledgePreviewNotice(page, environment)
        await page.locator('.hapi-session-open').filter({ hasText: 'DSH remote conversation' }).click();
        const remotePane = page.getByRole('region', { name: 'Pane: DSH remote conversation', exact: true });
        await expect(remotePane.locator('[data-hapi-graph="shared"]')).toHaveAttribute('data-hapi-host', 'runner-one');
        await expect(remotePane.locator('[data-hapi-session-view]')).toHaveAttribute('data-hapi-session-view', environment.remoteSessionId!);
        await expect(remotePane.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible();
        const composer = remotePane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions' });
        await expect(composer).toBeVisible();
        await composer.fill('A real remote DSH composer turn');
        await remotePane.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(remotePane.getByText('A real remote DSH composer turn', { exact: true })).toBeVisible();
        await expect(remotePane.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toHaveCount(2);
        await composer.fill('Remote draft remains in its original shared conversation');

        // Official Host chrome belongs to the focused compatibility plugin view.
        // It is reached from a public menu; the shared chat keeps its one graph.
        const paneIds = await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')));
        await (await paneActions(page, remotePane)).getByRole('button', { name: 'Plugin views in a new pane', exact: true }).click();
        await expect.poll(async () => (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).filter(id => !paneIds.includes(id)).length).toBe(1);
        const toolsId = (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).find(id => !paneIds.includes(id))!;
        const toolsPane = page.locator(`[data-pane-id="${toolsId}"]`);
        await expect(toolsPane.locator('.hapi-remote-shell')).toBeVisible();
        await expect(toolsPane.locator('[data-hapi-host]')).toHaveAttribute('data-hapi-host', 'runner-one');
        const tools = await paneActions(page, toolsPane);
        await tools.getByRole('button', { name: 'Host settings', exact: true }).click();
        // Scope to this remote graph: a primary-Host dialog would fail here.
        await expect(toolsPane.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(toolsPane.getByRole('dialog')).toHaveCount(0);
        await (await paneActions(page, toolsPane)).getByRole('combobox', { name: 'Host tools', exact: true }).selectOption({ label: 'Plugins' });
        await expect(toolsPane.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
        await expect(remotePane.locator('[data-hapi-session-view]')).toHaveAttribute('data-hapi-session-view', environment.remoteSessionId!);
        await expect(composer).toHaveText('Remote draft remains in its original shared conversation');
        await (await paneActions(page, toolsPane)).getByRole('combobox', { name: 'Host tools', exact: true }).selectOption({ label: 'Conversation' });
        await expect(toolsPane.locator('[data-hapi-session-view]')).toHaveAttribute('data-hapi-session-view', environment.remoteSessionId!);
        await expect(toolsPane.getByText('A real remote DSH composer turn', { exact: true })).toBeVisible();
        await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1);
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
        const controls = pane.getByRole('region', { name: 'Codex plan', exact: true });
        // Keep proposal delivery during pane startup; do not wait for its
        // conversation or source controls to mount before this source event.
        await expect(controls).toHaveCount(0);
        const planId = 'e2e-source-plan-proposal';
        environment.hapi.proposePlan('native-beta', planId);
        await controls.getByRole('button', { name: 'Implement plan', exact: true }).click();
        await expect.poll(() => environment.hapi.planRequests).toEqual([{ sessionId: 'native-beta', planId }]);
        await expect(controls.locator('[data-plan-operation]')).toHaveCount(1);
        await expect(controls.locator('[data-plan-operation]')).toHaveAttribute('data-plan-state', 'queued');
        expect(environment.hapi.require('native-beta').session.agentState?.codexPlanProposalId).toBeUndefined();
        await page.reload();
        await expect(controls.locator('[data-plan-operation]')).toHaveCount(1);
        await expect(controls.locator('[data-plan-operation]')).toHaveAttribute('data-plan-state', 'queued');
        expect(environment.hapi.planRequests).toHaveLength(1);
        environment.hapi.consume('native-beta', `${planId}:implement`);
        await expect(controls.locator('[data-plan-operation]')).toHaveAttribute('data-plan-state', 'invoked');
        await expect(pane.getByText('Native response to: Implement the plan.', { exact: true })).toBeVisible();
        expect(environment.hapi.planRequests).toHaveLength(1);
        expect(errors).toEqual([]);
    });
});
