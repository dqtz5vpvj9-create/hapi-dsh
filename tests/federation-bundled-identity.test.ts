/** Build the production identity module at real distribution depths, not a mirrored fixture. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runtimeIdentity, identityMatches, type RuntimeIdentityV1 } from '../src/runner/identity.ts';

test('bundled Host and nested Runner preserve packaged provenance outside the checkout', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const temporary = await mkdtemp(join(tmpdir(), 'hhpi-bundled-identity-'));
    try {
        const source = runtimeIdentity({ dshVersion: '0.2.1-rc.3' });
        for (const path of ['index.mjs', 'runner/index.mjs']) {
            const outfile = join(temporary, path); await mkdir(dirname(outfile), { recursive: true });
            await build({ entryPoints: [join(root, 'src/runner/identity.ts')], outfile, bundle: true,
                platform: 'node', format: 'esm', packages: 'external', target: 'node24' });
            const module = await import(pathToFileURL(outfile).href) as { runtimeIdentity(input: { dshVersion: string }): RuntimeIdentityV1 };
            const bundled = module.runtimeIdentity({ dshVersion: '0.2.1-rc.3' });
            assert.notEqual(bundled.upstreamCommit, 'unknown', `${path} must carry the actual build provenance`);
            assert.deepEqual(bundled, source);
            assert.equal(identityMatches(source, bundled), true);
        }
    } finally { await rm(temporary, { recursive: true, force: true }); }
});
