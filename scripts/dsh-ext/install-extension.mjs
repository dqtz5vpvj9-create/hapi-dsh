/** Install one complete, verified source-built extension set into a development checkout. */
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, run, UPSTREAM_COMMIT, UPSTREAM_VERSION, EXTENSION_PACKAGES, FILESYSTEM_EXTENSION_PACKAGES, NATIVE_EXTENSION_PACKAGES, UI_EXTENSION_PACKAGES } from './prepare.mjs';
import { fingerprint, readJson, snapshot, matchesSnapshot, withLock, writeJson } from './cache.mjs';

export const EXTENSION_NAMES = Object.freeze(EXTENSION_PACKAGES.map(path => `@deepseek-ai/dsh-${NATIVE_EXTENSION_PACKAGES.includes(path) || FILESYSTEM_EXTENSION_PACKAGES.includes(path) ? path.split('/').at(-1) : path.slice('packages/'.length).replaceAll('/', '-')}`));
export const UI_EXTENSION_NAMES = Object.freeze(UI_EXTENSION_PACKAGES.map(path => `@deepseek-ai/dsh-${path.slice('packages/'.length).replaceAll('/', '-')}`));
const digest = value => createHash('sha256').update(value).digest('hex');
export function extensionIdentity(manifest, name) {
  return manifest.packageIdentities?.[name] ?? {
    upstreamCommit: manifest.upstreamCommit, upstreamVersion: manifest.upstreamVersion,
    patchSetSha256: manifest.patchSetSha256,
  };
}
const archiveName = name => `${name.slice(1).replace('/', '-')}-${UPSTREAM_VERSION}.tgz`;

/** Validate all archives before invoking npm; a missing or mixed set installs nothing. */
export async function verifyExtensionSet(directory) {
  directory = await realpath(directory);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.upstreamCommit !== UPSTREAM_COMMIT || manifest.upstreamVersion !== UPSTREAM_VERSION) throw new Error('Wrong pinned DSH source revision.');
  if (!Array.isArray(manifest.inputs) || manifest.patchSetSha256 !== digest(JSON.stringify(manifest.inputs))) throw new Error('Invalid source input fingerprint.');
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== EXTENSION_NAMES.length) throw new Error('A complete extension set is required.');
  const expected = new Map(EXTENSION_NAMES.map(name => [archiveName(name), name]));
  const seen = new Set(), packages = [];
  for (const item of manifest.packages) {
    if (!item || typeof item.file !== 'string' || basename(item.file) !== item.file || !expected.has(item.file) || seen.has(item.file)) throw new Error('Unexpected or duplicate extension archive.');
    seen.add(item.file);
    const path = join(directory, item.file), data = await readFile(path);
    if (data.length !== item.bytes || digest(data) !== item.sha256) throw new Error(`Extension checksum mismatch: ${item.file}`);
    const metadata = JSON.parse(run('tar', ['-xOf', path, 'package/package.json'], { timeout: 10_000 }));
    const identity = metadata.hhpiSourceExtension, expectedIdentity = extensionIdentity(manifest, metadata.name);
    if (metadata.name !== expected.get(item.file) || metadata.version !== UPSTREAM_VERSION || !identity
      || identity.upstreamCommit !== UPSTREAM_COMMIT || identity.upstreamVersion !== UPSTREAM_VERSION
      || expectedIdentity.upstreamCommit !== UPSTREAM_COMMIT || expectedIdentity.upstreamVersion !== UPSTREAM_VERSION
      || identity.patchSetSha256 !== expectedIdentity.patchSetSha256) throw new Error(`Mixed or unmarked source extension: ${item.file}`);
    if (metadata.name === '@deepseek-ai/dsh-session-persistence-jsonl') {
      const entries = new Set(run('tar', ['-tzf', path], { timeout: 10_000 }).split('\n'));
      for (const worker of ['package/lib/worker.cjs', 'package/lib/read-index-worker.mjs']) {
        if (!entries.has(worker)) throw new Error(`Native persistence archive is missing ${worker}.`);
      }
    }
    packages.push({ ...item, path, name: metadata.name, identity });
  }
  return { manifest, packages };
}

export async function installExtensionSet(directory, target = ROOT, options = {}) {
  target = await realpath(target);
  directory = await realpath(directory);
  return withLock(join(target, '.tmp/hhpi-ext/install.lock'), lockAttempt => withLock(`${directory}.lock`, async () => {
  const started = performance.now();
  const { manifest, packages } = await verifyExtensionSet(directory);
  const project = join(target, 'package.json'), lock = join(target, 'package-lock.json');
  const before = await Promise.all([readFile(project), readFile(lock)]);
  const installer = options.toolchain ?? { npm: run('npm', ['--version'], { cwd: target, timeout: 10_000 }).trim(), node: process.version, platform: process.platform, arch: process.arch, recipeSha256: digest(await readFile(fileURLToPath(import.meta.url))) };
  const inputSha256 = fingerprint({ project: digest(before[0]), lock: digest(before[1]), installer, packages: manifest.packages });
  const temporary = await mkdtemp('/mnt/cache/data-cache/hhpi-extension-verify-');
  try {
  // Compare installed files to the archives themselves, including workers and
  // declarations. A marker or an earlier success report is never sufficient.
  const expectedOutputs = [];
  for (const item of packages) {
    const entries = run('tar', ['-tzf', item.path], { timeout: 10_000 }).trim().split('\n');
    if (entries.some(path => !path.startsWith('package/') || path.split('/').includes('..') || path.includes('\\'))) throw new Error(`Unsafe extension archive: ${item.file}`);
    const staging = join(temporary, item.name.slice(1).replace('/', '-'));
    if (run('tar', ['-tvzf', item.path], { timeout: 10_000 }).trim().split('\n').some(line => !['-', 'd'].includes(line[0]))) throw new Error(`Extension archive contains a link or special file: ${item.file}`);
    await mkdir(staging);
    run('tar', ['-xzf', item.path, '-C', staging, '--no-same-owner'], { timeout: 10_000 });
    const outputs = await snapshot(staging, ['package']);
    if (outputs.some(entry => entry.link)) throw new Error(`Extension archive contains a symbolic link: ${item.file}`);
    expectedOutputs.push(...outputs.map(entry => ({ ...entry, path: `node_modules/${item.name}${entry.path.slice('package'.length)}` })));
  }
  const validate = async () => {
    if (!await matchesSnapshot(target, expectedOutputs, { ignoreChildren: ['node_modules'] })) return false;
    for (const item of packages) {
      const installed = JSON.parse(await readFile(join(target, 'node_modules', item.name, 'package.json'), 'utf8'));
      if (installed.name !== item.name || installed.version !== UPSTREAM_VERSION || fingerprint(installed.hhpiSourceExtension) !== fingerprint(item.identity)) return false;
    }
    return true;
  };
  const previous = await readJson(join(target, '.tmp/hhpi-ext/installed.json'));
  const reused = previous?.inputSha256 === inputSha256 && await validate();
  // Existing exact dependencies remain the bootstrap lock. The separately hashed
  // source build is explicit; npm ci restores the unextended upstream baseline.
  const failureFile = join(target, '.tmp/hhpi-ext/install-failure.json');
  if (!reused) {
    const failure = await readJson(failureFile);
    if (failure?.inputSha256 === inputSha256 && lockAttempt.waitedFor.has(failure.token)) throw new Error('Extension installation failed in the execution this request waited for. Inspect the previous diagnostic.');
    try {
      const message = (options.run ?? run)('npm', ['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', ...packages.map(item => item.path)], { cwd: target, timeout: 180_000 });
      if (message?.trim()) console.log(message);
    } catch (error) { await writeJson(failureFile, { inputSha256, token: lockAttempt.token, failed: true }); throw error; }
  }
  const after = await Promise.all([readFile(project), readFile(lock)]);
  if (before.some((data, index) => !data.equals(after[index]))) throw new Error('Installing source extensions changed tracked package inputs.');
  if (!await validate()) throw new Error('Installed extension outputs do not match the verified archives.');
  const report = { upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: UPSTREAM_VERSION, patchSetSha256: manifest.patchSetSha256,
    reused, elapsedMs: Math.round(performance.now() - started), inputSha256, installer, outputsSha256: fingerprint(expectedOutputs),
    packageIdentities: Object.fromEntries(packages.map(({ name, identity }) => [name, identity])),
    packages: packages.map(({ name, file, bytes, sha256 }) => ({ name, file, bytes, sha256 })) };
  await mkdir(join(target, '.tmp/hhpi-ext'), { recursive: true });
  await writeJson(join(target, '.tmp/hhpi-ext/installed.json'), report);
  await rm(failureFile, { force: true });
  return report;
  } finally { await rm(temporary, { recursive: true, force: true }); }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/dsh-ext/install-extension.mjs <package-directory> [checkout]');
  console.log(JSON.stringify(await installExtensionSet(process.argv[2], process.argv[3] ?? ROOT)));
}
