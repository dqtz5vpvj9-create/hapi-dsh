import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WorkspaceRepository } from '../src/hub/workspaces.ts';
import { initialWorkspace, parseWorkspaceState } from '../src/client/model.ts';

test('two clients writing the same workspace revision get an explicit conflict; accepted state survives restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-workspace-'));
    const path = join(directory, 'state.json');
    let id = 0;
    const state = initialWorkspace(() => `identity-${++id}`);
    try {
        const store = new WorkspaceRepository(path);
        assert.deepEqual(await store.get(), { revision: 0, state: null });
        const results = await Promise.all([
            store.put({ expectedRevision: 0, state, operationId: 'browser-a' }),
            store.put({ expectedRevision: 0, state: { ...state, windows: state.windows.map(window => ({ ...window, name: 'B' })) }, operationId: 'browser-b' }),
        ]);
        assert.deepEqual(results.map(result => result.status), ['applied', 'conflict']);
        assert.equal(results[1]?.state?.windows[0]?.name, 'W1');
        assert.deepEqual(await new WorkspaceRepository(path).get(), { revision: 1, state: parseWorkspaceState(state) });
        assert.equal((await stat(path)).mode & 0o077, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an acknowledgement lost after commit can be reconciled by the same operation identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-workspace-'));
    const path = join(directory, 'state.json');
    let id = 0;
    const request = { expectedRevision: 0, operationId: 'same-operation', state: initialWorkspace(() => `id-${++id}`) };
    try {
        await new WorkspaceRepository(path).put(request);
        const reconciled = await new WorkspaceRepository(path).put(request);
        assert.equal(reconciled.status, 'applied');
        assert.equal(reconciled.revision, 1);
        assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('workspace compare-and-swap survives a crashed writer without deleting a live holder lock', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-workspace-crash-'));
    const path = join(directory, 'state.json');
    const child = spawn(process.execPath, ['--input-type=module', '-e',
        'import { withFileLock } from "@deepseek-ai/dsh-atomic-write"; await withFileLock(process.argv[1], async () => { process.exit(86); });', path],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        const [code] = await once(child, 'close');
        assert.equal(code, 86, 'Fixture exits abruptly inside the held writer lock without running finally');
        let id = 0;
        const state = initialWorkspace(() => `crash-${++id}`);
        const [a, b] = await Promise.all([
            new WorkspaceRepository(path).put({ expectedRevision: 0, state, operationId: 'after-crash-a' }),
            new WorkspaceRepository(path).put({ expectedRevision: 0, state, operationId: 'after-crash-b' }),
        ]);
        assert.deepEqual([a.status, b.status].sort(), ['applied', 'conflict']);
        assert.equal((await new WorkspaceRepository(path).get()).revision, 1);
    } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); }
        await rm(directory, { recursive: true, force: true });
    }
});
