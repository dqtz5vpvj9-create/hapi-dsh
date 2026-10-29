/** Production configuration and routing boundaries; no HAPI service or credentials. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createConfig, parseConfig, publicConfig, readConfig, writeConfig } from '../src/cli/config.ts';
import { createRunnerConfig, parseRunnerConfig } from '../src/runner/config.ts';
import { assertOrdinarySourceTarget, legacyWorkbenchSource } from '../src/shared/source-access.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';

test('HAPI-free configuration has no token requirement or invented legacy identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-config-'));
    try {
        const config = createConfig(undefined, { HOME: directory, XDG_CONFIG_HOME: directory });
        assert.equal(config.hapi, undefined);
        const file = join(directory, 'config.json'); await writeConfig(file, config);
        const before = await readFile(file, 'utf8');
        const parsed = await readConfig(file);
        assert.equal(parsed.hapi, undefined); assert.deepEqual(publicConfig(parsed), parsed);
        assert.equal(await readFile(file, 'utf8'), before, 'no HAPI identity migration runs for a native-only Host');
        const source = { id: 'native', machineId: 'machine-a', engine: 'codex', command: 'codex', cwd: directory, ownership: 'shared' };
        assert.equal(parseConfig({ ...config, sources: [source] }).sources?.[0]?.id, 'native');
        assert.equal(parseConfig({ ...config, sources: [] }).hapi, undefined);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Runner sources use their paired machine identity and need no HAPI source', () => {
    const runner = createRunnerConfig('https://display.example.invalid', { id: 'machine-a' });
    const source = { id: 'native', machineId: runner.machine.id, engine: 'codex', endpoint: 'ws://127.0.0.1:4567' };
    assert.equal(parseRunnerConfig({ ...runner, sources: [source] }).sources?.[0]?.machineId, 'machine-a');
    assert.throws(() => parseRunnerConfig({ ...runner, sources: [{ ...source, machineId: 'machine-b' }] }), /paired machine ID/);
    assert.ok(!JSON.stringify(runner).includes('unused.invalid'));
});
test('direct and malformed HHPI identities cannot enter ordinary filesystem or execution routes', async () => {
    const ctx = new Context();
    try {
        const source = sourceSessionId({ machineId: 'm', sourceId: 's', engine: 'codex', nativeId: 'n' });
        for (const id of [source, 'hhpi:invalid', 'hhpi:']) {
            assert.throws(() => assertOrdinarySourceTarget(id), /exact native source capability/);
            assert.throws(() => legacyWorkbenchSource(ctx, id), /exact native source capability/);
        }
        assert.equal(legacyWorkbenchSource(ctx, 'ordinary-dsh-session'), undefined);
    } finally { await ctx.fiber.dispose(); }
});
