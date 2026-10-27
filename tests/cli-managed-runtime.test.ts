import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveDshCommand } from '../src/cli/runtime.ts';

async function home(): Promise<string> {
    const root = process.env.HAPI_DSH_TEST_ROOT ?? tmpdir();
    return mkdtemp(join(root, 'hapi-dsh-managed-runtime-'));
}

async function writeRuntime(dshHome: string, dshVersion: string, extRelease: string): Promise<string> {
    const release = join(dshHome, 'hapi-dsh', 'releases', 'r-fixture');
    const dshDirectory = join(release, 'runtime', 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(join(dshDirectory, 'lib'), { recursive: true });
    await writeFile(join(dshDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVersion, bin: { dsh: 'lib/bin.js' } }));
    const binary = join(dshDirectory, 'lib', 'bin.js');
    await writeFile(binary, '#!/usr/bin/env node\n');
    const runtimeRoot = join(release, 'runtime');
    const sealFiles = ['node_modules/@deepseek-ai/dsh/package.json', 'node_modules/@deepseek-ai/dsh/lib/bin.js'];
    const files = {};
    for (const path of sealFiles) files[path] = createHash('sha256').update(await readFile(join(runtimeRoot, path))).digest('hex');
    await writeFile(join(runtimeRoot, 'runtime-identity.json'), JSON.stringify({
        schemaVersion: 1, upstreamVersion: dshVersion, extRelease, packages: [], files,
    }));
    await mkdir(join(dshHome, 'hapi-dsh'), { recursive: true });
    await writeFile(join(dshHome, 'hapi-dsh', 'state.json'), JSON.stringify({
        version: 1,
        profiles: { hapi: { runtime: { dshBinary: binary, dshVersion, extRelease } } },
    }));
    return binary;
}

test('a managed runtime is used only when its resolved DSH matches the recorded version', async () => {
    const dshHome = await home();
    try {
        const binary = await writeRuntime(dshHome, '0.2.1-rc.3', '3');
        const command = await resolveDshCommand({ dsh: { home: dshHome, profile: 'hapi' } });
        assert.equal(command.args[0], binary, 'the bundle runtime binary becomes the launcher');
        assert.equal(command.executable, process.execPath);

        await writeFile(join(dshHome, 'hapi-dsh', 'releases', 'r-fixture', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
            JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.1', bin: { dsh: 'lib/bin.js' } }));
        await assert.rejects(resolveDshCommand({ dsh: { home: dshHome, profile: 'hapi' } }), /reinstall the bundle/,
            'a runtime whose code does not match the recorded identity must fail loudly');
    } finally {
        await rm(dshHome, { recursive: true, force: true });
    }
});

test('a malformed managed-runtime pointer fails instead of silently using another launcher', async () => {
    const dshHome = await home();
    try {
        await mkdir(join(dshHome, 'hapi-dsh'), { recursive: true });
        await writeFile(join(dshHome, 'hapi-dsh', 'state.json'), JSON.stringify({
            version: 1, profiles: { hapi: { runtime: { dshBinary: 'relative/path', dshVersion: '0.2.1-rc.3', extRelease: '3' } } },
        }));
        await assert.rejects(resolveDshCommand({ dsh: { home: dshHome, profile: 'hapi' } }), /pointer is malformed/);
    } finally {
        await rm(dshHome, { recursive: true, force: true });
    }
});

test('a runtime file changed after sealing refuses to start', async () => {
    const dshHome = await home();
    try {
        const binary = await writeRuntime(dshHome, '0.2.1-rc.3', '3');
        await writeFile(binary, '#!/usr/bin/env node\n// tampered\n');
        await assert.rejects(resolveDshCommand({ dsh: { home: dshHome, profile: 'hapi' } }), /changed since sealing/,
            'a re-installed or modified runtime must not be booted silently');
    } finally {
        await rm(dshHome, { recursive: true, force: true });
    }
});

test('a managed DSH home refuses an explicit launcher and an unmanaged profile', async () => {
    const dshHome = await home();
    try {
        await writeRuntime(dshHome, '0.2.1-rc.3', '3');
        await assert.rejects(resolveDshCommand({ dsh: { home: dshHome, profile: 'hapi', command: '/usr/bin/false' } }),
            /bypasses the bundle-managed runtime/, 'an explicit launcher must not silently bypass the verified runtime');
        await assert.rejects(resolveDshCommand({ dsh: { home: dshHome, profile: 'other' } }),
            /not managed by a bundle runtime/, 'an unmanaged profile must not borrow another profile runtime');
        const previous = process.env.HAPI_DSH_ALLOW_UNMANAGED;
        process.env.HAPI_DSH_ALLOW_UNMANAGED = '1';
        try {
            const command = await resolveDshCommand({ dsh: { home: dshHome, profile: 'hapi', command: '/usr/bin/false' } });
            assert.equal(command.executable, '/usr/bin/false', 'the explicit opt-out is honoured when requested');
        } finally {
            if (previous === undefined) delete process.env.HAPI_DSH_ALLOW_UNMANAGED;
            else process.env.HAPI_DSH_ALLOW_UNMANAGED = previous;
        }
    } finally {
        await rm(dshHome, { recursive: true, force: true });
    }
});

test('a sealed path that resolves outside the runtime is refused', async () => {
    const dshHome = await home();
    try {
        const binary = await writeRuntime(dshHome, '0.2.1-rc.3', '3');
        const runtimeRoot = join(dshHome, 'hapi-dsh', 'releases', 'r-fixture', 'runtime');
        const outside = join(dshHome, 'outside.txt');
        await writeFile(outside, 'outside');
        await symlink(outside, join(runtimeRoot, 'escape.txt'));
        const seal = JSON.parse(await readFile(join(runtimeRoot, 'runtime-identity.json'), 'utf8')) as { files: Record<string, string> };
        seal.files['escape.txt'] = createHash('sha256').update('outside').digest('hex');
        await writeFile(join(runtimeRoot, 'runtime-identity.json'), JSON.stringify(seal));
        await assert.rejects(resolveDshCommand({ dsh: { home: dshHome, profile: 'hapi' } }), /escapes its root/);
        void binary;
    } finally {
        await rm(dshHome, { recursive: true, force: true });
    }
});
