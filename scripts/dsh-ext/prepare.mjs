/** Restore the pinned, licensed DSH sources into a fresh build directory. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyCompleteWindows } from './complete-windows.mjs';
import { applyReaderPublication, applyReaderLayout } from './reader-publication.mjs';
import { applyInputContracts } from './input-contracts.mjs';
import { applyReadingOccurrences } from './reading-occurrences.mjs';
import { applyReadingTargets } from './reading-targets.mjs';
import { applyInputBindingOccurrences } from './input-binding-occurrences.mjs';
export const UPSTREAM_COMMIT = '1f81c047fc48fa190a683e469daa699857e9afe8';
export const UPSTREAM_VERSION = '0.2.1-rc.3';
export const EXTENSION_PACKAGES = ['packages/api/session-controller', 'packages/client/ui-slots', 'packages/client/ui-renderer', 'packages/client/ui-session', 'packages/client/ui-conversation', 'packages/client/ui-chat', 'packages/client/ui-trajectory', 'packages/client/ui-tool', 'packages/client/ui-plan', 'packages/client/ui-input-trigger', 'packages/client/ui-commands'];
export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || result.error?.message || String(result.status)).slice(-24_000)}`);
  return result.stdout;
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function prepareDshSource(parent = join(ROOT, '.tmp', 'hhpi-ext')) {
  const snapshot = join(ROOT, 'source-snapshots', 'dsh-ext'), patches = [join(snapshot, 'source.patch')];
  try { for (const name of (await readdir(join(snapshot, 'hhpi-patches'))).filter(name => name.endsWith('.patch')).sort()) patches.push(join(snapshot, 'hhpi-patches', name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'source-'));
  run('git', ['init', '--quiet', directory]);
  run('git', ['remote', 'add', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git'], { cwd: directory });
  run('git', ['fetch', '--quiet', '--depth=1', 'origin', UPSTREAM_COMMIT], { cwd: directory });
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: directory });
  if (run('git', ['rev-parse', 'HEAD'], { cwd: directory }).trim() !== UPSTREAM_COMMIT) throw new Error('The DSH source revision does not match the pinned input.');
  const inputs = [];
  for (const patch of patches) {
    run('git', ['apply', '--check', '--recount', patch], { cwd: directory });
    run('git', ['apply', '--recount', patch], { cwd: directory });
    inputs.push({ path: patch.slice(ROOT.length + 1), sha256: sha256(await readFile(patch)) });
  }
  const overrides = join(snapshot, 'hhpi-sources');
  const copySources = async (path, relative = '') => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(relative, entry.name), input = join(path, entry.name);
      if (entry.isDirectory()) await copySources(input, name);
      else if (entry.isFile()) {
        if (!name.replaceAll('\\', '/').startsWith('packages/')) throw new Error('An extension override must be an upstream package source.');
        await mkdir(resolve(directory, name, '..'), { recursive: true }); await cp(input, join(directory, name));
        inputs.push({ path: `source-snapshots/dsh-ext/hhpi-sources/${name}`, sha256: sha256(await readFile(input)) });
      } else throw new Error('Extension sources cannot contain symlinks.');
    }
  };
  try { await copySources(overrides); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await applyCompleteWindows(directory);
  await applyReaderPublication(directory);
  await applyReaderLayout(directory);
  await applyInputContracts(directory);
  await applyReadingOccurrences(directory);
  await applyReadingTargets(directory);
  await applyInputBindingOccurrences(directory);
  for (const file of ['complete-windows.mjs', 'reader-publication.mjs', 'input-contracts.mjs', 'reading-occurrences.mjs', 'reading-targets.mjs', 'input-binding-occurrences.mjs']) inputs.push({ path: `scripts/dsh-ext/${file}`, sha256: sha256(await readFile(new URL(file, import.meta.url))) });
  const provenance = { upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: UPSTREAM_VERSION, inputs, patchSetSha256: sha256(JSON.stringify(inputs)) };
  await writeFile(join(directory, 'hhpi-source-inputs.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return { directory, provenance };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { directory, provenance } = await prepareDshSource(process.argv[2]); console.log(JSON.stringify({ directory, ...provenance }));
}
