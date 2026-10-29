/** Reproducible source build using the pinned upstream workspace lock and compiler. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXTENSION_PACKAGES, ROOT, run } from './prepare.mjs';
const source = process.argv[2], output = resolve(process.argv[3] ?? join(ROOT, '.tmp/hhpi-ext/packages'));
if (!source) throw new Error('A prepared DSH source directory is required.');
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (manifest.packageManager !== 'pnpm@11.28.5') throw new Error('The pinned upstream package manager changed.');
const pnpm = (args, cwd = source, timeout = 180_000) => run('npm', ['exec', '--yes', '--package=pnpm@11.28.5', '--', 'pnpm', ...args], { cwd, timeout });
console.log('Installing the exact upstream lockfile with lifecycle scripts disabled.');
console.log(pnpm(['install', '--frozen-lockfile', '--ignore-scripts'], source, 300_000));
console.log('Generating official Typert source contracts before Client compilation.');
console.log(pnpm(['exec', 'tsx', 'scripts/generate-typert.ts'], source, 180_000));
console.log('Typechecking and emitting the source extension project references.');
console.log(pnpm(['exec', 'tsc', '-b', ...EXTENSION_PACKAGES.map(path => `${path}/tsconfig.json`)], source, 300_000));
await mkdir(output, { recursive: true });
for (const path of EXTENSION_PACKAGES) {
  const cwd = join(source, path);
  console.log(`Building ${path} with the official compiler preset.`);
  console.log(pnpm(['exec', 'tsdown', '--config-loader', 'native'], cwd, 180_000));
  console.log(pnpm(['pack', '--pack-destination', output], cwd));
}
const provenance = JSON.parse(await readFile(join(source, 'hhpi-source-inputs.json'), 'utf8'));
const packages = [];
for (const name of (await readdir(output)).filter(name => name.endsWith('.tgz')).sort()) {
  const bytes = await readFile(join(output, name));
  packages.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ ...provenance, packages }, null, 2)}\n`);
console.log(JSON.stringify({ output, packages }));
