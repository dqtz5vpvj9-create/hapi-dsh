/** Configuration/process unit tests use a fake launcher; real DSH boot is covered separately. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfig, DSH_VERSION } from '../src/cli/config.ts';
import { assertProfileProviders, installProfile, runtimeEnvironment, startArguments, verifyBundleArtifacts, type Command, type CommandRunner } from '../src/cli/runtime.ts';
import { checkHapi } from '../src/cli/doctor.ts';
import { parseDocument, stringify } from 'yaml';
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include';
import { OFFICIAL_PROVIDERS, OFFICIAL_PROVIDER_PACKAGES, ROUTING_PROVIDERS } from '../src/shared/official-provider.ts';

const providerNames = Object.keys(OFFICIAL_PROVIDERS) as Array<keyof typeof OFFICIAL_PROVIDERS>;
const validDump = stringify([
    ...providerNames.map(name => ({ id: name, name: OFFICIAL_PROVIDER_PACKAGES[name], isolate: { [OFFICIAL_PROVIDERS[name]]: true } })),
    ...providerNames.map(name => ({ id: `hapi-dsh-${ROUTING_PROVIDERS[name]}`, name: `hapi-dsh/${ROUTING_PROVIDERS[name]}` })),
    { id: 'hapi-dsh', name: 'hapi-dsh' },
]);

async function fixture(directory: string): Promise<string> {
    const root = join(directory, 'package with spaces');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'hapi-dsh', main: './host.js', exports: { './client': { default: './client.js' } },
        dsh: { bundle: { patch: './patch.yml' } },
    }));
    for (const name of ['host.js', 'client.js', 'patch.yml']) await writeFile(join(root, name), '');
    return root;
}

test('official profile setup uses launcher flags and safe argv, and preserves existing custom plugins', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-profile-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const packageRoot = await fixture(directory);
    const config = createConfig('http://127.0.0.1:3006', {});
    config.dsh.home = join(directory, 'dsh home');
    const calls: Command[] = [];
    const manifestPath = join(config.dsh.home, 'profiles', config.dsh.profile, 'package.json');
    const patchPath = join(config.dsh.home, 'profiles', config.dsh.profile, 'cordis.patch.yml');
    const fake: CommandRunner = async (command, { env }) => {
        calls.push(command);
        assert.equal(env.HAPI_DSH_CONFIG_FILE, join(directory, 'config.json'));
        assert.equal(env.DSH_HOME, config.dsh.home);
        if (command.args.includes('--version')) return { exitCode: 0, stdout: DSH_VERSION, stderr: '' };
        if (command.args.includes('--from-default-profile')) {
            await mkdir(join(config.dsh.home, 'profiles', config.dsh.profile), { recursive: true });
            await writeFile(manifestPath, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
            await writeFile(patchPath, '# custom user overlay\n');
        }
        if (command.args.includes('plugin')) {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } };
            if (!manifest.dsh.profile.bundles.includes('hapi-dsh')) manifest.dsh.profile.bundles.push('hapi-dsh');
            await writeFile(manifestPath, JSON.stringify(manifest));
        }
        return { exitCode: 0, stdout: validDump, stderr: '' };
    };
    const options = { command: { executable: 'fixture-dsh', args: [] }, run: fake, env: {} };
    await installProfile(config, join(directory, 'config.json'), packageRoot, options);
    assert.deepEqual(calls[1]!.args, ['--profile', 'hapi', '--from-default-profile', 'web', '--dump-config']);
    assert.deepEqual(calls[2]!.args, ['plugin', '--profile', 'hapi', 'add', `link:${packageRoot}`]);
    calls.length = 0;
    await installProfile(config, join(directory, 'config.json'), packageRoot, options);
    assert.ok(calls.every((call) => !call.args.includes('--from-default-profile')));
    assert.equal(await readFile(patchPath, 'utf8'), '# custom user overlay\n');
});

test('the installed bundle retains official Client roots and isolates their Host delegates using real patch semantics', async () => {
    const original = providerNames.map(name => ({ id: name, name: OFFICIAL_PROVIDER_PACKAGES[name] }));
    const patch = parseDocument(await readFile(new URL('../config/cordis.patch.yml', import.meta.url), 'utf8'), { logLevel: 'silent' }).toJS() as Parameters<typeof applyEntryPatches>[1];
    const warnings: string[] = [];
    const combined = applyEntryPatches(original, patch, message => warnings.push(message));
    assert.deepEqual(warnings, []);
    assert.doesNotThrow(() => assertProfileProviders(stringify(combined)));
    assert.deepEqual(original, providerNames.map(name => ({ id: name, name: OFFICIAL_PROVIDER_PACKAGES[name] })));
    const mistakenRename = applyEntryPatches(original, [{ id: 'workspace-files', name: 'hapi-dsh/workspace-files' }], () => {});
    assert.throws(() => assertProfileProviders(stringify(mistakenRename)), /did not activate/);
    assert.throws(() => assertProfileProviders(validDump.replace('sessionController: true', 'sessionController: false')), /did not activate/);
    const disabled = applyEntryPatches(combined, [{ id: 'session-controller', disabled: true }], () => {});
    assert.throws(() => assertProfileProviders(stringify(disabled)), /did not activate/);
    const subagentDisabled = applyEntryPatches(combined, [{ id: 'subagent', disabled: true }], () => {});
    assert.throws(() => assertProfileProviders(stringify(subagentDisabled)), /subagent provider/);
    const subagentNotIsolated = applyEntryPatches(combined, [{ id: 'subagent', isolate: { subagents: false } }], () => {});
    assert.throws(() => assertProfileProviders(stringify(subagentNotIsolated)), /subagent provider/);
    const fileReferencesDisabled = applyEntryPatches(combined, [{ id: 'file-reference-local', disabled: true }], () => {});
    assert.throws(() => assertProfileProviders(stringify(fileReferencesDisabled)), /file-reference-local provider/);
    const fileReferencesUnisolated = applyEntryPatches(combined, [{ id: 'file-reference-local', isolate: { fileReferences: false } }], () => {});
    assert.throws(() => assertProfileProviders(stringify(fileReferencesUnisolated)), /file-reference-local provider/);
});

test('an incomplete existing profile is never reset by setup', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-incomplete-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const packageRoot = await fixture(directory);
    const config = createConfig('http://127.0.0.1:3006', {});
    config.dsh.home = join(directory, 'dsh');
    const profile = join(config.dsh.home, 'profiles', config.dsh.profile);
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'valuable.txt'), 'keep');
    let calls = 0;
    await assert.rejects(installProfile(config, join(directory, 'config.json'), packageRoot, {
        command: { executable: 'fixture-dsh', args: [] }, env: {},
        run: async () => { calls++; return { exitCode: 0, stdout: DSH_VERSION, stderr: '' }; },
    }), /already exists without a manifest/);
    assert.equal(calls, 1);
    assert.equal(await readFile(join(profile, 'valuable.txt'), 'utf8'), 'keep');
});

test('a missing official package manager is actionable while subprocess diagnostics stay private', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-prerequisite-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const packageRoot = await fixture(directory);
    const config = createConfig('http://127.0.0.1:3006', {});
    config.dsh.home = join(directory, 'dsh');
    const profile = join(config.dsh.home, 'profiles', config.dsh.profile);
    await mkdir(profile, { recursive: true });
    const original = JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'existing-plugin'] } } });
    await writeFile(join(profile, 'package.json'), original);
    const marker = 'dsh: pnpm was not found; install pnpm and make it available on PATH.';
    for (const [exitCode, stderr, expected] of [
        [127, `${marker}\r\nfixture-private-diagnostic`, /requires pnpm on PATH.*11\.28\.5/],
        [1, `${marker}\nfixture-private-diagnostic`, /Official DSH plugin installation failed/],
        [127, 'fixture-private-diagnostic', /Official DSH plugin installation failed/],
    ] as const) {
        let calls = 0;
        await assert.rejects(installProfile(config, join(directory, 'config.json'), packageRoot, {
            command: { executable: 'fixture-dsh', args: [] }, env: {},
            run: async (command) => {
                calls++;
                if (command.args.includes('--version')) return { exitCode: 0, stdout: DSH_VERSION, stderr: '' };
                assert.equal(command.args[0], 'plugin');
                return { exitCode, stdout: 'fixture-private-stdout', stderr };
            },
        }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, expected);
            assert.ok(!error.message.includes('fixture-private'));
            return true;
        });
        assert.equal(calls, 2);
        assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), original);
    }
});

test('artifact verification refuses an escaping client export', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-artifact-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = await fixture(directory);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { exports: { './client': { default: string } } };
    manifest.exports['./client'].default = '../outside.js';
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(verifyBundleArtifacts(root), /escapes/);
});

test('runtime environment carries only the config path and start uses the official Web flags', () => {
    const config = createConfig('http://127.0.0.1:3006', {});
    config.hapi.token = 'fixture-private-token';
    config.server.publicUrl = 'https://work.example.test';
    config.server.trustedHosts = ['work.example.test:443'];
    config.server.tls = { certFile: '/private/chain.pem', keyFile: '/private/key.pem' };
    const env = runtimeEnvironment(config, '/private/config.json', {});
    assert.equal(env.HAPI_DSH_CONFIG_FILE, '/private/config.json');
    assert.ok(!JSON.stringify(env).includes('fixture-private-token'));
    const args = startArguments(config, true);
    assert.deepEqual(args, ['--profile', 'hapi', '--host', '127.0.0.1', '--port', '3080', '--public-url', 'https://work.example.test',
        '--trusted-host', 'work.example.test:443', '--tls-cert', '/private/chain.pem', '--tls-key', '/private/key.pem', '--no-open']);
    assert.ok(!args.join(' ').includes('fixture-private-token'));
});

test('doctor exchanges the HAPI CLI token for a Web JWT before querying catalogs', async () => {
    const config = createConfig('https://hub.example.test/mount', {});
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        urls.push(url);
        assert.equal(init?.redirect, 'error');
        if (url.endsWith('/auth')) {
            assert.deepEqual(JSON.parse(String(init?.body)), { accessToken: 'fixture-access-token' });
            return Response.json({ token: 'fixture-web-jwt' });
        }
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-web-jwt');
        return Response.json(url.endsWith('/sessions') ? { sessions: [{ id: 'fixture-session' }] } : { machines: [] });
    };
    const checks = await checkHapi(config, { env: { HAPI_DSH_TOKEN: 'fixture-access-token' }, fetch: fakeFetch });
    assert.equal(urls[0], 'https://hub.example.test/mount/api/auth');
    assert.equal(checks[0]!.status, 'pass');
    assert.equal(checks.find((check) => check.name === 'hapi-machines')!.status, 'warn');
    assert.ok(!JSON.stringify(checks).includes('fixture-web-jwt'));
});

test('doctor does not echo a Hub authentication error body', async () => {
    const config = createConfig('http://127.0.0.1:3006', {});
    await assert.rejects(checkHapi(config, {
        env: { HAPI_DSH_TOKEN: 'fixture-access-token' },
        fetch: async () => Response.json({ error: 'fixture-access-token' }, { status: 401 }),
    }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 401/);
        assert.ok(!error.message.includes('fixture-access-token'));
        return true;
    });
});
