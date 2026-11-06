/** Build the approved Chat source and retain every other package from a complete release. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './prepare.mjs';
import { packageSetSha256 } from '../bundle/lib/manifest.mjs';
const [sourceArg, previousArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !previousArg || !outputArg) throw Error('Usage: build-chat-release.mjs prepared-source previous-release fresh-output');
const source = resolve(sourceArg), previous = resolve(previousArg), output = resolve(outputArg);
await mkdir(output);
await cp(previous, output, { recursive: true });
const release = JSON.parse(await readFile(join(previous, 'release.json'), 'utf8'));
const files = [
  'packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx',
  'packages/client/ui-chat/src/client/presentation-policy.ts',
  'packages/client/ui-chat/tests/chat-view.client.spec.tsx',
  'packages/client/ui-chat/README.md',
  'packages/client/ui-chat/README.zh.md',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = [{ path: 'previous-release.json', sha256: digest(await readFile(join(previous, 'release.json'))) }];
for (const path of files) inputs.push({ path, sha256: digest(await readFile(join(source, path))) });
const patchSetSha256 = digest(JSON.stringify(inputs));
const identity = { upstreamCommit: release.upstreamCommit, upstreamVersion: release.upstreamVersion, patchSetSha256 };
const pnpm = process.env.PNPM_COMMAND ?? 'pnpm';
if (run(pnpm, ['--config.managePackageManagerVersions=false', '--version']).trim() !== '11.28.5') throw Error('Use the pinned pnpm 11.28.5 to build this release.');
const pkg = join(source, 'packages/client/ui-chat');
const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
metadata.hhpiSourceExtension = identity;
await writeFile(join(pkg, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(run(join(source, 'node_modules/.bin/tsc'), ['-b', 'packages/client/ui-chat/tsconfig.json'], { cwd: source }));
console.log(run(join(source, 'node_modules/.bin/tsdown'), ['--config-loader', 'native'], { cwd: pkg }));
console.log(run(pnpm, ['--config.verifyDepsBeforeRun=false', '--config.managePackageManagerVersions=false', '--config.ignoreScripts=true', 'pack', '--pack-destination', output], { cwd: pkg }));
const archive = 'source/live-process-chat-source.tgz';
console.log(run('tar', ['--exclude=lib', '--exclude=node_modules', '-czf', join(output, archive), '-C', source, 'packages/client/ui-chat']));
await cp(join(previous, 'release.json'), join(output, 'source/previous-release.json'));
await writeFile(join(output, 'source/live-process-inputs.json'), `${JSON.stringify({ ...identity, inputs }, null, 2)}\n`);
for (const [from, to] of [
  ['scripts/dsh-ext/live-process-expansion.mjs', 'source/live-process-expansion.mjs.txt'],
  ['source-snapshots/dsh-ext/live-process-expansion.test.txt', 'source/live-process-expansion.test.txt'],
  ['docs/adr/hhpi-live-process-expansion.md', 'source/hhpi-live-process-expansion.md'],
  ['docs/upstream-pr-live-process-expansion.md', 'source/upstream-pr-live-process-expansion.md'],
]) { await cp(from, join(output, to)); release.sourceOffer.push(to); }
release.sourceOffer.push(archive, 'source/previous-release.json', 'source/live-process-inputs.json');
release.extRelease = 'hhpi-live-process-20261106.1';
release.compositionVersion = `${release.upstreamVersion}+hhpi.liveprocess.20261106.1`;
release.patchSetSha256 = patchSetSha256;
const packages = [];
for (const item of release.packages) {
  const bytes = await readFile(join(output, item.tarball));
  packages.push({ ...item, sha256: digest(bytes) });
}
release.packageSetSha256 = packageSetSha256(packages);
await writeFile(join(output, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(JSON.stringify({ output, extRelease: release.extRelease, packages: packages.length, identity }));
