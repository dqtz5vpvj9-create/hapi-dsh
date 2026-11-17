/** Build the official shell from the same source as its dynamic UI extensions.
 * The published npm shell embeds platform modules (including SlotCore); merely
 * overriding their npm packages cannot update that already compiled seed.
 */
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { sourceSnapshot, run } from './prepare.mjs';
import { fingerprint } from './cache.mjs';
import { createTgzFromDirectory } from '../bundle/lib/tar.mjs';
import { packageSetSha256 } from '../bundle/lib/manifest.mjs';

const [sourceArg, sdkArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !sdkArg || !outputArg) throw Error('Usage: build-web-shell.mjs PREPARED_SOURCE SDK_RELEASE FRESH_OUTPUT');
const source = resolve(sourceArg), sdk = resolve(sdkArg), output = resolve(outputArg);
const release = JSON.parse(await readFile(join(sdk, 'release.json'), 'utf8'));
const provenance = JSON.parse(await readFile(join(source, 'hhpi-source-inputs.json'), 'utf8'));
if (release.upstreamCommit !== provenance.upstreamCommit || release.patchSetSha256 !== provenance.patchSetSha256) {
    throw Error('The shell and UI extensions must use the same source revision and patches.');
}
const sourceSha256 = fingerprint(await sourceSnapshot(source));
await mkdir(output);
const app = join(source, 'apps/web'), appRequire = createRequire(join(app, 'package.json'));
const rootRequire = createRequire(join(source, 'package.json'));
const { build, loadConfigFromFile } = await import(pathToFileURL(appRequire.resolve('vite')).href);
const { default: sourcePaths } = await import(pathToFileURL(rootRequire.resolve('vite-tsconfig-paths')).href);
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(app, 'vite.config.ts'));
if (!loaded) throw Error('The official Web build configuration was not found.');
const config = loaded.config;
// Build the served product, not the independent browser-worker preview. The
// original theme, assets, build defines and product isolation checks remain.
config.plugins = config.plugins.filter(plugin => plugin.name !== 'dsh-emit-preview-page');
config.plugins.unshift(sourcePaths({ projects: [join(source, 'tsconfig.base.json')] }));
config.build.rollupOptions.input = { index: join(app, 'index.html') };
const staging = join(output, 'web-shell-package');
config.build.outDir = join(staging, 'dist');
await build({ ...config, root: app, configFile: false });
if (fingerprint(await sourceSnapshot(source)) !== sourceSha256) throw Error('Source changed while building the Web shell.');
const metadata = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
if (metadata.version !== release.upstreamVersion) throw Error('Web shell version does not match the SDK.');
metadata.hhpiSourceExtension = { upstreamVersion: release.upstreamVersion, upstreamCommit: release.upstreamCommit,
    patchSetSha256: release.patchSetSha256, sourceSha256 };
await writeFile(join(staging, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
await cp(join(source, 'LICENSE'), join(staging, 'LICENSE'));
const tarball = `deepseek-ai-dsh-web-frontend-${metadata.version}.tgz`;
const bytes = await createTgzFromDirectory(staging, { prefix: 'package' });
await cp(sdk, output, { recursive: true });
await writeFile(join(output, tarball), bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
release.packages = [...release.packages.filter(item => item.name !== metadata.name), { name: metadata.name, version: metadata.version, tarball, sha256 }];
release.packageSetSha256 = packageSetSha256(release.packages);
release.extRelease += '-web-shell';
release.compositionVersion += '.web-shell';
await mkdir(join(output, 'source'), { recursive: true });
await cp(new URL(import.meta.url), join(output, 'source/build-web-shell.mjs.txt'));
// Existing source.patch and packages-source.tgz contain the modified UI. These
// additional inputs preserve the shell/seed and its unmodified framework code.
run('tar', ['--exclude=node_modules', '--exclude=lib', '--exclude=dist', '-czf', join(output, 'source/web-shell-source.tgz'), '-C', source,
    'apps/web', 'packages/client/web', 'packages/client/store', 'packages/client/ui-dockkit', 'packages/client/ui-primitives',
    'vendor', 'scripts/client-build-environment.ts', 'scripts/bundle-input-isolation.ts', 'scripts/experimental-package-policy.ts',
    'tsconfig.base.json', 'package.json', 'pnpm-lock.yaml']);
await writeFile(join(output, 'source/web-shell-build.json'), JSON.stringify({ sourceSha256, upstreamCommit: release.upstreamCommit,
    node: process.version, vite: JSON.parse(await readFile(appRequire.resolve('vite/package.json'), 'utf8')).version, sha256 }, null, 2) + '\n');
release.sourceOffer = [...release.sourceOffer, 'source/build-web-shell.mjs.txt', 'source/web-shell-source.tgz', 'source/web-shell-build.json'];
await writeFile(join(output, 'release.json'), JSON.stringify(release, null, 2) + '\n');
console.log(JSON.stringify({ output, sha256, sourceSha256, packages: release.packages.length }));
