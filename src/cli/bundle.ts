/**
 * `hapi-dsh bundle` — the post-install side of the distribution layer.
 *
 * First installation happens through the bundle's own `dist/install.mjs`
 * (hapi-dsh is not installed yet at that point). This command covers the
 * operations that need the private configuration and the pinned official
 * launcher: status, verify, upgrade from an extracted bundle, rollback, prune.
 */
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from './config.ts';
import { resolveDshCommand, runCommand, runtimeEnvironment, type Command, type CommandRunner } from './runtime.ts';
import { digest, ops, release, tar, type InstallResult } from './release.ts';

export const BUNDLE_HELP = `hapi-dsh bundle — manage immutable hapi-dsh release directories

Usage:
  hapi-dsh bundle status [--json]
  hapi-dsh bundle verify [--json]
  hapi-dsh bundle upgrade (--bundle-root DIR | --tgz FILE) [--role host|runner] [--dry-run]
  hapi-dsh bundle install (--bundle-root DIR | --tgz FILE) [--role host|runner] [--dry-run]
  hapi-dsh bundle rollback [--role host|runner]
  hapi-dsh bundle prune [--keep-previous N]

Options:
  --bundle-root DIR  Extracted bundle package/ directory
  --tgz FILE         hapi-dsh-bundle-<version>.tgz; extracted into the release store
  --role ROLE        host (default) or runner profile
  --style STYLE      tarball (default) or directory pnpm overrides fallback
  --dry-run          Verify and stage, print the plan, change nothing
  --keep-previous N  Previous releases to retain (minimum 2)
  --json             Machine-readable output

The release pointer only moves after the 30s health gate passes. A failed
upgrade keeps the previous active release and restores its profile manifest and
lockfile; session logs, queues and approvals are never rolled back.
`;

export interface BundleFlags {
    [name: string]: string | true | undefined;
}

export interface BundleContext {
    config: RuntimeConfig;
    configFile: string;
    command?: Command;
    run?: CommandRunner;
    pnpm?: Command;
    logger?: (message: string) => void;
    json?: boolean;
}

function flagValue(flags: BundleFlags, name: string): string | undefined {
    const value = flags[name];
    return typeof value === 'string' ? value : undefined;
}

function integerFlag(flags: BundleFlags, name: string, fallback: number): number {
    const value = flagValue(flags, name);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
    return Number(value);
}

async function pathExists(path: string): Promise<boolean> {
    return lstat(path).then(() => true).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    });
}

/** Extract a bundle tarball into a content-addressed cache directory. */
export async function extractBundleTarball({ file, dshHome }: { file: string; dshHome: string }): Promise<string> {
    const archive = await readFile(file);
    const sha256 = digest.sha256Bytes(archive);
    const target = join(release.stateRoot(dshHome), 'bundles', sha256.slice(0, 16));
    const bundleRoot = join(target, 'package');
    if (!(await pathExists(join(bundleRoot, 'manifest.json')))) {
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rm(temporary, { recursive: true, force: true });
        await mkdir(temporary, { recursive: true, mode: 0o755 });
        try {
            await tar.extractTgz(archive, temporary);
            const extracted = join(temporary, 'package');
            if (!(await pathExists(join(extracted, 'manifest.json')))) throw new Error('the archive is not a hapi-dsh bundle (no package/manifest.json)');
            await rename(extracted, target).catch(async (error: NodeJS.ErrnoException) => {
                if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return;
                throw error;
            });
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    }
    await release.verifyBundleRoot(bundleRoot);
    return bundleRoot;
}

function summarizeInstall(result: InstallResult): string {
    if (!result.ok) {
        const lines = [`FAILED  ${result.error ?? 'installation failed'}`];
        if (result.rolledBack) lines.push('The new release did not pass its health gate and was rolled back.');
        if (result.oldActivePreserved) lines.push('The previous active release is preserved.');
        return lines.join('\n');
    }
    if (result.waiting) return `WAITING  ${result.reason ?? 'the running Host/Runner is not idle'}\nNothing was activated; re-run the command when idle.`;
    if (result.dryRun) return `DRY RUN  release ${result.releaseId}\n  directory: ${result.releaseDirectory}\nNo profile or release pointer was changed.`;
    if (result.idempotent) return `UNCHANGED  release ${result.releaseId} is already active for profile ${result.profile}`;
    return `OK  release ${result.releaseId} is active for profile ${result.profile}\n  restart the ${result.role} to load it; health gate attempts: ${result.healthAttempts}`;
}

export async function bundleCommand(action: string | undefined, flags: BundleFlags, context: BundleContext): Promise<number> {
    const { config, configFile } = context;
    const json = context.json ?? flags.json === true;
    const logger = context.logger ?? ((message: string) => { process.stderr.write(`[bundle] ${message}\n`); });
    const run = context.run ?? runCommand;
    const dshHome = config.dsh.home;
    const profile = config.dsh.profile;
    const role = (flagValue(flags, 'role') ?? 'host') as 'host' | 'runner';
    if (role !== 'host' && role !== 'runner') throw new Error('--role must be host or runner');
    const style = flagValue(flags, 'style') === 'directory' ? 'directory' : 'tarball';

    if (action === undefined || action === 'help') {
        process.stdout.write(BUNDLE_HELP);
        return action === undefined ? 1 : 0;
    }

    const resolveLauncher = async (): Promise<Command> => context.command ?? await resolveDshCommand(config);
    const environment = runtimeEnvironment(config, configFile);

    if (action === 'status') {
        const result = await ops.statusRelease({ dshHome, profile });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.ok ? 0 : 1;
    }
    if (action === 'verify') {
        const store = await ops.verifyReleaseStore({ dshHome });
        process.stdout.write(`${JSON.stringify(store, null, 2)}\n`);
        return store.ok ? 0 : 1;
    }
    if (action === 'prune') {
        const result = await ops.pruneReleaseStore({ dshHome, keepPrevious: integerFlag(flags, 'keep-previous', release.DEFAULT_KEEP_PREVIOUS), logger });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.ok ? 0 : 1;
    }
    if (action === 'rollback') {
        const command = await resolveLauncher();
        const result = await ops.rollbackRelease({
            dshHome,
            profile,
            command,
            run,
            env: environment,
            logger: json ? () => {} : (message) => logger(message),
            pnpm: context.pnpm ?? { executable: 'pnpm', args: [] },
        });
        process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.ok ? 'OK' : 'FAILED'}  ${result.from ?? ''} -> ${result.to ?? ''}\n${result.ok ? 'The previous release, profile manifest and lockfile were restored. Session logs, queues and approvals were not touched.' : result.error ?? ''}\n`);
        return result.ok ? 0 : 1;
    }
    if (action === 'install' || action === 'upgrade') {
        const bundleRootFlag = flagValue(flags, 'bundle-root');
        const tgzFlag = flagValue(flags, 'tgz');
        if (bundleRootFlag && tgzFlag) throw new Error('pass either --bundle-root or --tgz, not both');
        if (!bundleRootFlag && !tgzFlag) throw new Error(`${action} requires --bundle-root DIR or --tgz FILE (extract the release tarball first)`);
        const bundleRoot = tgzFlag
            ? await extractBundleTarball({ file: resolve(tgzFlag), dshHome })
            : resolve(bundleRootFlag!);
        const command = await resolveLauncher();
        const result = await ops.installRelease({
            bundleRoot,
            dshHome,
            profile,
            role,
            style,
            command,
            run,
            env: environment,
            dryRun: flags['dry-run'] === true,
            keepPrevious: integerFlag(flags, 'keep-previous', release.DEFAULT_KEEP_PREVIOUS),
            logger: json ? () => {} : (message) => logger(`${action}: ${message}`),
            pnpm: context.pnpm ?? { executable: 'pnpm', args: [] },
        });
        if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else process.stdout.write(`${summarizeInstall(result)}\n`);
        return result.ok ? 0 : 1;
    }
    throw new Error(`unknown bundle action ${action}; run hapi-dsh bundle --help`);
}
