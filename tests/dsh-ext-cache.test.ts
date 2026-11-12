import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PNPM_WORKSPACE_STATE, dependencySnapshot, validateDependencySnapshot, snapshot, matchesSnapshot } from '../scripts/dsh-ext/cache.mjs';

async function fixture(t: any) {
  const root = await mkdtemp('/mnt/cache/data-cache/dsh-ext-metadata-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { lastValidatedTimestamp: 1, projects: { '/workspace/example': { name: 'example', version: '1' } }, settings: { nodeLinker: 'isolated' }, nested: { lastValidatedTimestamp: 7 } };
  const writeState = (value: any) => writeFile(join(root, PNPM_WORKSPACE_STATE), `${JSON.stringify(value, null, 2)}\n`);
  await mkdir(join(root, 'node_modules/tool'), { recursive: true });
  await writeFile(join(root, 'node_modules/tool/index.js'), 'export const value = 1;\n');
  await writeFile(join(root, 'node_modules/.modules.yaml'), 'nodeLinker: isolated\n');
  await writeState(state);
  return { root, state, writeState };
}

test('dependency snapshots ignore only the top-level pnpm validation timestamp', async t => {
  const f = await fixture(t);
  const before = await dependencySnapshot(f.root, ['node_modules']);
  await f.writeState({ ...f.state, lastValidatedTimestamp: 1794143284192 });
  assert.ok(await validateDependencySnapshot(f.root, before));
  for (const changed of [
    { ...f.state, nested: { lastValidatedTimestamp: 8 } },
    { ...f.state, settings: { nodeLinker: 'hoisted' } },
    { ...f.state, projects: { '/workspace/example': { name: 'different', version: '1' } } },
    { ...f.state, unexpectedSetting: true },
    { ...f.state, lastValidatedTimestamp: 'invalid' },
  ]) {
    await f.writeState(changed);
    assert.equal(await validateDependencySnapshot(f.root, before), null);
  }
  // Formatting and every non-timestamp byte remain part of the fingerprint.
  await writeFile(join(f.root, PNPM_WORKSPACE_STATE), JSON.stringify(f.state));
  assert.equal(await validateDependencySnapshot(f.root, before), null);
});

test('dependency contents and ordinary artifact snapshots retain exact byte validation', async t => {
  const f = await fixture(t);
  const dependencies = await dependencySnapshot(f.root, ['node_modules']);
  const artifacts = await snapshot(f.root, ['node_modules']);
  await f.writeState({ ...f.state, lastValidatedTimestamp: 2 });
  assert.ok(await validateDependencySnapshot(f.root, dependencies));
  assert.equal(await matchesSnapshot(f.root, artifacts), false);
  await writeFile(join(f.root, 'node_modules/tool/index.js'), 'export const value = 2;\n');
  assert.equal(await validateDependencySnapshot(f.root, dependencies), null);
  await writeFile(join(f.root, 'node_modules/tool/index.js'), 'export const value = 1;\n');
  await writeFile(join(f.root, 'node_modules/.modules.yaml'), 'nodeLinker: hoisted\n');
  assert.equal(await validateDependencySnapshot(f.root, dependencies), null);
});

test('legacy dependency snapshots migrate only when their original raw metadata still matches', async t => {
  const f = await fixture(t);
  const legacy = await snapshot(f.root, ['node_modules'], { normalizeLinks: true });
  const upgraded = await validateDependencySnapshot(f.root, legacy);
  assert.equal(upgraded?.migrated, true);
  assert.ok(upgraded?.outputs.find(item => item.path === PNPM_WORKSPACE_STATE)?.normalization);
  await f.writeState({ ...f.state, lastValidatedTimestamp: 2 });
  assert.ok(await validateDependencySnapshot(f.root, upgraded!.outputs));
  assert.equal(await validateDependencySnapshot(f.root, legacy), null);
});

test('the timestamp exception does not apply to another file with the same basename', async t => {
  const f = await fixture(t);
  const other = 'node_modules/tool/.pnpm-workspace-state-v1.json';
  await writeFile(join(f.root, other), JSON.stringify(f.state));
  const before = await dependencySnapshot(f.root, ['node_modules']);
  await writeFile(join(f.root, other), JSON.stringify({ ...f.state, lastValidatedTimestamp: 2 }));
  assert.equal(await validateDependencySnapshot(f.root, before), null);
});

test('only the exact Vitest results file is excluded from dependencies, including existing records', async t => {
  const f = await fixture(t);
  const result = 'node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json';
  const others = ['node_modules/tool/results.json', 'node_modules/.vite/vitest/config.json',
    'node_modules/.vite/vitest/not-a-project-hash/results.json', 'node_modules/.pnpm/lock.yaml'];
  for (const path of [result, ...others]) {
    await mkdir(join(f.root, path, '..'), { recursive: true });
    await writeFile(join(f.root, path), 'original bytes\n');
  }
  const artifacts = await snapshot(f.root, ['node_modules']);
  const legacy = await snapshot(f.root, ['node_modules'], { normalizeLinks: true, normalizePnpmWorkspaceState: true });
  const dependencies = await dependencySnapshot(f.root, ['node_modules']);
  assert.equal(dependencies.some(entry => entry.path === result), false);
  await writeFile(join(f.root, result), 'updated test timings\n');
  assert.ok(await validateDependencySnapshot(f.root, dependencies));
  assert.equal(await matchesSnapshot(f.root, artifacts), false, 'ordinary output validation stays byte-exact');
  const migrated = await validateDependencySnapshot(f.root, legacy);
  assert.equal(migrated?.migrated, true);
  assert.deepEqual(migrated?.outputs, dependencies);
  for (const path of others) {
    await writeFile(join(f.root, path), 'changed real input\n');
    assert.equal(await validateDependencySnapshot(f.root, dependencies), null, path);
    await writeFile(join(f.root, path), 'original bytes\n');
  }
});
