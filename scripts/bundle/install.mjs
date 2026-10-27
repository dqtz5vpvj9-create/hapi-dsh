#!/usr/bin/env node
/**
 * Standalone bundle entry point. Runs before hapi-dsh exists, so it only uses
 * Node builtins and the `lib/` modules shipped inside the bundle.
 *
 *   node dist/install.mjs install --profile hapi --role host
 *   node dist/install.mjs upgrade --profile hapi --role host --dry-run
 *   node dist/install.mjs rollback --profile hapi
 *   node dist/install.mjs status|verify|prune
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    installRelease, rollbackRelease, statusRelease, verifyReleaseStore, pruneReleaseStore,
} from './lib/ops.mjs';
import { dshHomeFromEnv, verifyBundleRoot, verifyPayloadTarballs } from './lib/release.mjs';
import { listTgz, readTgz } from './lib/tar.mjs';

const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `hapi-dsh-bundle — install, upgrade, roll back and audit a hapi-dsh bundle

Usage:
  node dist/install.mjs install   --profile NAME --role host|runner [options]
  node dist/install.mjs upgrade   --profile NAME --role host|runner [options]
  node dist/install.mjs rollback  --profile NAME [--to RELEASE_ID] [options]
  node dist/install.mjs status    [--profile NAME] [--json]
  node dist/install.mjs verify    [--json]
  node dist/install.mjs prune     [--keep-previous N]

Options:
  --dsh-home DIR           DSH home to install into (default: $DSH_HOME or ~/.dsh)
  --bundle-root DIR        Extracted bundle package/ directory (default: this bundle)
  --style tarball|dir      pnpm override style; 'dir' is the documented fallback
  --dsh-command PATH       Official DSH launcher (default: dsh on PATH)
  --pnpm-command PATH      pnpm executable (default: pnpm on PATH)
  --dry-run                Verify and stage, print the plan, change nothing
  --wait-idle-timeout MS   Wait this long at waiting-idle before reporting (default 0: stop)
  --health-timeout MS      Health gate timeout (default 30000)
  --health-url URL         Optional live health endpoint polled during the gate
  --keep-previous N        Previous releases to retain (minimum 2, default 2)
  --json                   Print a machine-readable result

Exit status: 0 success (including an idempotent no-op), 1 failure (the previous
active release is preserved), 2 usage error.
`;

function parseArguments(argv) {
    const leading = argv[0];
    const options = { command: leading === undefined || leading === '--help' || leading === '-h' ? 'help' : leading, flags: {} };
    if (leading === '--help' || leading === '-h') return options;
    const valueFlags = new Set(['profile', 'role', 'dsh-home', 'bundle-root', 'style', 'dsh-command', 'pnpm-command', 'wait-idle-timeout', 'health-timeout', 'health-interval', 'health-url', 'keep-previous', 'to']);
    const booleanFlags = new Set(['dry-run', 'json', 'help']);
    for (let index = 1; index < argv.length; index++) {
        const argument = argv[index];
        if (!argument.startsWith('--')) throw new UsageError(`unexpected argument: ${argument}`);
        const separator = argument.indexOf('=');
        const name = argument.slice(2, separator < 0 ? undefined : separator);
        if (booleanFlags.has(name)) {
            if (separator >= 0) throw new UsageError(`--${name} does not take a value`);
            options.flags[name] = true;
            continue;
        }
        if (!valueFlags.has(name)) throw new UsageError(`unknown option: --${name}`);
        const value = separator >= 0 ? argument.slice(separator + 1) : argv[++index];
        if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} requires a value`);
        options.flags[name] = value;
    }
    return options;
}

class UsageError extends Error {}

function integerFlag(flags, name, fallback) {
    if (flags[name] === undefined) return fallback;
    const value = Number(flags[name]);
    if (!Number.isInteger(value) || value < 0) throw new UsageError(`--${name} must be a non-negative integer`);
    return value;
}

function logger(message) {
    process.stderr.write(`[hapi-dsh-bundle] ${message}\n`);
}

function summary(result) {
    const lines = [];
    if (result.ok === false) {
        lines.push(`FAILED  ${result.error ?? 'installation failed'}`);
        if (result.rolledBack) lines.push('The new release did not pass its health gate; it was rolled back.');
        if (result.oldActivePreserved) lines.push('The previous active release was preserved.');
        if (result.reverted) lines.push(`Profile revert: restored ${result.reverted.restored?.join(', ') || 'nothing'}; dependencies reinstalled: ${result.reverted.reinstalled ? 'yes' : 'no'}${result.reverted.warning ? `; warning: ${result.reverted.warning}` : ''}`);
        return lines.join('\n');
    }
    if (result.waiting) {
        lines.push(`WAITING  the ${result.role} is not idle: ${result.reason}`);
        lines.push('Re-run the same command when the running sessions have finished. Nothing was activated.');
        return lines.join('\n');
    }
    if (result.dryRun) {
        lines.push(`DRY RUN  release ${result.releaseId}`);
        lines.push(`  release directory: ${result.releaseDirectory}`);
        for (const check of result.checks) lines.push(`  ${check.status.toUpperCase().padEnd(7)} ${check.name}: ${check.detail}`);
        for (const [name, spec] of Object.entries(result.managedOverrides)) lines.push(`  override ${name}: ${spec}`);
        for (const command of result.plannedCommands) lines.push(`  would run: dsh ${command.args.join(' ')}`);
        lines.push('No profile, release pointer or client resource was modified.');
        return lines.join('\n');
    }
    if (result.idempotent) {
        lines.push(`UNCHANGED  release ${result.releaseId} is already active for profile ${result.profile}`);
        return lines.join('\n');
    }
    if (result.state === 'healthy') {
        lines.push(`OK  release ${result.releaseId} is active for profile ${result.profile} (${result.role})`);
        lines.push(`  retained releases: ${(result.retained ?? []).length}`);
        lines.push(`  restart the ${result.role ?? result.role} to load the new release; health gate attempts: ${result.healthAttempts}`);
    }
    if (result.state === 'rolled-back' || result.from) lines.push(`ROLLED BACK  ${result.from ?? ''} -> ${result.to ?? ''}`);
    return lines.join('\n');
}

async function installCommand(options, { upgrade = false } = {}) {
    const { flags } = options;
    const profile = flags.profile;
    if (typeof profile !== 'string') throw new UsageError('install requires --profile');
    const role = flags.role ?? 'host';
    if (role !== 'host' && role !== 'runner') throw new UsageError('--role must be host or runner');
    const dshHome = resolve(flags['dsh-home'] ?? dshHomeFromEnv());
    const root = resolve(flags['bundle-root'] ?? bundleRoot);
    const waitIdleTimeout = integerFlag(flags, 'wait-idle-timeout', 0);
    const command = typeof flags['dsh-command'] === 'string' ? { executable: flags['dsh-command'], args: [] } : { executable: 'dsh', args: [] };
    const pnpm = typeof flags['pnpm-command'] === 'string' ? { executable: flags['pnpm-command'], args: [] } : { executable: 'pnpm', args: [] };
    return installRelease({
        bundleRoot: root,
        dshHome,
        profile,
        role,
        style: (flags.style ?? 'tarball') === 'dir' || flags.style === 'directory' ? 'directory' : 'tarball',
        command,
        pnpm,
        dryRun: flags['dry-run'] === true,
        waitIdleTimeoutMs: waitIdleTimeout,
        healthTimeoutMs: integerFlag(flags, 'health-timeout', 30_000),
        healthIntervalMs: integerFlag(flags, 'health-interval', 1000),
        keepPrevious: integerFlag(flags, 'keep-previous', 2),
        ...(typeof flags['health-url'] === 'string' ? { healthUrl: flags['health-url'] } : {}),
        logger: (message) => { if (flags.json !== true) logger(`${upgrade ? 'upgrade' : 'install'}: ${message}`); },
    });
}

async function main() {
    let options;
    try {
        options = parseArguments(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`hapi-dsh-bundle: ${error.message}\n`);
        return 2;
    }
    if (options.flags.help || options.command === 'help' || options.command === undefined) {
        process.stdout.write(HELP);
        return options.command === undefined && !options.flags.help ? 0 : 0;
    }
    const json = options.flags.json === true;
    try {
        let result;
        switch (options.command) {
            case 'install':
            case 'upgrade':
                result = await installCommand(options, { upgrade: options.command === 'upgrade' });
                break;
            case 'rollback': {
                const profile = options.flags.profile;
                if (typeof profile !== 'string') throw new UsageError('rollback requires --profile');
                result = await rollbackRelease({
                    dshHome: resolve(options.flags['dsh-home'] ?? dshHomeFromEnv()),
                    profile,
                    ...(typeof options.flags.to === 'string' ? { toReleaseId: options.flags.to } : {}),
                    pnpm: { executable: options.flags['pnpm-command'] ?? 'pnpm', args: [] },
                    healthTimeoutMs: integerFlag(options.flags, 'health-timeout', 30_000),
                    healthIntervalMs: integerFlag(options.flags, 'health-interval', 1000),
                    logger: (message) => { if (!json) logger(`rollback: ${message}`); },
                });
                break;
            }
            case 'status':
                result = await statusRelease({
                    dshHome: resolve(options.flags['dsh-home'] ?? dshHomeFromEnv()),
                    profile: options.flags.profile,
                });
                break;
            case 'verify': {
                const root = resolve(options.flags['bundle-root'] ?? bundleRoot);
                const bundle = await verifyBundleRoot(root);
                await verifyPayloadTarballs(root, { listTgz, readTgz });
                const store = await verifyReleaseStore({ dshHome: resolve(options.flags['dsh-home'] ?? dshHomeFromEnv()) });
                result = { ok: store.ok, bundle: { releaseId: bundle.releaseId, manifestSha256: bundle.manifestSha256, files: bundle.files.length }, store };
                break;
            }
            case 'prune':
                result = await pruneReleaseStore({
                    dshHome: resolve(options.flags['dsh-home'] ?? dshHomeFromEnv()),
                    keepPrevious: integerFlag(options.flags, 'keep-previous', 2),
                    logger: (message) => { if (!json) logger(`prune: ${message}`); },
                });
                break;
            default:
                process.stderr.write(`hapi-dsh-bundle: unknown command ${options.command}\n`);
                process.stdout.write(HELP);
                return 2;
        }
        if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else {
            process.stdout.write(`${summary(result)}\n`);
            if (options.command === 'status') process.stdout.write(`${JSON.stringify(result.profiles, null, 2)}\n`);
            if (options.command === 'verify' || options.command === 'prune') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        return result?.ok === false ? 1 : 0;
    } catch (error) {
        if (error instanceof UsageError) {
            process.stderr.write(`hapi-dsh-bundle: ${error.message}\n`);
            return 2;
        }
        process.stderr.write(`hapi-dsh-bundle: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}

main().then((code) => { process.exitCode = code; });
