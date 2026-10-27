/**
 * Content digests shared by the bundle producer, the installer and doctor.
 *
 * Only Node builtins are used here: this module is copied into the bundle and
 * executed by `dist/install.mjs` before hapi-dsh (or any dependency) exists.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export function sha256Bytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path) {
    return sha256Bytes(await readFile(path));
}

/** Stable JSON: object keys sorted recursively so equal values always hash equally. */
export function canonicalJson(value) {
    return JSON.stringify(sortValue(value));
}

function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
        const result = {};
        for (const key of Object.keys(value).sort()) {
            const item = value[key];
            if (item === undefined) continue;
            result[key] = sortValue(item);
        }
        return result;
    }
    return value;
}

/** Hash a digest map (relative path -> sha256) without depending on directory order. */
export function digestOfEntries(entries) {
    const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return sha256Bytes(canonicalJson(sorted));
}

/** Digest every regular file under `root`; returns { digest, files: [{ path, sha256, size }] }. */
export async function digestTree(root, { ignore = [] } = {}) {
    const ignoreSet = new Set(ignore);
    const files = [];
    async function visit(directory) {
        const items = await readdir(directory, { withFileTypes: true });
        for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = join(directory, item.name);
            const rel = relative(root, absolute).split(sep).join('/');
            if (ignoreSet.has(rel)) continue;
            if (item.isDirectory()) await visit(absolute);
            else if (item.isFile()) files.push({ path: rel, sha256: await sha256File(absolute), size: (await readFile(absolute)).byteLength });
        }
    }
    await visit(root);
    return { digest: digestOfEntries(files), files };
}
