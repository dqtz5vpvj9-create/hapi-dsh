import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfig, readConfig } from '../src/cli/config.ts';
import { addPairing, readPairingStore } from '../src/hub/federation-credentials.ts';

function exitedPidRecord(): string {
    // A completed real child provides a proven exited owner, without guessing a PID.
    return `${execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })}\n`;
}

test('identity migration takes over a lock left by an exited process', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-lock-migration-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    const config = createConfig('http://127.0.0.1:3006', {});
    const { id: _id, ...hapi } = config.hapi;
    await writeFile(path, JSON.stringify({ ...config, hapi }), { mode: 0o600 });
    await writeFile(`${path}.migration.lock`, exitedPidRecord(), { mode: 0o600 });
    const results = await Promise.all([readConfig(path), readConfig(path)]);
    assert.equal(results[0]!.hapi.id, results[1]!.hapi.id);
    assert.deepEqual(await readdir(directory), ['config.json']);
});

test('pairing recovers an exited owner and serializes concurrent machine additions', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-lock-pairing-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'pairings.json');
    await writeFile(`${path}.lock`, exitedPidRecord(), { mode: 0o600 });
    const tokens = await Promise.all([addPairing(path, 'machine-a', 'Machine A'), addPairing(path, 'machine-b', 'Machine B')]);
    assert.notEqual(tokens[0], tokens[1]);
    const store = await readPairingStore(path);
    assert.deepEqual(store.machines.map(machine => machine.id).sort(), ['machine-a', 'machine-b']);
    for (const token of tokens) assert.ok(!JSON.stringify(store).includes(token));
    await assert.rejects(addPairing(path, 'unsupported:identity', 'Invalid identity'), /Invalid machine/);
    assert.deepEqual(await readdir(directory), ['pairings.json']);
});
