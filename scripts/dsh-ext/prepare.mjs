/** Restore the licensed DSH rc with the matching, consolidated source patch. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const UPSTREAM_COMMIT = '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db';
export const UPSTREAM_VERSION = '0.2.2-rc.1';
export const UI_EXTENSION_PACKAGES = ['packages/client/file-upload', 'packages/api/session-controller', 'packages/client/ui-slots', 'packages/client/ui-renderer', 'packages/client/ui-session', 'packages/client/ui-conversation', 'packages/client/ui-chat', 'packages/client/ui-trajectory', 'packages/client/ui-tool', 'packages/client/ui-plan', 'packages/client/ui-input-trigger', 'packages/client/ui-commands'];
export const NATIVE_EXTENSION_PACKAGES = ['packages/session/session-persistence', 'packages/session/session-format-v3-to-v4', 'packages/session/session-persistence-jsonl'];
export const EXTENSION_PACKAGES = [...UI_EXTENSION_PACKAGES, ...NATIVE_EXTENSION_PACKAGES];
export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || result.error?.message || String(result.status)).slice(-24_000)}`);
  return result.stdout;
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function prepareDshSource(parent = '/mnt/cache/data-cache/hhpi-dsh-ext') {
  const patch = join(ROOT, 'source-snapshots/dsh-ext/source.patch');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'source-'));
  run('git', ['init', '--quiet', directory]);
  run('git', ['remote', 'add', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git'], { cwd: directory });
  run('git', ['fetch', '--quiet', '--depth=1', 'origin', UPSTREAM_COMMIT], { cwd: directory });
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: directory });
  if (run('git', ['rev-parse', 'HEAD'], { cwd: directory }).trim() !== UPSTREAM_COMMIT) throw new Error('The DSH source revision does not match the pinned input.');
  run('git', ['apply', '--check', patch], { cwd: directory });
  run('git', ['apply', patch], { cwd: directory });
  const provenance = await sourceProvenance();
  await writeFile(join(directory, 'hhpi-source-inputs.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return { directory, provenance };
}
export async function sourceProvenance() {
  const inputs = [{ path: 'source-snapshots/dsh-ext/source.patch', sha256: sha256(await readFile(join(ROOT, 'source-snapshots/dsh-ext/source.patch'))) }];
  const identity = { upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: UPSTREAM_VERSION, inputs, patchSetSha256: sha256(JSON.stringify(inputs)) };
  return { ...identity, nativeSourceExtension: identity };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { directory, provenance } = await prepareDshSource(process.argv[2]); console.log(JSON.stringify({ directory, ...provenance }));
}
