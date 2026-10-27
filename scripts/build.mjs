import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { buildIdentity as computeBuildIdentity } from './build-identity.mjs';
import { buildClientBundle, buildSourceProvider } from './client-bundle.mjs';

await mkdir('dist', { recursive: true });
const buildIdentity = await computeBuildIdentity();
const entryPoints = { index: 'src/index.ts', cli: 'src/cli/index.ts', 'session-controller': 'src/codex/session-controller.ts', 'workspace-files': 'src/hapi/workspace-files.ts', 'file-references': 'src/hapi/file-references.ts', 'terminal-controller': 'src/hapi/terminal-controller.ts', 'subagent-controller': 'src/hapi-agent/subagent-controller.ts', 'runner/index': 'src/runner/index.ts', 'session-provider/index': 'src/session-provider/index.ts' };
await build({
    entryPoints, outdir: 'dist', bundle: true, format: 'esm', platform: 'node',
    target: 'node24', packages: 'external', sourcemap: true,
    define: { __HAPI_DSH_BUILD_ID__: buildIdentity },
    banner: { js: '// hapi-dsh: compiled from the accompanying AGPL-3.0-only source.' },
});
await buildClientBundle(buildIdentity);
await buildSourceProvider(buildIdentity);
// Host and Client have different Cordis service declarations; emit them in separate TS programs.
for (const [name, include] of [
    ['host', ['src/index.ts', 'src/client-api.ts', 'src/hapi/**/*.ts', 'src/hapi-agent/**/*.ts', 'src/codex/**/*.ts', 'src/shared/**/*.ts', 'src/hub/**/*.ts', 'src/runner/**/*.ts', 'src/cli/**/*.ts', 'src/session-provider/**/*.ts']],
    ['client', ['src/client/**/*.ts', 'src/client/**/*.tsx', 'src/client-api.ts']],
]) {
    const path = `tsconfig.build-${name}.json`;
    await writeFile(path, JSON.stringify({ extends: `./tsconfig.${name}.json`, compilerOptions: { rootDir: 'src', outDir: 'dist/types', declaration: true, emitDeclarationOnly: true }, include, exclude: ['node_modules', 'dist', 'tests'] }, null, 2) + '\n');
    const done = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', path], { stdio: 'inherit' });
    if (done.status !== 0) process.exit(done.status ?? 1);
}
// The runner is a separate DSH Host-only bundle. It never installs the workspace Client on itself.
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('dist/runner/package.json', JSON.stringify({
    name: 'hapi-dsh-runner', version: manifest.version, type: 'module', license: manifest.license,
    main: './index.js', exports: { '.': './index.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
    engines: { node: '>=24', dsh: manifest.engines.dsh },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/cordis': '4.0.5' },
}, null, 2) + '\n');
await writeFile('dist/runner/cordis.patch.yml', await readFile('config/runner.patch.yml', 'utf8'));
