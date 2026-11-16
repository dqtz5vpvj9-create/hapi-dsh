/** Materialize the explicitly pinned fork package without relaxing pnpm's
 * transitive-source policy. Metadata comes from the already verified payload. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTgz } from './tar.mjs';

const NAME = '@dsh-remote/native-runtime';
const MAX_BYTES = 16 * 1024 * 1024;

export async function prepareNativeRuntimeDependency({ releaseRoot, manifest, fetchPackage = fetch }) {
    const payload = readTgz(await readFile(join(releaseRoot, manifest.payload.hapi.tarball)), { withData: true });
    const json = path => {
        const item = payload.find(entry => entry.path === `package/${path}`);
        return item?.data ? JSON.parse(item.data.toString('utf8')) : undefined;
    };
    const spec = json('package.json')?.dependencies?.[NAME];
    if (!spec) return [];
    const pin = json('UPSTREAMS.json')?.remoteNativeRuntime;
    if (!pin || pin.package !== NAME || spec !== pin.tarball || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity ?? '') ||
        typeof pin.version !== 'string' || typeof pin.repository !== 'string' ||
        !pin.repository.startsWith('https://github.com/') || !pin.tarball.startsWith(`${pin.repository}/releases/download/`) ||
        pin.tarball.includes('/latest/') || !pin.tarball.endsWith('.tgz')) {
        throw new Error('Shared native runtime requires an exact release URL and integrity pin');
    }
    const directory = join(releaseRoot, 'runtime');
    const vendor = join(directory, 'vendor');
    await mkdir(vendor, { recursive: true });
    if (!(await lstat(vendor)).isDirectory()) throw new Error('Native runtime vendor path must be a private directory');
    const target = join(vendor, 'native-runtime.tgz');
    const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && !existing.isFile()) throw new Error('Native runtime cache must be a regular file');
    let bytes = existing ? await readFile(target) : undefined;
    if (!bytes) {
        const response = await fetchPackage(pin.tarball, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok || !response.body) throw new Error(`Native runtime download failed (${response.status})`);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > MAX_BYTES) throw new Error('Native runtime download exceeds the package budget');
            chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
    }
    if (bytes.length > MAX_BYTES || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== pin.integrity) {
        throw new Error('Native runtime package integrity does not match the verified release');
    }
    const entry = readTgz(bytes, { withData: true }).find(entry => entry.path === 'package/package.json');
    const identity = entry?.data && JSON.parse(entry.data.toString('utf8'));
    if (identity?.name !== NAME || identity.version !== pin.version) throw new Error('Native runtime package identity differs from the verified release');
    if (!existing) await writeFile(target, bytes, { flag: 'wx' });
    // pnpm 11 reads overrides from this file, rather than the deprecated
    // package.json field. Only this verified package receives an override.
    await writeFile(join(directory, 'pnpm-workspace.yaml'), `overrides:\n  '${NAME}': 'file:vendor/native-runtime.tgz'\n`);
    return ['pnpm-workspace.yaml', 'vendor/native-runtime.tgz'];
}
