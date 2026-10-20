import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.name !== 'hapi-dsh' || manifest.dependencies?.['@deepseek-ai/dsh'] !== '0.2.1-rc.2') {
    throw new Error('Run distribution packaging from the pinned hapi-dsh repository');
}
const runner = JSON.parse(await readFile('dist/runner/package.json', 'utf8'));
if (runner.name !== 'hapi-dsh-runner' || runner.dsh?.client || runner.version !== manifest.version
    || runner.engines?.dsh !== manifest.engines?.dsh) throw new Error('Runner manifest is not the matching Host-only bundle');

await mkdir('artifacts', { recursive: true });
const npmArgs = ['pack', '--ignore-scripts', '--json', '--pack-destination', 'artifacts'];
const result = process.platform === 'win32'
    ? spawnSync(process.execPath, [process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...npmArgs], { encoding: 'utf8', shell: false })
    : spawnSync('npm', npmArgs, { encoding: 'utf8', shell: false });
if (result.error || result.status !== 0) throw new Error(`npm pack failed: ${result.error?.message ?? result.stderr}`);
const [pack] = JSON.parse(result.stdout);
if (!pack || typeof pack.filename !== 'string' || basename(pack.filename) !== pack.filename || !Array.isArray(pack.files)) {
    throw new Error('npm pack returned an unexpected package manifest');
}
const paths = new Set(pack.files.map(file => file.path));
const required = [
    'package.json', 'README.md', 'LICENSE', 'NOTICE', 'dist/index.js', 'dist/client.js', 'dist/cli.js', 'dist/session-controller.js',
    'dist/runner/index.js', 'dist/runner/package.json', 'dist/runner/cordis.patch.yml',
    'dist/types/index.d.ts', 'dist/types/client/index.d.ts', 'dist/types/cli/index.d.ts',
    'config/cordis.patch.yml', 'config/runner.patch.yml', 'docs/install.md', 'docs/architecture.md',
    'docs/validation.md', 'docs/distribution.md', 'docs/native-codex.md', 'docs/licenses/DSH-MIT.txt', 'docs/licenses/HAPI-NOTICE.txt',
    'docs/licenses/ZUSTAND-MIT.txt', 'docs/licenses/IMMER-MIT.txt',
    'UPSTREAMS.json', 'scripts/build.mjs', 'tsconfig.json', 'tsconfig.host.json', 'tsconfig.client.json',
];
for (const path of await readdir('src', { recursive: true })) {
    if (/\.(?:ts|tsx)$/.test(path)) required.push(`src/${path.replaceAll('\\', '/')}`);
}
for (const path of required) if (!paths.has(path)) throw new Error(`Required runtime or attribution file is absent: ${path}`);
for (const path of paths) {
    if (/(^|\/)(?:node_modules|test-results|playwright-report|\.git|\.env(?:\.[^/]*)?|runner-pairings\.json|runner\.json|config\.json)(?:\/|$)/.test(path)) {
        throw new Error(`Private or transient file must not be distributed: ${path}`);
    }
}
const cli = await readFile('dist/cli.js', 'utf8');
if (!cli.startsWith('#!/usr/bin/env node\n')) throw new Error('The distribution CLI is missing its executable hashbang');
const file = resolve('artifacts', pack.filename);
const hash = createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile('artifacts/SHA256SUMS', `${hash}  ${pack.filename}\n`);
process.stdout.write(`Verified ${paths.size} package files. Created ${file} and artifacts/SHA256SUMS.\n`);
