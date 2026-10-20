import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfig, parseConfig, publicConfig, readConfig, resolveHapiToken, writeConfig, writePrivateJson } from '../src/cli/config.ts';
import { configFromArguments, parseArguments } from '../src/cli/index.ts';
import { createInvitation, readInvitation } from '../src/cli/federation.ts';
import { readPairingStore } from '../src/hub/federation-credentials.ts';

test('configuration normalizes Hub URLs and preserves a random Hub identity across address changes', () => {
    const config = createConfig('https://hub.example.test/subpath/', {});
    assert.equal(config.hapi.url, 'https://hub.example.test/subpath');
    assert.match(config.hapi.id, /^[0-9a-f-]{36}$/);
    const changed = parseConfig({ ...config, hapi: { ...config.hapi, url: 'https://other.example.test' } });
    assert.equal(changed.hapi.id, config.hapi.id);
    assert.notEqual(createConfig(config.hapi.url, {}).hapi.id, config.hapi.id);
});

test('invalid profile, listener and credential-bearing URL are rejected without echoing credentials', () => {
    const config = createConfig('http://127.0.0.1:3006', {});
    for (const profile of ['web', 'sdk', '../web', 'Hapi']) {
        assert.throws(() => parseConfig({ ...config, dsh: { ...config.dsh, profile } }));
    }
    for (const host of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', 'localhost']) {
        assert.throws(() => parseConfig({ ...config, server: { ...config.server, host } }));
    }
    for (const port of [-1, 65536, 3.5, '3080']) {
        assert.throws(() => parseConfig({ ...config, server: { ...config.server, port } }));
    }
    assert.throws(() => createConfig('https://user:fixture-secret@hub.example.test'), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('fixture-secret'));
        return true;
    });
    assert.throws(() => parseConfig({ ...config, hapi: { ...config.hapi, unexpected: true } }), /unknown fields/);
});

test('private config creation is atomic, exclusive, and never exposes the token in the public view', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    const config = createConfig('http://127.0.0.1:3006', {});
    config.hapi.token = 'fixture-file-token';
    const results = await Promise.allSettled([writeConfig(path, config), writeConfig(path, config)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.deepEqual(await readConfig(path), config);
    if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['config.json']);
    assert.equal(resolveHapiToken(config, { HAPI_DSH_TOKEN: 'fixture-env-token' }), 'fixture-env-token');
    assert.equal(resolveHapiToken(config, {}), 'fixture-file-token');
    const rendered = JSON.stringify(publicConfig(config));
    assert.ok(!rendered.includes('fixture-file-token'));
    assert.ok(!rendered.includes('fixture-env-token'));
    assert.equal(publicConfig(config).hapi.credentialConfigured, true);
});

test('legacy config identity migration gives concurrent readers the same persistent identity', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-migrate-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    const current = createConfig('http://127.0.0.1:3006', {});
    const { id: _id, ...legacyHapi } = current.hapi;
    await writeFile(path, JSON.stringify({ ...current, hapi: legacyHapi }), { mode: 0o600 });
    const results = await Promise.all([readConfig(path), readConfig(path), readConfig(path)]);
    assert.equal(new Set(results.map((result) => result.hapi.id)).size, 1);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { hapi: { id: string } };
    assert.equal(persisted.hapi.id, results[0]!.hapi.id);
    assert.deepEqual(await readdir(directory), ['config.json']);
});

test('symlinks and broad config permissions are refused', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-mode-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    await writeConfig(path, createConfig('http://127.0.0.1:3006', {}));
    if (process.platform !== 'win32') {
        const link = join(directory, 'link.json');
        await symlink(path, link);
        await assert.rejects(readConfig(link), /symlink/);
        await assert.rejects(writeConfig(link, createConfig('http://127.0.0.1:3006', {}), true), /non-regular/);
        await chmod(path, 0o644);
        await assert.rejects(readConfig(path), /0600/);
    }
});

test('CLI accepts explicit config options and rejects secret-bearing arguments', () => {
    const parsed = parseArguments(['init', '--hapi-url=https://hub.example.test', '--port', '0', '--config-only']);
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
    assert.throws(() => configFromArguments({ 'hapi-url': 'http://localhost', port: '3e2' }), /integer/);
});

test('remote deployment uses explicit canonical trusted authorities and a complete TLS pair', () => {
    const parsed = parseArguments(['init', '--hapi-url', 'https://hub.example.test', '--public-url', 'https://work.example.test/ui',
        '--trusted-host', 'work.example.test:443', '--tls-cert', '/private/chain.pem', '--tls-key', '/private/key.pem']);
    const config = configFromArguments(parsed.flags, {});
    assert.deepEqual(config.server.trustedHosts, ['work.example.test:443']);
    assert.deepEqual(config.server.tls, { certFile: '/private/chain.pem', keyFile: '/private/key.pem' });
    for (const host of ['work.example.test/path', 'user@work.example.test', 'work.example.test:0443', '*.example.test', ' work.example.test']) {
        assert.throws(() => parseConfig({ ...config, server: { ...config.server, trustedHosts: [host] } }));
    }
    assert.throws(() => configFromArguments({ 'hapi-url': 'https://hub.example.test', 'tls-cert': '/private/chain.pem' }), /supplied together/);
});

test('oversized private updates leave the readable configuration untouched', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-size-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'config.json');
    const config = createConfig('http://127.0.0.1:3006', {});
    await writeConfig(path, config);
    await assert.rejects(writePrivateJson(path, { value: 'x'.repeat(65_536) }, true), /64 KiB/);
    assert.deepEqual(await readConfig(path), config);
});

test('Runner pairing infers HTTPS when the official Hub listener uses TLS', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-pair-tls-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = createConfig('http://127.0.0.1:3006', {});
    config.server.tls = { certFile: join(directory, 'cert.pem'), keyFile: join(directory, 'key.pem') };
    config.federation = { credentialsFile: join(directory, 'pairings.json') };
    const configFile = join(directory, 'config.json');
    await writeConfig(configFile, config);
    const invitationFile = join(directory, 'invitation.json');
    await createInvitation(config, configFile, invitationFile, { id: 'tls-runner', name: 'TLS Runner' });
    assert.equal((await readInvitation(invitationFile)).hubUrl, 'https://127.0.0.1:3080');
    assert.deepEqual((await readPairingStore(config.federation.credentialsFile)).machines.map(machine => machine.id), ['tls-runner']);
});
