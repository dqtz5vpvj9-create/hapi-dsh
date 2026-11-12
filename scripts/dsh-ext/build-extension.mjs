/** Build the pinned source; reuse only byte-validated dependency and output sets. */
import { cp, mkdir, readFile, readdir, rename, rm, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EXTENSION_PACKAGES, FILESYSTEM_EXTENSION_PACKAGES, NATIVE_EXTENSION_PACKAGES, ROOT, UPSTREAM_COMMIT, UPSTREAM_VERSION, run, sourceSnapshot } from './prepare.mjs';
import { digest, fingerprint, readJson, snapshot, matchesSnapshot, dependencySnapshot, validateDependencySnapshot, completeSnapshot, withLock, writeJson, environmentIdentity } from './cache.mjs';
import { verifyExtensionSet } from './install-extension.mjs';

const INLINE_RUNTIME_PACKAGES = ['packages/util/brand', 'packages/util/crypto', 'packages/util/values', 'vendor/cosmokit'];
const MISSING_CLIENT_EXTERNALS = ['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-util-crypto', '@deepseek-ai/dsh-util-values', '@deepseek-ai/cosmokit'];
const archiveName = metadata => `${metadata.name.slice(1).replace('/', '-')}-${metadata.version}.tgz`;
const jsonConfig = text => JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
const log = value => { if (value?.trim()) console.log(value); };

const sourceIdentity = value => value ? ({ upstreamCommit: value.upstreamCommit, upstreamVersion: value.upstreamVersion,
  inputs: value.inputs, patchSetSha256: value.patchSetSha256 }) : null;
const validSourceIdentity = value => value?.upstreamCommit === UPSTREAM_COMMIT && value.upstreamVersion === UPSTREAM_VERSION
  && Array.isArray(value.inputs) && value.inputs.every(item => typeof item?.path === 'string' && /^[a-f0-9]{64}$/.test(item.sha256))
  && value.patchSetSha256 === fingerprint(value.inputs);
async function expectedSourceIdentity(provenance, supplied) {
  if (supplied === undefined) return;
  const record = typeof supplied === 'string' ? await readJson(resolve(supplied)) : supplied;
  // The prepare API returns {provenance}; its CLI and frozen manifests expose
  // the same identity at the top level. Extra execution/status fields are not identity.
  const expected = record?.provenance ?? record;
  if (!validSourceIdentity(expected) || !validSourceIdentity(expected.nativeSourceExtension)) throw new Error('Invalid expected frozen source identity.');
  if (fingerprint(sourceIdentity(provenance)) !== fingerprint(sourceIdentity(expected))
    || fingerprint(sourceIdentity(provenance.nativeSourceExtension)) !== fingerprint(sourceIdentity(expected.nativeSourceExtension))) {
    throw new Error('Prepared source provenance does not match the expected frozen source identity; no build started. Prepare or replay the correct source cohort before building.');
  }
  const hashes = [record.sourceSha256, record.build?.sourceSha256].filter(value => value !== undefined);
  if (hashes.some(value => !/^[a-f0-9]{64}$/.test(value)) || new Set(hashes).size > 1) throw new Error('Invalid expected frozen source hash.');
  return hashes[0];
}

/** Resolve an installed pnpm once, then run it with this exact Node executable. */
export async function pnpmToolchain(source, execute = run, settings = {}) {
  const command = settings.command ?? process.env.PNPM_COMMAND;
  const candidates = [];
  if (command) candidates.push(command.includes('/') ? resolve(command) : execute('which', [command]).trim());
  else {
    candidates.push(join(source, 'node_modules/.bin/pnpm'));
    try { candidates.push(execute('which', ['pnpm']).trim()); } catch { /* not installed on PATH */ }
    // npm exec can require registry metadata even with its package installed.
    // Reuse its bounded, local package cache directly; never install a tool as
    // a side effect of a build or start an npm wrapper for every compiler/pack.
    const cache = settings.cache ?? process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? join(homedir(), '.npm');
    let entries = [];
    try { entries = await readdir(join(cache, '_npx'), { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 64)) {
      candidates.push(join(cache, '_npx', entry.name, 'node_modules/pnpm/bin/pnpm.mjs'));
    }
  }
  for (const candidate of candidates) {
    let executable, metadata;
    try {
      executable = await realpath(candidate);
      metadata = await readJson(join(dirname(executable), '../package.json'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadata?.name !== 'pnpm' || metadata.version !== '11.28.5' || executable !== resolve(dirname(executable), '..', metadata.bin?.pnpm ?? '')) {
      if (command) throw new Error('PNPM_COMMAND must point to the installed pnpm 11.28.5 package executable.');
      continue;
    }
    const invoke = (args, cwd = source, timeout = 180_000) => execute(process.execPath,
      [executable, '--config.verify-deps-before-run=false', ...args], { cwd, timeout });
    const version = invoke(['--version']).trim();
    if (version !== '11.28.5') throw new Error(`Expected pnpm 11.28.5, got ${version}.`);
    const packageFiles = await snapshot(resolve(dirname(executable), '..'), ['package.json', 'bin', 'dist']);
    if (!completeSnapshot(packageFiles)) throw new Error('The installed pnpm package is incomplete.');
    return { invoke, identity: { ...environmentIdentity(executable, version, digest(await readFile(executable))),
      packageSha256: fingerprint(packageFiles), nodeSha256: digest(await readFile(process.execPath)),
      nodeOptions: process.env.NODE_OPTIONS ?? '', verifyDepsBeforeRun: false } };
  }
  throw new Error('No installed pnpm 11.28.5 package was found locally. Set PNPM_COMMAND to its executable.');
}
/** Group source inputs by their nearest package and derive dependency signatures. */
export async function workspace(source, files) {
  const roots = files.filter(item => /^(?:vendor\/[^/]+|packages\/[^/]+\/[^/]+|native\/system(?:\/packages\/[^/]+)?|apps\/[^/]+|website|benchmarks|python\/sdk-runtime)\/package\.json$/.test(item.path)).map(item => dirname(item.path)).sort((a, b) => b.length - a.length);
  const metadata = new Map(await Promise.all(roots.map(async path => [path, JSON.parse(await readFile(join(source, path, 'package.json'), 'utf8'))])));
  const byName = new Map([...metadata].map(([path, value]) => [value.name, path]));
  const graph = new Map();
  for (const [path, value] of metadata) {
    const dependencies = new Set(Object.keys({ ...value.dependencies, ...value.devDependencies, ...value.peerDependencies, ...value.optionalDependencies }).map(name => byName.get(name)).filter(Boolean));
    for (const item of files.filter(item => dirname(item.path) === path && /\/tsconfig[^/]*\.json$/.test(item.path))) {
      const config = jsonConfig(await readFile(join(source, item.path), 'utf8'));
      for (const reference of config.references ?? []) {
        const target = resolve(source, path, reference.path);
        const match = roots.find(root => target === join(source, root) || target.startsWith(`${join(source, root)}/`));
        if (match) dependencies.add(match);
      }
    }
    graph.set(path, dependencies);
  }
  const owner = file => roots.find(root => file.startsWith(`${root}/`));
  const global = [], byRoot = new Map(roots.map(root => [root, []]));
  for (const file of files) {
    const root = owner(file.path);
    if (root === undefined) global.push(file);
    else byRoot.get(root).push(file);
  }
  const own = new Map([...byRoot].map(([root, entries]) => [root, fingerprint(entries)]));
  function closure(root, seen = new Set()) {
    if (seen.has(root)) return seen;
    seen.add(root); for (const next of graph.get(root) ?? []) closure(next, seen);
    return seen;
  }
  return { roots, metadata, signatures: Object.fromEntries(roots.map(root => [root, fingerprint({ global, dependencies: [...closure(root)].sort().map(path => [path, own.get(path)]) })])) };
}
async function outputPaths(source, roots, kind) {
  const paths = [];
  for (const root of roots) {
    let entries; try { entries = await readdir(join(source, root, 'lib'), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) if (kind === 'typert' ? entry.name.startsWith('typert.') : entry.name === 'types' || entry.name.endsWith('.tsbuildinfo')) paths.push(`${root}/lib/${entry.name}`);
  }
  return paths;
}
async function dependencyEnvironment(source, inputs, roots, invoke, cache) {
  const key = fingerprint(inputs), file = join(cache, `${key}.json`);
  return withLock(join(cache, `${key}.lock`), async lock => {
    const local = await readJson(join(source, '.hhpi-dependencies.json'));
    const validatedLocal = local?.input === key && await validateDependencySnapshot(source, local.outputs);
    if (validatedLocal) {
      if (validatedLocal.migrated) {
        const record = { ...local, snapshotVersion: 2, outputs: validatedLocal.outputs };
        await writeJson(join(source, '.hhpi-dependencies.json'), record); await writeJson(file, record);
      }
      return { key, outputs: validatedLocal.outputs, reused: true };
    }
    const shared = await readJson(file);
    const validatedShared = shared?.source !== source && shared?.input === key && await validateDependencySnapshot(shared.source, shared.outputs);
    if (validatedShared) {
      for (const path of shared.roots) {
        await rm(join(source, path), { recursive: true, force: true });
        await cp(join(shared.source, path), join(source, path), { recursive: true, verbatimSymlinks: true });
      }
      // pnpm's normal workspace links are relative. The comparison rejects
      // unsafe absolute links before using a copied environment.
      if (await validateDependencySnapshot(source, validatedShared.outputs)) {
        await writeJson(join(source, '.hhpi-dependencies.json'), { ...shared, source, snapshotVersion: 2, outputs: validatedShared.outputs });
        return { key, outputs: validatedShared.outputs, reused: true, copied: true };
      }
    }
    const failure = await readJson(`${file}.failed.json`);
    if (failure?.input === key && lock.waitedFor.has(failure.token)) throw new Error('Pinned dependency installation failed in the execution this request waited for. Inspect the previous diagnostic.');
    console.log('Installing the exact upstream lockfile with lifecycle scripts disabled.');
    try { log(invoke(['install', '--frozen-lockfile', '--ignore-scripts'], source, 300_000)); }
    catch (error) { await writeJson(`${file}.failed.json`, { input: key, token: lock.token, stage: 'dependency-install', failed: true }); throw error; }
    const dependencyRoots = ['node_modules', ...roots.map(path => `${path}/node_modules`)];
    const existing = [];
    for (const path of dependencyRoots) { try { await readdir(join(source, path)); existing.push(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const outputs = await dependencySnapshot(source, existing);
    if (!existing.includes('node_modules') || !completeSnapshot(outputs) || outputs.length < 2) throw new Error('The dependency install produced no validated environment.');
    const record = { input: key, source, roots: existing, snapshotVersion: 2, outputs };
    await writeJson(join(source, '.hhpi-dependencies.json'), record); await writeJson(file, record);
    await rm(`${file}.failed.json`, { force: true });
    return { key, outputs, reused: false };
  });
}

export async function buildExtension(source, output = join(ROOT, '.tmp/hhpi-ext/packages'), options = {}) {
  source = await realpath(source); output = resolve(output);
  return withLock(join(source, '.hhpi-build.lock'), lock => withLock(`${output}.lock`, async () => {
    const started = performance.now(), cache = join(source, '.hhpi-build-cache'), stateFile = join(cache, 'state.json');
    const state = await readJson(stateFile) ?? { bundles: {}, packs: {} };
    state.bundles ??= {}; state.packs ??= {};
    const save = () => writeJson(stateFile, state);
    const rootManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (rootManifest.packageManager !== 'pnpm@11.28.5') throw new Error('The pinned upstream package manager changed.');
    const provenance = await readJson(join(source, 'hhpi-source-inputs.json'));
    if (provenance?.upstreamCommit !== UPSTREAM_COMMIT || provenance?.upstreamVersion !== UPSTREAM_VERSION || provenance.patchSetSha256 !== fingerprint(provenance.inputs)) throw new Error('Invalid prepared source provenance.');
    const expectedHash = await expectedSourceIdentity(provenance, options.expectedSource);
    if ((options.run ?? run)('git', ['rev-parse', 'HEAD'], { cwd: source }).trim() !== UPSTREAM_COMMIT) throw new Error('The DSH checkout does not match the pinned source revision.');
    const files = await sourceSnapshot(source), sourceSha256 = fingerprint(files);
    if (expectedHash && expectedHash !== sourceSha256) throw new Error('Prepared source contents do not match the expected frozen source hash; no build started.');
    const graph = await workspace(source, files);
    for (const path of [...EXTENSION_PACKAGES, ...INLINE_RUNTIME_PACKAGES]) if (!graph.metadata.has(path)) throw new Error(`Missing source package: ${path}`);
    const tools = options.toolchain ? { identity: options.toolchain, invoke: options.pnpm } : await pnpmToolchain(source, options.run ?? run);
    const recipe = fingerprint(await snapshot(ROOT, ['scripts/dsh-ext/build-extension.mjs', 'scripts/dsh-ext/cache.mjs', 'scripts/dsh-ext/prepare.mjs']));
    const dependencyFiles = files.filter(item => /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|pnpmfile\.[cm]?js)$/.test(item.path));
    const attemptInput = fingerprint({ sourceSha256, dependencyFiles, toolchain: tools.identity, recipe });
    if (state.lastAttempt?.input === attemptInput && state.lastAttempt.status === 'failed' && lock.waitedFor.has(state.lastAttempt.token)) throw new Error('DSH build failed in the execution this request waited for. Inspect the previous diagnostic.');
    state.lastAttempt = { input: attemptInput, token: lock.token, status: 'running' }; await save();
    try {
    const dependencies = await dependencyEnvironment(source, { files: dependencyFiles, toolchain: tools.identity }, graph.roots, tools.invoke, options.dependencyCache ?? join(dirname(source), '.hhpi-dependencies'));
    const environment = fingerprint({ recipe, toolchain: tools.identity, input: dependencies.key, outputs: dependencies.outputs });
    const counts = { dependencyInstall: Number(!dependencies.reused), dependencyCopy: Number(Boolean(dependencies.copied)), typert: 0, typecheck: 0, bundles: 0, packs: 0 };
    const contractFiles = files.filter(item => /\.(?:[cm]?tsx?|json)$/.test(item.path));
    const generation = fingerprint({ environment, contractFiles });
    if (state.generation?.input !== generation || !await matchesSnapshot(source, state.generation.outputs)) {
      log(tools.invoke(['exec', 'tsx', 'scripts/generate-typert.ts'], source, 180_000)); counts.typert++;
      const outputs = await snapshot(source, await outputPaths(source, graph.roots, 'typert'));
      if (!completeSnapshot(outputs)) throw new Error('Typert generation produced no contracts.');
      state.generation = { input: generation, outputs }; await save();
    }
    const typesInput = fingerprint({ environment, files: contractFiles, generated: state.generation.outputs });
    const validTypes = state.types && await matchesSnapshot(source, state.types.outputs);
    if (state.types?.input !== typesInput || !validTypes) {
      const affected = EXTENSION_PACKAGES.filter(path => state.signatures?.[path] !== graph.signatures[path]);
      const targets = affected.length && validTypes && state.environment === environment ? affected : EXTENSION_PACKAGES;
      const previousFiles = new Map((state.types?.files ?? []).map(item => [item.path, item.sha256]));
      const changedFiles = contractFiles.filter(item => previousFiles.get(item.path) !== item.sha256);
      const deletedFiles = [...previousFiles.keys()].some(path => !contractFiles.some(item => item.path === path));
      const oldTimestamp = (await Promise.all(changedFiles.map(async item => (await stat(join(source, item.path))).mtimeMs <= (state.types?.completedAtMs ?? 0)))).some(Boolean);
      // Ordinary edits retain upstream tsc -b incremental state. Missing or
      // corrupt output, changed tools, and content edits hiding behind an old
      // timestamp explicitly invalidate the selected reference closure.
      const force = !validTypes || state.environment !== environment || deletedFiles || oldTimestamp;
      log(tools.invoke(['exec', 'tsc', '-b', ...(force ? ['--force'] : []), ...targets.map(path => `${path}/tsconfig.json`)], source, 300_000)); counts.typecheck++;
      const outputs = await snapshot(source, await outputPaths(source, graph.roots, 'types'));
      if (!completeSnapshot(outputs) || !EXTENSION_PACKAGES.every(path => outputs.some(item => item.path.startsWith(`${path}/lib/types/`)))) throw new Error('TypeScript compilation produced incomplete extension declarations.');
      state.types = { input: typesInput, outputs, files: contractFiles, completedAtMs: Date.now() }; await save();
    }
    await mkdir(output, { recursive: true });
    const expectedArchives = new Set(EXTENSION_PACKAGES.map(path => archiveName(graph.metadata.get(path))));
    if ((await readdir(output)).some(name => name.endsWith('.tgz') && !expectedArchives.has(name))) throw new Error('Unknown archives in extension output; mixed builds are not accepted.');
    const packageIdentities = {}, packages = [];
    for (const path of [...INLINE_RUNTIME_PACKAGES, ...EXTENSION_PACKAGES]) {
      const cwd = join(source, path), input = fingerprint({ environment, source: graph.signatures[path], generated: state.generation.outputs });
      const previous = state.bundles[path];
      if (previous?.input !== input || !await matchesSnapshot(source, previous.outputs)) {
        const oneFile = INLINE_RUNTIME_PACKAGES.includes(path) || path === 'packages/session/session-persistence' || path === 'packages/experimental/translator' || FILESYSTEM_EXTENSION_PACKAGES.includes(path);
        log(tools.invoke(oneFile ? ['exec', 'tsdown', 'lib/types/index.js', '--no-config', '--out-dir', 'lib', '--format', 'esm', '--platform', 'node', '--target', 'es2024', '--no-dts', '--no-clean', '--logLevel', 'error'] : ['exec', 'tsdown', '--config-loader', 'native'], cwd, 180_000));
        if (oneFile) await rename(join(cwd, 'lib/index.mjs'), join(cwd, 'lib/index.js'));
        const outputs = await snapshot(source, [`${path}/lib`]);
        if (!completeSnapshot(outputs) || !outputs.some(item => item.path === `${path}/lib/index.js`)) throw new Error(`Missing built package entrypoint: ${path}`);
        state.bundles[path] = { input, outputs }; counts.bundles++; await save();
      }
      if (!EXTENSION_PACKAGES.includes(path)) continue;
      const metadata = graph.metadata.get(path);
      const original = NATIVE_EXTENSION_PACKAGES.includes(path) ? provenance.nativeSourceExtension : provenance;
      metadata.hhpiSourceExtension = { upstreamCommit: original.upstreamCommit, upstreamVersion: original.upstreamVersion, patchSetSha256: original.patchSetSha256 };
      await writeJson(join(cwd, 'package.json'), metadata);
      try {
        const client = await readFile(join(cwd, 'lib/client.js'), 'utf8');
        const unresolved = MISSING_CLIENT_EXTERNALS.filter(name => client.includes(`require(${JSON.stringify(name)})`));
        if (unresolved.length) throw new Error(`${path} left browser-only dependencies in the module table: ${unresolved.join(', ')}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const packInput = fingerprint({ input, outputs: state.bundles[path].outputs, metadata, source: graph.signatures[path] });
      const packDirectory = join(cache, 'packages', packInput), file = archiveName(metadata);
      let packed = state.packs[path];
      if (packed?.input !== packInput || !await matchesSnapshot(packDirectory, packed.outputs)) {
        await mkdir(packDirectory, { recursive: true });
        log(tools.invoke(['pack', '--pack-destination', packDirectory], cwd, 180_000)); counts.packs++;
        const outputs = await snapshot(packDirectory, [file]);
        if (!completeSnapshot(outputs)) throw new Error(`Missing packed extension: ${path}`);
        packed = { input: packInput, outputs }; state.packs[path] = packed; await save();
      }
      const bytes = await readFile(join(packDirectory, file));
      const entry = { file, bytes: bytes.length, sha256: digest(bytes) };
      let current; try { current = await readFile(join(output, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!current || digest(current) !== entry.sha256) {
        await rm(join(output, 'manifest.json'), { force: true });
        await cp(join(packDirectory, file), join(output, file));
      }
      packages.push(entry); packageIdentities[metadata.name] = metadata.hhpiSourceExtension;
    }
    if (fingerprint(await sourceSnapshot(source)) !== sourceSha256) {
      await rm(join(output, 'manifest.json'), { force: true });
      throw new Error('DSH source inputs changed during the build; no complete manifest was published. Rerun against stable inputs.');
    }
    const manifest = { ...provenance, packageIdentities, packages: packages.sort((a, b) => a.file.localeCompare(b.file)), build: { sourceSha256, dependencySha256: fingerprint(dependencies.outputs), dependencyInputsSha256: dependencies.key, toolchain: tools.identity, recipeSha256: recipe } };
    await writeJson(join(output, 'manifest.json'), manifest);
    await verifyExtensionSet(output);
    state.signatures = graph.signatures; state.environment = environment; state.lastAttempt.status = 'passed'; await save();
    return { output, packages: manifest.packages, counts, elapsedMs: Math.round(performance.now() - started), reused: Object.values(counts).every(count => count === 0) };
    } catch (error) { state.lastAttempt.status = 'failed'; await save(); throw error; }
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), flags = args.filter(value => value === '--expected-source').length;
  let expectedSource;
  if (flags) {
    const index = args.indexOf('--expected-source');
    if (flags !== 1 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--expected-source requires one frozen source JSON file.');
    expectedSource = args[index + 1]; args.splice(index, 2);
  }
  if (!args[0] || args.length > 2 || args.some(value => value.startsWith('--'))) throw new Error('Usage: build-extension.mjs PREPARED_SOURCE [OUTPUT] [--expected-source FROZEN_SOURCE_JSON]');
  console.log(JSON.stringify(await buildExtension(args[0], args[1], { expectedSource })));
}
