/** Shared production/client-only build configuration. No upstream bytes are edited. */
import { build } from 'esbuild';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export async function buildClientBundle(buildIdentity, { publish = true, minifyIdentifiers = true } = {}) {
    const modulesSource = await readFile(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8');
    // The official store is a Web platform seed, not a downloadable graph entry.
    const storeRuntime = await build({
        entryPoints: ['@deepseek-ai/dsh-client-store'], bundle: true, format: 'iife', globalName: '__HAPI_DSH_OFFICIAL_STORE__',
        platform: 'browser', target: 'es2022', write: false, legalComments: 'inline',
        define: { 'process.env.NODE_ENV': '"production"' },
    });
    const options = {
        bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
        write: false, jsx: 'automatic', legalComments: 'inline', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers,
        metafile: Boolean(process.env.HAPI_DSH_BUNDLE_REPORT),
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
    };
    const chunks = [
        ['client.voice.js', 'src/client/source-voice/composer.tsx'], ['client.capture.js', 'html2canvas-pro'],
        ['client.native-panels.js', 'src/client/native-panels.ts'], ['client.session-panels.js', 'src/client/session-extras.tsx'],
        ['client.administration.js', 'src/client/source-admin-panel.tsx'],
    ];
    const [result, ...extras] = await Promise.all([
        build({ ...options, entryPoints: ['src/client/index.ts'] }),
        ...chunks.map(([, entry]) => build({ ...options, entryPoints: [entry] })),
    ]);
    const body = result.outputFiles[0].text;
    if (result.metafile) await writeFile(process.env.HAPI_DSH_BUNDLE_REPORT, JSON.stringify(result.metafile));
    if (!publish) return result;
    await mkdir('dist', { recursive: true });
    // Publish each supported package-local chunk before announcing the new main
    // bundle. Conversations do not load optional panels, voice SDKs or PNG capture.
    for (let i = 0; i < chunks.length; i++) {
        const fileName = chunks[i][0], pendingChunk = `dist/${fileName}.${process.pid}.pending`;
        await writeFile(pendingChunk, `window.__ModuleLoader__.load({id:"hapi-dsh",chunk:${JSON.stringify(fileName)},factory:function(require){var module={exports:{}};var exports=module.exports;\n${extras[i].outputFiles[0].text}\nreturn module.exports;}});\n`);
        await rename(pendingChunk, `dist/${fileName}`);
    }
    // The official 500 ms HMR poll must only see a completed bundle generation.
    const pending = `dist/client.js.${process.pid}.pending`;
    await writeFile(pending, `window.__ModuleLoader__.load({id:"hapi-dsh",factory:function(require){var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`);
    await rename(pending, 'dist/client.js');
    return result;
}

/**
 * Build the pre-UI source-session composition as a separate client graph row.
 * The package manifest lives beside the bundle so the official Host module
 * registry can discover `dsh.client` through the same mechanism as every
 * pinned package. No upstream or node_modules byte is changed.
 */
export async function buildSourceProvider(buildIdentity) {
    const options = {
        bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
        write: false, legalComments: 'inline', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: true,
        external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-session-controller/client'],
        define: { __HAPI_DSH_BUILD_ID__: buildIdentity },
    };
    const result = await build({ ...options, entryPoints: ['src/client/source-sessions-provider.ts'] });
    const body = result.outputFiles[0].text;
    await mkdir('dist/session-provider', { recursive: true });
    const pending = `dist/session-provider/client.js.${process.pid}.pending`;
    await writeFile(pending, `window.__ModuleLoader__.load({id:"hapi-dsh-session-provider",factory:function(require){var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`);
    await rename(pending, 'dist/session-provider/client.js');
    await writeFile('dist/session-provider/package.json', JSON.stringify({
        name: 'hapi-dsh-session-provider', version: JSON.parse(await readFile('package.json', 'utf8')).version,
        type: 'module', main: './index.js', license: 'AGPL-3.0-only',
        exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
        dsh: { client: { platform: 'web', external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-session-controller'] } },
    }, null, 2) + '\n');
    return result;
}
