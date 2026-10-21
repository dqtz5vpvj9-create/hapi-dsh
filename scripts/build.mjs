import { build } from 'esbuild';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

await mkdir('dist', { recursive: true });
const fingerprint = createHash('sha256');
async function includeSources(directory) {
    for (const name of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = `${directory}/${name.name}`;
        if (name.isDirectory()) await includeSources(path);
        else if (name.isFile()) { fingerprint.update(path); fingerprint.update(await readFile(path)); }
    }
}
await includeSources('src'); await includeSources('config');
for (const path of ['package.json', 'package-lock.json', 'scripts/build.mjs']) {
    fingerprint.update(path); fingerprint.update(await readFile(path));
}
const buildIdentity = JSON.stringify(fingerprint.digest('hex'));
const entryPoints = { index: 'src/index.ts', cli: 'src/cli/index.ts', 'session-controller': 'src/codex/session-controller.ts', 'workspace-files': 'src/hapi/workspace-files.ts', 'file-references': 'src/hapi/file-references.ts', 'terminal-controller': 'src/hapi/terminal-controller.ts', 'subagent-controller': 'src/hapi-agent/subagent-controller.ts', 'runner/index': 'src/runner/index.ts' };
await build({
    entryPoints, outdir: 'dist', bundle: true, format: 'esm', platform: 'node',
    target: 'node24', packages: 'external', sourcemap: true,
    define: { __HAPI_DSH_BUILD_ID__: buildIdentity },
    banner: { js: '// hapi-dsh: compiled from the accompanying AGPL-3.0-only source.' },
});
// The official store is a Web platform seed, not a downloadable graph entry.
// Compile its pinned, unmodified npm source once, then embed the factory bytes;
// each federated graph evaluates them with its own localStorage capability.
const storeRuntime = await build({
    entryPoints: ['@deepseek-ai/dsh-client-store'], bundle: true, format: 'iife', globalName: '__HAPI_DSH_OFFICIAL_STORE__',
    platform: 'browser', target: 'es2022', write: false, legalComments: 'inline',
    define: { 'process.env.NODE_ENV': '"production"' },
});
const result = await build({
    entryPoints: ['src/client/index.ts'], bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
    write: false, jsx: 'automatic', legalComments: 'inline',
    logOverride: { 'import-is-undefined': 'error' },
    define: { __HAPI_DSH_OFFICIAL_STORE_SOURCE__: JSON.stringify(storeRuntime.outputFiles[0].text), __HAPI_DSH_BUILD_ID__: buildIdentity },
    plugins: [{ name: 'style-text', setup(builder) {
        builder.onResolve({ filter: /\?text$/ }, args => {
            const id = args.path.slice(0, -5);
            return { path: id.startsWith('.') ? resolve(args.resolveDir, id) : createRequire(import.meta.url).resolve(id), namespace: 'hapi-style-text' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'hapi-style-text' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
    } }],
    external: [
        'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
        'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store',
        '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
        // The published ClientTerminals entry is an official module factory,
        // not an ESM file to inline. Let the unchanged DSH loader resolve it.
        '@deepseek-ai/dsh-api-terminal-controller/client',
    ],
});
const body = result.outputFiles[0].text;
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"hapi-dsh",factory:function(require){var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`);
// Host and Client have different Cordis service declarations; emit them in separate TS programs.
for (const [name, include] of [
    ['host', ['src/index.ts', 'src/client-api.ts', 'src/hapi/**/*.ts', 'src/hapi-agent/**/*.ts', 'src/codex/**/*.ts', 'src/shared/**/*.ts', 'src/hub/**/*.ts', 'src/runner/**/*.ts', 'src/cli/**/*.ts']],
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
