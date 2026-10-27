#!/usr/bin/env node
/**
 * Produce `hapi-dsh-bundle-<version>.tgz`.
 *
 *   node scripts/bundle/pack.mjs --ext-release DIR     # real ext payload
 *   node scripts/bundle/pack.mjs --fixture             # checked-in placeholder payload
 *   node scripts/bundle/pack.mjs --hapi-dsh-tgz FILE   # reuse an already packed package
 *
 * The bundle layout is fixed by the distribution spec:
 *   package/dist/install.mjs, package/payload/hapi-dsh.tgz,
 *   package/payload/dsh-ext/*.tgz, package/manifest.json, package/SHA256SUMS,
 *   package/LICENSES/, package/SOURCE-OFFER/
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createTgzFromDirectory, extractTgz, listTgz, readTgz } from './lib/tar.mjs';
import { sha256Bytes, sha256File } from './lib/digest.mjs';
import {
    BUNDLE_LAYOUT, BUNDLE_NAME, BUNDLE_PROTOCOL, BUNDLE_SCHEMA_VERSION, EXT_CAPABILITIES,
    MINIMUM_PNPM, PINNED_UPSTREAM_COMMIT, PINNED_UPSTREAM_VERSION, computeReleaseId,
    formatSums, packageSetSha256, validateBundleManifest, bundleLayoutErrors,
    installerImportErrors, releaseDirName,
} from './lib/manifest.mjs';
import { verifyBundleRoot, verifyPayloadTarballs } from './lib/release.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');

function parseArguments(argv) {
    const options = { out: 'artifacts/bundle', fixture: false, json: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const next = () => {
            const value = argv[++index];
            if (value === undefined) throw new Error(`${argument} requires a value`);
            return value;
        };
        switch (argument) {
            case '--ext-release': options.extRelease = next(); break;
            case '--hapi-dsh-tgz': options.hapiDshTgz = next(); break;
            case '--out': options.out = next(); break;
            case '--version': options.version = next(); break;
            case '--tmp': options.tmp = next(); break;
            case '--fixture': options.fixture = true; break;
            case '--json': options.json = true; break;
            case '--help': case '-h': options.help = true; break;
            default: throw new Error(`unknown argument: ${argument}`);
        }
    }
    return options;
}

const HELP = `Usage: node scripts/bundle/pack.mjs [--ext-release DIR | --fixture] [options]

Options:
  --ext-release DIR   Directory with a dsh-ext release.json and its tarballs.
  --fixture           Use the checked-in placeholder ext payload (no real extension).
  --hapi-dsh-tgz F    Reuse an already packed hapi-dsh package tarball.
  --version V         Bundle version; defaults to package.json version.
  --out DIR           Output directory; defaults to artifacts/bundle.
  --tmp DIR           Scratch directory; defaults to the OS temporary directory.
  --json              Print a machine-readable summary.
`;

async function gitRevision() {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', shell: false });
    return result.status === 0 ? result.stdout.trim() : null;
}

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

function npmPack(destination, scratch) {
    mkdirSync(destination, { recursive: true });
    const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', destination];
    const env = {
        ...process.env,
        npm_config_cache: join(scratch, 'npm-cache'),
        npm_config_logs_dir: join(scratch, 'npm-logs'),
        npm_config_update_notifier: 'false',
    };
    const result = spawnSync(process.platform === 'win32'
        ? process.execPath
        : 'npm', process.platform === 'win32'
        ? [process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args]
        : args, { cwd: repositoryRoot, env, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`npm pack failed: ${result.error?.message ?? result.stderr}`);
    const [pack] = JSON.parse(result.stdout);
    if (!pack || typeof pack.filename !== 'string') throw new Error('npm pack returned an unexpected manifest');
    return join(destination, basename(pack.filename));
}

async function packFixtureExt(releaseDirectory, stagingExt) {
    const release = await readJson(join(releaseDirectory, 'release.json'));
    if (release.fixture !== true) throw new Error('the fixture ext release must declare "fixture": true');
    const packages = [];
    for (const item of release.packages) {
        const source = join(releaseDirectory, item.source);
        const tarball = `payload/dsh-ext/${basename(item.source)}-${item.version}.tgz`;
        const buffer = await createTgzFromDirectory(source, { prefix: 'package' });
        await writeFile(join(stagingExt, basename(tarball)), buffer);
        packages.push({ name: item.name, version: item.version, tarball, sha256: sha256Bytes(buffer), size: buffer.byteLength });
    }
    return { release, packages, sourceOfferFiles: [], licenses: [] };
}

async function packRealExt(releaseDirectory, stagingExt, stageRoot) {
    const release = await readJson(join(releaseDirectory, 'release.json'));
    const packages = [];
    for (const item of release.packages) {
        const source = join(releaseDirectory, item.tarball);
        const buffer = await readFile(source);
        const target = `payload/dsh-ext/${basename(item.tarball)}`;
        const entries = readTgz(buffer, { withData: true });
        const packageJson = entries.find((entry) => entry.path === 'package/package.json');
        if (!packageJson?.data) throw new Error(`${item.tarball} has no package/package.json`);
        const inner = JSON.parse(packageJson.data.toString('utf8'));
        if (inner.name !== item.name || inner.version !== item.version) {
            throw new Error(`${item.tarball} contains ${inner.name}@${inner.version}, expected ${item.name}@${item.version}`);
        }
        await writeFile(join(stagingExt, basename(target)), buffer);
        packages.push({ name: item.name, version: item.version, tarball: target, sha256: sha256Bytes(buffer), size: buffer.byteLength });
    }
    const licenses = [];
    for (const item of release.licenses ?? []) {
        const from = join(releaseDirectory, item);
        const to = `LICENSES/dsh-ext/${basename(item)}`;
        await mkdir(dirname(join(stagingExt, '..', to)), { recursive: true });
        await copyFile(from, join(releaseDirectory, '..', to));
        licenses.push(to);
    }
    const sourceOfferFiles = [];
    for (const item of release.sourceOffer ?? []) {
        const from = join(releaseDirectory, item);
        const to = `SOURCE-OFFER/dsh-ext/${basename(item)}`;
        await mkdir(dirname(join(releaseDirectory, '..', to)), { recursive: true });
        await copyFile(from, join(releaseDirectory, '..', to));
        sourceOfferFiles.push(to);
    }
    return { release, packages, sourceOfferFiles, licenses };
}

function sourceOfferReadme({ version, release, packages, revision, fixture }) {
    return `# Corresponding source offer — hapi-dsh bundle ${version}

This bundle contains the AGPL-3.0-only hapi-dsh plugin plus ${fixture ? 'placeholder fixture payloads' : 'the modified official DSH packages produced by the dsh-ext repository'}.
The complete corresponding source is available from the public repositories below,
at the revision identified by the manifest.

- hapi-dsh source: https://github.com/dqtz5vpvj9-create/hapi-dsh (revision: ${revision ?? 'see the release tag matching this version'})
- upstream DSH: @deepseek-ai/dsh ${release.upstreamVersion} (commit ${release.upstreamCommit})
- ext release: ${release.extRelease}
- patch set sha256: ${release.patchSetSha256}
- package set sha256: ${release.packageSetSha256 ?? '(computed from the payload)'}

Modified official packages in this bundle:

${packages.map((item) => `- ${item.name}@${item.version} (${item.tarball})`).join('\n')}

Licenses are collected in LICENSES/. The upstream DSH packages remain under
their original MIT license; hapi-dsh is AGPL-3.0-only.

${fixture ? 'NOTE: this bundle was produced with `--fixture` placeholder payloads. Do not publish it.\n' : ''}`;
}

async function stageLicenses(stageRoot, extLicenses) {
    const directory = join(stageRoot, BUNDLE_LAYOUT.licenses);
    await mkdir(directory, { recursive: true });
    const index = [];
    const copy = async (from, name) => {
        await copyFile(from, join(directory, name));
        index.push({ file: name, source: from.replace(`${repositoryRoot}/`, '') });
    };
    await copy(join(repositoryRoot, 'LICENSE'), 'hapi-dsh-AGPL-3.0-only.txt');
    await copy(join(repositoryRoot, 'NOTICE'), 'NOTICE.txt');
    const licenseDirectory = join(repositoryRoot, 'docs', 'licenses');
    for (const name of await readdir(licenseDirectory).catch(() => [])) {
        if (name.endsWith('.txt')) await copy(join(licenseDirectory, name), name);
    }
    for (const relative of extLicenses) await copy(join(repositoryRoot, relative), basename(relative));
    await writeFile(join(directory, 'INDEX.json'), `${JSON.stringify({ upstreamVersion: PINNED_UPSTREAM_VERSION, hapiDshLicense: 'AGPL-3.0-only', files: index }, null, 2)}\n`);
    return index.map((entry) => `${BUNDLE_LAYOUT.licenses}/${entry.file}`).concat(`${BUNDLE_LAYOUT.licenses}/INDEX.json`);
}

async function stageSourceOffer(stageRoot, { version, release, packages, revision, fixture, extSourceOffer }) {
    const directory = join(stageRoot, BUNDLE_LAYOUT.sourceOffer);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'README.md'), sourceOfferReadme({ version, release, packages, revision, fixture }));
    await writeFile(join(directory, 'PROVENANCE.json'), `${JSON.stringify({
        bundleVersion: version,
        hapiDshRevision: revision,
        upstreamVersion: release.upstreamVersion,
        upstreamCommit: release.upstreamCommit,
        extRelease: release.extRelease,
        patchSetSha256: release.patchSetSha256,
        packageSetSha256: release.packageSetSha256,
        compositionVersion: release.compositionVersion,
        protocol: release.protocol,
        fixture,
        packages,
    }, null, 2)}\n`);
    const files = [`${BUNDLE_LAYOUT.sourceOffer}/README.md`, `${BUNDLE_LAYOUT.sourceOffer}/PROVENANCE.json`];
    for (const relative of extSourceOffer) files.push(relative);
    return files;
}

async function writeSums(root) {
    const entries = [];
    async function visit(directory, prefix = '') {
        for (const item of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
            const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
            if (item.isDirectory()) await visit(join(directory, item.name), rel);
            else if (item.isFile()) {
                if (rel === BUNDLE_LAYOUT.sums) continue;
                entries.push({ path: rel, sha256: await sha256File(join(root, rel)) });
            } else throw new Error(`bundle staging contains a non-regular file: ${rel}`);
        }
    }
    await visit(root);
    await writeFile(join(root, BUNDLE_LAYOUT.sums), formatSums(entries));
    return entries;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(HELP);
        return 0;
    }
    const manifest = await readJson(join(repositoryRoot, 'package.json'));
    if (manifest.name !== 'hapi-dsh') throw new Error('run bundle packaging from the hapi-dsh repository root');
    if (manifest.dependencies?.['@deepseek-ai/dsh'] !== PINNED_UPSTREAM_VERSION) throw new Error(`hapi-dsh must pin @deepseek-ai/dsh ${PINNED_UPSTREAM_VERSION}`);
    const version = options.version ?? manifest.version;
    if (!options.fixture && !options.extRelease) {
        throw new Error('a real dsh-ext payload is required: pass --ext-release DIR with its release.json, or --fixture for the placeholder payload');
    }
    if (options.fixture && options.extRelease) throw new Error('choose either --fixture or --ext-release, not both');

    const scratch = options.tmp ? resolve(repositoryRoot, options.tmp) : tmpdir();
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(scratch, 'hapi-dsh-bundle-pack-'));
    const outDirectory = resolve(repositoryRoot, options.out);
    await mkdir(outDirectory, { recursive: true });
    try {
        const stageRoot = join(temporary, 'package');
        const stagingPayload = join(stageRoot, BUNDLE_LAYOUT.hapiPayload, '..');
        const stagingExt = join(stageRoot, BUNDLE_LAYOUT.extPayload);
        await mkdir(stagingExt, { recursive: true });
        await mkdir(join(stageRoot, BUNDLE_LAYOUT.lib), { recursive: true });
        await copyFile(join(scriptDirectory, 'install.mjs'), join(stageRoot, BUNDLE_LAYOUT.install));
        for (const name of (await readdir(join(scriptDirectory, 'lib'))).sort()) {
            if (name.endsWith('.mjs')) await copyFile(join(scriptDirectory, 'lib', name), join(stageRoot, BUNDLE_LAYOUT.lib, name));
        }
        // The hapi-dsh payload.
        let hapiTarball;
        if (options.hapiDshTgz) hapiTarball = resolve(options.hapiDshTgz);
        else hapiTarball = npmPack(join(temporary, 'npm'), temporary);
        const hapiBuffer = await readFile(hapiTarball);
        const innerPackage = readTgz(hapiBuffer, { withData: true }).find((entry) => entry.path === 'package/package.json');
        if (!innerPackage?.data) throw new Error('the hapi-dsh payload has no package/package.json');
        const inner = JSON.parse(innerPackage.data.toString('utf8'));
        if (inner.name !== 'hapi-dsh' || inner.version !== version) throw new Error(`the hapi-dsh payload is ${inner.name}@${inner.version}, expected hapi-dsh@${version}`);
        await writeFile(join(stagingPayload, 'hapi-dsh.tgz'), hapiBuffer);

        const ext = options.fixture
            ? await packFixtureExt(join(scriptDirectory, 'fixtures', 'ext-release'), stagingExt)
            : await packRealExt(resolve(options.extRelease), stagingExt, stageRoot);
        const release = {
            upstreamVersion: PINNED_UPSTREAM_VERSION,
            upstreamCommit: PINNED_UPSTREAM_COMMIT,
            extRelease: ext.release.extRelease,
            patchSetSha256: ext.release.patchSetSha256,
            packageSetSha256: packageSetSha256(ext.packages),
            compositionVersion: ext.release.compositionVersion,
            protocol: BUNDLE_PROTOCOL,
            capabilities: Object.fromEntries(EXT_CAPABILITIES.map((name) => [name, ext.release.capabilities?.[name] ?? 1])),
        };
        const licenses = await stageLicenses(stageRoot, ext.licenses);
        const packageSet = release.packageSetSha256;
        const revision = await gitRevision();
        const extSourceOffer = options.fixture ? [] : ext.sourceOfferFiles;
        const sourceOffer = await stageSourceOffer(stageRoot, {
            version, release, packages: ext.packages, revision, fixture: options.fixture, extSourceOffer,
        });

        const bundleManifest = {
            schemaVersion: BUNDLE_SCHEMA_VERSION,
            name: BUNDLE_NAME,
            version,
            createdAt: new Date().toISOString(),
            fixture: options.fixture,
            release,
            payload: {
                hapi: { tarball: BUNDLE_LAYOUT.hapiPayload, sha256: sha256Bytes(hapiBuffer), size: hapiBuffer.byteLength, version },
                dshExt: ext.packages,
            },
            minimums: { node: '>=24', pnpm: MINIMUM_PNPM },
            licenses,
            sourceOffer,
        };
        bundleManifest.release.packageSetSha256 = packageSet;
        bundleManifest.releaseId = computeReleaseId(bundleManifest);
        validateBundleManifest(bundleManifest);
        await writeFile(join(stageRoot, BUNDLE_LAYOUT.manifest), `${JSON.stringify(bundleManifest, null, 2)}\n`);
        await writeSums(stageRoot);

        const archive = await createTgzFromDirectory(stageRoot, { prefix: 'package' });
        const filename = `hapi-dsh-bundle-${version}.tgz`;
        const destination = join(outDirectory, filename);
        await writeFile(destination, archive);

        // Verify the produced bytes, not just the staging directory.
        const extracted = await mkdtemp(join(temporary, 'verify-'));
        await extractTgz(archive, extracted);
        const extractedRoot = join(extracted, 'package');
        const verified = await verifyBundleRoot(extractedRoot);
        await verifyPayloadTarballs(extractedRoot, { listTgz, readTgz });
        const files = (await readdir(extracted, { recursive: true })).map((path) => path.split('\\').join('/')).filter((path) => path !== 'package');
        const stripped = files.map((path) => path.replace(/^package\//, ''));
        const layoutErrors = bundleLayoutErrors(stripped);
        if (layoutErrors.length > 0) throw new Error(`produced bundle layout is invalid: ${layoutErrors.join('; ')}`);
        for (const file of stripped.filter((path) => path.endsWith('.mjs'))) {
            const source = await readFile(join(extractedRoot, file), 'utf8');
            const errors = installerImportErrors(source, file);
            if (errors.length > 0) throw new Error(errors.join('; '));
        }
        if (verified.releaseId !== bundleManifest.releaseId) throw new Error('produced bundle release id does not match its manifest');
        const archiveSha256 = createHash('sha256').update(archive).digest('hex');
        await writeFile(join(outDirectory, 'SHA256SUMS'), `${archiveSha256}  ${filename}\n`);

        const summary = {
            ok: true,
            bundle: destination,
            sha256: archiveSha256,
            version,
            fixture: options.fixture,
            releaseId: bundleManifest.releaseId,
            releaseDirectoryName: releaseDirName(bundleManifest.releaseId),
            payload: {
                hapiDsh: { tarball: BUNDLE_LAYOUT.hapiPayload, sha256: bundleManifest.payload.hapi.sha256, size: bundleManifest.payload.hapi.size },
                dshExt: bundleManifest.payload.dshExt.map((item) => ({ name: item.name, version: item.version, tarball: item.tarball })),
            },
            layout: stripped.filter((path) => !stripped.some((other) => other !== path && other.startsWith(`${path}/`))),
            fileCount: stripped.length,
        };
        if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        else {
            process.stdout.write(`Created ${destination}\n`);
            process.stdout.write(`  sha256:    ${archiveSha256}\n`);
            process.stdout.write(`  release:   ${summary.releaseDirectoryName} (${stripped.length} files)\n`);
            process.stdout.write(`  hapi-dsh:  payload/hapi-dsh.tgz (${bundleManifest.payload.hapi.size} bytes)\n`);
            for (const item of bundleManifest.payload.dshExt) process.stdout.write(`  dsh-ext:   ${item.name}@${item.version}\n`);
            process.stdout.write(`  fixture:   ${options.fixture ? 'yes (placeholder payload, not publishable)' : 'no'}\n`);
        }
        return 0;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`hapi-dsh bundle pack: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
