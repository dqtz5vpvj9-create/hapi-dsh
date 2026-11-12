/** Restore the licensed DSH rc with the matching, consolidated source patch. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint, readJson, snapshot, withLock, writeJson } from './cache.mjs';
export const UPSTREAM_COMMIT = '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db';
export const UPSTREAM_VERSION = '0.2.2-rc.1';
export const UI_EXTENSION_PACKAGES = ['packages/client/file-upload', 'packages/api/session-controller', 'packages/client/ui-slots', 'packages/client/ui-renderer', 'packages/client/ui-session', 'packages/client/ui-conversation', 'packages/client/ui-chat', 'packages/client/ui-trajectory', 'packages/client/ui-tool', 'packages/client/ui-plan', 'packages/client/ui-input-trigger', 'packages/client/ui-commands', 'packages/client/ui-sidebar-files', 'packages/client/ui-workspace', 'packages/client/ui-theme'];
export const NATIVE_EXTENSION_PACKAGES = ['packages/session/session-persistence', 'packages/session/session-format-v3-to-v4', 'packages/session/session-persistence-jsonl'];
export const WORKSPACE_EXTENSION_PACKAGES = ['packages/api/terminal-controller'];
export const FILESYSTEM_EXTENSION_PACKAGES = ['packages/fs/fs', 'packages/fs/fs-local', 'packages/fs/fs-sandbox'];
export const TRANSLATION_EXTENSION_PACKAGES = ['packages/experimental/translator', 'packages/experimental/client-ui-cot-translation'];
export const EXTENSION_PACKAGES = [...UI_EXTENSION_PACKAGES, ...WORKSPACE_EXTENSION_PACKAGES, ...FILESYSTEM_EXTENSION_PACKAGES, ...NATIVE_EXTENSION_PACKAGES, ...TRANSLATION_EXTENSION_PACKAGES];
export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || result.error?.message || String(result.status)).slice(-24_000)}`);
  return result.stdout;
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function sourceSnapshot(directory) {
  const paths = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: directory }).split('\0')
    .filter(path => path && !path.split('/').some(part => ['node_modules', 'lib', '.git'].includes(part))
      && !path.startsWith('.hhpi-') && path !== 'hhpi-source-inputs.json');
  return snapshot(directory, paths, { normalizePackage: true });
}
export async function prepareDshSource(parent = '/mnt/cache/data-cache/hhpi-dsh-ext', options = {}) {
  parent = resolve(parent);
  const patch = options.patch ?? join(ROOT, 'source-snapshots/dsh-ext/source.patch');
  const patchBytes = await readFile(patch);
  const provenance = await sourceProvenance(patch, patchBytes);
  const directory = join(parent, `source-${UPSTREAM_COMMIT.slice(0, 12)}-${provenance.patchSetSha256}`);
  const execute = options.run ?? run;
  await mkdir(parent, { recursive: true });
  return withLock(`${directory}.lock`, async () => {
    const record = await readJson(join(directory, '.hhpi-prepared.json'));
    if (record) {
      if (execute('git', ['rev-parse', 'HEAD'], { cwd: directory }).trim() !== UPSTREAM_COMMIT
        || fingerprint(record.provenance) !== fingerprint(provenance)
        || record.sourceSha256 !== fingerprint(await sourceSnapshot(directory))
        || fingerprint(await readJson(join(directory, 'hhpi-source-inputs.json'))) !== fingerprint(provenance)) {
        throw new Error(`Prepared DSH source was edited or damaged; preserved without overwrite: ${directory}`);
      }
      return { directory, provenance, reused: true };
    }
    try { await stat(directory); throw new Error(`Unrecognized prepared DSH directory; preserved without overwrite: ${directory}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Reuse git objects from explicitly supplied/local prepared checkouts. Never
    // reset these candidates or inherit their working-tree modifications.
    const candidates = [...(options.references ?? []), ...((await readdir(parent, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith('source-')).slice(0, 32).map(item => join(parent, item.name)))];
    let local;
    for (const candidate of candidates) {
      if (resolve(candidate) === directory) continue;
      try { execute('git', ['cat-file', '-e', `${UPSTREAM_COMMIT}^{commit}`], { cwd: candidate }); local = candidate; break; } catch { /* not this pinned object */ }
    }
    const staging = await mkdtemp(join(parent, '.preparing-'));
    try {
      execute('git', ['init', '--quiet', staging]);
      execute('git', ['remote', 'add', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git'], { cwd: staging });
      execute('git', ['fetch', '--quiet', '--depth=1', local ?? 'origin', UPSTREAM_COMMIT], { cwd: staging });
      execute('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: staging });
      if (execute('git', ['rev-parse', 'HEAD'], { cwd: staging }).trim() !== UPSTREAM_COMMIT) throw new Error('The DSH source revision does not match the pinned input.');
      const capturedPatch = join(staging, '.hhpi-input.patch');
      await writeFile(capturedPatch, patchBytes);
      execute('git', ['apply', '--check', capturedPatch], { cwd: staging });
      execute('git', ['apply', capturedPatch], { cwd: staging });
      await rm(capturedPatch);
      await writeJson(join(staging, 'hhpi-source-inputs.json'), provenance);
      await writeJson(join(staging, '.hhpi-prepared.json'), { provenance, sourceSha256: fingerprint(await sourceSnapshot(staging)) });
      await rename(staging, directory);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return { directory, provenance, reused: false, localObjects: Boolean(local) };
  });
}
export async function sourceProvenance(patch = join(ROOT, 'source-snapshots/dsh-ext/source.patch'), patchBytes) {
  const inputs = [{ path: 'source-snapshots/dsh-ext/source.patch', sha256: sha256(patchBytes ?? await readFile(patch)) }];
  const identity = { upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: UPSTREAM_VERSION, inputs, patchSetSha256: sha256(JSON.stringify(inputs)) };
  return { ...identity, nativeSourceExtension: identity };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { directory, provenance, ...reuse } = await prepareDshSource(process.argv[2], { references: process.env.DSH_SOURCE_REFERENCE ? [process.env.DSH_SOURCE_REFERENCE] : [] }); console.log(JSON.stringify({ directory, ...provenance, ...reuse }));
}
