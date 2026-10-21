import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HapiRequestError } from '../src/codex/contracts.ts';
import { adminMachine, SourceAdministrationService } from '../src/hapi/source-admin.ts';
import type { HapiMachine } from '../src/hapi/schemas.ts';
import type { SourceAdminAction, SourceHubSettings } from '../src/source-admin-types.ts';

/** Explicit original-HAPI protocol fixtures; no real machine is renamed or restarted. */
async function harness(run: (fixture: {
    service: SourceAdministrationService; machine: HapiMachine; settings: SourceHubSettings; calls: Array<{ path: string; method: string; body: unknown }>;
    handle(path: string, method: string, body: unknown): Promise<unknown>; reload(): SourceAdministrationService;
}) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-admin-'));
    const fixture = {
        machine: { id: 'runner-one', active: true, activeAt: 1000, metadata: { host: 'original', platform: 'linux', happyCliVersion: '1.2.3', supervisedRestart: true,
            startedCliMtimeMs: 100, installedCliMtimeMs: 200, accessToken: 'fixture-secret-do-not-forward' }, runnerState: { status: 'running', pid: 7, startedAt: 1000, environment: { PRIVATE: 'fixture-secret-do-not-forward' } } } as HapiMachine,
        settings: { sessionSummaryContract: false, sessionSummaryInChat: false }, calls: [] as Array<{ path: string; method: string; body: unknown }>,
        handle: async (_path: string, _method: string, _body: unknown): Promise<unknown> => ({ ok: true }),
    };
    const client = { hubId: 'source-hub', isConnected: true, listMachines: async () => [fixture.machine],
        request: async (path: string, options?: { method?: string; body?: unknown }) => {
            const method = options?.method ?? 'GET'; fixture.calls.push({ path, method, body: options?.body });
            if (path === '/api/hub-settings' && method === 'GET') return fixture.settings;
            return fixture.handle(path, method, options?.body);
        } };
    const reload = () => new SourceAdministrationService(client, directory), service = reload();
    try { await run(Object.assign(fixture, { service, reload })); } finally { await service.settled(); await rm(directory, { recursive: true, force: true }); }
}

test('administration whitelists original machine metadata and preserves independent setting-read errors', async () => harness(async fixture => {
    const overview = await fixture.service.overview();
    assert.equal(overview.hubId, 'source-hub'); assert.equal(overview.machines[0]?.restartRecommended, true);
    assert.equal(overview.machines[0]?.supervisedRestart, true);
    assert.equal(JSON.stringify(overview).includes('fixture-secret'), false);
    assert.deepEqual(adminMachine(fixture.machine).runner, { status: 'running', pid: 7, startedAt: 1000 });
}));

test('Runner binary changes include a rollback, but missing and non-finite times cannot recommend a restart', async () => harness(async fixture => {
    const metadata = fixture.machine.metadata!;
    metadata.startedCliMtimeMs = 200; metadata.installedCliMtimeMs = 100;
    assert.equal(adminMachine(fixture.machine).restartRecommended, true);
    metadata.startedCliMtimeMs = 100;
    assert.equal(adminMachine(fixture.machine).restartRecommended, false);
    metadata.installedCliMtimeMs = Number.NaN;
    assert.equal(adminMachine(fixture.machine).restartRecommended, false);
    metadata.installedCliMtimeMs = Infinity;
    assert.equal(adminMachine(fixture.machine).restartRecommended, false);
    delete metadata.installedCliMtimeMs;
    assert.equal(adminMachine(fixture.machine).restartRecommended, false);
}));

test('lost restart receipt survives Host reload, observes new source process and never restarts twice', async () => harness(async fixture => {
    fixture.handle = async (path, method) => { assert.equal(path, '/api/machines/runner-one/restart-runner'); assert.equal(method, 'POST'); throw new HapiRequestError('Lost reply', 'indeterminate'); };
    const input = { operationId: randomUUID(), action: { kind: 'restart-runner' as const, machineId: 'runner-one' } };
    assert.equal((await fixture.service.operation(input)).status, 'indeterminate');
    await assert.rejects(fixture.service.operation({ ...input, operationId: randomUUID() }), /unresolved operation/);
    const loaded = fixture.reload(); assert.equal((await loaded.operation(input)).status, 'indeterminate');
    fixture.machine.runnerState = { status: 'running', pid: 8, startedAt: 2000 };
    const observed = await loaded.read(input.operationId); assert.equal(observed?.status, 'observed');
    assert.match(observed?.message ?? '', /original response remains unknown/);
    assert.equal(fixture.calls.length, 1);
    await assert.rejects(loaded.operation({ ...input, action: { kind: 'machine-name', machineId: 'runner-one', displayName: 'different' } }), /different input/);
}));

test('an unsupervised Runner cannot be stopped from the restart action', async () => harness(async fixture => {
    fixture.machine.metadata!.supervisedRestart = false;
    const receipt = await fixture.service.operation({ operationId: randomUUID(), action: { kind: 'restart-runner', machineId: 'runner-one' } });
    assert.equal(receipt.status, 'rejected'); assert.match(receipt.message ?? '', /supervisor/); assert.equal(fixture.calls.length, 0);
}));

test('settings readback confirms desired state without inventing a missing mutation response', async () => harness(async fixture => {
    fixture.handle = async (_path, method, body) => {
        assert.equal(method, 'PUT'); Object.assign(fixture.settings, body); throw new HapiRequestError('Lost reply', 'indeterminate');
    };
    const action: SourceAdminAction = { kind: 'settings', values: { sessionSummaryInChat: true } }, operationId = randomUUID();
    assert.equal((await fixture.service.operation({ operationId, action })).status, 'indeterminate');
    assert.equal((await fixture.reload().read(operationId))?.status, 'observed');
    assert.equal(fixture.calls.filter(row => row.method !== 'GET').length, 1);
    assert.equal(fixture.settings.sessionSummaryContract, false);
}));

test('bundle switches use only an available optional source profile entry, retain restart requirement', async () => harness(async fixture => {
    const profile = { profile: 'default', dshHome: '/runner/dsh', bundles: ['foundation'], available: [
        { name: 'foundation', description: '', enabled: true, switchable: false }, { name: 'optional', description: '', enabled: false, switchable: true },
    ], restartRequired: false };
    fixture.handle = async (path, method, body) => {
        assert.equal(path, '/api/machines/runner-one/dsh-bundles');
        if (method === 'POST') { assert.deepEqual(body, { name: 'optional', enabled: true }); profile.available[1]!.enabled = true; profile.bundles.push('optional'); profile.restartRequired = true; }
        return profile;
    };
    assert.equal((await fixture.service.operation({ operationId: randomUUID(), action: { kind: 'dsh-bundle', machineId: 'runner-one', name: 'foundation', enabled: false } })).status, 'rejected');
    assert.equal(fixture.calls.filter(row => row.method === 'POST').length, 0);
    const receipt = await fixture.service.operation({ operationId: randomUUID(), action: { kind: 'dsh-bundle', machineId: 'runner-one', name: 'optional', enabled: true } });
    assert.equal(receipt.status, 'confirmed'); assert.equal(receipt.bundles?.restartRequired, true);
    assert.equal(fixture.calls.filter(row => row.method === 'POST').length, 1);
}));

test('usage validates source timezone and does not invent monetary prices', async () => harness(async fixture => {
    await assert.rejects(fixture.service.usage({ range: '7d', timeZone: 'not/a-zone' }), /valid IANA/);
    assert.equal(fixture.calls.length, 0);
    fixture.handle = async path => {
        assert.equal(path, '/api/usage/summary?range=30d&timeZone=Asia%2FShanghai');
        return { range: { from: 1, to: 2 }, totals: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 1, totalTokens: 8, uncachedTokens: 6, requests: 1, sessions: 1 },
            daily: [], byAgent: [], byModel: [], updatedAt: 3, secret: 'discarded', price: 999 };
    };
    const value = await fixture.service.usage({ range: '30d', timeZone: 'Asia/Shanghai' });
    assert.equal(value.totals.totalTokens, 8); assert.equal('price' in value, false); assert.equal('secret' in value, false);
}));
