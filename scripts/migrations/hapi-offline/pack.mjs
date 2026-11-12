#!/usr/bin/env node
/** A separate offline archive, never a product plugin or bundle payload. */
import { build } from 'esbuild';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createTgzFromDirectory } from '../../bundle/lib/tar.mjs';

const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../../..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const output = resolve(values.out ?? join(root, 'artifacts/recovery'));
const scratch = await mkdtemp('/mnt/cache/data-cache/hhpi-offline-distribution-');
try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const packageRoot = join(scratch, 'package');
    await mkdir(packageRoot);
    const result = await build({ absWorkingDir: root, entryPoints: [join(directory, 'api.ts')], outfile: join(packageRoot, 'api.mjs'),
        bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true, legalComments: 'linked',
        banner: { js: '// HHPI offline recovery. Corresponding source and licenses accompany this archive.' },
    });
    const sourceFiles = Object.keys(result.metafile.inputs).sort();
    for (const source of sourceFiles) {
        const path = relative(root, resolve(root, source));
        if (isAbsolute(path) || path === '..' || path.startsWith('../')) throw Error('Source outside the package root');
        const target = join(packageRoot, 'SOURCE', path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(root, path), target);
    }
    for (const name of ['cli.mjs', 'pack.mjs', 'README.md']) {
        const source = join(directory, name), target = join(packageRoot, 'SOURCE/scripts/migrations/hapi-offline', name);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
        if (name === 'cli.mjs') await copyFile(source, join(packageRoot, name));
    }
    await copyFile(join(root, 'docs/offline-recovery.md'), join(packageRoot, 'README.md'));
    await mkdir(join(packageRoot, 'SOURCE/docs'), { recursive: true });
    await copyFile(join(root, 'docs/offline-recovery.md'), join(packageRoot, 'SOURCE/docs/offline-recovery.md'));
    await mkdir(join(packageRoot, 'SOURCE/scripts/bundle/lib'), { recursive: true });
    await copyFile(join(root, 'scripts/bundle/lib/tar.mjs'), join(packageRoot, 'SOURCE/scripts/bundle/lib/tar.mjs'));
    await mkdir(join(packageRoot, 'LICENSES'));
    for (const [from, name] of [['LICENSE', 'HHPI-AGPL-3.0-only.txt'], ['NOTICE', 'NOTICE.txt'], ['node_modules/zod/LICENSE', 'ZOD-MIT.txt']])
        await copyFile(join(root, from), join(packageRoot, 'LICENSES', name));
    const zod = JSON.parse(await readFile(join(root, 'node_modules/zod/package.json'), 'utf8'));
    await writeFile(join(packageRoot, 'SOURCE/package.json'), JSON.stringify({ name: 'hhpi-offline-recovery-source', private: true,
        version: manifest.version, type: 'module', license: manifest.license, dependencies: { zod: zod.version },
        devDependencies: { esbuild: manifest.devDependencies.esbuild },
    }, null, 2) + '\n');
    await copyFile(join(root, 'LICENSE'), join(packageRoot, 'SOURCE/LICENSE'));
    await copyFile(join(root, 'NOTICE'), join(packageRoot, 'SOURCE/NOTICE'));
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'hapi-dsh-offline-recovery', version: manifest.version,
        type: 'module', license: manifest.license, engines: { node: '>=24' }, exports: './api.mjs', bin: { 'hapi-dsh-offline': './cli.mjs' },
        description: 'Explicit offline recovery of selected legacy records; no source execution or product registration.',
    }, null, 2) + '\n');
    const runtimeImports = Object.values(result.metafile.outputs).flatMap(output => output.imports).filter(value => value.external).map(value => value.path);
    if (runtimeImports.some(value => !value.startsWith('node:'))) throw Error('Standalone recovery has an unbundled runtime dependency');
    await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify({ version: 1, tool: 'hapi-dsh-offline-recovery', toolVersion: manifest.version,
        node: '>=24', productRegistration: false, automaticInstall: false, automaticDispatch: false,
        runtimeImports: [...new Set(runtimeImports)].sort(), bundledDependencies: [{ name: 'zod', version: zod.version, license: 'MIT' }],
        sourceFiles, buildTool: { name: 'esbuild', version: manifest.devDependencies.esbuild },
    }, null, 2) + '\n');
    await mkdir(output, { recursive: true });
    const archive = join(output, `hapi-dsh-offline-recovery-${manifest.version}.tgz`);
    await writeFile(archive, await createTgzFromDirectory(packageRoot));
    process.stdout.write(JSON.stringify({ archive, version: manifest.version, sourceFiles: sourceFiles.length, runtimeDependencies: 0, productRegistration: false }) + '\n');
} finally { await rm(scratch, { recursive: true, force: true }); }
