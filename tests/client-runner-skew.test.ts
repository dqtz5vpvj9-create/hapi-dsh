import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { cliBinaryUpdatedOnDisk, listSkewedMachines, missingRequiredCapabilities, REQUIRED_MACHINE_CAPABILITIES } from '../src/source-runner-capabilities.ts';
import { RUNNER_SKEW_DISMISS_UNTIL_KEY, RUNNER_SKEW_MINIMIZED_KEY, RUNNER_SKEW_TEMP_DISMISS_MS, RunnerSkewPreferences } from '../src/client/runner-skew-state.ts';
import { SourceAdministrationRuntime } from '../src/client/source-admin-runtime.ts';
import type { SourceAdminApi, SourceAdministration, SourceAdminReceipt } from '../src/source-admin-types.ts';

function memoryStorage() {
    const data = new Map<string, string>();
    return { data, getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
function administration(hubId = 'hub'): SourceAdministration {
    return { hubId, connected: true, machines: [], settings: { sessionSummaryContract: false, sessionSummaryInChat: false }, settingsError: null, operations: [] };
}

test('Runner skew follows exact required RPC capabilities and only includes online machines', () => {
    assert.deepEqual(missingRequiredCapabilities(null), ['agent-availability', 'cursor-chat-store-status']);
    assert.deepEqual(missingRequiredCapabilities(['agent-availability', 'machine-terminal', 'agent-availability']), ['cursor-chat-store-status']);
    assert.deepEqual(missingRequiredCapabilities([...REQUIRED_MACHINE_CAPABILITIES, 'future-capability']), []);
    const machines = [
        { id: 'same-version-capable', online: true, capabilities: [...REQUIRED_MACHINE_CAPABILITIES], version: '1.0' },
        { id: 'same-version-incomplete', online: true, capabilities: ['agent-availability'], version: '1.0' },
        { id: 'old-offline', online: false, capabilities: [], version: '0.0' },
        { id: 'new-incomplete', online: true, capabilities: [], version: '999.0' },
    ];
    assert.deepEqual(listSkewedMachines(machines).map(row => row.id), ['same-version-incomplete', 'new-incomplete']);
});

test('original binary comparison detects either direction and requires two finite numbers', () => {
    assert.equal(cliBinaryUpdatedOnDisk({ startedCliMtimeMs: 20, installedCliMtimeMs: 10 }), true);
    assert.equal(cliBinaryUpdatedOnDisk({ startedCliMtimeMs: 10, installedCliMtimeMs: 20 }), true);
    assert.equal(cliBinaryUpdatedOnDisk({ startedCliMtimeMs: -2, installedCliMtimeMs: -1 }), true);
    for (const metadata of [null, undefined, {}, { startedCliMtimeMs: 10 }, { startedCliMtimeMs: '10', installedCliMtimeMs: 20 },
        { startedCliMtimeMs: 20, installedCliMtimeMs: 20 }, { startedCliMtimeMs: NaN, installedCliMtimeMs: 20 }, { startedCliMtimeMs: 20, installedCliMtimeMs: Infinity }]) {
        assert.equal(cliBinaryUpdatedOnDisk(metadata), false);
    }
});

test('original session keys restore minimization and dismissal expires after exactly one hour', () => {
    const storage = memoryStorage(); storage.setItem(RUNNER_SKEW_MINIMIZED_KEY, '1');
    const preferences = new RunnerSkewPreferences(storage);
    assert.equal(preferences.getSnapshot().minimized, true);
    preferences.setMinimized(false); assert.equal(storage.getItem(RUNNER_SKEW_MINIMIZED_KEY), null);
    preferences.dismiss(100); assert.equal(storage.getItem(RUNNER_SKEW_DISMISS_UNTIL_KEY), String(100 + 60 * 60_000));
    const restored = new RunnerSkewPreferences(storage);
    assert.equal(restored.getSnapshot().dismissUntil, 100 + RUNNER_SKEW_TEMP_DISMISS_MS);
    restored.expire(99 + RUNNER_SKEW_TEMP_DISMISS_MS); assert.notEqual(restored.getSnapshot().dismissUntil, 0);
    restored.expire(100 + RUNNER_SKEW_TEMP_DISMISS_MS); assert.equal(restored.getSnapshot().dismissUntil, 0);
    assert.equal(storage.getItem(RUNNER_SKEW_DISMISS_UNTIL_KEY), null);
});

test('blocked sessionStorage preserves immediate in-memory controls and subscription cleanup', () => {
    const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); }, removeItem() { throw new Error('SecurityError'); } };
    const preferences = new RunnerSkewPreferences(blocked); let changes = 0;
    const unsubscribe = preferences.subscribe(() => { changes++; });
    preferences.setMinimized(true); assert.equal(preferences.getSnapshot().minimized, true);
    preferences.dismiss(1000); assert.equal(preferences.getSnapshot().dismissUntil, 1000 + RUNNER_SKEW_TEMP_DISMISS_MS);
    preferences.setMinimized(false); assert.equal(preferences.getSnapshot().minimized, false);
    preferences.expire(1000 + RUNNER_SKEW_TEMP_DISMISS_MS); assert.equal(preferences.getSnapshot().dismissUntil, 0);
    assert.equal(changes, 4); unsubscribe(); preferences.setMinimized(true); assert.equal(changes, 4);
    preferences.dispose();
});

test('invalid persisted dismissal dates cannot permanently hide Runner incompatibility', () => {
    for (const value of ['Infinity', 'NaN', 'not-a-time', '-1', '']) {
        const storage = memoryStorage(); storage.setItem(RUNNER_SKEW_DISMISS_UNTIL_KEY, value);
        assert.equal(new RunnerSkewPreferences(storage).getSnapshot().dismissUntil, 0);
    }
});

test('Settings and banner coalesce administration reads and keep one mutation owner across refresh', async () => {
    let release!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const api = { sourceAdministration: async () => { reads++; await gate; return { ok: true, value: administration() }; } } as unknown as SourceAdminApi;
    const runtime = new SourceAdministrationRuntime(api, memoryStorage());
    const bannerRead = runtime.refresh(), settingsRead = runtime.refresh();
    assert.equal(bannerRead, settingsRead); release(); await bannerRead;
    const controller = runtime.getSnapshot().controller; assert.ok(controller); assert.equal(reads, 1);
    await runtime.refresh(); assert.equal(reads, 2); assert.equal(runtime.getSnapshot().controller, controller);
    runtime.dispose();
});

test('a banner restart remains the same persisted operation in Settings and only readback resolves an unknown reply', async () => {
    const operationId = randomUUID(), data = administration(); let posts = 0, reads = 0;
    const receipt: SourceAdminReceipt = { operationId, hubId: 'hub', action: { kind: 'restart-runner', machineId: 'machine' },
        status: 'indeterminate', createdAt: 1, updatedAt: 2, message: 'Lost original reply', settings: null, bundles: null, machine: null };
    const api = {
        sourceAdministration: async () => ({ ok: true, value: structuredClone(data) }),
        sourceAdminOperation: async (request: { operationId: string }) => { posts++; receipt.operationId = request.operationId; data.operations = [structuredClone(receipt)]; throw new Error('Lost original reply'); },
        sourceAdminOperationRead: async () => { reads++; return { ok: true, value: structuredClone(receipt) }; },
    } as unknown as SourceAdminApi;
    const runtime = new SourceAdministrationRuntime(api, memoryStorage()); await runtime.refresh();
    const bannerController = runtime.getSnapshot().controller!;
    await bannerController.run(receipt.action); assert.equal(posts, 1); assert.equal(bannerController.canRun(receipt.action), false);
    await runtime.refresh(); const settingsController = runtime.getSnapshot().controller!;
    assert.equal(settingsController, bannerController); assert.equal(settingsController.canRun(receipt.action), false);
    await settingsController.run(receipt.action); assert.equal(posts, 1);
    receipt.status = 'observed'; receipt.updatedAt = 3;
    await runtime.refresh(); await settingsController.recover();
    assert.equal(settingsController.getSnapshot().receipts[0]?.status, 'observed'); assert.equal(posts, 1); assert.ok(reads >= 3);
    runtime.dispose();
});

test('a completed mutation revalidates after an already-dispatched stale overview instead of reusing it', async () => {
    let release!: () => void, reads = 0;
    const data = administration(), gate = new Promise<void>(resolve => { release = resolve; });
    const api = { sourceAdministration: async () => {
        reads++; const response = structuredClone(data);
        if (reads === 1) await gate;
        return { ok: true, value: response };
    } } as unknown as SourceAdminApi;
    const runtime = new SourceAdministrationRuntime(api, memoryStorage());
    const beforeMutation = runtime.refresh(); await Promise.resolve();
    data.settings!.sessionSummaryInChat = true;
    const afterMutation = runtime.revalidate(); release();
    await Promise.all([beforeMutation, afterMutation]);
    assert.equal(reads, 2); assert.equal(runtime.getSnapshot().data?.settings?.sessionSummaryInChat, true);
    runtime.dispose();
});

test('read-only administration does not write an empty mutation journal and rejects stale publication after disposal', async () => {
    let writes = 0, release!: () => void;
    const data = administration(), gate = new Promise<void>(resolve => { release = resolve; });
    let delayed = false;
    const api = { sourceAdministration: async () => { if (delayed) await gate; return { ok: true, value: data }; } } as unknown as SourceAdminApi;
    const runtime = new SourceAdministrationRuntime(api, { getItem: () => null, setItem() { writes++; throw new Error('quota'); } });
    await runtime.refresh(); assert.equal(writes, 0); assert.equal(runtime.getSnapshot().controller?.getSnapshot().error, null);
    delayed = true; const pending = runtime.refresh(), snapshot = runtime.getSnapshot();
    runtime.dispose(); data.hubId = 'another-source'; release(); await pending;
    assert.equal(runtime.getSnapshot(), snapshot); assert.equal(writes, 0);
});
