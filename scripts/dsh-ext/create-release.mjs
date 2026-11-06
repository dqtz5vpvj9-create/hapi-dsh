/** Assemble one complete source-built rc release, including its corresponding source. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT, run, UPSTREAM_VERSION, EXTENSION_PACKAGES } from './prepare.mjs';
import { verifyExtensionSet } from './install-extension.mjs';
import { packageSetSha256 } from '../bundle/lib/manifest.mjs';
const [sourceArg, packagesArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !packagesArg || !outputArg) throw Error('Usage: create-release.mjs prepared-source package-directory fresh-output');
const source = resolve(sourceArg), output = resolve(outputArg);
const { manifest, packages: built } = await verifyExtensionSet(packagesArg);
await mkdir(output);
for (const item of built) await cp(item.path, join(output, item.file));
await mkdir(join(output, 'source'));
await mkdir(join(output, 'licenses'));
await cp(join(source, 'LICENSE'), join(output, 'licenses/DSH-MIT.txt'));
const sourceOffer = [];
for (const [from, to] of [
  ['source-snapshots/dsh-ext/source.patch', 'source/source.patch'],
  ['docs/adr/hhpi-dsh-022-upgrade.md', 'source/architecture.md'],
  ['docs/upstream-pr-dsh-022-upload-provider.md', 'source/upstream-pr.md'],
  ['scripts/dsh-ext/prepare.mjs', 'source/prepare.mjs.txt'],
  ['scripts/dsh-ext/build-extension.mjs', 'source/build-extension.mjs.txt'],
  ['scripts/dsh-ext/create-release.mjs', 'source/create-release.mjs.txt'],
]) { await cp(join(ROOT, from), join(output, to)); sourceOffer.push(to); }
await writeFile(join(output, 'source/inputs.json'), `${JSON.stringify(manifest, null, 2)}\n`);
sourceOffer.push('source/inputs.json', 'source/packages-source.tgz');
run('tar', ['--exclude=lib', '--exclude=node_modules', '-czf', join(output, 'source/packages-source.tgz'), '-C', source,
  ...EXTENSION_PACKAGES, 'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'tsdown.config.ts', 'scripts/generate-typert.ts']);
const packages = built.map(({ name, file, sha256 }) => ({ name, version: UPSTREAM_VERSION, tarball: file, sha256 }));
const release = {
  upstreamVersion: manifest.upstreamVersion, upstreamCommit: manifest.upstreamCommit,
  extRelease: 'hhpi-dsh-022-20261106.1', patchSetSha256: manifest.patchSetSha256,
  packageSetSha256: packageSetSha256(packages), compositionVersion: `${UPSTREAM_VERSION}+hhpi.20261106.1`,
  protocol: 2, capabilities: { historySource: 1, mountedChat: 1, windowCommit: 1 },
  packages, sourceOffer, licenses: ['licenses/DSH-MIT.txt'],
};
await writeFile(join(output, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(JSON.stringify({ output, packages: packages.length, extRelease: release.extRelease }));
