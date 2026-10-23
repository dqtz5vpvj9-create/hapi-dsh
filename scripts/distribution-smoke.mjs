/** Clean-package integration: real npm install and official profiles; no live HAPI or model call. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const manifest = JSON.parse(await readFile('package.json', 'utf8'));

const temporaryRoot = process.env.HAPI_DSH_TEST_ROOT ?? (existsSync('/mnt/cache/data-cache') ? '/mnt/cache/data-cache' : tmpdir());
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, 'hapi-dsh package smoke-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key === 'NODE_PATH' || key === 'DSH_HOME' || key === 'CLI_API_TOKEN' || key.startsWith('HAPI_')) delete env[key];
const run = async (file, args, input) => {
    const execution = runFile(file, args, { cwd: directory, env, timeout: 300_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    if (input !== undefined) execution.child.stdin.end(input);
    const result = await execution;
    return result.stdout;
};
const npm = (args, input) => process.platform === 'win32'
    ? run(process.execPath, [process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args], input)
    : run('npm', args, input);
// Exercise npm's actual executable shim, including Unix symlinks and Windows .cmd.
const installed = (args, input) => npm(['exec', '--offline', '--', 'hapi-dsh', ...args], input);
let host;
let hostClosed;
try {
    process.stdout.write('Installing the tarball with runtime dependencies in a clean temporary directory…\n');
    await npm(['install', '--prefix', directory, '--omit=dev', '--no-audit', '--no-fund', 'pnpm@11.28.5', archive]);
    const packageRoot = join(directory, 'node_modules', 'hapi-dsh');
    const cli = join(packageRoot, 'dist', 'cli.js');
    await run(process.execPath, ['--input-type=module', '-e', 'for (const path of process.argv.slice(1)) await import(path);',
        ...['index.js', 'session-controller.js', 'runner/index.js'].map(path => pathToFileURL(join(packageRoot, 'dist', path)).href)]);
    assert.match(await installed(['--help']), /official DSH Web profile/);
    assert.equal((await installed(['--version'])).trim(), manifest.version);
    assert.equal((await npm(['exec', '--offline', '--', 'pnpm', '--version'])).trim(), '11.28.5');

    const config = join(directory, 'hub.json');
    const home = join(directory, 'dsh');
    process.stdout.write('Creating the main profile through the installed CLI and official DSH…\n');
    await installed(['init', '--config', config, '--dsh-home', home, '--hapi-url', 'http://127.0.0.1:9', '--profile', 'package-main', '--port', '0']);
    const secret = 'package-fixture-token';
    const loginOutput = await installed(['login', '--stdin', '--config', config], `${secret}\n`);
    assert.ok(!loginOutput.includes(secret));
    assert.equal(JSON.parse(await readFile(config, 'utf8')).hapi.token, secret);
    assert.ok(!(await installed(['config', '--config', config])).includes(secret));
    const doctor = JSON.parse(await installed(['doctor', '--offline', '--json', '--config', config]));
    assert.equal(doctor.ok, true);
    for (const name of ['dsh-version', 'bundle-artifacts', 'profile']) assert.equal(doctor.checks.find(check => check.name === name)?.status, 'pass');
    assert.equal(doctor.checks.find(check => check.name === 'hapi')?.status, 'skipped');

    process.stdout.write('Starting the installed official Web Host on an ephemeral loopback port…\n');
    host = spawn(process.execPath, [cli, 'start', '--config', config, '--no-open'], { cwd: directory, env, stdio: 'ignore', windowsHide: true });
    let hostError;
    host.on('error', error => { hostError = error; });
    hostClosed = new Promise(resolveClosed => host.once('close', resolveClosed));
    let launch;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (hostError) throw hostError;
        if (host.exitCode !== null) throw new Error(`Installed Host exited before serving HTTP (${host.exitCode})`);
        launch = await readFile(join(directory, 'launch-url'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (launch) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
    assert.ok(launch, 'Installed Host did not print a login URL');
    const response = await fetch(launch.trim(), { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 303, 'Official admission endpoint must accept its login URL');
    const html = await fetch(new URL(response.headers.get('location') ?? '/', launch.trim()), {
        headers: { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') },
        signal: AbortSignal.timeout(10_000),
    });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<script/);

    const invitation = join(directory, 'invitation.json');
    const runnerConfig = join(directory, 'runner.json');
    await installed(['pair', '--name', 'Package fixture', '--machine-id', 'package-fixture', '--hub-url', 'http://127.0.0.1:9', '--output', invitation, '--config', config]);
    process.stdout.write('Installing the Host-only Runner profile using a disposable private invitation…\n');
    await installed(['runner', 'init', '--pairing-file', invitation, '--config', runnerConfig, '--dsh-home', home, '--profile', 'package-runner']);
    const profile = JSON.parse(await readFile(join(home, 'profiles', 'package-runner', 'package.json'), 'utf8'));
    assert.ok(profile.dsh.profile.bundles.includes('hapi-dsh-runner'));
    assert.ok(!profile.dsh.profile.bundles.includes('hapi-dsh'));
    const privateInvitation = JSON.parse(await readFile(invitation, 'utf8'));
    const publicConfig = await installed(['runner', 'config', '--config', runnerConfig]);
    assert.ok(!publicConfig.includes(privateInvitation.token));
    assert.equal(JSON.parse(publicConfig).machine.id, 'package-fixture');
    await installed(['revoke', '--machine-id', 'package-fixture', '--config', config]);
    const paired = JSON.parse(await readFile(join(directory, 'runner-pairings.json'), 'utf8'));
    assert.deepEqual(paired.machines, []);
    process.stdout.write('Clean tarball, npm executable, login, offline doctor, HTTP boot, Runner install, redaction, and revocation passed. No live HAPI/model call was made.\n');
} finally {
    if (host?.pid && host.exitCode === null) {
        if (process.platform === 'win32') await runFile('taskkill.exe', ['/PID', String(host.pid), '/T', '/F']);
        else host.kill('SIGTERM');
        await hostClosed;
    }
    await rm(directory, { recursive: true, force: true });
}
