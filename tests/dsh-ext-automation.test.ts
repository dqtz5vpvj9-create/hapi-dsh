import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, utimes } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareDshSource, EXTENSION_PACKAGES, UPSTREAM_COMMIT, UPSTREAM_VERSION, run, sourceSnapshot } from '../scripts/dsh-ext/prepare.mjs';
import { buildExtension, workspace } from '../scripts/dsh-ext/build-extension.mjs';
import { installExtensionSet, verifyExtensionSet } from '../scripts/dsh-ext/install-extension.mjs';
import { fingerprint, readJson, withLock } from '../scripts/dsh-ext/cache.mjs';

// Process boundaries for git fetching, pnpm compilation and npm installation are
// fixtures. Production orchestration, locking, filesystem/archive validation and
// every invalidation decision execute unchanged; no upstream build is claimed.
const inline = ['packages/util/brand', 'packages/util/crypto', 'packages/util/values', 'vendor/cosmokit'];
const roots = [...EXTENSION_PACKAGES, ...inline];
const toolchain = { pnpm: '11.28.5', node: process.version, fixture: true };
const nameFor = (path: string) => `@deepseek-ai/dsh-${path === 'packages/util/brand' ? 'brand' : path.startsWith('vendor/') ? 'cosmokit' : path.startsWith('packages/fs/') || path.startsWith('packages/session/') ? path.split('/').at(-1) : path.slice('packages/'.length).replaceAll('/', '-')}`;
const put = (file: string, data: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); };
async function fixture(t: any) {
  const directory = await mkdtemp('/mnt/cache/data-cache/dsh-ext-automation-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), output = join(directory, 'output'), target = join(directory, 'target');
  await mkdir(source); await mkdir(target);
  run('git', ['init', '--quiet', source]);
  const identity = { upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: UPSTREAM_VERSION, inputs: [], patchSetSha256: fingerprint([]) };
  await writeFile(join(source, 'hhpi-source-inputs.json'), JSON.stringify({ ...identity, nativeSourceExtension: identity }));
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture-root', packageManager: 'pnpm@11.28.5' }));
  await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(source, '.gitignore'), 'node_modules/\nlib/\n');
  for (const path of roots) {
    put(join(source, path, 'package.json'), JSON.stringify({ name: nameFor(path), version: UPSTREAM_VERSION,
      ...(path === EXTENSION_PACKAGES[1]! ? { devDependencies: { [nameFor(EXTENSION_PACKAGES[0]!)]: 'workspace:*' } } : {}) }));
    put(join(source, path, 'src/index.ts'), `export const value = ${JSON.stringify(path)};\n`);
    put(join(source, path, 'tsconfig.json'), '{}');
  }
  await writeFile(join(target, 'package.json'), '{"name":"target"}\n');
  await writeFile(join(target, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const calls: string[][] = [];
  let fail: string | undefined;
  const pnpm = (args: string[], cwd: string) => {
    calls.push([cwd, ...args]);
    if (fail && args.includes(fail)) throw Error(`fixture ${fail} failure`);
    if (args[0] === 'install') put(join(source, 'node_modules/tool/index.js'), 'dependency bytes\n');
    else if (args[1] === 'tsx') put(join(source, EXTENSION_PACKAGES[0]!, 'lib/typert.host.js'), '// generated contract\n');
    else if (args[1] === 'tsc') for (const path of roots) {
      const content = readFileSync(join(source, path, 'src/index.ts'), 'utf8');
      put(join(source, path, 'lib/types/index.js'), content);
      put(join(source, path, 'lib/types/index.d.ts'), 'export declare const value: string;\n');
      put(join(source, path, 'lib/tsconfig.tsbuildinfo'), content);
    }
    else if (args[1] === 'tsdown') {
      const content = readFileSync(join(cwd, 'src/index.ts'), 'utf8');
      put(join(cwd, 'lib', args.includes('--no-config') ? 'index.mjs' : 'index.js'), content);
      if (cwd.endsWith('session-persistence-jsonl')) for (const worker of ['worker.cjs', 'read-index-worker.mjs']) put(join(cwd, 'lib', worker), '// worker\n');
    } else if (args[0] === 'pack') {
      const metadata = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      const dest = args[2]!, staging = join(directory, 'pack-staging');
      rmSync(staging, { recursive: true, force: true }); mkdirSync(join(staging, 'package'), { recursive: true });
      cpSync(join(cwd, 'package.json'), join(staging, 'package/package.json'));
      cpSync(join(cwd, 'lib'), join(staging, 'package/lib'), { recursive: true });
      run('tar', ['-czf', join(dest, `${metadata.name.slice(1).replace('/', '-')}-${UPSTREAM_VERSION}.tgz`), '-C', staging, 'package']);
    }
    return '';
  };
  const options = { pnpm, toolchain, run: (command: string, args: string[], settings: any) => args[0] === 'rev-parse' ? UPSTREAM_COMMIT : run(command, args, settings), dependencyCache: join(directory, 'dependencies') };
  const npmCalls: string[][] = [];
  const npm = (_command: string, args: string[]) => {
    npmCalls.push(args);
    if (fail === 'npm') throw Error('fixture npm failure');
    for (const archive of args.filter(arg => arg.endsWith('.tgz'))) {
      const metadata = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json']));
      const dest = join(target, 'node_modules', metadata.name);
      mkdirSync(dest, { recursive: true });
      run('tar', ['-xzf', archive, '--strip-components=1', '-C', dest]);
    }
    return '';
  };
  return { directory, source, output, target, calls, options, npmCalls, installOptions: { run: npm, toolchain }, fail(value?: string) { fail = value; } };
}

const cohort = (sha256: string) => {
  const inputs = [{ path: 'source-snapshots/dsh-ext/source.patch', sha256 }];
  const identity = { upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: UPSTREAM_VERSION, inputs, patchSetSha256: fingerprint(inputs) };
  return { ...identity, nativeSourceExtension: identity };
};
// Actual .16/.17 patch digests from the provenance-recovery incident. The tree
// and all compiler/install boundaries below remain the small local fixture.
const extension16 = cohort('48fec28645b7410d2bcc38c953ebe851f73faecab2e4bc3d770ae9e8cb6062d2');
const extension17 = cohort('14f375834921859ab46f10da76fca80e850bc96675ac1b52466b4d5282ed9ae9');

test('expected frozen provenance rejects stale .16 identity before any toolchain work in API and CLI', async t => {
  const f = await fixture(t), prepared = join(f.source, 'hhpi-source-inputs.json'), expected = join(f.directory, 'frozen.json');
  const stale = JSON.stringify(extension16);
  await writeFile(prepared, stale); await writeFile(expected, JSON.stringify({ status: 'frozen', ...extension17 }));
  let commands = 0;
  await assert.rejects(buildExtension(f.source, f.output, { ...f.options, expectedSource: expected, run() { commands++; throw Error('A tool was started'); } }), /expected frozen source identity/);
  assert.equal(commands, 0); assert.equal(f.calls.length, 0);
  assert.throws(() => run(process.execPath, [new URL('../scripts/dsh-ext/build-extension.mjs', import.meta.url).pathname, f.source, f.output, '--expected-source', expected]), /expected frozen source identity/);
  assert.equal(await readFile(prepared, 'utf8'), stale, 'the checker must not repair or rewrite provenance');
  assert.equal(await readJson(join(f.source, '.hhpi-build-cache/state.json')), undefined);
  assert.equal(await readJson(join(f.output, 'manifest.json')), undefined);
});

test('expected frozen provenance checks native identity and rejects an inconsistent expected record', async t => {
  const f = await fixture(t), prepared = join(f.source, 'hhpi-source-inputs.json');
  await writeFile(prepared, JSON.stringify({ ...extension17, nativeSourceExtension: extension16.nativeSourceExtension }));
  await assert.rejects(buildExtension(f.source, f.output, { ...f.options, expectedSource: extension17 }), /expected frozen source identity/);
  await writeFile(prepared, JSON.stringify(extension17));
  await assert.rejects(buildExtension(f.source, f.output, { ...f.options, expectedSource: { ...extension17, patchSetSha256: extension16.patchSetSha256 } }), /Invalid expected frozen source identity/);
  assert.equal(f.calls.length, 0);
});

test('expected frozen provenance accepts prepare output, validates a supplied source hash and keeps legacy calls compatible', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'hhpi-source-inputs.json'), JSON.stringify(extension17));
  const sourceSha256 = fingerprint(await sourceSnapshot(f.source));
  const result = await buildExtension(f.source, f.output, { ...f.options, expectedSource: { provenance: extension17, sourceSha256 } });
  assert.equal(result.packages.length, EXTENSION_PACKAGES.length);
  const manifest = await readJson(join(f.output, 'manifest.json'));
  assert.equal(manifest.patchSetSha256, extension17.patchSetSha256);
  assert.equal(manifest.nativeSourceExtension.patchSetSha256, extension17.nativeSourceExtension.patchSetSha256);
  assert.equal((await buildExtension(f.source, f.output, { ...f.options, expectedSource: { ...extension17, build: { sourceSha256 } } })).reused, true);
  const calls = f.calls.length;
  await assert.rejects(buildExtension(f.source, f.output, { ...f.options, expectedSource: { ...extension17, sourceSha256: '0'.repeat(64) } }), /expected frozen source hash/);
  assert.equal(f.calls.length, calls);
  assert.equal((await buildExtension(f.source, f.output, f.options)).reused, true);
});

test('complete build/install chain coalesces duplicate requests and validates a warm repeat', async t => {
  const f = await fixture(t);
  const results = await Promise.all([buildExtension(f.source, f.output, f.options), buildExtension(f.source, f.output, f.options)]);
  assert.deepEqual(results.map(result => result.counts.dependencyInstall).sort(), [0, 1]);
  assert.deepEqual(results.map(result => result.counts.packs).sort((a, b) => a - b), [0, EXTENSION_PACKAGES.length]);
  assert.equal(results.find(result => result.reused)?.counts.bundles, 0);
  assert.equal((await verifyExtensionSet(f.output)).packages.length, EXTENSION_PACKAGES.length);
  const installed = await Promise.all([installExtensionSet(f.output, f.target, f.installOptions), installExtensionSet(f.output, f.target, f.installOptions)]);
  assert.equal(f.npmCalls.length, 1);
  assert.deepEqual(installed.map(result => result.reused).sort(), [false, true]);
  assert.equal((await readJson(join(f.output, 'manifest.json'))).build.toolchain.fixture, true);
});

test('pnpm validation timestamp rewrites during exec and pack preserve warm build reuse', async t => {
  const f = await fixture(t);
  const file = join(f.source, 'node_modules/.pnpm-workspace-state-v1.json');
  let timestamp = 1;
  const options = { ...f.options, pnpm(args: string[], cwd: string) {
    const result = f.options.pnpm(args, cwd);
    const metadata = args[0] === 'install'
      ? { lastValidatedTimestamp: timestamp++, settings: { nodeLinker: 'isolated' } }
      : { ...JSON.parse(readFileSync(file, 'utf8')), lastValidatedTimestamp: timestamp++ };
    writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
    return result;
  } };
  await buildExtension(f.source, f.output, options);
  assert.ok(JSON.parse(await readFile(file, 'utf8')).lastValidatedTimestamp > 1);
  const warm = await buildExtension(f.source, f.output, options);
  assert.equal(warm.reused, true);
  assert.deepEqual(warm.counts, { dependencyInstall: 0, dependencyCopy: 0, typert: 0, typecheck: 0, bundles: 0, packs: 0 });
  const metadata = JSON.parse(await readFile(file, 'utf8'));
  metadata.settings.nodeLinker = 'hoisted';
  await writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.equal((await buildExtension(f.source, f.output, options)).counts.dependencyInstall, 1);
});

test('Vitest result updates reuse the build while dependency bytes and lock/config inputs still invalidate', async t => {
  const f = await fixture(t);
  const results = join(f.source, 'node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json');
  let installed = 'dependency bytes\n';
  const options = { ...f.options, pnpm(args: string[], cwd: string) {
    const result = f.options.pnpm(args, cwd);
    if (args[0] === 'install') {
      put(join(f.source, 'node_modules/tool/index.js'), installed);
      if (!existsSync(results)) put(results, '{"version":"4.1.11","results":[]}\n');
    }
    return result;
  } };
  await buildExtension(f.source, f.output, options);
  await writeFile(results, '{"version":"4.1.11","results":[["changed-test",0.25]]}\n');
  const warm = await buildExtension(f.source, f.output, options);
  assert.deepEqual(warm.counts, { dependencyInstall: 0, dependencyCopy: 0, typert: 0, typecheck: 0, bundles: 0, packs: 0 });
  const second = join(f.directory, 'second-source');
  await cp(f.source, second, { recursive: true });
  await rm(join(second, 'node_modules'), { recursive: true });
  await rm(join(second, '.hhpi-dependencies.json'));
  const copied = await buildExtension(second, join(f.directory, 'second-output'), { ...options, pnpm() { throw Error('Validated dependency copy must not compile or install'); } });
  assert.equal(copied.counts.dependencyInstall, 0); assert.equal(copied.counts.dependencyCopy, 1);
  installed = 'changed installed dependency bytes\n';
  await writeFile(join(f.source, 'node_modules/tool/index.js'), 'corrupt dependency\n');
  const dependency = await buildExtension(f.source, f.output, options);
  assert.equal(dependency.counts.dependencyInstall, 1);
  assert.equal(dependency.counts.bundles, roots.length);
  for (const [path, contents] of [['pnpm-lock.yaml', 'lockfileVersion: changed\n'], ['.npmrc', 'node-linker=isolated\n']]) {
    await writeFile(join(f.source, path!), contents!);
    const changed = await buildExtension(f.source, f.output, options);
    assert.equal(changed.counts.dependencyInstall, 1, path);
    assert.equal(changed.counts.bundles, roots.length, path);
  }
});

test('workspace signatures isolate nested owners and retain transitive and global inputs', async t => {
  const f = await fixture(t);
  const parent = 'native/system', child = 'native/system/packages/linux-x64';
  const dependent = EXTENSION_PACKAGES[0]!, unrelated = EXTENSION_PACKAGES[2]!;
  put(join(f.source, parent, 'package.json'), JSON.stringify({ name: 'parent', version: UPSTREAM_VERSION }));
  put(join(f.source, parent, 'src/index.ts'), 'export const parent = true;');
  put(join(f.source, child, 'package.json'), JSON.stringify({ name: 'child', version: UPSTREAM_VERSION }));
  put(join(f.source, child, 'src/index.ts'), 'export const child = 1;');
  const metadata = JSON.parse(await readFile(join(f.source, dependent, 'package.json'), 'utf8'));
  metadata.dependencies = { child: 'workspace:*' };
  await writeFile(join(f.source, dependent, 'package.json'), JSON.stringify(metadata));
  const graph = () => sourceSnapshot(f.source).then(files => workspace(f.source, files));
  const before = await graph();
  put(join(f.source, child, 'src/index.ts'), 'export const child = 2;');
  const changed = await graph();
  assert.notEqual(changed.signatures[child], before.signatures[child]);
  assert.notEqual(changed.signatures[dependent], before.signatures[dependent]);
  assert.equal(changed.signatures[parent], before.signatures[parent]);
  assert.equal(changed.signatures[unrelated], before.signatures[unrelated]);
  await writeFile(join(f.source, 'tsdown.config.ts'), 'export default {};');
  const global = await graph();
  for (const path of global.roots) assert.notEqual(global.signatures[path], changed.signatures[path]);
});

test('source changes rebuild the affected dependency closure while lock/toolchain changes invalidate the environment', async t => {
  const f = await fixture(t);
  await buildExtension(f.source, f.output, f.options);
  await writeFile(join(f.source, EXTENSION_PACKAGES[0]!, 'src/index.ts'), 'export const value = "changed";\n');
  const changed = await buildExtension(f.source, f.output, f.options);
  assert.equal(changed.counts.dependencyInstall, 0); assert.equal(changed.counts.typert, 1);
  assert.equal(changed.counts.bundles, 2); assert.equal(changed.counts.packs, 2);
  assert.equal(f.calls.filter(call => call[2] === 'tsc').at(-1)?.includes('--force'), false);
  await writeFile(join(f.source, EXTENSION_PACKAGES[0]!, 'src/index.ts'), 'export const value = "old timestamp";\n');
  await utimes(join(f.source, EXTENSION_PACKAGES[0]!, 'src/index.ts'), 1, 1);
  await buildExtension(f.source, f.output, f.options);
  assert.equal(f.calls.filter(call => call[2] === 'tsc').at(-1)?.includes('--force'), true);
  await writeFile(join(f.source, 'pnpm-lock.yaml'), 'lockfileVersion: changed\n');
  const lock = await buildExtension(f.source, f.output, f.options);
  assert.equal(lock.counts.dependencyInstall, 1); assert.equal(lock.counts.bundles, roots.length);
  const tools = await buildExtension(f.source, f.output, { ...f.options, toolchain: { ...toolchain, revision: 2 } });
  assert.equal(tools.counts.dependencyInstall, 1); assert.equal(tools.counts.bundles, roots.length);
});

test('missing and corrupted dependencies, generated output, bundles and archives invalidate only usable results', async t => {
  const f = await fixture(t);
  await buildExtension(f.source, f.output, f.options);
  await writeFile(join(f.source, 'node_modules/tool/index.js'), 'corrupt');
  const dependencies = await buildExtension(f.source, f.output, f.options);
  assert.equal(dependencies.counts.dependencyInstall, 1);
  await rm(join(f.source, EXTENSION_PACKAGES[0]!, 'lib/typert.host.js'));
  assert.equal((await buildExtension(f.source, f.output, f.options)).counts.typert, 1);
  await writeFile(join(f.source, EXTENSION_PACKAGES[2]!, 'lib/index.js'), 'corrupt');
  const bundle = await buildExtension(f.source, f.output, f.options);
  assert.equal(bundle.counts.bundles, 1);
  await writeFile(join(f.source, EXTENSION_PACKAGES[2]!, 'lib/types/index.d.ts'), 'corrupt');
  assert.equal((await buildExtension(f.source, f.output, f.options)).counts.typecheck, 1);
  assert.equal(f.calls.filter(call => call[2] === 'tsc').at(-1)?.includes('--force'), true);
  const manifest = await readJson(join(f.output, 'manifest.json'));
  await writeFile(join(f.output, manifest.packages[0].file), 'corrupt');
  const archive = await buildExtension(f.source, f.output, f.options);
  assert.equal(archive.counts.packs, 0);
  await verifyExtensionSet(f.output);
  const state = await readJson(join(f.source, '.hhpi-build-cache/state.json'));
  const pack = state.packs[EXTENSION_PACKAGES[3]!];
  await writeFile(join(f.source, '.hhpi-build-cache/packages', pack.input, pack.outputs[0].path), 'corrupt');
  assert.equal((await buildExtension(f.source, f.output, f.options)).counts.packs, 1);
});

test('identical installed markers cannot hide a corrupted runtime or missing worker, and changed target inputs reinstall', async t => {
  const f = await fixture(t);
  await buildExtension(f.source, f.output, f.options);
  await installExtensionSet(f.output, f.target, f.installOptions);
  const name = nameFor(EXTENSION_PACKAGES[0]!);
  await writeFile(join(f.target, 'node_modules', name, 'lib/index.js'), 'corrupt');
  assert.equal((await installExtensionSet(f.output, f.target, f.installOptions)).reused, false);
  await writeFile(join(f.target, 'node_modules', name, 'lib/stale.js'), 'unexpected file');
  // npm's fixture copies exactly like an unpack; an unexpected old file must
  // prevent a no-op and cannot be accepted as a repaired installation.
  await assert.rejects(installExtensionSet(f.output, f.target, f.installOptions), /do not match the verified archives/);
  await rm(join(f.target, 'node_modules', name, 'lib/stale.js'));
  await rm(join(f.target, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/read-index-worker.mjs'));
  assert.equal((await installExtensionSet(f.output, f.target, f.installOptions)).reused, false);
  await writeFile(join(f.target, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
  assert.equal((await installExtensionSet(f.output, f.target, f.installOptions)).reused, false);
  assert.equal((await installExtensionSet(f.output, f.target, f.installOptions)).reused, true);
  assert.equal(f.npmCalls.length, 5);
});

test('a failed dependency/compiler/install operation records no false success and a later request can recover', async t => {
  const f = await fixture(t);
  f.fail('install');
  const failedBuilds = await Promise.allSettled([buildExtension(f.source, f.output, f.options), buildExtension(f.source, f.output, f.options)]);
  assert.equal(failedBuilds.filter(item => item.status === 'rejected').length, 2);
  assert.ok(failedBuilds.some(item => item.status === 'rejected' && /execution this request waited for/.test(item.reason.message)));
  assert.equal(f.calls.filter(call => call[1] === 'install').length, 1);
  assert.equal(await readJson(join(f.source, '.hhpi-dependencies.json')), undefined);
  f.fail('tsdown'); await assert.rejects(buildExtension(f.source, f.output, f.options), /fixture tsdown failure/);
  assert.equal(await readJson(join(f.output, 'manifest.json')), undefined);
  f.fail(); const recovered = await buildExtension(f.source, f.output, f.options);
  assert.equal(recovered.counts.dependencyInstall, 0); assert.equal(recovered.counts.typert, 0);
  f.fail('npm');
  const failedInstalls = await Promise.allSettled([installExtensionSet(f.output, f.target, f.installOptions), installExtensionSet(f.output, f.target, f.installOptions)]);
  assert.equal(failedInstalls.filter(item => item.status === 'rejected').length, 2);
  assert.equal(f.npmCalls.length, 1);
  assert.equal(await readJson(join(f.target, '.tmp/hhpi-ext/installed.json')), undefined);
  f.fail(); assert.equal((await installExtensionSet(f.output, f.target, f.installOptions)).reused, false);
});

test('matching dependency environments are copied to another source without another install', async t => {
  const f = await fixture(t);
  await buildExtension(f.source, f.output, f.options);
  const second = join(f.directory, 'second-source');
  await cp(f.source, second, { recursive: true });
  await rm(join(second, 'node_modules'), { recursive: true });
  await rm(join(second, '.hhpi-dependencies.json'));
  const result = await buildExtension(second, join(f.directory, 'second-output'), { ...f.options, pnpm() { throw Error('No compiler/install should run for a validated copied environment'); } });
  assert.equal(result.counts.dependencyInstall, 0); assert.equal(result.counts.dependencyCopy, 1);
});

test('an input edit during compilation cannot publish a complete manifest for the old source fingerprint', async t => {
  const f = await fixture(t);
  let edit = true;
  const options = { ...f.options, pnpm(args: string[], cwd: string) {
    if (edit && args[1] === 'tsx') { edit = false; put(join(f.source, EXTENSION_PACKAGES[0]!, 'src/index.ts'), 'export const value = "concurrent edit";\n'); }
    return f.options.pnpm(args, cwd);
  } };
  await assert.rejects(buildExtension(f.source, f.output, options), /inputs changed during the build/);
  assert.equal(await readJson(join(f.output, 'manifest.json')), undefined);
  await buildExtension(f.source, f.output, options);
  assert.equal((await verifyExtensionSet(f.output)).packages.length, EXTENSION_PACKAGES.length);
});

test('prepared source is stable across duplicate requests and dirty source is preserved', async t => {
  const base = await mkdtemp('/mnt/cache/data-cache/dsh-ext-prepare-test-');
  t.after(() => rm(base, { recursive: true, force: true }));
  const patch = join(base, 'source.patch'); await writeFile(patch, 'fixture patch');
  let fetches = 0;
  const execute = (command: string, args: string[], options?: any) => {
    if (args[0] === 'fetch') { fetches++; put(join(options.cwd, 'source.ts'), 'original'); return ''; }
    if (args[0] === 'checkout' || args[0] === 'remote' || args[0] === 'apply') return '';
    if (args[0] === 'rev-parse') return UPSTREAM_COMMIT;
    return run(command, args, options);
  };
  const results = await Promise.all([prepareDshSource(join(base, 'cache'), { patch, run: execute }), prepareDshSource(join(base, 'cache'), { patch, run: execute })]);
  assert.equal(results[0].directory, results[1].directory); assert.equal(fetches, 1);
  await writeFile(join(results[0].directory, 'source.ts'), 'local edit');
  await assert.rejects(prepareDshSource(join(base, 'cache'), { patch, run: execute }), /preserved without overwrite/);
  assert.equal(await readFile(join(results[0].directory, 'source.ts'), 'utf8'), 'local edit');
  await writeFile(patch, 'changed fixture patch');
  const changed = await prepareDshSource(join(base, 'cache'), { patch, run(command: string, args: string[], settings: any) {
    if (args[0] === 'apply') {
      if (args[1] === '--check') writeFileSync(patch, 'changed while applying');
      assert.equal(readFileSync(args.at(-1)!, 'utf8'), 'changed fixture patch');
    }
    return execute(command, args, settings);
  } });
  assert.notEqual(changed.directory, results[0].directory);
});

test('a killed real process releases its lock and competing successors remain serialized', async t => {
  const directory = await mkdtemp('/mnt/cache/data-cache/dsh-ext-lock-process-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = new URL('../scripts/dsh-ext/cache.mjs', import.meta.url).href;
  const file = join(directory, 'lock.sqlite'), active = join(directory, 'active');
  const children: ReturnType<typeof spawn>[] = [];
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); }));
  const start = (code: string) => { const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); return child; };
  const holder = start(`import {withLock} from ${JSON.stringify(module)};await withLock(${JSON.stringify(file)},async()=>{console.log('held');await new Promise(()=>{setInterval(()=>{},1000)})});`);
  await once(holder.stdout!, 'data');
  const contender = `import {withLock} from ${JSON.stringify(module)};import {openSync,closeSync,unlinkSync} from 'node:fs';await withLock(${JSON.stringify(file)},async()=>{const fd=openSync(${JSON.stringify(active)},'wx');await new Promise(done=>setTimeout(done,30));closeSync(fd);unlinkSync(${JSON.stringify(active)});});`;
  const successors = [start(contender), start(contender)];
  const completed = successors.map(child => once(child, 'exit'));
  const holderExited = once(holder, 'exit'); holder.kill('SIGKILL'); await holderExited;
  for (const result of await Promise.all(completed)) assert.equal(result[0], 0);
  assert.equal(await withLock(file, () => 'recovered'), 'recovered');
});
