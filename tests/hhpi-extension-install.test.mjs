import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTENSION_NAMES, verifyExtensionSet } from '../scripts/dsh-ext/install-extension.mjs';
import { UPSTREAM_COMMIT, UPSTREAM_VERSION, run } from '../scripts/dsh-ext/prepare.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');

// Only package bytes are synthetic. Validation uses the production installer;
// these tests deliberately never invoke npm or claim runtime integration.
async function fixture(t, alter = () => {}, nativeIdentity = false) {
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-extension-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputs = [], patchSetSha256 = digest(JSON.stringify(inputs));
  const identity = { upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: UPSTREAM_VERSION, patchSetSha256 };
  const packageIdentities = {}, packages = [];
  const nativeHash = digest(JSON.stringify([{ path: 'native-persistence.patch', sha256: digest('native') }]));
  for (const name of EXTENSION_NAMES) {
    await rm(join(directory, 'package'), { recursive: true, force: true });
    await mkdir(join(directory, 'package'), { recursive: true });
    const metadata = { name, version: UPSTREAM_VERSION, hhpiSourceExtension: { ...identity } };
    if (nativeIdentity && name.startsWith('@deepseek-ai/dsh-session-')) metadata.hhpiSourceExtension.patchSetSha256 = nativeHash;
    packageIdentities[name] = { ...metadata.hhpiSourceExtension };
    alter(metadata);
    await writeFile(join(directory, 'package/package.json'), JSON.stringify(metadata));
    const file = `${name.slice(1).replace('/', '-')}-${UPSTREAM_VERSION}.tgz`;
    if (name === '@deepseek-ai/dsh-session-persistence-jsonl') {
      await mkdir(join(directory, 'package/lib'), { recursive: true });
      for (const worker of ['worker.cjs', 'read-index-worker.mjs']) await writeFile(join(directory, 'package/lib', worker), '// synthetic archive fixture\n');
    }
    run('tar', ['-czf', join(directory, file), '-C', directory, 'package']);
    const data = await readFile(join(directory, file));
    packages.push({ file, bytes: data.length, sha256: digest(data) });
  }
  const manifest = { ...identity, inputs, packages, ...(nativeIdentity ? { packageIdentities } : {}) };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, manifest };
}

test('verifies the complete fourteen-package source-built package identities and archive checksums', async t => {
  const { directory } = await fixture(t);
  const result = await verifyExtensionSet(directory);
  assert.deepEqual(result.packages.map(item => item.name), EXTENSION_NAMES);
});

test('rejects an incomplete extension set before npm is invoked', async t => {
  const { directory, manifest } = await fixture(t);
  manifest.packages.pop();
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyExtensionSet(directory), /complete extension set/);
});

test('rejects changed archive bytes even with the same filename', async t => {
  const { directory, manifest } = await fixture(t);
  await writeFile(join(directory, manifest.packages[0].file), 'corrupt');
  await assert.rejects(verifyExtensionSet(directory), /checksum mismatch/);
});

test('rejects a different patch set with valid individual archive hashes', async t => {
  const { directory } = await fixture(t, metadata => { metadata.hhpiSourceExtension.patchSetSha256 = '0'.repeat(64); });
  await assert.rejects(verifyExtensionSet(directory), /Mixed or unmarked/);
});

test('rejects official rc packages without the source extension marker', async t => {
  const { directory } = await fixture(t, metadata => { delete metadata.hhpiSourceExtension; });
  await assert.rejects(verifyExtensionSet(directory), /Mixed or unmarked/);
});

test('rejects duplicate packages and paths outside the package set', async t => {
  const { directory, manifest } = await fixture(t);
  manifest.packages[1] = manifest.packages[0];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyExtensionSet(directory), /duplicate/);
  manifest.packages[0] = { ...manifest.packages[0], file: '../outside.tgz' };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyExtensionSet(directory), /Unexpected/);
});


test('accepts independently marked native packages while retaining the eleven UI source identities', async t => {
  const { directory, manifest } = await fixture(t, () => {}, true);
  const result = await verifyExtensionSet(directory);
  assert.equal(result.packages.length, 14);
  const native = result.packages.filter(item => item.name.startsWith('@deepseek-ai/dsh-session-'));
  assert.equal(native.length, 3);
  assert.ok(native.every(item => item.identity.patchSetSha256 !== manifest.patchSetSha256));
});

test('rejects a missing native provider even when all UI archives are present', async t => {
  const { directory, manifest } = await fixture(t, () => {}, true);
  manifest.packages = manifest.packages.filter(item => !item.file.includes('session-persistence-jsonl'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyExtensionSet(directory), /complete extension set/);
});

test('rejects native archive identity mismatch independently of UI identity', async t => {
  const { directory } = await fixture(t, metadata => {
    if (metadata.name === '@deepseek-ai/dsh-session-persistence-jsonl') metadata.hhpiSourceExtension.patchSetSha256 = digest('wrong-native-source');
  }, true);
  await assert.rejects(verifyExtensionSet(directory), /Mixed or unmarked/);
});


test('rejects native persistence archives missing their dynamically loaded index worker', async t => {
  const { directory, manifest } = await fixture(t, () => {}, true);
  const entry = manifest.packages.find(item => item.file.includes('session-persistence-jsonl'));
  run('tar', ['-xzf', join(directory, entry.file), '-C', directory]);
  await rm(join(directory, 'package/lib/read-index-worker.mjs'));
  run('tar', ['-czf', join(directory, entry.file), '-C', directory, 'package']);
  const data = await readFile(join(directory, entry.file));
  entry.bytes = data.length; entry.sha256 = digest(data);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyExtensionSet(directory), /missing package\/lib\/read-index-worker/);
});
