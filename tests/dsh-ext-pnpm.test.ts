import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pnpmToolchain } from '../scripts/dsh-ext/build-extension.mjs';

// Only the pnpm process is a fixture here. Resolution, installed-tool hashing
// and the arguments used by the production compiler/pack launcher are real.
async function fixture(t: any) {
  const root = await mkdtemp('/mnt/cache/data-cache/dsh-ext-pnpm-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, 'npm-cache'), source = join(root, 'source');
  const packageRoot = join(cache, '_npx', 'cached-package', 'node_modules/pnpm');
  const executable = join(packageRoot, 'bin/pnpm.mjs');
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await mkdir(join(packageRoot, 'dist')); await mkdir(source);
  const metadata = { name: 'pnpm', version: '11.28.5', bin: { pnpm: 'bin/pnpm.mjs' } };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(metadata));
  await writeFile(executable, '// pinned entrypoint\n');
  await writeFile(join(packageRoot, 'dist/pnpm.mjs'), '// installed pnpm runtime\n');
  const calls: { command: string; args: string[]; options: any }[] = [];
  const execute = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    if (command === 'which') throw Error('No PATH pnpm');
    assert.equal(command, process.execPath);
    return args.includes('--version') ? '11.28.5\n' : 'tool output';
  };
  return { root, cache, source, packageRoot, executable, metadata, calls, execute };
}

test('the pinned cached pnpm launches compilers and packs directly without npm or automatic installs', async t => {
  const f = await fixture(t);
  const tools = await pnpmToolchain(f.source, f.execute, { command: '', cache: f.cache });
  const nested = join(f.source, 'packages/example');
  assert.equal(tools.invoke(['exec', 'tsc', '-b'], nested, 4321), 'tool output');
  tools.invoke(['pack', '--pack-destination', f.root]);
  assert.equal(f.calls.filter(call => call.command === 'which').length, 1);
  const executions = f.calls.filter(call => call.command !== 'which');
  assert.deepEqual(executions.map(call => call.args), [
    [f.executable, '--config.verify-deps-before-run=false', '--version'],
    [f.executable, '--config.verify-deps-before-run=false', 'exec', 'tsc', '-b'],
    [f.executable, '--config.verify-deps-before-run=false', 'pack', '--pack-destination', f.root],
  ]);
  assert.deepEqual(executions[1]!.options, { cwd: nested, timeout: 4321 });
  assert.equal(tools.identity.command, f.executable);
  assert.equal(tools.identity.verifyDepsBeforeRun, false);
  assert.match(tools.identity.nodeSha256, /^[0-9a-f]{64}$/);
});

test('changing the installed pnpm implementation invalidates its identity even when version and entrypoint stay identical', async t => {
  const f = await fixture(t);
  const settings = { command: f.executable };
  const before = await pnpmToolchain(f.source, f.execute, settings);
  await writeFile(join(f.packageRoot, 'dist/pnpm.mjs'), '// changed installed runtime\n');
  const after = await pnpmToolchain(f.source, f.execute, settings);
  assert.equal(before.identity.version, after.identity.version);
  assert.equal(before.identity.commandSha256, after.identity.commandSha256);
  assert.notEqual(before.identity.packageSha256, after.identity.packageSha256);
  assert.equal(f.calls.some(call => call.command !== process.execPath), false);
});

test('missing, unpinned and misreported local pnpm installations fail without an implicit tool install', async t => {
  const f = await fixture(t);
  const settings = { command: '', cache: f.cache };
  await writeFile(join(f.packageRoot, 'package.json'), JSON.stringify({ ...f.metadata, version: '11.28.6' }));
  await assert.rejects(pnpmToolchain(f.source, f.execute, settings), /No installed pnpm 11\.28\.5/);
  await assert.rejects(pnpmToolchain(f.source, f.execute, { command: f.executable }), /PNPM_COMMAND must point/);
  await writeFile(join(f.packageRoot, 'package.json'), JSON.stringify(f.metadata));
  await assert.rejects(pnpmToolchain(f.source, () => '11.28.6\n', { command: f.executable }), /Expected pnpm 11\.28\.5/);
  await rm(join(f.packageRoot, 'dist'), { recursive: true });
  await assert.rejects(pnpmToolchain(f.source, f.execute, { command: f.executable }), /installed pnpm package is incomplete/);
  assert.equal(f.calls.some(call => call.command === 'npm'), false);
});
