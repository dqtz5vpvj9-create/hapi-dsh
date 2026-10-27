/**
 * Minimal USTAR reader/writer built on Node builtins only.
 *
 * The installer may not rely on `tar` being on PATH and may not install a
 * package before extracting the bundle, so it needs its own reader. The writer
 * is deterministic (sorted entries, fixed mtime) and is reused by the bundle
 * packer for placeholder payloads.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { chmod, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const MAX_NAME = 100;
const MAX_PREFIX = 155;

function octal(value, width) {
    const digits = Math.floor(value).toString(8);
    if (digits.length > width - 1) throw new Error(`tar field overflow: ${value}`);
    return digits.padStart(width - 1, '0') + '\0';
}

function writeText(buffer, text, offset, width) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > width) throw new Error(`tar field too long: ${text}`);
    bytes.copy(buffer, offset);
}

function splitName(path) {
    if (Buffer.byteLength(path) <= MAX_NAME) return { name: path, prefix: '' };
    for (let index = path.length - 1; index > 0; index--) {
        if (path[index] !== '/') continue;
        const prefix = path.slice(0, index);
        const name = path.slice(index + 1);
        if (Buffer.byteLength(name) <= MAX_NAME && Buffer.byteLength(prefix) <= MAX_PREFIX) return { name, prefix };
    }
    throw new Error(`tar entry path is too long for ustar: ${path}`);
}

function buildHeader({ path, size, mode, mtime, type, linkname = '' }) {
    const { name, prefix } = splitName(path);
    const header = Buffer.alloc(BLOCK);
    writeText(header, name, 0, MAX_NAME);
    writeText(header, octal(mode, 8), 100, 8);
    writeText(header, octal(0, 8), 108, 8);
    writeText(header, octal(0, 8), 116, 8);
    writeText(header, octal(size, 12), 124, 12);
    writeText(header, octal(mtime, 12), 136, 12);
    header.fill(0x20, 148, 156);
    writeText(header, type, 156, 1);
    if (linkname) writeText(header, linkname, 157, 100);
    writeText(header, 'ustar', 257, 6);
    writeText(header, '00', 263, 2);
    writeText(header, 'root', 265, 32);
    writeText(header, 'root', 297, 32);
    writeText(header, prefix, 345, MAX_PREFIX);
    let sum = 0;
    for (const byte of header) sum += byte;
    writeText(header, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return header;
}

function padToBlock(bytes) {
    const remainder = bytes.length % BLOCK;
    if (remainder === 0) return Buffer.alloc(0);
    return Buffer.alloc(BLOCK - remainder);
}

/**
 * Build a gzipped tarball from explicit entries.
 * entries: [{ path, data?, mode?, mtime?, type?: 'file'|'dir' }]
 */
export function createTgz(entries, { gzip = true, mtime = 0 } = {}) {
    const seen = new Set();
    const parts = [];
    const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    for (const entry of sorted) {
        const type = entry.type ?? 'file';
        const path = type === 'dir' ? `${entry.path.replace(/\/+$/, '')}/` : entry.path.replace(/^\/+/, '');
        if (seen.has(path)) throw new Error(`duplicate tar entry: ${path}`);
        seen.add(path);
        const data = type === 'dir' ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
        const mode = entry.mode ?? (type === 'dir' ? 0o755 : 0o644);
        const stamp = entry.mtime ?? mtime;
        const header = buildHeader({ path, size: data.length, mode, mtime: stamp, type: type === 'dir' ? '5' : '0' });
        parts.push(header, data, padToBlock(data));
    }
    parts.push(ZERO_BLOCK, ZERO_BLOCK);
    const archive = Buffer.concat(parts);
    return gzip ? gzipSync(archive, { level: 9 }) : archive;
}

/** Package a directory as `<prefix>/...` entries (npm-pack layout without npm). */
export async function createTgzFromDirectory(root, { prefix = 'package', gzip = true, mtime = 0 } = {}) {
    const entries = [{ path: prefix, type: 'dir', mode: 0o755 }];
    async function visit(directory) {
        const { readdir } = await import('node:fs/promises');
        const items = await readdir(directory, { withFileTypes: true });
        for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = join(directory, item.name);
            const rel = relative(root, absolute).split('\\').join('/');
            const entryPath = `${prefix}/${rel}`;
            if (item.isDirectory()) {
                entries.push({ path: entryPath, type: 'dir', mode: 0o755 });
                await visit(absolute);
            } else if (item.isFile()) {
                const info = await stat(absolute);
                entries.push({ path: entryPath, data: await readFile(absolute), mode: info.mode & 0o777, mtime });
            } else {
                throw new Error(`refusing to package a non-regular file: ${rel}`);
            }
        }
    }
    await visit(root);
    return createTgz(entries, { gzip, mtime });
}

function parseOctal(buffer) {
    const text = buffer.toString('utf8').replace(/\0.*$/, '').trim();
    if (text === '') return 0;
    if (!/^[0-7]+$/.test(text)) throw new Error(`invalid tar numeric field: ${JSON.stringify(text)}`);
    return Number.parseInt(text, 8);
}

function parsePaxRecords(data) {
    const records = {};
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space < 0) break;
        const length = Number.parseInt(data.toString('utf8', offset, space), 10);
        if (!Number.isFinite(length) || length <= 0) break;
        const record = data.toString('utf8', space + 1, offset + length - 1);
        const equals = record.indexOf('=');
        if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
        offset += length;
    }
    return records;
}

function headerChecksumValid(header) {
    const stored = parseOctal(header.subarray(148, 156));
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of copy) sum += byte;
    return sum === stored;
}

/**
 * Iterate archive entries. Returns [{ path, type, size, mode, mtime, data? }].
 * GNU long names and PAX path/size records are honoured; symlinks and devices
 * are reported but never extracted by `extractTgz`.
 */
export function readTar(archive, { withData = false } = {}) {
    const entries = [];
    let offset = 0;
    let pendingPath;
    let pendingSize;
    while (offset + BLOCK <= archive.length) {
        const header = archive.subarray(offset, offset + BLOCK);
        if (header.equals(ZERO_BLOCK)) break;
        if (!headerChecksumValid(header)) throw new Error(`tar header checksum mismatch at offset ${offset}`);
        offset += BLOCK;
        const type = String.fromCharCode(header[156] || 0x30);
        const size = pendingSize ?? parseOctal(header.subarray(124, 136));
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const prefix = header.subarray(345, 345 + MAX_PREFIX).toString('utf8').replace(/\0.*$/, '');
        const path = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
        const data = archive.subarray(offset, offset + size);
        offset += size + ((size % BLOCK === 0) ? 0 : BLOCK - (size % BLOCK));
        pendingPath = undefined;
        pendingSize = undefined;
        if (type === 'x' || type === 'g') {
            const records = parsePaxRecords(data);
            if (type === 'x') {
                if (records.path !== undefined) pendingPath = records.path;
                if (records.size !== undefined) pendingSize = Number.parseInt(records.size, 10);
            }
            continue;
        }
        if (type === 'L') {
            pendingPath = data.toString('utf8').replace(/\0.*$/, '');
            continue;
        }
        if (type === 'K') continue;
        const mode = parseOctal(header.subarray(100, 108));
        const mtime = parseOctal(header.subarray(136, 148));
        entries.push({ path, type: type === '0' || type === '\0' ? 'file' : type === '5' ? 'dir' : type === '2' ? 'symlink' : type === '1' ? 'hardlink' : 'other', size, mode, mtime, ...(withData ? { data } : {}) });
    }
    return entries;
}

/** Safe join for an archive path; throws when the entry escapes the target root. */
function resolveEntryPath(root, entryPath, type) {
    if (entryPath.includes('\0')) throw new Error('tar entry path contains a NUL byte');
    const normalized = entryPath.replace(/^\.\/+/, '');
    if (normalized === '' || normalized === '.') return undefined;
    if (isAbsolute(normalized) || /^[A-Za-z]:[\\/]/.test(normalized)) throw new Error(`tar entry uses an absolute path: ${entryPath}`);
    const target = join(root, ...normalized.split('/'));
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`tar entry escapes its destination: ${entryPath}`);
    return { target, isDirectory: type === 'dir' };
}

/**
 * Extract a gzipped tarball into `targetDirectory`.
 * Rejects symlinks, hardlinks, device nodes and path traversal instead of
 * silently materialising them.
 */
export async function extractTgz(buffer, targetDirectory) {
    const { mkdir: makeDirectory } = await import('node:fs/promises');
    await makeDirectory(targetDirectory, { recursive: true, mode: 0o755 });
    const entries = readTar(gunzipSync(buffer), { withData: true });
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
        const resolved = resolveEntryPath(targetDirectory, entry.path, entry.type);
        if (!resolved) continue;
        if (entry.type === 'dir') {
            await mkdir(resolved.target, { recursive: true, mode: 0o755 });
            continue;
        }
        if (entry.type !== 'file') throw new Error(`refusing to extract a ${entry.type} entry from the bundle: ${entry.path}`);
        await mkdir(dirname(resolved.target), { recursive: true, mode: 0o755 });
        await writeFile(resolved.target, entry.data);
        await chmod(resolved.target, entry.mode & 0o777 || 0o644);
        if (entry.mtime > 0) {
            const date = new Date(entry.mtime * 1000);
            await utimes(resolved.target, date, date);
        }
        files += 1;
        bytes += entry.size;
    }
    return { files, bytes };
}

/** Read a gzipped tarball without shelling out to `tar`. */
export function readTgz(buffer, options = {}) {
    return readTar(gunzipSync(buffer), options);
}

export function listTgz(buffer) {
    return readTgz(buffer).map(({ path, type, size, mode, mtime }) => ({ path, type, size, mode, mtime }));
}
