/** Clean-package integration: real npm install and official profiles; no live source or model call. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyExtensionSet } from './dsh-ext/install-extension.mjs';
import { CLIENT_CHUNKS } from '../src/shared/client-artifacts.ts';

const runFile = promisify(execFile);
const extensionDirectory = process.argv[2];
if (!extensionDirectory) throw new Error('Usage: node scripts/distribution-smoke.mjs <complete-extension-package-directory>');
const extensions = await verifyExtensionSet(extensionDirectory);
const [record] = (await readFile('artifacts/SHA256SUMS', 'utf8')).trim().split('\n');
const match = /^([a-f0-9]{64})  (hapi-dsh-[A-Za-z0-9.+-]+\.tgz)$/.exec(record ?? '');
if (!match) throw new Error('Run distribution-pack.mjs first to produce a verified package');
const archive = resolve('artifacts', match[2]);
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), match[1], 'Package checksum mismatch');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const clientChunks = CLIENT_CHUNKS;

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
    await npm(['install', '--prefix', directory, '--omit=dev', '--no-audit', '--no-fund', 'pnpm@11.28.5', archive, ...extensions.packages.map(item => item.path)]);
    const packageRoot = join(directory, 'node_modules', 'hapi-dsh');
    const cli = join(packageRoot, 'dist', 'cli.js');
    for (const item of extensions.packages) {
        const installedPackage = JSON.parse(await readFile(join(directory, 'node_modules', item.name, 'package.json'), 'utf8'));
        assert.deepEqual(installedPackage.hhpiSourceExtension, item.identity, `${item.name} must use the supplied source extension`);
    }
    for (const fileName of clientChunks) {
        const source = await readFile(join(packageRoot, 'dist', fileName), 'utf8');
        assert.ok(source.startsWith('window.__ModuleLoader__.load('), `${fileName} must be an official package-local chunk`);
        assert.ok(source.includes(`chunk:${JSON.stringify(fileName)}`), `${fileName} must register its matching chunk name`);
    }
    await run(process.execPath, ['--input-type=module', '-e', 'for (const path of process.argv.slice(1)) await import(path);',
        ...['index.js', 'session-controller.js', 'runner/index.js'].map(path => pathToFileURL(join(packageRoot, 'dist', path)).href)]);
    assert.match(await installed(['--help']), /HHPI workspace for official DSH Web/);
    assert.equal((await installed(['--version'])).trim(), manifest.version);
    assert.equal((await npm(['exec', '--offline', '--', 'pnpm', '--version'])).trim(), '11.28.5');

    const config = join(directory, 'hub.json');
    const home = join(directory, 'dsh');
    process.stdout.write('Creating the main profile through the installed CLI and official DSH…\n');
    await installed(['init', '--config', config, '--dsh-home', home, '--profile', 'package-main', '--port', '0']);
    const initialized = JSON.parse(await readFile(config, 'utf8'));
    assert.ok(!Object.hasOwn(initialized, 'hapi'), 'New profiles must not configure a retired Hub');
    assert.ok(!Object.hasOwn(JSON.parse(await installed(['config', '--config', config])), 'hapi'));
    const doctor = JSON.parse(await installed(['doctor', '--offline', '--json', '--config', config]));
    assert.equal(doctor.ok, true);
    for (const name of ['dsh-version', 'bundle-artifacts', 'profile']) assert.equal(doctor.checks.find(check => check.name === name)?.status, 'pass');
    assert.ok(!doctor.checks.some(check => check.name === 'hapi'), 'Doctor must not probe the retired Hub');

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
    const pageUrl = new URL(response.headers.get('location') ?? '/', launch.trim());
    const headers = { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
    const html = await fetch(pageUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
    });
    assert.equal(html.status, 200);
    const page = await html.text();
    const boot = /<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/.exec(page);
    assert.ok(boot, 'Installed Host must provide its official client boot graph');
    const entry = JSON.parse(boot[1]).entries.find(value => value.id === manifest.name);
    assert.equal(typeof entry?.rev, 'string', 'Installed package must appear in the official client boot graph');
    for (const fileName of clientChunks) {
        const url = new URL(`plugins/${manifest.name}/${fileName}`, pageUrl);
        url.searchParams.set('rev', entry.rev);
        const chunk = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        assert.equal(chunk.status, 200, `Installed Host must serve ${fileName} at its current revision`);
        assert.match(chunk.headers.get('content-type') ?? '', /javascript/);
        assert.ok((await chunk.text()).includes(`chunk:${JSON.stringify(fileName)}`), `${fileName} HTTP response must register its matching chunk`);
    }

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
    process.stdout.write('Clean tarball, matching extensions, npm executable, official admission, offline doctor, HTTP boot, two lazy chunk routes, Runner install, redaction, and revocation passed. No live source/model call was made.\n');
} finally {
    if (host?.pid && host.exitCode === null) {
        if (process.platform === 'win32') await runFile('taskkill.exe', ['/PID', String(host.pid), '/T', '/F']);
        else host.kill('SIGTERM');
        await hostClosed;
    }
    await rm(directory, { recursive: true, force: true });
}
