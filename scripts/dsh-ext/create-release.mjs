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
  ['docs/adr/hhpi-terminal-owner.md', 'source/terminal-owner-architecture.md'],
  ['docs/upstream-pr-dsh-terminal-owner.md', 'source/terminal-owner-upstream-pr.md'],
  ['docs/adr/hhpi-filesystem-commit-checkpoint.md', 'source/filesystem-checkpoint-architecture.md'],
  ['docs/upstream-pr-filesystem-commit-checkpoint.md', 'source/filesystem-checkpoint-upstream-pr.md'],
  ['docs/adr/hhpi-structured-references.md', 'source/structured-reference-architecture.md'],
  ['docs/upstream-pr-structured-references.md', 'source/structured-reference-upstream-pr.md'],
  ['docs/adr/hhpi-user-file-slot.md', 'source/user-file-slot-architecture.md'],
  ['docs/upstream-pr-user-file-slot.md', 'source/user-file-slot-upstream-pr.md'],
  ['docs/adr/hhpi-mounted-reader-render-commit.md', 'source/mounted-reader-render-architecture.md'],
  ['docs/upstream-pr-mounted-reader-render-commit.md', 'source/mounted-reader-render-upstream-pr.md'],
  ['docs/adr/hhpi-candidate-group-identity.md', 'source/candidate-group-architecture.md'],
  ['docs/upstream-pr-candidate-group-identity.md', 'source/candidate-group-upstream-pr.md'],
  ['docs/adr/hhpi-short-tail-reading-room.md', 'source/short-tail-room-architecture.md'],
  ['docs/upstream-pr-short-tail-reading-room.md', 'source/short-tail-room-upstream-pr.md'],
  ['docs/adr/hhpi-complete-window-dependency-prefix.md', 'source/dependency-prefix-architecture.md'],
  ['docs/upstream-pr-complete-window-dependency-prefix.md', 'source/dependency-prefix-upstream-pr.md'],
  ['docs/adr/hhpi-navigator-owner-style.md', 'source/navigator-owner-architecture.md'],
  ['docs/upstream-pr-navigator-owner-style.md', 'source/navigator-owner-upstream-pr.md'],
  ['docs/adr/hhpi-interior-reading-range.md', 'source/interior-reading-range-architecture.md'],
  ['docs/upstream-pr-interior-reading-range.md', 'source/interior-reading-range-upstream-pr.md'],
  ['docs/adr/hhpi-single-window-correction.md', 'source/single-window-correction-architecture.md'],
  ['docs/upstream-pr-single-window-correction.md', 'source/single-window-correction-upstream-pr.md'],
  ['docs/adr/hhpi-text-interaction-area-selection.md', 'source/text-interaction-area-selection-architecture.md'],
  ['docs/upstream-pr-text-interaction-area-selection.md', 'source/text-interaction-area-selection-upstream-pr.md'],
  ['docs/adr/hhpi-measured-virtual-layout.md', 'source/measured-virtual-layout-architecture.md'],
  ['docs/upstream-pr-measured-virtual-layout.md', 'source/measured-virtual-layout-upstream-pr.md'],
  ['docs/adr/hhpi-batched-virtual-row-measurement.md', 'source/batched-virtual-row-measurement-architecture.md'],
  ['docs/upstream-pr-batched-virtual-row-measurement.md', 'source/batched-virtual-row-measurement-upstream-pr.md'],
  ['docs/adr/hhpi-incremental-window-preparation.md', 'source/incremental-window-preparation-architecture.md'],
  ['docs/upstream-pr-incremental-window-preparation.md', 'source/incremental-window-preparation-upstream-pr.md'],
  ['docs/adr/hhpi-workspace-navigation-ownership.md', 'source/workspace-navigation-ownership-architecture.md'],
  ['docs/upstream-pr-workspace-navigation-ownership.md', 'source/workspace-navigation-ownership-upstream-pr.md'],
  ['source-snapshots/dsh-ext/adr/0004.md', 'source/programmatic-live-edge-architecture.md'],
  ['source-snapshots/dsh-ext/upstream-pr/0004.md', 'source/programmatic-live-edge-upstream-pr.md'],
  ['docs/adr/hhpi-input-ack-draft-revision.md', 'source/input-ack-draft-revision-architecture.md'],
  ['docs/upstream-pr-input-ack-draft-revision.md', 'source/input-ack-draft-revision-upstream-pr.md'],
  ['docs/adr/hhpi-focused-control-modality.md', 'source/focused-control-modality-architecture.md'],
  ['docs/upstream-pr-focused-control-modality.md', 'source/focused-control-modality-upstream-pr.md'],
  ['docs/adr/hhpi-registry-publication-recovery.md', 'source/registry-publication-recovery-architecture.md'],
  ['docs/upstream-pr-registry-publication-recovery.md', 'source/registry-publication-recovery-upstream-pr.md'],
  ['docs/adr/hhpi-root-registration-recovery.md', 'source/root-registration-recovery-architecture.md'],
  ['docs/upstream-pr-root-registration-recovery.md', 'source/root-registration-recovery-upstream-pr.md'],
  ['docs/adr/hhpi-public-history-complete-window.md', 'source/public-history-complete-window-architecture.md'],
  ['docs/upstream-pr-public-history-complete-window.md', 'source/public-history-complete-window-upstream-pr.md'],
  ['docs/adr/hhpi-native-queued-input.md', 'source/native-queued-input-architecture.md'],
  ['docs/upstream-pr-native-queue-actions.md', 'source/native-queue-actions-upstream-pr.md'],
  ['scripts/dsh-ext/prepare.mjs', 'source/prepare.mjs.txt'],
  ['scripts/dsh-ext/build-extension.mjs', 'source/build-extension.mjs.txt'],
  ['scripts/dsh-ext/cache.mjs', 'source/cache.mjs.txt'],
  ['scripts/dsh-ext/install-extension.mjs', 'source/install-extension.mjs.txt'],
  ['scripts/dsh-ext/create-release.mjs', 'source/create-release.mjs.txt'],
]) { await cp(join(ROOT, from), join(output, to)); sourceOffer.push(to); }
await writeFile(join(output, 'source/inputs.json'), `${JSON.stringify(manifest, null, 2)}\n`);
sourceOffer.push('source/inputs.json', 'source/packages-source.tgz');
run('tar', ['--exclude=lib', '--exclude=node_modules', '-czf', join(output, 'source/packages-source.tgz'), '-C', source,
  ...EXTENSION_PACKAGES, 'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'tsdown.config.ts', 'scripts/generate-typert.ts']);
const packages = built.map(({ name, file, sha256 }) => ({ name, version: UPSTREAM_VERSION, tarball: file, sha256 }));
const release = {
  upstreamVersion: manifest.upstreamVersion, upstreamCommit: manifest.upstreamCommit,
  extRelease: 'hhpi-dsh-022-20261107.27', patchSetSha256: manifest.patchSetSha256,
  packageSetSha256: packageSetSha256(packages), compositionVersion: `${UPSTREAM_VERSION}+hhpi.20261107.27`,
  protocol: 2, capabilities: { historySource: 1, mountedChat: 1, windowCommit: 1 },
  packages, sourceOffer, licenses: ['licenses/DSH-MIT.txt'],
};
await writeFile(join(output, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(JSON.stringify({ output, packages: packages.length, extRelease: release.extRelease }));
