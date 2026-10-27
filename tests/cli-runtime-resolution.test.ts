import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ops } from '../src/cli/release.ts';

async function releaseRoot(): Promise<string> {
    const root = process.env.HAPI_DSH_TEST_ROOT ?? tmpdir();
    return mkdtemp(join(root, 'hapi-dsh-runtime-resolution-'));
}

async function writePackage(path: string, name: string, version: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ name, version }));
}

test('a shared singleton resolved to two versions across runtime consumers fails the audit', async () => {
    const release = await releaseRoot();
    try {
        const runtime = join(release, 'runtime');
        await writePackage(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '@deepseek-ai/dsh', '0.2.1-rc.3');
        await writePackage(join(runtime, 'node_modules', 'hapi-dsh', 'package.json'), 'hapi-dsh', '0.1.2');
        await writePackage(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json'),
            '@deepseek-ai/dsh-session', '0.2.1-rc.3');
        await writePackage(join(runtime, 'node_modules', 'hapi-dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json'),
            '@deepseek-ai/dsh-session', '0.2.0-rc.1');
        const audit = await ops.auditResolution(release);
        assert.equal(audit.ok, false, 'two dsh-session versions must be a split');
        assert.match(audit.problems.join(' '), /dsh-session resolves to 2 versions/);
    } finally {
        await rm(release, { recursive: true, force: true });
    }
});

test('same-version peer variants are pnpm layout, not a split', async () => {
    const release = await releaseRoot();
    try {
        const runtime = join(release, 'runtime');
        await writePackage(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '@deepseek-ai/dsh', '0.2.1-rc.3');
        await writePackage(join(runtime, 'node_modules', 'hapi-dsh', 'package.json'), 'hapi-dsh', '0.1.2');
        for (const consumer of [join('node_modules', '@deepseek-ai', 'dsh'), join('node_modules', 'hapi-dsh')]) {
            await writePackage(join(runtime, consumer, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json'),
                '@deepseek-ai/dsh-session', '0.2.1-rc.3');
        }
        const audit = await ops.auditResolution(release);
        assert.equal(audit.ok, true, 'the same version in two physical locations is not a version split');
        assert.equal(existsSync(join(runtime, 'node_modules', 'hapi-dsh', 'package.json')), true);
    } finally {
        await rm(release, { recursive: true, force: true });
    }
});
