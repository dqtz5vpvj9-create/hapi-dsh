/** The retired credential command must fail before reading stdin or mutating private config. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createConfig, writeConfig } from '../src/cli/config.ts';
const execute = promisify(execFile);
test('CLI refuses legacy login/options/config and preserves the private original for offline recovery', async t => {
    const root = process.env.HAPI_DSH_TEST_ROOT ?? (existsSync('/mnt/cache/data-cache') ? '/mnt/cache/data-cache' : tmpdir());
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'hapi-dsh-retired-login-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'config with spaces.json');
    await writeConfig(file, createConfig({}));
    const invoke = (args: string[], input?: string) => {
        const running = execute(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), ...args, '--config', file]);
        if (input !== undefined) running.child.stdin!.end(input);
        return running;
    };
    const unchanged = await readFile(file, 'utf8');
    for (const args of [['login', '--stdin'], ['init', '--hapi-url', 'https://legacy.example.test'], ['init', '--token-env', 'OLD_TOKEN']]) {
        await assert.rejects(invoke(args), (error: unknown) => {
            assert.ok(error instanceof Error); assert.match(error.message, /retired.*offline migration/i); return true;
        });
        assert.equal(await readFile(file, 'utf8'), unchanged);
    }
    const legacy = JSON.stringify({ ...createConfig({}), hapi: { url: 'https://legacy.example.test', token: 'fixture-login-secret' } });
    await writeFile(file, legacy, { mode: 0o600 });
    for (const command of ['start', 'config']) await assert.rejects(invoke([command]), (error: unknown) => {
        assert.ok(error instanceof Error); assert.match(error.message, /retired.*offline migration/i);
        assert.ok(!error.message.includes('fixture-login-secret')); return true;
    });
    assert.equal(await readFile(file, 'utf8'), legacy);
});
