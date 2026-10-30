/** Reproducible source build using the pinned upstream workspace lock and compiler. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXTENSION_PACKAGES, ROOT, run } from './prepare.mjs';
const source = process.argv[2], output = resolve(process.argv[3] ?? join(ROOT, '.tmp/hhpi-ext/packages'));
if (!source) throw new Error('A prepared DSH source directory is required.');
const INLINE_RUNTIME_PACKAGES = [
  'packages/util/brand',
  'packages/util/crypto',
  'packages/util/values',
  'vendor/cosmokit',
];
const MISSING_CLIENT_EXTERNALS = [
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-util-crypto',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/cosmokit',
];
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (manifest.packageManager !== 'pnpm@11.28.5') throw new Error('The pinned upstream package manager changed.');
const provenance = JSON.parse(await readFile(join(source, 'hhpi-source-inputs.json'), 'utf8'));
const identity = { upstreamCommit: provenance.upstreamCommit, upstreamVersion: provenance.upstreamVersion, patchSetSha256: provenance.patchSetSha256 };
const pnpm = (args, cwd = source, timeout = 180_000) => run('npm', ['exec', '--yes', '--package=pnpm@11.28.5', '--', 'pnpm', ...args], { cwd, timeout });
console.log('Installing the exact upstream lockfile with lifecycle scripts disabled.');
console.log(pnpm(['install', '--frozen-lockfile', '--ignore-scripts'], source, 300_000));
console.log('Generating official Typert source contracts before Client compilation.');
console.log(pnpm(['exec', 'tsx', 'scripts/generate-typert.ts'], source, 180_000));
console.log('Typechecking and emitting the source extension project references.');
console.log(pnpm(['exec', 'tsc', '-b', ...EXTENSION_PACKAGES.map(path => `${path}/tsconfig.json`)], source, 300_000));
console.log('Building package entrypoints required by the browser inline dependencies.');
for (const path of INLINE_RUNTIME_PACKAGES) {
  const entry = `${path}/lib/types/index.js`;
  const outputDirectory = `${path}/lib`;
  console.log(pnpm([
    'exec', 'tsdown', entry, '--no-config', '--out-dir', outputDirectory,
    '--format', 'esm', '--platform', 'node', '--target', 'es2024',
    '--no-dts', '--no-clean', '--logLevel', 'error',
  ], source, 180_000));
  // The package exports its runtime at lib/index.js. The no-config one-file
  // build emits .mjs, so give package resolution the declared entry point.
  await rename(join(source, outputDirectory, 'index.mjs'), join(source, outputDirectory, 'index.js'));
}
await mkdir(output, { recursive: true });
if ((await readdir(output)).some(name => name.endsWith('.tgz'))) throw new Error('Use an empty package output directory; mixed extension builds are not accepted.');
for (const path of EXTENSION_PACKAGES) {
  const cwd = join(source, path), metadataPath = join(cwd, 'package.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  // Source package metadata distinguishes this build from the official npm rc.
  // Nothing in compiled JavaScript is intercepted or rewritten.
  metadata.hhpiSourceExtension = identity;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Building ${path} with the official compiler preset.`);
  console.log(pnpm(['exec', 'tsdown', '--config-loader', 'native'], cwd, 180_000));
  const clientBundlePath = join(cwd, 'lib/client.js');
  try {
    const clientBundle = await readFile(clientBundlePath, 'utf8');
    const unresolved = MISSING_CLIENT_EXTERNALS.filter(specifier => clientBundle.includes(`require(${JSON.stringify(specifier)})`));
    if (unresolved.length > 0) {
      throw new Error(`${path} left browser-only dependencies in the module table: ${unresolved.join(', ')}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.log(pnpm(['pack', '--pack-destination', output], cwd));
}
const packages = [];
for (const name of (await readdir(output)).filter(name => name.endsWith('.tgz')).sort()) {
  const bytes = await readFile(join(output, name));
  packages.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ ...provenance, packages }, null, 2)}\n`);
console.log(JSON.stringify({ output, packages }));
