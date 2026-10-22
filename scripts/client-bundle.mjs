/** Shared production/client-only build configuration. No upstream bytes are edited. */
import { build } from 'esbuild';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export async function buildClientBundle(buildIdentity) {
    const modulesSource = await readFile(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8');
    // The official store is a Web platform seed, not a downloadable graph entry.
    const storeRuntime = await build({
        entryPoints: ['@deepseek-ai/dsh-client-store'], bundle: true, format: 'iife', globalName: '__HAPI_DSH_OFFICIAL_STORE__',
        platform: 'browser', target: 'es2022', write: false, legalComments: 'inline',
        define: { 'process.env.NODE_ENV': '"production"' },
    });
    const result = await build({
        entryPoints: ['src/client/index.ts'], bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
        write: false, jsx: 'automatic', legalComments: 'inline',
        logOverride: { 'import-is-undefined': 'error' },
        define: { __HAPI_DSH_OFFICIAL_STORE_SOURCE__: JSON.stringify(storeRuntime.outputFiles[0].text),
            __HAPI_DSH_OFFICIAL_MODULES_SOURCE__: JSON.stringify(modulesSource), __HAPI_DSH_BUILD_ID__: buildIdentity },
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
            '@deepseek-ai/dsh-api-terminal-controller/client',
        ],
    });
    const body = result.outputFiles[0].text;
    await mkdir('dist', { recursive: true });
    // The official 500 ms HMR poll must only see a completed bundle generation.
    const pending = `dist/client.js.${process.pid}.pending`;
    await writeFile(pending, `window.__ModuleLoader__.load({id:"hapi-dsh",factory:function(require){var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`);
    await rename(pending, 'dist/client.js');
}
