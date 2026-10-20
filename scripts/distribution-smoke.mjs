/** Clean-package integration: real npm install and official profiles; no live HAPI or model call. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const [record] = (await readFile('artifacts/SHA256SUMS', 'utf8')).trim().split('\n');
const match = /^([a-f0-9]{64})  (hapi-dsh-[A-Za-z0-9.+-]+\.tgz)$/.exec(record ?? '');
if (!match) throw new Error('Run distribution-pack.mjs first to produce a verified package');
const archive = resolve('artifacts', match[2]);
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), match[1], 'Package checksum mismatch');

const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-package-smoke-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key === 'NODE_PATH' || key === 'DSH_HOME' || key === 'CLI_API_TOKEN' || key.startsWith('HAPI_')) delete env[key];
const run = async (file, args) => {
    const result = await runFile(file, args, { cwd: directory, env, timeout: 300_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return result.stdout;
};
try {
    process.stdout.write('Installing the tarball with runtime dependencies in a clean temporary directory…\n');
    const npmArgs = ['install', '--prefix', directory, '--omit=dev', '--no-audit', '--no-fund', archive];
    if (process.platform === 'win32') await run(process.execPath, [process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...npmArgs]);
    else await run('npm', npmArgs);
    const packageRoot = join(directory, 'node_modules', 'hapi-dsh');
    const cli = join(packageRoot, 'dist', 'cli.js');
    await run(process.execPath, ['--input-type=module', '-e', 'for (const path of process.argv.slice(1)) await import(path);',
        ...['index.js', 'session-controller.js', 'runner/index.js'].map(path => pathToFileURL(join(packageRoot, 'dist', path)).href)]);
    assert.match(await run(process.execPath, [cli, '--help']), /official DSH Web profile/);

    const config = join(directory, 'hub.json');
    const home = join(directory, 'dsh');
    process.stdout.write('Creating the main profile through the installed CLI and official DSH…\n');
    await run(process.execPath, [cli, 'init', '--config', config, '--dsh-home', home, '--hapi-url', 'http://127.0.0.1:9', '--profile', 'package-main', '--port', '0']);
    const doctor = JSON.parse(await run(process.execPath, [cli, 'doctor', '--offline', '--json', '--config', config]));
    assert.equal(doctor.ok, true);
    for (const name of ['dsh-version', 'bundle-artifacts', 'profile']) assert.equal(doctor.checks.find(check => check.name === name)?.status, 'pass');
    assert.equal(doctor.checks.find(check => check.name === 'hapi')?.status, 'skipped');

    const invitation = join(directory, 'invitation.json');
    const runnerConfig = join(directory, 'runner.json');
    await run(process.execPath, [cli, 'pair', '--name', 'Package fixture', '--machine-id', 'package-fixture', '--hub-url', 'http://127.0.0.1:9', '--output', invitation, '--config', config]);
    process.stdout.write('Installing the Host-only Runner profile using a disposable private invitation…\n');
    await run(process.execPath, [cli, 'runner', 'init', '--pairing-file', invitation, '--config', runnerConfig, '--dsh-home', home, '--profile', 'package-runner']);
    const profile = JSON.parse(await readFile(join(home, 'profiles', 'package-runner', 'package.json'), 'utf8'));
    assert.ok(profile.dsh.profile.bundles.includes('hapi-dsh-runner'));
    assert.ok(!profile.dsh.profile.bundles.includes('hapi-dsh'));
    const privateInvitation = JSON.parse(await readFile(invitation, 'utf8'));
    const publicConfig = await run(process.execPath, [cli, 'runner', 'config', '--config', runnerConfig]);
    assert.ok(!publicConfig.includes(privateInvitation.token));
    assert.equal(JSON.parse(publicConfig).machine.id, 'package-fixture');
    await run(process.execPath, [cli, 'revoke', '--machine-id', 'package-fixture', '--config', config]);
    const paired = JSON.parse(await readFile(join(directory, 'runner-pairings.json'), 'utf8'));
    assert.deepEqual(paired.machines, []);
    process.stdout.write('Clean tarball imports, main install, offline doctor, Runner install, redaction, and revocation passed. No live HAPI/model call was made.\n');
} finally {
    await rm(directory, { recursive: true, force: true });
}
