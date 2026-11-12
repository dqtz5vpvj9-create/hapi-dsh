import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfig, parseConfig, publicConfig, readConfig, readPrivateJson, writeConfig, writePrivateJson } from '../src/cli/config.ts';
import { configFromArguments, parseArguments } from '../src/cli/index.ts';
import { createInvitation, readInvitation } from '../src/cli/federation.ts';
import { readPairingStore } from '../src/hub/federation-credentials.ts';
import { createRunnerConfig, parseRunnerConfig, readRunnerConfig, writeRunnerConfig } from '../src/runner/config.ts';

test('native-only configuration preserves explicit DSH home and creates no Hub identity or credential', () => {
    const config = createConfig({ DSH_HOME: '/private/native-dsh' });
    assert.equal(config.dsh.home, '/private/native-dsh');
    assert.equal(Reflect.get(config, 'hapi'), undefined);
    assert.deepEqual(publicConfig(config), config);
});

test('legacy Hub configuration is rejected with offline migration guidance and no credential disclosure', () => {
    for (const hapi of [null, undefined, { id: 'old-hub', url: 'https://user:fixture-secret@hub.example.test', token: 'fixture-secret' }]) {
        const legacy = { ...createConfig({}), hapi };
        for (const parse of [parseConfig, publicConfig]) assert.throws(() => parse(legacy), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /retired.*offline migration/i);
            assert.equal(error.message.includes('fixture-secret'), false);
            return true;
        });
    }
});

test('invalid profile, listener and credential-bearing URL are rejected without echoing credentials', () => {
    const config = createConfig({});
    for (const profile of ['web', 'sdk', '../web', 'Hapi']) {
        assert.throws(() => parseConfig({ ...config, dsh: { ...config.dsh, profile } }));
    }
    for (const host of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', 'localhost']) {
        assert.throws(() => parseConfig({ ...config, server: { ...config.server, host } }));
    }
    for (const port of [-1, 65536, 3.5, '3080']) {
        assert.throws(() => parseConfig({ ...config, server: { ...config.server, port } }));
    }
    assert.throws(() => parseConfig({ ...config, server: { ...config.server, publicUrl: 'https://user:fixture-secret@hub.example.test' } }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('fixture-secret'));
        return true;
    });
    assert.throws(() => parseConfig({ ...config, unexpected: true }), /unknown fields/);
});

test('a paired Runner can retain the original Web profile without relaxing workspace or listener validation', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-web-runner-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = createRunnerConfig('https://display.example.test', { id: 'original-web', dshHome: directory });
    config.dsh.profile = 'web';
    const path = join(directory, 'runner.json');
    await writeRunnerConfig(path, config);
    assert.deepEqual(await readRunnerConfig(path), config, 'the same home, profile and machine survive a private configuration round trip');
    assert.throws(() => parseConfig({ version: 1, dsh: config.dsh, server: config.server }), /dedicated custom profile/);
    for (const profile of ['sdk', 'headless', '../web']) {
        assert.throws(() => parseRunnerConfig({ ...config, dsh: { ...config.dsh, profile } }));
    }
    assert.throws(() => parseRunnerConfig({ ...config, server: { host: '192.0.2.1', port: 0 } }), /bind 127.0.0.1/);
    assert.throws(() => parseRunnerConfig({ ...config, sources: [{ id: 'source', engine: 'codex', machineId: 'another-machine' }] }), /paired machine ID/);
});

test('native private config creation is atomic and exclusive', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    const config = createConfig({});
    const results = await Promise.allSettled([writeConfig(path, config), writeConfig(path, config)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.deepEqual(await readConfig(path), config);
    if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['config.json']);
    assert.deepEqual(publicConfig(config), config);
});

test('concurrent product readers reject a legacy config without rewriting the offline original', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-retired-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    const legacy = { ...createConfig({}), hapi: { url: 'https://legacy.example.test', token: 'fixture-private-token' } };
    const raw = JSON.stringify(legacy);
    await writeFile(path, raw, { mode: 0o600 });
    const results = await Promise.allSettled([readConfig(path), readConfig(path), readConfig(path)]);
    assert.equal(results.every(result => result.status === 'rejected' && /retired.*offline migration/i.test(String(result.reason))), true);
    assert.equal(await readFile(path, 'utf8'), raw);
    assert.deepEqual(await readPrivateJson(path), legacy, 'the explicit private JSON reader remains available to offline tools');
    assert.deepEqual(await readdir(directory), ['config.json']);
});

test('symlinks and broad config permissions are refused', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-mode-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    await writeConfig(path, createConfig({}));
    if (process.platform !== 'win32') {
        const link = join(directory, 'link.json');
        await symlink(path, link);
        await assert.rejects(readConfig(link), /symlink/);
        await assert.rejects(writeConfig(link, createConfig({}), true), /non-regular/);
        await chmod(path, 0o644);
        await assert.rejects(readConfig(path), /0600/);
    }
});

test('CLI accepts explicit config options and rejects secret-bearing arguments', () => {
    const parsed = parseArguments(['init', '--port', '0', '--config-only']);
    const config = configFromArguments(parsed.flags, {});
    assert.equal(config.server.port, 0);
    assert.equal(parsed.flags['config-only'], true);
    for (const args of [
        ['init', '--token', 'fixture-secret'], ['init', '--access-token=fixture-secret'],
        ['init', '--password=fixture-secret'], ['start', '--hapi-url', 'https://hub.example.test'],
        ['doctor', '--offline=true'], ['start', '--no-open', '--no-open'],
    ]) {
        assert.throws(() => parseArguments(args), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes('fixture-secret'));
            return true;
        });
    }
    assert.throws(() => configFromArguments({ port: '3e2' }), /integer/);
});

test('remote deployment uses explicit canonical trusted authorities and a complete TLS pair', () => {
    const parsed = parseArguments(['init', '--public-url', 'https://work.example.test/ui',
        '--trusted-host', 'work.example.test:443', '--tls-cert', '/private/chain.pem', '--tls-key', '/private/key.pem']);
    const config = configFromArguments(parsed.flags, {});
    assert.deepEqual(config.server.trustedHosts, ['work.example.test:443']);
    assert.deepEqual(config.server.tls, { certFile: '/private/chain.pem', keyFile: '/private/key.pem' });
    for (const host of ['work.example.test/path', 'user@work.example.test', 'work.example.test:0443', '*.example.test', ' work.example.test']) {
        assert.throws(() => parseConfig({ ...config, server: { ...config.server, trustedHosts: [host] } }));
    }
    assert.throws(() => configFromArguments({ 'tls-cert': '/private/chain.pem' }), /supplied together/);
});

test('oversized private updates leave the readable configuration untouched', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-size-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    const config = createConfig({});
    await writeConfig(path, config);
    await assert.rejects(writePrivateJson(path, { value: 'x'.repeat(65_536) }, true), /64 KiB/);
    assert.deepEqual(await readConfig(path), config);
});

test('Runner pairing infers HTTPS when the official Hub listener uses TLS', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-pair-tls-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = createConfig({});
    config.server.tls = { certFile: join(directory, 'cert.pem'), keyFile: join(directory, 'key.pem') };
    config.federation = { credentialsFile: join(directory, 'pairings.json') };
    const configFile = join(directory, 'config.json');
    await writeConfig(configFile, config);
    const invitationFile = join(directory, 'invitation.json');
    await createInvitation(config, configFile, invitationFile, { id: 'tls-runner', name: 'TLS Runner' });
    assert.equal((await readInvitation(invitationFile)).hubUrl, 'https://127.0.0.1:3080');
    assert.deepEqual((await readPairingStore(config.federation.credentialsFile)).machines.map(machine => machine.id), ['tls-runner']);
});
