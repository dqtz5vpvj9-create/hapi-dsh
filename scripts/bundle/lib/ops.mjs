/**
 * Bundle operations: install / upgrade / rollback / status / verify / prune.
 *
 * One implementation is shared by the standalone `dist/install.mjs` entry
 * (which runs before hapi-dsh exists) and by `hapi-dsh bundle` (which already
 * has the official launcher resolved through the private config). Every
 * external effect — command execution, clock, sleep, health probe — is
 * injectable so tests can drive the state machine without a real DSH install.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readTgz, listTgz, extractTgz } from './tar.mjs';
import { EXT_CAPABILITIES, releaseDirName, releaseIdentity, validateBundleManifest } from './manifest.mjs';
import {
    DEFAULT_KEEP_PREVIOUS, FAILED_STATE, HEALTH_TIMEOUT_MS, RELEASE_STATES, ROLLED_BACK_STATE,
    activeRelease, applyOverridesToManifest, awaitHealthy, backupDirectory, backupProfileFiles,
    commitActivation, existingOverrides, failAttempt, forgetReleases, idleVerdict, inspectExtResolution, inspectHapiLink, isIdempotentReinstall,
    isProcessAlive, linkDependencyName, linkTarget, prepareRelease, profileDirectory, prunePlan, readBundleState, readProfileManifest, verifyReleaseDirectory,
    readRuntimeSnapshot, releaseDirectory, releasesDirectory, restoreProfileBackup, rollbackActivation, scanDshSingletons, stagedOverrides,
    startAttempt, stateRoot, transitionAttempt, trimRetained, verifyBundleRoot, verifyPayloadTarballs, writeBundleState,
} from './release.mjs';
import { auditRuntimeResolution, inspectRuntime, prepareRuntime } from './runtime.mjs';

const OFFICIAL_TIMEOUT_MS = 300_000;
const DUMP_TIMEOUT_MS = 120_000;

export const defaultRun = async (command, options = {}) => new Promise((resolveResult, reject) => {
    const child = spawn(command.executable, command.args, {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, options.timeoutMs ?? 30_000);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
        clearTimeout(timer);
        resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
});

async function pathExists(path) {
    return access(path).then(() => true).catch((error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
    });
}

async function atomicWriteJson(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    try {
        await rename(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

async function requireDirectory(path, message) {
    await access(path).catch(() => { throw new Error(message); });
}

/** One installer at a time per DSH home; a stale lock from a dead pid is reclaimed. */
export async function acquireInstallLock(dshHome) {
    const path = join(stateRoot(dshHome), 'install.lock');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await open(path, 'wx', 0o600);
            await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
            await handle.close();
            return async () => { await rm(path, { force: true }); };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const owner = await readFile(path, 'utf8').then((text) => JSON.parse(text)).catch(() => ({}));
            if (Number.isInteger(owner.pid) && isProcessAlive(owner.pid) && owner.pid !== process.pid) {
                throw new Error('another hapi-dsh installation holds the release lock for this DSH home');
            }
            await rm(path, { force: true });
        }
    }
    throw new Error('could not acquire the hapi-dsh installation lock');
}

/** Step the attempt forward through the fixed chain; used for resumed attempts too. */
function advanceTo(attempt, target) {
    let current = attempt;
    while (current.state !== target) {
        const index = RELEASE_STATES.indexOf(current.state);
        if (index < 0 || index + 1 >= RELEASE_STATES.length) throw new Error(`Cannot advance release attempt from ${current.state} to ${target}`);
        current = transitionAttempt(current, RELEASE_STATES[index + 1]);
    }
    return current;
}

function commandLine(command) {
    return [command.executable, ...command.args].map((part) => (/[\s'"]/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

/* ------------------------------------------------------------------ */
/* Staging and activation                                              */
/* ------------------------------------------------------------------ */

/** Directory-style override fallback: unpack tarballs beside the release store. */
export async function unpackExtDirectories({ dshHome, manifest, releaseId, releaseRoot, logger }) {
    const container = join(stateRoot(dshHome), 'unpacked', releaseDirName(releaseId));
    const directories = {};
    for (const item of manifest.payload.dshExt) {
        const slug = `${item.name.replace(/^@[^/]+\//, '')}-${item.version}`.replace(/[^A-Za-z0-9._-]/g, '_');
        const target = join(container, slug);
        if (!(await pathExists(target))) {
            const buffer = await readFile(join(releaseRoot, item.tarball));
            const temporary = `${target}.${process.pid}.tmp`;
            await rm(temporary, { recursive: true, force: true });
            await extractTgz(buffer, temporary);
            const { rename } = await import('node:fs/promises');
            await rename(join(temporary, 'package'), target).catch(async (error) => {
                // The tarball may not use the npm `package/` prefix.
                if (error.code === 'ENOENT') return rename(temporary, target);
                throw error;
            });
            await rm(temporary, { recursive: true, force: true });
            logger?.(`unpacked ${item.name}@${item.version} for directory-style overrides`);
        }
        directories[item.name] = target;
    }
    return { container, directories };
}

/** Pre-activation gate: the machine, the launcher, the payload and the attribution files. */
export async function preActivationChecks({ manifest, bundleRoot, releaseRoot, command, run, env, nodeVersion = process.versions.node, pnpmVersion }) {
    const checks = [];
    const major = Number(String(nodeVersion).split('.')[0]);
    checks.push({ name: 'node', status: major >= 24 ? 'pass' : 'fail', detail: `Node ${nodeVersion}; the bundle requires Node 24 or later` });
    if (pnpmVersion !== undefined) {
        const pnpmMajor = Number(String(pnpmVersion).split('.')[0]);
        checks.push({ name: 'pnpm', status: pnpmMajor >= 11 ? 'pass' : 'fail', detail: `pnpm ${pnpmVersion}; the official plugin manager requires pnpm 11 (pinned ${manifest.minimums.pnpm})` });
    }
    if (command) {
        const version = await run({ ...command, args: [...command.args, '--version'] }, { env, timeoutMs: 30_000 });
        const reported = version.stdout.trim();
        checks.push({
            name: 'dsh-version',
            status: version.exitCode === 0 && reported === manifest.release.upstreamVersion ? 'pass' : 'fail',
            detail: version.exitCode === 0
                ? `Official launcher reports ${reported}; bundle requires ${manifest.release.upstreamVersion}`
                : 'The official DSH launcher could not report its version',
        });
    } else {
        checks.push({ name: 'dsh-version', status: 'fail', detail: 'No official DSH launcher was provided' });
    }
    const root = releaseRoot ?? bundleRoot;
    const licenses = await readdir(join(root, 'LICENSES')).catch(() => []);
    checks.push({ name: 'licenses', status: licenses.length > 0 ? 'pass' : 'fail', detail: licenses.length > 0 ? `${licenses.length} license material file(s) in the bundle` : 'LICENSES/ is missing or empty' });
    const sourceOffer = await readdir(join(root, 'SOURCE-OFFER')).catch(() => []);
    checks.push({ name: 'source-offer', status: sourceOffer.length > 0 ? 'pass' : 'fail', detail: sourceOffer.length > 0 ? `${sourceOffer.length} source-offer file(s) in the bundle` : 'SOURCE-OFFER/ is missing or empty' });
    const failed = checks.filter((check) => check.status === 'fail');
    if (failed.length > 0) throw new Error(`Pre-activation checks failed: ${failed.map((check) => `${check.name}: ${check.detail}`).join('; ')}`);
    return checks;
}

async function runOfficial(run, command, args, { env, cwd, timeoutMs = OFFICIAL_TIMEOUT_MS }) {
    return run({ ...command, args: [...command.args, ...args] }, { env, cwd, timeoutMs });
}

async function officialInitProfile({ run, command, env, profileDirectory: directory, profile, logger }) {
    logger?.(`initializing the official Web profile ${profile}`);
    const result = await runOfficial(run, command, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env, cwd: undefined, timeoutMs: DUMP_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error('official DSH profile initialization failed; the existing profile was preserved');
    const manifest = await readProfileManifest(directory);
    if (!manifest) throw new Error('official DSH profile initialization did not write a profile manifest');
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-web-app')) {
        throw new Error('the initialized profile is not the official Web profile');
    }
}

/**
 * Write staged overrides, let the official plugin manager add the bundle, then
 * verify the resulting profile. Any thrown error is reverted by the caller.
 */
export async function activateRelease({ dshHome, profile, role, releaseRoot, manifest, style, extractedExtDirectories, previousManaged, command, run, env, logger, pnpm, reinstall, previousActive }) {
    const directory = profileDirectory(dshHome, profile);
    let createdProfile = false;
    let backup;
    try {
        let current = await readProfileManifest(directory);
        if (!current) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await officialInitProfile({ run, command, env, profileDirectory: directory, profile, logger });
            current = await readProfileManifest(directory);
            createdProfile = true;
        }
        // Runtime-managed bundles keep patched packages inside the private
        // runtime; the profile only links the plugin and keeps user overrides.
        const managed = {};
        const merged = { overrides: existingOverrides(current) };
        const staged = current;
        backup = await backupProfileFiles(dshHome, profile, manifest.releaseId);
        const before = JSON.stringify(current);
        if (JSON.stringify(staged) !== before) {
            await atomicWriteJson(join(directory, 'package.json'), staged);
            logger?.(`staged ${Object.keys(managed).length} pnpm override(s) in profile ${profile}`);
        }
        const target = linkTarget(releaseRoot, role);
        await requireDirectory(target, `the release does not contain ${target}`);
        const name = linkDependencyName(role);
        logger?.(`running the official plugin manager: ${commandLine({ ...command, args: [...command.args, 'plugin', '--profile', profile, 'add', `link:${target}`] })}`);
        const installed = await runOfficial(run, command, ['plugin', '--profile', profile, 'add', `link:${target}`], { env, cwd: directory });
        if (installed.exitCode !== 0) throw new Error('official DSH plugin installation failed; run dsh plugin for its installation diagnostics');
        const after = await readProfileManifest(directory);
        const dependency = after?.dependencies?.[name];
        const spec = typeof dependency === 'string' && dependency.startsWith('link:') ? dependency.slice(5) : dependency;
        if (typeof spec !== 'string' || resolve(directory, spec) !== resolve(target)) {
            throw new Error(`the official plugin manager did not link ${name} to the staged release`);
        }
        const dump = await runOfficial(run, command, ['--profile', profile, '--dump-config'], { env, cwd: undefined, timeoutMs: DUMP_TIMEOUT_MS });
        if (dump.exitCode !== 0 || !new RegExp(`^\\s*-?\\s*id:\\s*["']?${name}["']?\\s*$`, 'm').test(dump.stdout)) {
            throw new Error(`the composed profile does not contain the ${name} plugin row`);
        }
        return { createdProfile, backup, managed, merged, before, staged };
    } catch (error) {
        if (backup || createdProfile) {
            const reverted = await revertActivation({ dshHome, profile, releaseId: manifest.releaseId, backup, createdProfile, previousActive, pnpm, run, env, reinstall, logger }).catch((revertError) => ({ restored: [], reinstalled: false, warning: revertError instanceof Error ? revertError.message : String(revertError) }));
            error.reverted = reverted;
        }
        throw error;
    }
}

/** Restore the previous profile files and rebuild node_modules from the restored lock. */
export async function reinstallProfile({ profileDirectory: directory, pnpm, run, env, logger }) {
    logger?.(`restoring profile dependencies from the previous lockfile in ${directory}`);
    const result = await run({ ...pnpm, args: [...pnpm.args, 'install', '--frozen-lockfile'] }, { env, cwd: directory, timeoutMs: OFFICIAL_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error('pnpm could not restore the previous profile from its lockfile');
}

/**
 * Undo an activation that failed its health gate. The release pointer is never
 * moved for a failed attempt, so the old active release stays active.
 */
export async function revertActivation({ dshHome, profile, releaseId, backup, createdProfile, previousActive, pnpm, run, env, reinstall, logger }) {
    const restored = [];
    if (backup) restored.push(...await restoreProfileBackup({ backupDirectory: backup.directory, profileDirectory: profileDirectory(dshHome, profile) }));
    if (createdProfile && !previousActive) {
        const directory = profileDirectory(dshHome, profile);
        if (resolve(directory) === join(resolve(dshHome), 'profiles', profile)) {
            await rm(directory, { recursive: true, force: true });
            logger?.(`removed profile ${profile} because this installation created it and never became healthy`);
        }
    }
    logger?.(`reverted profile ${profile} to its previous manifest (${restored.join(', ') || 'nothing to restore'})`);
    const effect = reinstall ?? reinstallProfile;
    if (pnpm && (previousActive || createdProfile === false)) {
        try {
            await effect({ profileDirectory: profileDirectory(dshHome, profile), pnpm, run, env, logger });
        } catch (error) {
            return { restored, reinstalled: false, warning: error instanceof Error ? error.message : String(error) };
        }
        return { restored, reinstalled: true };
    }
    return { restored, reinstalled: false };
}

function resolveExtDirectoriesOption(extracted) {
    return extracted ? { container: extracted.container, directories: extracted.directories } : { container: undefined, directories: {} };
}

function buildHealthProbe({ dshHome, profile, role, releaseRoot, manifest, healthUrl, healthProbe, run, command, env, logger }) {
    return async () => {
        const problems = [];
        const runtime = await inspectRuntime({ releaseRoot, manifest });
        if (!runtime.ok) problems.push(...runtime.problems);
        const resolution = await auditRuntimeResolution(releaseRoot);
        if (!resolution.ok) problems.push(...resolution.problems);
        // A profile copy of a patched package would load a second singleton
        // beside the runtime's verified copy.
        const profileDeps = join(profileDirectory(dshHome, profile), 'node_modules', '@deepseek-ai');
        const profileNames = new Set(await readdir(profileDeps).catch(() => []));
        for (const item of manifest.payload.dshExt) {
            const short = item.name.slice('@deepseek-ai/'.length);
            if (profileNames.has(short)) problems.push(`profile ${profile} installs a second copy of ${item.name}; keep it in the pinned runtime only`);
        }
        const link = await inspectHapiLink({ dshHome, profile, releaseRoot, role });
        problems.push(...link.problems);
        const singletons = await scanDshSingletons({ dshHome, profile });
        for (const duplicate of singletons.duplicates) problems.push(`${duplicate.name} resolves to ${duplicate.copies.length} physical copies`);
        if (healthProbe) {
            const verdict = await healthProbe();
            if (verdict !== undefined && verdict !== null) problems.push(verdict instanceof Error ? verdict.message : String(verdict));
        }
        if (healthUrl) {
            try {
                const response = await fetch(healthUrl, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
                await response.body?.cancel();
                if (!response.ok) problems.push(`health endpoint returned HTTP ${response.status}`);
            } catch (error) {
                problems.push(`health endpoint is not reachable: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (problems.length > 0) return problems.join('; ');
        if (command && run) {
            // The official launcher itself must still compose the profile.
            const dump = await run({ ...command, args: [...command.args, '--profile', profile, '--dump-config'] }, { env, timeoutMs: DUMP_TIMEOUT_MS });
            const name = linkDependencyName(role);
            if (dump.exitCode !== 0 || !new RegExp(`^\\s*-?\\s*id:\\s*["']?${name}["']?\\s*$`, 'm').test(dump.stdout)) {
                return `the composed ${profile} profile lost the ${name} plugin row`;
            }
        }
        logger?.(`health check passed for release ${releaseDirName(manifest.releaseId)}`);
        return undefined;
    };
}

function normalizeOptions(options) {
    if (!options || typeof options !== 'object') throw new Error('installRelease requires options');
    const { dshHome, profile, role, bundleRoot } = options;
    if (typeof dshHome !== 'string' || !resolve(dshHome)) throw new Error('installRelease requires an absolute DSH home');
    if (typeof profile !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('installRelease requires a valid profile name');
    if (role !== 'host' && role !== 'runner') throw new Error('installRelease requires --role host or --role runner');
    if (typeof bundleRoot !== 'string') throw new Error('installRelease requires the extracted bundle directory');
    const style = options.style ?? 'tarball';
    if (style !== 'tarball' && style !== 'directory') throw new Error('override style must be tarball or directory');
    const keepPrevious = options.keepPrevious ?? DEFAULT_KEEP_PREVIOUS;
    if (!Number.isInteger(keepPrevious) || keepPrevious < DEFAULT_KEEP_PREVIOUS) throw new Error(`at least ${DEFAULT_KEEP_PREVIOUS} previous releases must be retained`);
    return {
        ...options,
        dshHome: resolve(dshHome),
        style,
        keepPrevious,
        role,
        run: options.run ?? defaultRun,
        pnpm: options.pnpm ?? { executable: 'pnpm', args: [] },
        now: options.now ?? Date.now,
        sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
        logger: options.logger ?? (() => {}),
    };
}

/* ------------------------------------------------------------------ */
/* Install / upgrade                                                   */
/* ------------------------------------------------------------------ */

export async function installRelease(rawOptions) {
    const options = normalizeOptions(rawOptions);
    const { dshHome, profile, role, bundleRoot, run, pnpm, env: extraEnv, logger } = options;
    const env = { ...process.env, ...(extraEnv ?? {}), DSH_HOME: dshHome };
    const dryRun = options.dryRun === true;
    const style = options.style;
    let command = options.command;

    const verification = await verifyBundleRoot(bundleRoot);
    await verifyPayloadTarballs(bundleRoot, { listTgz, readTgz });
    const { manifest, releaseId } = verification;
    logger(`bundle ${manifest.version} verified (release ${releaseDirName(releaseId)})`);

    let state = await readBundleState(dshHome);
    const resumable = !dryRun && state.attempt && state.attempt.releaseId === releaseId && state.attempt.state === 'waiting-idle';
    let attempt;
    const persist = async () => {
        if (dryRun) return;
        state.attempt = attempt;
        state = await writeBundleState(dshHome, state);
    };
    // An idempotent reinstall must not even write an attempt into the state file.
    const beginAttempt = async () => {
        if (attempt) return;
        attempt = startAttempt({ releaseId, role, profile, dryRun });
        attempt = advanceTo(attempt, 'verified');
        await persist();
    };
    if (resumable) {
        attempt = state.attempt;
        logger('resuming the waiting-idle upgrade attempt');
    }

    const prepared = await prepareRelease({ bundleRoot, dshHome, verification });
    const releaseRoot = prepared.directory;
    // The profile only installs plugins; ext packages take effect through a
    // private pinned runtime so every consumer resolves one physical copy.
    let preparedRuntime;
    let extracted = { container: undefined, directories: {} };
    if (style === 'directory') {
        const unpacked = await unpackExtDirectories({ dshHome, manifest, releaseId, releaseRoot, logger });
        extracted = { container: unpacked.container, directories: unpacked.directories };
    }
    const overridesRoot = style === 'directory' ? extracted.container : releaseRoot;

    const directory = profileDirectory(dshHome, profile);
    const current = await readProfileManifest(directory);
    const previousManaged = state.profiles[profile]?.managedOverrides ?? {};
    let managed;
    let merged;
    let staged;
    try {
        // The pinned runtime owns the patched packages; the profile must not
        // carry a second copy through overrides. A user override that targets a
        // patched package is still a loud misconfiguration.
        const detection = stagedOverrides({
            current, manifest, profile, dshHome, releaseRoot: overridesRoot, style,
            extractedExtDirectories: extracted.directories, previousManaged,
        });
        if (detection.merged.conflicts.length > 0) {
            throw new Error(`Profile overrides conflict with hapi-dsh: ${detection.merged.conflicts.map(c => c.name).join(', ')}`);
        }
        managed = {};
        staged = current ?? {};
    } catch (error) {
        await beginAttempt();
        attempt = failAttempt(attempt, error);
        await persist();
        return { ok: false, state: FAILED_STATE, releaseId, profile, role, error: error instanceof Error ? error.message : String(error), oldActivePreserved: activeRelease(state, profile) !== null };
    }

    if (isIdempotentReinstall({ state, dshHome, profile, role, releaseId, releaseRoot, currentProfile: current, managedOverrides: managed })) {
        logger(`release ${releaseDirName(releaseId)} is already active for profile ${profile}; nothing to change`);
        return {
            ok: true, changed: false, idempotent: true, state: 'healthy', releaseId,
            releaseDirectory: releaseRoot, profile, role, managedOverrides: managed,
        };
    }

    await beginAttempt();
    if (!resumable) {
        attempt = advanceTo(attempt, 'staged');
        await persist();
    }

    let checks;
    if (!resumable) try {
        let pnpmVersion = options.pnpmVersion;
        if (pnpmVersion === undefined) {
            const pnpmResult = await run({ ...pnpm, args: [...pnpm.args, '--version'] }, { env, timeoutMs: 30_000 }).catch(() => undefined);
            pnpmVersion = pnpmResult?.exitCode === 0 ? pnpmResult.stdout.trim() : undefined;
        }
        if (!dryRun && !preparedRuntime) {
            preparedRuntime = await (options.runtimeBuilder ?? prepareRuntime)({ run, pnpm, env, releaseRoot, manifest, logger });
            // The injected builder is a test seam: keep the caller's launcher there.
            if (!options.runtimeBuilder) command = { executable: process.execPath, args: [preparedRuntime.dshBinary] };
            logger(`runtime: @deepseek-ai/dsh ${preparedRuntime.dshVersion} with ${preparedRuntime.packages.length} ext package(s)`);
        }
        checks = await preActivationChecks({
            manifest, bundleRoot, releaseRoot, command, run, env,
            nodeVersion: options.nodeVersion, pnpmVersion,
        });
    } catch (error) {
        attempt = failAttempt(attempt, error);
        await persist();
        return { ok: false, state: FAILED_STATE, releaseId, profile, role, error: error instanceof Error ? error.message : String(error), oldActivePreserved: activeRelease(state, profile) !== null };
    }
    if (!resumable) {
        attempt = advanceTo(attempt, 'doctor-passed');
        await persist();
    }
    if (dryRun) {
        return {
            ok: true, dryRun: true, state: 'doctor-passed', releaseId, releaseDirectory: releaseRoot,
            profile, role, checks, stagedProfile: staged, managedOverrides: managed,
            plannedRuntime: { directory: join(releaseRoot, 'runtime'), upstreamVersion: manifest.release.upstreamVersion,
                packages: manifest.payload.dshExt.map(item => item.name) },
            plannedCommands: command ? [
                { purpose: 'initialize-profile (only when missing)', args: ['--profile', profile, '--from-default-profile', 'web', '--dump-config'] },
                { purpose: 'add-bundle', args: ['plugin', '--profile', profile, 'add', `link:${linkTarget(releaseRoot, role)}`] },
                { purpose: 'dump-config', args: ['--profile', profile, '--dump-config'] },
            ] : [],
        };
    }

    if (attempt.state === 'doctor-passed') {
        attempt = advanceTo(attempt, 'waiting-idle');
        await persist();
    }
    const probeRuntime = async () => (options.runtimeProbe ? options.runtimeProbe() : readRuntimeSnapshot(dshHome));
    let runtime = await probeRuntime();
    let verdict = idleVerdict(runtime, { role, pidAlive: options.pidAlive ?? isProcessAlive });
    if (verdict.wait) {
        const deadline = options.now() + (options.waitIdleTimeoutMs ?? 0);
        while (verdict.wait && options.now() < deadline) {
            await options.sleep(options.idlePollMs ?? 1000);
            runtime = await probeRuntime();
            verdict = idleVerdict(runtime, { role, pidAlive: options.pidAlive ?? isProcessAlive });
        }
        if (verdict.wait) {
            logger(verdict.reason);
            return { ok: true, waiting: true, state: 'waiting-idle', releaseId, profile, role, reason: verdict.reason };
        }
    }

    attempt = advanceTo(attempt, 'activating');
    await persist();
    const unlock = dryRun ? async () => {} : await acquireInstallLock(dshHome);
    let activation;
    try {
        activation = await activateRelease({
            dshHome, profile, role, releaseRoot, manifest, style,
            extractedExtDirectories: extracted, previousManaged, command, run, env, logger,
            pnpm, reinstall: options.reinstall, previousActive: activeRelease(state, profile),
        });
    } catch (error) {
        const previousActive = activeRelease(state, profile);
        attempt = failAttempt(attempt, error);
        await persist();
        await unlock();
        return {
            ok: false, state: FAILED_STATE, releaseId, profile, role,
            error: error instanceof Error ? error.message : String(error),
            reverted: error.reverted, oldActivePreserved: previousActive !== null,
        };
    }

    const health = await awaitHealthy(
        buildHealthProbe({ dshHome, profile, role, releaseRoot, manifest, healthUrl: options.healthUrl, healthProbe: options.healthProbe, run, command, env, logger }),
        {
            timeoutMs: options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
            intervalMs: options.healthIntervalMs ?? 1000,
            now: options.now, sleep: options.sleep,
        },
    );
    if (!health.ok) {
        const previousActive = activeRelease(state, profile);
        const reverted = await revertActivation({
            dshHome, profile, releaseId, backup: activation.backup, createdProfile: activation.createdProfile,
            previousActive, pnpm, run, env, reinstall: options.reinstall, logger,
        }).catch((revertError) => ({ restored: [], reinstalled: false, warning: revertError instanceof Error ? revertError.message : String(revertError) }));
        attempt = failAttempt(attempt, health.lastError ?? 'health check failed');
        await persist();
        await unlock();
        return {
            ok: false, state: FAILED_STATE, rolledBack: true, releaseId, profile, role,
            error: health.lastError ?? 'health check failed', healthAttempts: health.attempts,
            reverted, oldActivePreserved: previousActive !== null,
        };
    }

    const activatedAt = new Date(options.now()).toISOString();
    let next = commitActivation(state, profile, {
        releaseId, role, activatedAt,
        manifest, manifestSha256: prepared.manifestSha256, treeDigest: prepared.treeDigest,
        managedOverrides: managed,
    });
    const plan = prunePlan(next, { keepPrevious: options.keepPrevious });
    await removeReleaseArtifacts(dshHome, plan.remove, logger);
    next = trimRetained(forgetReleases(next, plan.remove), { keepPrevious: options.keepPrevious });
    if (preparedRuntime) {
        next.profiles[profile] = { ...next.profiles[profile],
            runtime: { dshBinary: preparedRuntime.dshBinary, dshVersion: preparedRuntime.dshVersion,
                extRelease: manifest.release.extRelease, releaseId } };
    }
    await writeBundleState(dshHome, next);
    await unlock();
    logger(`release ${releaseDirName(releaseId)} is healthy for profile ${profile}; ${plan.keep.length - 1} older release(s) retained`);
    return {
        ok: true, changed: true, state: 'healthy', releaseId, releaseDirectory: releaseRoot, profile, role,
        managedOverrides: managed, healthAttempts: health.attempts,
        retained: plan.keep, pruned: plan.remove,
        restartRequired: role,
    };
}

async function removeReleaseArtifacts(dshHome, releaseIds, logger) {
    for (const releaseId of releaseIds) {
        const directory = releaseDirectory(dshHome, releaseId);
        const expected = join(releasesDirectory(dshHome), releaseDirName(releaseId));
        if (directory !== expected) throw new Error(`refusing to delete ${directory}: it is not a release directory`);
        await rm(directory, { recursive: true, force: true });
        for (const profile of await readdir(join(stateRoot(dshHome), 'backups')).catch(() => [])) {
            void profile;
        }
        await rm(join(stateRoot(dshHome), 'backups', releaseDirName(releaseId)), { recursive: true, force: true });
        logger?.(`pruned old release ${releaseDirName(releaseId)}`);
    }
}

/* ------------------------------------------------------------------ */
/* Rollback                                                            */
/* ------------------------------------------------------------------ */

export async function rollbackRelease(rawOptions) {
    const { dshHome, profile, toReleaseId, pnpm, env: extraEnv, logger = () => {}, reinstall } = rawOptions;
    // The CLI may omit the process runner; rollback still needs it for the
    // profile reinstall and the composed-profile health check.
    const run = rawOptions.run ?? defaultRun;
    const home = resolve(dshHome);
    const env = { ...process.env, ...(extraEnv ?? {}), DSH_HOME: home };
    let state = await readBundleState(home);
    const target = rollbackActivation(state, profile, { toReleaseId });
    const targetManifest = validateBundleManifest(JSON.parse(await readFile(join(releaseDirectory(home, target.to.releaseId), 'manifest.json'), 'utf8')));
    // The backup that restores a release is the one taken just before that
    // release's successor was installed: it names the release we roll back from.
    const backup = { directory: backupDirectory(home, target.from.releaseId, profile) };
    const restored = await restoreProfileBackup({ backupDirectory: backup.directory, profileDirectory: profileDirectory(home, profile) });
    logger(`restored profile ${profile}: ${restored.join(', ')}`);
    const effect = reinstall ?? reinstallProfile;
    if (pnpm) await effect({ profileDirectory: profileDirectory(home, profile), pnpm, run, env, logger });
    const health = await awaitHealthy(
        buildHealthProbe({ dshHome: home, profile, role: target.to.role ?? 'host', releaseRoot: releaseDirectory(home, target.to.releaseId), manifest: targetManifest, run, command: rawOptions.command, env, logger }),
        { timeoutMs: rawOptions.healthTimeoutMs ?? HEALTH_TIMEOUT_MS, intervalMs: rawOptions.healthIntervalMs ?? 1000, now: rawOptions.now ?? Date.now, sleep: rawOptions.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))) },
    );
    if (!health.ok) {
        return { ok: false, state: 'failed', error: `rollback target ${releaseDirName(target.to.releaseId)} is not healthy: ${health.lastError ?? 'unknown'}`, from: target.from.releaseId, to: target.to.releaseId };
    }
    state = target.state;
    // The rolled-back release keeps its own pinned runtime; point the profile at
    // it so `hapi-dsh start` boots the same ext set as the restored state.
    const runtime = await inspectRuntime({ releaseRoot: releaseDirectory(home, target.to.releaseId), manifest: targetManifest }).catch(() => undefined);
    if (runtime?.ok && runtime.dshBinary) {
        state.profiles[profile].runtime = { dshBinary: runtime.dshBinary, dshVersion: targetManifest.release.upstreamVersion,
            extRelease: targetManifest.release.extRelease, releaseId: target.to.releaseId };
    }
    const restoredManifest = await readProfileManifest(profileDirectory(home, profile));
    const extNames = new Set(targetManifest.payload.dshExt.map((item) => item.name));
    state.profiles[profile].managedOverrides = Object.fromEntries(
        Object.entries(existingOverrides(restoredManifest)).filter(([name]) => extNames.has(name)),
    );
    await writeBundleState(home, state);
    return {
        ok: true, state: 'healthy', from: target.from.releaseId, to: target.to.releaseId,
        releaseDirectory: releaseDirectory(home, target.to.releaseId), profile, restored,
        note: 'session logs, queues and approvals are deliberately not rolled back',
    };
}

/* ------------------------------------------------------------------ */
/* Status / verify / prune                                             */
/* ------------------------------------------------------------------ */

export async function statusRelease({ dshHome, profile }) {
    const home = resolve(dshHome);
    const state = await readBundleState(home);
    const selected = Object.keys(state.profiles);
    const profiles = {};
    for (const name of selected) {
        const entry = state.profiles[name];
        const activeDirectory = entry.active ? releaseDirectory(home, entry.active.releaseId) : undefined;
        profiles[name] = {
            role: entry.role,
            active: entry.active ? { releaseId: entry.active.releaseId, directory: activeDirectory, present: activeDirectory ? await pathExists(activeDirectory) : false } : null,
            previous: await Promise.all(entry.previous.map(async (item) => ({ releaseId: item.releaseId, directory: releaseDirectory(home, item.releaseId), present: await pathExists(releaseDirectory(home, item.releaseId)) }))),
            managedOverrides: entry.managedOverrides,
        };
    }
    const runtime = await readRuntimeSnapshot(home).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    return { ok: true, dshHome: home, stateFile: join(stateRoot(home), 'state.json'), profiles, attempt: state.attempt, runtime, requestedProfile: profile };
}

export async function verifyReleaseStore({ dshHome }) {
    const home = resolve(dshHome);
    const state = await readBundleState(home);
    const releases = [];
    for (const [releaseId, entry] of Object.entries(state.releases)) {
        const directory = releaseDirectory(home, releaseId);
        if (!(await pathExists(directory))) {
            releases.push({ releaseId, directory, ok: false, error: 'release directory is missing' });
            continue;
        }
        try {
            const verified = await verifyReleaseDirectory(directory);
            releases.push({
                releaseId, directory, ok: true,
                releaseIdMatches: verified.releaseId === releaseId,
                manifestSha256Matches: entry.manifestSha256 === verified.manifestSha256,
                treeDigestMatches: entry.treeDigest === verified.treeDigest,
                treeDigest: verified.treeDigest,
            });
        } catch (error) {
            releases.push({ releaseId, directory, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
    const referenced = new Set();
    for (const entry of Object.values(state.profiles)) {
        if (entry.active) referenced.add(entry.active.releaseId);
        for (const item of entry.previous) referenced.add(item.releaseId);
    }
    const missing = [...referenced].filter((releaseId) => !releases.some((release) => release.releaseId === releaseId));
    return { ok: releases.every((release) => release.ok) && missing.length === 0, releases, missing, state };
}

export async function pruneReleaseStore({ dshHome, keepPrevious = DEFAULT_KEEP_PREVIOUS, logger = () => {} }) {
    const home = resolve(dshHome);
    let state = await readBundleState(home);
    const plan = prunePlan(state, { keepPrevious });
    await removeReleaseArtifacts(home, plan.remove, logger);
    state = forgetReleases(state, plan.remove);
    await writeBundleState(home, state);
    return { ok: true, removed: plan.remove, retained: plan.keep };
}

/* ------------------------------------------------------------------ */
/* Read-only inspection used by `hapi-dsh doctor`                      */
/* ------------------------------------------------------------------ */

export async function inspectReleaseState({ dshHome, profile, runtime: runtimeOverride }) {
    const home = resolve(dshHome);
    const state = await readBundleState(home);
    const statePresent = await pathExists(join(stateRoot(home), 'state.json'));
    const entry = state.profiles[profile];
    const report = {
        installed: Boolean(entry?.active),
        statePresent,
        profile,
        role: entry?.role,
        state,
        active: undefined,
        previous: [],
        manifestHash: undefined,
        integrity: undefined,
        licenses: [],
        sourceOffer: [],
        extCapabilities: undefined,
        extResolution: undefined,
        link: undefined,
        singletons: undefined,
        profileOverrides: undefined,
        managedOverrides: entry?.managedOverrides ?? {},
        overridesMatch: undefined,
        runtime: undefined,
        roles: Object.fromEntries(Object.entries(state.profiles).map(([name, value]) => [name, { role: value.role, releaseId: value.active?.releaseId ?? null, identity: value.active ? state.releases[value.active.releaseId]?.identity : undefined }])),
    };
    const runtime = runtimeOverride !== undefined ? runtimeOverride : await readRuntimeSnapshot(home).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    report.runtime = runtime;
    if (!entry?.active) return report;

    const directory = releaseDirectory(home, entry.active.releaseId);
    const installed = state.releases[entry.active.releaseId];
    const present = await pathExists(directory);
    report.active = { releaseId: entry.active.releaseId, directory, present };
    if (!present) {
        report.active.verificationError = 'the active release directory is missing';
        return report;
    }
    try {
        const verified = await verifyReleaseDirectory(directory);
        report.active.manifest = verified.manifest;
        report.active.identity = releaseIdentity(verified.manifest);
        report.manifestHash = {
            recorded: installed?.manifestSha256,
            actual: verified.manifestSha256,
            releaseIdMatches: verified.releaseId === entry.active.releaseId,
            ok: installed?.manifestSha256 === verified.manifestSha256 && verified.releaseId === entry.active.releaseId,
        };
        report.integrity = { treeDigest: verified.treeDigest, recordedTreeDigest: installed?.treeDigest, ok: !installed?.treeDigest || installed.treeDigest === verified.treeDigest };
        const manifest = verified.manifest;
        report.extCapabilities = { declared: { ...manifest.release.capabilities }, expected: Object.fromEntries(EXT_CAPABILITIES.map((name) => [name, 1])), packages: [] };
        for (const item of manifest.payload.dshExt) {
            const entries = readTgz(await readFile(join(directory, item.tarball)), { withData: true });
            const packageJson = entries.find((file) => file.path === 'package/package.json');
            const declared = packageJson?.data ? JSON.parse(packageJson.data.toString('utf8'))?.dsh?.ext?.capabilities : undefined;
            report.extCapabilities.packages.push({ name: item.name, version: item.version, declared: declared ?? null });
        }
        report.licenses = await readdir(join(directory, 'LICENSES'));
        report.sourceOffer = await readdir(join(directory, 'SOURCE-OFFER'));
        // Keep the live runtime snapshot under `runtime`; the managed runtime
        // closure is reported separately so identity checks stay unchanged.
        const managed = await inspectRuntime({ releaseRoot: directory, manifest }).catch(error => ({ ok: false, packages: [], problems: [error instanceof Error ? error.message : String(error)] }));
        report.runtimePackages = managed;
        report.runtimeResolution = await auditRuntimeResolution(directory).catch(error => ({ ok: false, problems: [error instanceof Error ? error.message : String(error)] }));
        report.extResolution = (managed.packages ?? []).map(item => {
            const expected = manifest.payload.dshExt.find(entry => entry.name === item.name);
            const problems = [];
            if (expected && item.version !== expected.version) problems.push(`${item.name} resolves to ${String(item.version)}, expected the extended ${expected.version}`);
            return { name: item.name, expectedVersion: expected?.version, version: item.version, resolved: true, problems };
        });
        if (!managed.ok) report.extResolution.push({ name: 'runtime', resolved: false, problems: managed.problems });
        report.link = await inspectHapiLink({ dshHome: home, profile, releaseRoot: directory, role: entry.role });
        report.singletons = await scanDshSingletons({ dshHome: home, profile });
        const profileManifest = await readProfileManifest(profileDirectory(home, profile));
        report.profileOverrides = existingOverrides(profileManifest);
        report.overridesMatch = Object.entries(entry.managedOverrides).every(([name, value]) => report.profileOverrides[name] === value);
        report.manifestSha256 = verified.manifestSha256;
        report.releaseIdMatches = verified.releaseId === entry.active.releaseId;
    } catch (error) {
        report.active.verificationError = error instanceof Error ? error.message : String(error);
    }
    for (const item of entry.previous) {
        const previousDirectory = releaseDirectory(home, item.releaseId);
        const previousPresent = await pathExists(previousDirectory);
        let error;
        let treeDigest;
        if (previousPresent) {
            try {
                const verified = await verifyReleaseDirectory(previousDirectory);
                treeDigest = verified.treeDigest;
                if (verified.releaseId !== item.releaseId) error = 'release directory content does not match its release id';
            } catch (verifyError) {
                error = verifyError instanceof Error ? verifyError.message : String(verifyError);
            }
        } else {
            error = 'previous release directory is missing';
        }
        report.previous.push({ releaseId: item.releaseId, directory: previousDirectory, present: previousPresent, treeDigest, error });
    }
    return report;
}

export { RELEASE_STATES, ROLLED_BACK_STATE, FAILED_STATE, releaseDirName, releaseIdentity, validateBundleManifest };

/** Cross-consumer singleton resolution audit (used by doctor and tests). */
export async function auditResolution(releaseRoot) {
    return auditRuntimeResolution(releaseRoot);
}
