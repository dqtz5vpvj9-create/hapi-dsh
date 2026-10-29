/** Install one complete, verified source-built extension set into a development checkout. */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, run, UPSTREAM_COMMIT, UPSTREAM_VERSION } from './prepare.mjs';

export const EXTENSION_NAMES = Object.freeze([
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-chat',
]);
const digest = value => createHash('sha256').update(value).digest('hex');
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
    const identity = metadata.hhpiSourceExtension;
    if (metadata.name !== expected.get(item.file) || metadata.version !== UPSTREAM_VERSION || !identity
      || identity.upstreamCommit !== UPSTREAM_COMMIT || identity.upstreamVersion !== UPSTREAM_VERSION
      || identity.patchSetSha256 !== manifest.patchSetSha256) throw new Error(`Mixed or unmarked source extension: ${item.file}`);
    packages.push({ ...item, path, name: metadata.name });
  }
  return { manifest, packages };
}

export async function installExtensionSet(directory, target = ROOT) {
  target = await realpath(target);
  const { manifest, packages } = await verifyExtensionSet(directory);
  const project = join(target, 'package.json'), lock = join(target, 'package-lock.json');
  const before = await Promise.all([readFile(project), readFile(lock)]);
  // Existing exact dependencies remain the bootstrap lock. The separately hashed
  // source build is explicit; npm ci restores the unextended upstream baseline.
  console.log(run('npm', ['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', ...packages.map(item => item.path)], { cwd: target, timeout: 180_000 }));
  const after = await Promise.all([readFile(project), readFile(lock)]);
  if (before.some((data, index) => !data.equals(after[index]))) throw new Error('Installing source extensions changed tracked package inputs.');
  for (const item of packages) {
    const installed = JSON.parse(await readFile(join(target, 'node_modules', item.name, 'package.json'), 'utf8'));
    if (installed.name !== item.name || installed.version !== UPSTREAM_VERSION || installed.hhpiSourceExtension?.patchSetSha256 !== manifest.patchSetSha256) throw new Error(`Installed extension identity mismatch: ${item.name}`);
  }
  const report = { upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: UPSTREAM_VERSION, patchSetSha256: manifest.patchSetSha256,
    packages: packages.map(({ name, file, bytes, sha256 }) => ({ name, file, bytes, sha256 })) };
  await mkdir(join(target, '.tmp/hhpi-ext'), { recursive: true });
  await writeFile(join(target, '.tmp/hhpi-ext/installed.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/dsh-ext/install-extension.mjs <package-directory> [checkout]');
  console.log(JSON.stringify(await installExtensionSet(process.argv[2], process.argv[3] ?? ROOT)));
}
