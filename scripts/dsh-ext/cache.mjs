/** Content-validated workflow state. Locks cover mutations, never cache a failed command. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, lstat, readlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const fingerprint = value => digest(JSON.stringify(value));
export const PNPM_WORKSPACE_STATE = 'node_modules/.pnpm-workspace-state-v1.json';
const PNPM_TIMESTAMP_NORMALIZATION = 'pnpm-workspace-state-v1:lastValidatedTimestamp';
// Vitest's per-project timing/results file is generated test state, not an
// installed dependency. Keep its directories and every other file validated.
const isVitestResult = path => /^node_modules\/\.vite\/vitest\/[a-f0-9]{40}\/results\.json$/.test(path);

/** Mask only the one top-level numeric timestamp; preserve every other byte. */
function dependencyMetadata(path, bytes) {
  if (path !== PNPM_WORKSPACE_STATE) return { bytes };
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) return { bytes };
  let value;
  try { value = JSON.parse(text); } catch { return { bytes }; }
  if (!value || Array.isArray(value) || !Number.isSafeInteger(value.lastValidatedTimestamp) || value.lastValidatedTimestamp < 0) return { bytes };
  const ranges = [];
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
    else if (character === '"') {
      const start = index++;
      for (; index < text.length; index++) { if (text[index] === '\\') index++; else if (text[index] === '"') break; }
      if (depth !== 1 || JSON.parse(text.slice(start, index + 1)) !== 'lastValidatedTimestamp') continue;
      let cursor = index + 1;
      while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
      if (text[cursor++] !== ':') continue;
      while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
      const number = text.slice(cursor).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (number) ranges.push([cursor, cursor + number[0].length]);
    }
  }
  if (ranges.length !== 1) return { bytes };
  const [start, end] = ranges[0];
  return { bytes: Buffer.from(`${text.slice(0, start)}0${text.slice(end)}`), normalization: PNPM_TIMESTAMP_NORMALIZATION };
}
export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
}
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.partial`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export async function withLock(file, work, timeout = 600_000) {
  await mkdir(dirname(file), { recursive: true });
  // The SQLite transaction is a process-held OS lock. Process exit releases it
  // atomically; no PID guessing, stale-directory removal or owner-write window.
  const database = new DatabaseSync(file);
  database.exec('PRAGMA busy_timeout=0');
  const token = randomUUID(), waitedFor = new Set();
  const started = Date.now();
  try {
    for (;;) {
      try { database.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (error.errcode !== 5) throw error;
        const owner = await readJson(`${file}.owner.json`);
        if (owner?.token) waitedFor.add(owner.token);
        if (Date.now() - started > timeout) throw new Error(`Timed out waiting for DSH workflow lock: ${file}`);
        await new Promise(done => setTimeout(done, 25));
      }
    }
    await writeJson(`${file}.owner.json`, { token });
    try { return await work({ token, waitedFor }); }
    finally { database.exec('ROLLBACK'); }
  }
  finally { database.close(); }
}

/** Only dependency snapshots normalize pnpm metadata and omit Vitest's exact results file. */
export async function snapshot(root, paths, { normalizePackage = false, normalizeLinks = false, normalizePnpmWorkspaceState = false, ignoreVitestResults = false, ignoreChildren = [] } = {}) {
  const entries = [];
  async function visit(path) {
    const absolute = join(root, path);
    let info;
    try { info = await lstat(absolute); } catch (error) { if (error.code === 'ENOENT') { entries.push({ path, missing: true }); return; } throw error; }
    if (info.isDirectory()) {
      entries.push({ path, directory: true });
      const children = await readdir(absolute);
      for (const name of children.sort()) if (!ignoreChildren.includes(name)) await visit(join(path, name));
    } else if (info.isSymbolicLink()) {
      let link = await readlink(absolute);
      if (normalizeLinks && link.startsWith(`${resolve(root)}/`)) link = `<source>/${relative(root, link)}`;
      entries.push({ path, link });
    } else if (info.isFile()) {
      if (ignoreVitestResults && isVitestResult(path)) return;
      let bytes = await readFile(absolute);
      if (normalizePackage && path.endsWith('package.json')) {
        const metadata = JSON.parse(bytes); delete metadata.hhpiSourceExtension;
        bytes = Buffer.from(JSON.stringify(metadata));
      }
      const metadata = normalizePnpmWorkspaceState ? dependencyMetadata(path, bytes) : { bytes };
      entries.push({ path, bytes: metadata.bytes.length, sha256: digest(metadata.bytes), executable: Boolean(info.mode & 0o111), ...(metadata.normalization ? { normalization: metadata.normalization } : {}) });
    } else throw new Error(`Unsupported DSH workflow output: ${absolute}`);
  }
  for (const path of [...new Set(paths)].sort()) await visit(path);
  return entries;
}
export const completeSnapshot = entries => entries.length > 0 && entries.every(entry => !entry.missing);
export async function matchesSnapshot(root, entries, options) {
  if (!Array.isArray(entries) || !completeSnapshot(entries)) return false;
  // Checking recorded roots also notices added/deleted output files.
  const directories = new Set(entries.filter(item => item.directory).map(item => item.path));
  const paths = entries.map(item => item.path).filter(path => {
    let parent = dirname(path);
    while (parent !== '.') { if (directories.has(parent)) return false; parent = dirname(parent); }
    return true;
  });
  const ordered = values => [...values].sort((a, b) => a.path.localeCompare(b.path));
  return fingerprint(ordered(await snapshot(root, paths, options))) === fingerprint(ordered(entries));
}
export const dependencySnapshot = (root, paths) => snapshot(root, paths, { normalizeLinks: true, normalizePnpmWorkspaceState: true, ignoreVitestResults: true });

/** Upgrade raw pnpm metadata only while its exact original bytes remain available. */
export async function validateDependencySnapshot(root, entries) {
  if (!Array.isArray(entries) || !completeSnapshot(entries)) return null;
  let migrated = false;
  const outputs = [];
  for (const entry of entries) {
    if (entry.sha256 && isVitestResult(entry.path)) { migrated = true; continue; }
    if (entry.path !== PNPM_WORKSPACE_STATE || entry.normalization) { outputs.push(entry); continue; }
    let bytes;
    try { bytes = await readFile(join(root, entry.path)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    // An old digest cannot prove which JSON field changed. Do not adopt a
    // changed raw file merely because it has the pnpm metadata filename.
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) return null;
    const metadata = dependencyMetadata(entry.path, bytes);
    if (!metadata.normalization) { outputs.push(entry); continue; }
    outputs.push({ ...entry, bytes: metadata.bytes.length, sha256: digest(metadata.bytes), normalization: metadata.normalization });
    migrated = true;
  }
  return await matchesSnapshot(root, outputs, { normalizeLinks: true, normalizePnpmWorkspaceState: true, ignoreVitestResults: true }) ? { outputs, migrated } : null;
}
export function environmentIdentity(command, version, commandSha256) {
  return { node: process.version, platform: process.platform, arch: process.arch, command, version, commandSha256 };
}
