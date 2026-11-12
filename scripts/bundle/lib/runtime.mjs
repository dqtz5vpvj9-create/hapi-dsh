/**
 * Assemble the private, pinned DSH runtime a bundle activation runs.
 *
 * The profile only installs plugins, so pnpm overrides there cannot replace the
 * official runtime's packages (and `file:` overrides are not honoured). Instead
 * the bundle builds the pinned `@deepseek-ai/dsh` closure on the machine and
 * overlays the verified ext tarballs onto the exact package directories, so
 * every consumer resolves one physical copy.
 */
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readTgz } from './tar.mjs';
import { canonicalJson, sha256Bytes } from './digest.mjs';
import { verifyReleaseDirectory } from './release.mjs';

const RUNTIME_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const RUNTIME_IDENTITY_FILE = 'runtime-identity.json';

const runtimeManifest = (releaseRoot, manifest) => ({
    name: 'hapi-dsh-runtime', private: true, version: String(manifest.version),
    // Both consumers resolve from this private closure, without a profile copy.
    dependencies: { '@deepseek-ai/dsh': manifest.release.upstreamVersion,
        'hapi-dsh': `file:${join(releaseRoot, manifest.payload.hapi.tarball)}` },
});

/** Seed only an absent target lock from the current profile's verified active runtime. */
export async function reuseRuntimeLockfile({ releaseRoot, manifest, previousReleaseRoot, pnpmVersion, logger = () => {} }) {
    const target = join(releaseRoot, 'runtime', 'pnpm-lock.yaml');
    if (await lstat(target).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) return;
    if (!previousReleaseRoot || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pnpmVersion ?? '')) return;
    try {
        const previous = await verifyReleaseDirectory(previousReleaseRoot);
        if (previous.manifest.release.upstreamVersion !== manifest.release.upstreamVersion) throw new Error('upstream versions differ');
        const directory = join(previousReleaseRoot, 'runtime');
        const regular = async file => { if (!(await lstat(file)).isFile()) throw new Error('previous runtime metadata is not a regular file'); return readFile(file); };
        if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('previous runtime is not a private directory');
        const inspected = await inspectRuntime({ releaseRoot: previousReleaseRoot, manifest: previous.manifest });
        if (!inspected.ok) throw new Error('previous runtime identity is not intact');
        const pkg = JSON.parse(await regular(join(directory, 'package.json')));
        if (canonicalJson(pkg) !== canonicalJson(runtimeManifest(previousReleaseRoot, previous.manifest))) throw new Error('previous runtime inputs differ');
        const modules = (await regular(join(directory, 'node_modules/.modules.yaml'))).toString('utf8');
        let manager;
        // pnpm 11 writes JSON to this historical .yaml path; older installs
        // may still carry the plain YAML scalar. Neither format is guessed.
        try { manager = JSON.parse(modules).packageManager; }
        catch { manager = /^packageManager:\s*['"]?(pnpm@[^\s'"]+)['"]?\s*$/m.exec(modules)?.[1]; }
        const seal = await readJson(join(directory, RUNTIME_IDENTITY_FILE), 'previous runtime identity');
        if (manager !== `pnpm@${pnpmVersion}` || (seal.packageManager && seal.packageManager !== manager)) throw new Error('pnpm versions differ');
        const bytes = await regular(join(directory, 'pnpm-lock.yaml'));
        const installed = await regular(join(directory, 'node_modules/.pnpm/lock.yaml'));
        if (!bytes.equals(installed)) throw new Error('previous lock differs from the installed lock');
        const sha256 = sha256Bytes(bytes);
        if (seal.files?.['pnpm-lock.yaml'] && seal.files['pnpm-lock.yaml'] !== sha256) throw new Error('previous lock changed after identity verification');
        // The source is read-only. A competing preparation may already have
        // written a target lock; wx preserves it instead of replacing its work.
        await writeFile(target, bytes, { flag: 'wx' });
        const source = { releaseId: previous.releaseId, sha256, packageManager: manager };
        logger(`runtime: reused active release ${previous.releaseId} lockfile (${source.sha256.slice(0, 12)})`);
        return source;
    } catch (error) {
        logger(`runtime: previous lockfile not reused (${error instanceof Error ? error.message : String(error)}); using normal pnpm install`);
    }
}

/** Resolve a sealed file within its runtime using the platform's path rules. */
export function runtimeFilePath(directory, file, paths = { resolve, relative, isAbsolute, sep }) {
    const target = paths.resolve(directory, file), within = paths.relative(directory, target);
    if (!within || within === '..' || within.startsWith(`..${paths.sep}`) || paths.isAbsolute(within)) return undefined;
    return target;
}

/** Flat sha256 map for one installed package directory, relative to the runtime root. */
async function hashPackageTree(runtimeDirectory, packageDirectory) {
    const files = {};
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) { await walk(path); continue; }
            if (!entry.isFile()) continue;
            const key = relative(runtimeDirectory, path).split('\\').join('/');
            files[key] = sha256Bytes(await readFile(path));
        }
    }
    await walk(packageDirectory);
    return files;
}

async function readJson(path, description) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read ${description} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Every physical copy of one scoped package inside a pnpm closure. */
async function packageCopies(runtimeDirectory, name) {
    const { realpath } = await import('node:fs/promises');
    const candidates = [];
    const top = join(runtimeDirectory, 'node_modules', name);
    if (await readPackageJson(join(top, 'package.json'))) candidates.push(top);
    const store = join(runtimeDirectory, 'node_modules', '.pnpm');
    for (const entry of await readdir(store, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const candidate = join(store, entry.name, 'node_modules', name);
        if (await readPackageJson(join(candidate, 'package.json'))) candidates.push(candidate);
    }
    // Nested peer entries are symlinks into one virtual-store directory; count
    // physical copies, not link paths.
    const seen = new Map();
    for (const candidate of candidates) {
        let real;
        try { real = await realpath(candidate); } catch { continue; }
        if (seen.has(real)) continue;
        const identity = await readPackageJson(join(real, 'package.json'));
        if (identity) seen.set(real, { directory: real, identity, link: candidate });
    }
    const copies = [...seen.values()];
    // Prefer the canonical virtual-store directory for extraction.
    copies.sort((left, right) => Number(right.directory.includes(`${'node_modules'}/.pnpm`)) - Number(left.directory.includes(`${'node_modules'}/.pnpm`)));
    return copies;
}

async function readPackageJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
    }
}

/** Extract one ext tarball over its resolved package directory. */
async function overlayPackage(runtimeDirectory, tarballPath, item, logger) {
    const buffer = await readFile(tarballPath);
    const expected = { name: item.name, version: item.version };
    const entries = readTgz(buffer, { withData: true });
    const identity = entries.find(entry => entry.path === 'package/package.json');
    if (!identity?.data) throw new Error(`${tarballPath} has no package/package.json`);
    const inner = JSON.parse(identity.data.toString('utf8'));
    if (inner.name !== expected.name || inner.version !== expected.version) {
        throw new Error(`${tarballPath} contains ${inner.name}@${inner.version}, expected ${expected.name}@${expected.version}`);
    }
    const copies = await packageCopies(runtimeDirectory, item.name);
    if (copies.length !== 1) {
        throw new Error(`${item.name} must resolve to exactly one runtime copy, found ${copies.length}`);
    }
    const target = copies[0].directory;
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const entry of entries) {
        if (!entry.path.startsWith('package/')) continue;
        const relative = entry.path.slice('package/'.length);
        if (!relative) continue;
        const destination = join(target, relative);
        if (entry.path.endsWith('/')) { await mkdir(destination, { recursive: true }); continue; }
        await mkdir(join(destination, '..'), { recursive: true });
        await writeFile(destination, entry.data ?? Buffer.alloc(0));
    }
    const installed = await readPackageJson(join(target, 'package.json'));
    if (installed?.version !== expected.version) {
        throw new Error(`${item.name} did not overlay: expected ${expected.version}, found ${String(installed?.version)}`);
    }
    const remaining = await packageCopies(runtimeDirectory, item.name);
    if (remaining.length !== 1) throw new Error(`${item.name} has ${remaining.length} copies after overlay`);
    logger(`runtime: overlaid ${item.name}@${item.version} (${sha256Bytes(buffer).slice(0, 12)})`);
    return { name: item.name, version: item.version, sha256: sha256Bytes(buffer) };
}

/**
 * Build the pinned runtime under the release directory and overlay ext packages.
 * @returns {Promise<{directory: string, dshBinary: string, dshVersion: string, packages: Array<{name: string, version: string, sha256: string}>}>}
 */
export async function prepareRuntime({ run, pnpm, pnpmVersion, env, releaseRoot, manifest, previousReleaseRoot, logger = () => {} }) {
    const directory = join(releaseRoot, 'runtime');
    const upstreamVersion = manifest.release.upstreamVersion;
    await mkdir(directory, { recursive: true });
    const manifestPath = join(directory, 'package.json');
    const existing = await readPackageJson(manifestPath);
    const wanted = runtimeManifest(releaseRoot, manifest);
    if (JSON.stringify(existing) !== JSON.stringify(wanted)) {
        await writeFile(manifestPath, `${JSON.stringify(wanted, null, 2)}\n`);
    }
    // pnpm reconciles changed file: payloads and dependency inputs itself. Keep
    // existing resolution state instead of deleting it whenever its path moves.
    const lockfileSource = await reuseRuntimeLockfile({ releaseRoot, manifest, previousReleaseRoot, pnpmVersion, logger });
    const install = await run({ ...pnpm, args: [...pnpm.args, 'install', '--prod', '--ignore-scripts', '--no-frozen-lockfile'] },
        { env, cwd: directory, timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS });
    if (install.exitCode !== 0) {
        const detail = (install.stderr || install.stdout || '').trim().split('\n').slice(-4).join(' | ');
        throw new Error(`pinned runtime install failed (pnpm exit ${install.exitCode}): ${detail}`);
    }
    const dshDirectory = join(directory, 'node_modules', '@deepseek-ai', 'dsh');
    const dsh = await readPackageJson(join(dshDirectory, 'package.json'));
    if (dsh?.version !== upstreamVersion) {
        throw new Error(`pinned runtime resolves @deepseek-ai/dsh ${String(dsh?.version)}, expected ${upstreamVersion}`);
    }
    const bin = typeof dsh.bin === 'string' ? dsh.bin : dsh.bin?.dsh;
    if (typeof bin !== 'string') throw new Error('pinned runtime DSH package has no dsh binary');
    const packages = [];
    for (const item of manifest.payload.dshExt) {
        packages.push(await overlayPackage(directory, join(releaseRoot, item.tarball), item, logger));
    }
    const files = {};
    for (const path of ['package.json', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml', 'node_modules/.modules.yaml']) {
        files[path] = sha256Bytes(await readFile(join(directory, path)));
    }
    // Seal the DSH launcher's own files (not its nested dependency closure) so
    // start-time verification stays cheap but covers the code we execute.
    const dshDirectory2 = join(directory, 'node_modules', '@deepseek-ai', 'dsh');
    async function walkLauncher(path) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue;
            const full = join(path, entry.name);
            if (entry.isDirectory()) { await walkLauncher(full); continue; }
            if (!entry.isFile()) continue;
            files[relative(directory, full).split('\\').join('/')] = sha256Bytes(await readFile(full));
        }
    }
    await walkLauncher(dshDirectory2);
    for (const item of manifest.payload.dshExt) {
        const copies = await packageCopies(directory, item.name);
        if (copies.length !== 1) throw new Error(`${item.name} must resolve to exactly one runtime copy, found ${copies.length}`);
        Object.assign(files, await hashPackageTree(directory, copies[0].directory));
    }
    await writeFile(join(directory, RUNTIME_IDENTITY_FILE), `${JSON.stringify({
        schemaVersion: 1,
        upstreamVersion,
        extRelease: manifest.release.extRelease,
        ...(pnpmVersion ? { packageManager: `pnpm@${pnpmVersion}` } : {}),
        ...(lockfileSource ? { lockfileSource } : {}),
        packages: manifest.payload.dshExt.map(item => ({ name: item.name, version: item.version })),
        files,
    }, null, 2)}\n`);
    return { directory, dshBinary: join(dshDirectory, bin), dshVersion: upstreamVersion, packages };
}

/** Verify the sealed runtime identity: every recorded file must match. */
export async function verifyRuntimeSeal(releaseRoot, manifest) {
    const directory = join(releaseRoot, 'runtime');
    const problems = [];
    let seal;
    try {
        seal = JSON.parse(await readFile(join(directory, RUNTIME_IDENTITY_FILE), 'utf8'));
    } catch (error) {
        return { ok: false, problems: [`the runtime has no sealed identity (${error instanceof Error ? error.message : String(error)})`] };
    }
    if (seal.schemaVersion !== 1 || seal.upstreamVersion !== manifest.release.upstreamVersion || seal.extRelease !== manifest.release.extRelease) {
        problems.push('the sealed runtime identity does not match the bundle manifest');
    }
    for (const [path, expected] of Object.entries(seal.files ?? {})) {
        const target = runtimeFilePath(directory, path);
        if (!target) { problems.push(`sealed path escapes the runtime: ${path}`); continue; }
        try {
            if (sha256Bytes(await readFile(target)) !== expected) problems.push(`runtime file changed since sealing: ${path}`);
        } catch {
            problems.push(`runtime file is missing: ${path}`);
        }
    }
    return { ok: problems.length === 0, problems, seal };
}

/** Verify an already prepared runtime against the bundle manifest. */
export async function inspectRuntime({ releaseRoot, manifest }) {
    const directory = join(releaseRoot, 'runtime');
    const dsh = await readPackageJson(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    const problems = [];
    if (dsh?.version !== manifest.release.upstreamVersion) {
        problems.push(`runtime resolves @deepseek-ai/dsh ${String(dsh?.version)}, expected ${manifest.release.upstreamVersion}`);
    }
    const packages = [];
    for (const item of manifest.payload.dshExt) {
        const copies = await packageCopies(directory, item.name);
        if (copies.length !== 1) { problems.push(`${item.name} has ${copies.length} runtime copies`); continue; }
        if (copies[0].identity.version !== item.version) {
            problems.push(`${item.name} resolves ${String(copies[0].identity.version)}, expected the extended ${item.version}`);
        }
        packages.push({ name: item.name, version: copies[0].identity.version, directory: copies[0].directory });
    }
    const bin = typeof dsh?.bin === 'string' ? dsh.bin : dsh?.bin?.dsh;
    const sealed = await verifyRuntimeSeal(releaseRoot, manifest);
    if (!sealed.ok) problems.push(...sealed.problems);
    return { ok: problems.length === 0, directory, dshBinary: typeof bin === 'string' ? join(directory, 'node_modules', '@deepseek-ai', 'dsh', bin) : undefined, packages, problems };
}


/** Cross-consumer singletons whose split would break service identity. */
export const RESOLUTION_SINGLETONS = Object.freeze([
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-modules',
    '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-brand',
    '@deepseek-ai/dsh-llm',
]);

/**
 * Resolve the shared singleton packages from the actual runtime consumers (the DSH
 * launcher, Host plugin and Host-only Runner plugin) and report any version split. Same-version peer
 * variants are pnpm layout, not a split; only different versions fail.
 * @param {string} releaseRoot - installed release directory.
 */
export async function auditRuntimeResolution(releaseRoot) {
    const directory = join(releaseRoot, 'runtime');
    const { realpath } = await import('node:fs/promises');
    // Resolve from the files Node actually loads, not from a package directory.
    const consumerFiles = [];
    for (const packageFile of [
        join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        join(directory, 'node_modules', 'hapi-dsh', 'package.json'),
        join(directory, 'node_modules', 'hapi-dsh', 'dist', 'runner', 'package.json'),
    ]) {
        let manifest;
        try { manifest = JSON.parse(await readFile(packageFile, 'utf8')); } catch { consumerFiles.push(packageFile); continue; }
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
        const clientExport = typeof manifest.exports === 'object' && manifest.exports !== null
            ? manifest.exports['./client']?.default : undefined;
        const relatives = [bin ?? (typeof manifest.main === 'string' ? manifest.main : undefined), clientExport]
            .filter(relative => typeof relative === 'string');
        if (relatives.length === 0) consumerFiles.push(packageFile);
        for (const relative of relatives) {
            const entry = join(dirname(packageFile), relative);
            try { consumerFiles.push(await realpath(entry)); }
            catch { consumerFiles.push(packageFile); }
        }
    }
    const packages = [];
    const problems = [];
    const unresolved = [];
    for (const name of RESOLUTION_SINGLETONS) {
        const resolved = [];
        for (const consumer of consumerFiles) {
            try {
                const require = createRequire(consumer);
                const manifestPath = require.resolve(`${name}/package.json`);
                const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
                resolved.push({ version: String(manifest.version), path: await realpath(manifestPath) });
            } catch { /* this consumer does not depend on the package */ }
        }
        const versions = [...new Set(resolved.map(entry => entry.version))];
        const paths = [...new Set(resolved.map(entry => entry.path))];
        const split = versions.length > 1;
        if (resolved.length === 0) unresolved.push(name);
        // Same version in two physical instances can still split module state;
        // report it as unshared instead of claiming coverage.
        if (split) problems.push(`${name} resolves to ${versions.length} versions (${versions.join(', ')}) across runtime consumers`);
        packages.push({ name, versions, split, shared: versions.length <= 1 && paths.length <= 1,
            resolvedBy: resolved.length, paths });
    }
    return { ok: problems.length === 0, packages, problems, unresolved,
        coverage: packages.filter(entry => entry.shared).map(entry => entry.name) };
}
