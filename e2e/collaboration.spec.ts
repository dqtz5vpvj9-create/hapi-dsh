import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';
import type { SourceWorkEvent } from '../src/source-collaboration-types.ts';

test.describe('source teams and work ledger inside official DSH plugin tabs', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment();
        Object.assign(environment.hapi.require('native-alpha').session, { teamStateUpdatedAt: 10, teamState: { teamName: 'Original alpha team',
            members: [{ name: 'Planner', agentType: 'codex', status: 'active' }, { name: 'Reviewer', agentType: 'claude', status: 'idle' }],
            tasks: [{ id: 'source-task', title: 'Read Runner files', status: 'in_progress', owner: 'Planner', description: 'Keep this task on its original machine.' }],
            messages: [{ from: 'Planner', to: 'Reviewer', type: 'message', summary: 'Please review the source changes.', timestamp: 1700000000000 }] } });
        const event: SourceWorkEvent = { id: 'alpha-handoff', ts: 1700000000000, sourceKind: 'session', sourceRef: 'native-beta', sinkKind: 'session', sinkRef: 'native-alpha',
            relatedSessionId: 'native-alpha', eventType: 'handoff', summary: 'Work sent to the original alpha team.', payloadJson: { originalField: 'preserved' },
            artifactRefs: [], tags: ['review'], relatedEventId: null, provenance: 'fixture-runner', idempotencyKey: null, dedupeKey: null, confidence: null, severity: null, expiresAt: null,
            principal: { kind: 'agent', id: 'Planner', on_behalf_of: 'original-owner' } };
        environment.hapi.collaboration.events.set(event.id, event);
        environment.hapi.collaboration.events.set('beta-only', { ...event, id: 'beta-only', summary: 'Beta private fixture task', relatedSessionId: 'native-beta' });
        environment.hapi.collaboration.links.push({ id: 'handoff-link', fromEventId: event.id, toEventId: 'beta-only', relationType: 'derived_from', createdAt: event.ts, metadataJson: { runner: 'machine-beta' } });
        environment.hapi.emit({ type: 'session-updated', sessionId: 'native-alpha' });
    });
    test.afterAll(async () => { await environment?.close(); });
    test('live original team state, source-scoped ledger and exact cross-session navigation retain the official draft', async ({ page }) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(environment.launchUrl); await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
        const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
        if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        const pane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        const draft = pane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true });
        await draft.fill('An unsent native task stays here');
        await pane.getByRole('button', { name: 'Open team: Original alpha team', exact: true }).click();
        const panel = pane.getByRole('region', { name: 'Team & work ledger', exact: true });
        await expect(panel).toContainText('Read Runner files'); await expect(panel).toContainText('Please review the source changes.');
        await expect(panel).toContainText('Work sent to the original alpha team.'); await expect(panel).not.toContainText('Beta private fixture task');
        await panel.getByRole('button', { name: 'Inspect event links', exact: true }).click();
        await expect(panel.getByRole('list', { name: 'Event links', exact: true })).toContainText('derived_from');
        environment.hapi.collaboration.offline = true;
        await panel.getByRole('button', { name: 'Refresh ledger', exact: true }).click();
        await expect(panel.getByRole('alert')).toBeVisible(); await expect(panel).toContainText('Work sent to the original alpha team.');
        environment.hapi.collaboration.offline = false;
        const original = environment.hapi.require('native-alpha').session;
        Object.assign(original, { teamStateUpdatedAt: 20, teamState: { teamName: 'Original alpha team', members: [{ name: 'Reviewer', status: 'active' }],
            tasks: [{ id: 'source-task', title: 'Read Runner files', status: 'completed', owner: 'Reviewer' }] } });
        environment.hapi.emit({ type: 'session-updated', sessionId: original.id });
        await expect(panel).toContainText('1/1 tasks completed'); await expect(draft).toHaveText('An unsent native task stays here');
        Object.assign(original, { teamStateUpdatedAt: 30, teamState: null }); environment.hapi.emit({ type: 'session-updated', sessionId: original.id });
        await expect(panel).toContainText('The source session has no active team.'); await expect(panel).not.toContainText('Read Runner files');
        await panel.getByRole('button', { name: 'Open source conversation', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true })).toBeVisible();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        await expect(draft).toHaveText('An unsent native task stays here');
        await page.reload(); await expect(pane).toBeVisible(); await expect(draft).toHaveText('An unsent native task stays here');
        expect(environment.hapi.collaboration.requests.every(request => request.method === 'GET')).toBe(true);
        expect(environment.hapi.collaboration.requests.filter(request => request.path === '/api/work-graph/events').every(request => request.sourceId === 'native-alpha')).toBe(true);
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([]);
    });
});
