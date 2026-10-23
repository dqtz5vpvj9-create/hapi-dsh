import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createConfig, writeConfig } from '../src/cli/config.ts';

const execute = promisify(execFile);
test('CLI login persists stdin privately, keeps identity, redacts output, and rejects multiline tokens', async t => {
    const root = process.env.HAPI_DSH_TEST_ROOT ?? (existsSync('/mnt/cache/data-cache') ? '/mnt/cache/data-cache' : tmpdir());
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'hapi-dsh-login-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'config with spaces.json');
    const initial = createConfig('https://hub.example.test', {});
    await writeConfig(file, initial);
    const invoke = (args: string[], input?: string) => {
        const running = execute(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), ...args, '--config', file]);
        if (input !== undefined) running.child.stdin!.end(input);
        return running;
    };
    const result = await invoke(['login', '--stdin'], 'fixture-login-secret\r\n');
    assert.ok(!`${result.stdout}${result.stderr}`.includes('fixture-login-secret'));
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.hapi.id, initial.hapi.id);
    assert.equal(saved.hapi.token, 'fixture-login-secret');
    assert.ok(!(await invoke(['config'])).stdout.includes('fixture-login-secret'));
    await assert.rejects(invoke(['login', '--stdin'], 'first-secret\nsecond-secret\n'), error => {
        assert.ok(!String(error).includes('first-secret'));
        return true;
    });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).hapi.token, saved.hapi.token);
    await assert.rejects(invoke(['login']), /interactive terminal/);
});
