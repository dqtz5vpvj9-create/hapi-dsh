/**
 * Release store, upgrade state machine and rollback bookkeeping.
 *
 * The on-disk contract is intentionally boring so that four different actors
 * agree on it: the bundle installer (`install.mjs`), the CLI
 * (`hapi-dsh bundle`), `hapi-dsh doctor`, and the acceptance scripts.
 *
 *   <DSH_HOME>/hapi-dsh/
 *     state.json                    pointers, identities, managed overrides
 *     releases/r-<16 hex>/          immutable copy of the bundle's package/
 *     backups/r-<16 hex>/<profile>/ previous profile package.json + lockfile
 *     bundles/<sha256>/             extracted installers kept for upgrades
 *     runtime.json                  written by a running Host/Runner (optional)
 */
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { digestOfEntries, sha256Bytes, sha256File } from './digest.mjs';
import { BUNDLE_LAYOUT, bundleLayoutErrors, computeReleaseId, formatSums, parseSums, payloadEntries, releaseDirName, releaseIdentity, validateBundleManifest } from './manifest.mjs';
import { extractTgz } from './tar.mjs';
import { assertTargetInside, buildManagedOverrides, describeConflicts, mergeOverrides, overridesEqual } from './overrides.mjs';

export const STATE_VERSION = 1;
export const DEFAULT_KEEP_PREVIOUS = 2;
/** Fixed by the spec: a release that is not healthy within 30s is rolled back. */
export const HEALTH_TIMEOUT_MS = 30_000;

/** downloaded → verified → staged → doctor-passed → waiting-idle → activating → healthy */
export const RELEASE_STATES = Object.freeze(['downloaded', 'verified', 'staged', 'doctor-passed', 'waiting-idle', 'activating', 'healthy']);
export const FAILED_STATE = 'failed';
export const ROLLED_BACK_STATE = 'rolled-back';

export function dshHomeFromEnv(env = process.env) {
    return resolve(env.DSH_HOME || join(homedir(), '.dsh'));
}

export function stateRoot(dshHome) {
    return join(resolve(dshHome), 'hapi-dsh');
}

export function stateFile(dshHome) {
    return join(stateRoot(dshHome), 'state.json');
}

export function releasesDirectory(dshHome) {
    return join(stateRoot(dshHome), 'releases');
}

export function releaseDirectory(dshHome, releaseId) {
    return join(releasesDirectory(dshHome), releaseDirName(releaseId));
}

export function backupsDirectory(dshHome) {
    return join(stateRoot(dshHome), 'backups');
}

export function backupDirectory(dshHome, releaseId, profile) {
    return join(backupsDirectory(dshHome), releaseDirName(releaseId), profile);
}

export function bundleCacheDirectory(dshHome) {
    return join(stateRoot(dshHome), 'bundles');
}

export function profileDirectory(dshHome, profile) {
    return join(resolve(dshHome), 'profiles', profile);
}

/** A Host/Runner snapshot used for the idle gate and strict identity checks. */
export function runtimeFile(dshHome) {
    return join(stateRoot(dshHome), 'runtime.json');
}

export function emptyState() {
    return { version: STATE_VERSION, profiles: {}, releases: {}, attempt: null, history: [], updatedAt: new Date().toISOString() };
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeState(input) {
    if (input === undefined) return emptyState();
    if (!isRecord(input) || input.version !== STATE_VERSION) throw new Error('Bundle release state has an unsupported version');
    const state = emptyState();
    if (isRecord(input.profiles)) {
        for (const [profile, value] of Object.entries(input.profiles)) {
            if (!isRecord(value)) throw new Error(`Bundle release state for profile ${profile} is malformed`);
            state.profiles[profile] = {
                role: value.role === 'runner' ? 'runner' : 'host',
                active: value.active ?? null,
                previous: Array.isArray(value.previous) ? value.previous : [],
                managedOverrides: isRecord(value.managedOverrides) ? { ...value.managedOverrides } : {},
                // The pinned runtime pointer must survive every state read: a
                // failed upgrade/health rollback otherwise persists a profile
                // without a runtime and the old active release cannot boot.
                ...(isRecord(value.runtime) ? { runtime: { ...value.runtime } } : {}),
            };
        }
    }
    if (isRecord(input.releases)) state.releases = { ...input.releases };
    if (isRecord(input.attempt)) state.attempt = { ...input.attempt };
    if (Array.isArray(input.history)) state.history = [...input.history];
    if (typeof input.updatedAt === 'string') state.updatedAt = input.updatedAt;
    return state;
}

export async function readBundleState(dshHome) {
    let text;
    try {
        text = await readFile(stateFile(dshHome), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return emptyState();
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Bundle release state is not valid JSON');
    }
    return normalizeState(parsed);
}

export async function writeBundleState(dshHome, state) {
    const root = stateRoot(dshHome);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const next = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
    const temporary = `${stateFile(dshHome)}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try {
        await rename(temporary, stateFile(dshHome));
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
    return next;
}

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

export function startAttempt({ releaseId, role, profile, at = Date.now(), dryRun = false }) {
    return {
        releaseId,
        role,
        profile,
        dryRun,
        state: RELEASE_STATES[0],
        startedAt: at,
        error: null,
        history: [{ state: RELEASE_STATES[0], at }],
    };
}

export function transitionAttempt(attempt, next, { at = Date.now(), detail } = {}) {
    if (attempt.state === FAILED_STATE || attempt.state === ROLLED_BACK_STATE) throw new Error(`Release attempt already finished as ${attempt.state}`);
    if (next === FAILED_STATE || next === ROLLED_BACK_STATE) {
        return { ...attempt, state: next, ...(detail ? { error: detail } : {}), history: [...attempt.history, { state: next, at, ...(detail ? { detail } : {}) }] };
    }
    const index = RELEASE_STATES.indexOf(attempt.state);
    const target = RELEASE_STATES.indexOf(next);
    if (target !== index + 1) throw new Error(`Invalid release transition ${attempt.state} -> ${next}; the upgrade state machine is strictly ordered`);
    return { ...attempt, state: next, history: [...attempt.history, { state: next, at, ...(detail ? { detail } : {}) }] };
}

export function failAttempt(attempt, error, { at = Date.now() } = {}) {
    return transitionAttempt(attempt, FAILED_STATE, { at, detail: error instanceof Error ? error.message : String(error) });
}

/** The old active release is retained until `healthy`; any earlier failure keeps it. */
export function activeRelease(state, profile) {
    return state.profiles[profile]?.active ?? null;
}

export function priorReleases(state, profile) {
    return state.profiles[profile]?.previous ?? [];
}

function releaseRef(profile, entry) {
    return { ...entry, profile };
}

export function commitActivation(state, profile, entry) {
    const current = state.profiles[profile] ?? { role: entry.role, active: null, previous: [], managedOverrides: {} };
    const ref = releaseRef(profile, entry);
    const previous = [];
    if (current.active && current.active.releaseId !== entry.releaseId) previous.push(current.active);
    for (const item of current.previous) {
        if (item.releaseId === entry.releaseId) continue;
        if (previous.some((existing) => existing.releaseId === item.releaseId)) continue;
        previous.push(item);
    }
    const next = normalizeState(state);
    next.profiles[profile] = { role: entry.role, active: ref, previous, managedOverrides: { ...entry.managedOverrides } };
    next.releases[entry.releaseId] = {
        releaseId: entry.releaseId,
        dirName: releaseDirName(entry.releaseId),
        manifestSha256: entry.manifestSha256,
        treeDigest: entry.treeDigest,
        identity: releaseIdentity(entry.manifest),
        createdAt: entry.activatedAt,
    };
    if (next.attempt && next.attempt.releaseId === entry.releaseId) {
        next.history.push({ ...next.attempt, state: RELEASE_STATES[RELEASE_STATES.length - 1] });
        next.attempt = null;
    }
    return next;
}

/**
 * Move the profile pointer back to a previous release. The release that failed
 * stays in `previous` so a retry remains possible.
 */
export function rollbackActivation(state, profile, { toReleaseId } = {}) {
    const current = state.profiles[profile];
    if (!current?.active) throw new Error(`Profile ${profile} has no active release to roll back`);
    const target = toReleaseId
        ? current.previous.find((item) => item.releaseId === toReleaseId)
        : current.previous[0];
    if (!target) throw new Error(`Profile ${profile} has no previous release to roll back to`);
    const next = normalizeState(state);
    const previous = [current.active, ...current.previous.filter((item) => item.releaseId !== target.releaseId)];
    next.profiles[profile] = { ...current, active: target, previous };
    if (state.attempt) {
        next.history.push({ ...state.attempt, state: ROLLED_BACK_STATE, error: `rolled back to ${target.releaseId}` });
        next.attempt = null;
    }
    return { state: next, from: current.active, to: target };
}

/** Releases safe to delete: active nowhere, kept as the last `keepPrevious` for every profile. */
export function prunePlan(state, { keepPrevious = DEFAULT_KEEP_PREVIOUS } = {}) {
    if (!Number.isInteger(keepPrevious) || keepPrevious < DEFAULT_KEEP_PREVIOUS) {
        throw new Error(`At least ${DEFAULT_KEEP_PREVIOUS} previous releases must be retained`);
    }
    const kept = new Set();
    for (const profile of Object.values(state.profiles)) {
        if (profile.active) kept.add(profile.active.releaseId);
        for (const item of profile.previous.slice(0, keepPrevious)) kept.add(item.releaseId);
    }
    if (state.attempt) kept.add(state.attempt.releaseId);
    const remove = Object.keys(state.releases).filter((releaseId) => !kept.has(releaseId));
    return { keep: [...kept].sort(), remove: remove.sort() };
}

/** Keep only the newest `keepPrevious` previous entries per profile after pruning. */
export function trimRetained(state, { keepPrevious = DEFAULT_KEEP_PREVIOUS } = {}) {
    const next = normalizeState(state);
    for (const profile of Object.values(next.profiles)) {
        profile.previous = profile.previous.slice(0, keepPrevious);
    }
    return next;
}

/** State after deleting releases: registry entries go away, pointers may not. */
export function forgetReleases(state, releaseIds) {
    const next = normalizeState(state);
    for (const releaseId of releaseIds) {
        if (prunePlan(next).keep.includes(releaseId)) throw new Error(`refusing to forget release ${releaseId}: it is still referenced`);
        delete next.releases[releaseId];
    }
    return next;
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

async function walkFiles(root, prefix = '') {
    const entries = [];
    const items = await readdir(root, { withFileTypes: true });
    for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = join(root, item.name);
        const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
        if (item.isDirectory()) entries.push(...await walkFiles(absolute, rel));
        else if (item.isFile()) entries.push(rel);
        else throw new Error(`${rel} is not a regular file; the bundle must not contain links or devices`);
    }
    return entries;
}

/**
 * File list for an installed release. Generated trees are private and may hold
 * pnpm symlinks (the pinned runtime is assembled on this machine), so they are
 * excluded instead of being walked; every copied file still needs a checksum.
 */
async function walkReleaseFiles(root, prefix = '') {
    const entries = [];
    const items = await readdir(root, { withFileTypes: true });
    for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = join(root, item.name);
        const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
        if (isGeneratedReleasePath(`${rel}/`)) continue;
        if (item.isDirectory()) entries.push(...await walkReleaseFiles(absolute, rel));
        else if (item.isFile()) entries.push(rel);
        else throw new Error(`${rel} is not a regular file; the release must not contain links or devices`);
    }
    return entries;
}

export async function copyTree(source, destination) {
    await mkdir(destination, { recursive: true, mode: 0o755 });
    const items = await readdir(source, { withFileTypes: true });
    for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
        const from = join(source, item.name);
        const to = join(destination, item.name);
        if (item.isDirectory()) await copyTree(from, to);
        else if (item.isFile()) {
            await mkdir(dirname(to), { recursive: true, mode: 0o755 });
            await copyFile(from, to);
        } else {
            throw new Error(`refusing to copy a non-regular file: ${item.name}`);
        }
    }
}

export async function readManifestFrom(root) {
    let text;
    try {
        text = await readFile(join(root, BUNDLE_LAYOUT.manifest), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`${BUNDLE_LAYOUT.manifest} is missing from the bundle`);
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`${BUNDLE_LAYOUT.manifest} is not valid JSON`);
    }
    return validateBundleManifest(parsed);
}

/**
 * Verify a bundle root or an installed release directory.
 * Returns { manifest, releaseId, manifestSha256, treeDigest, files }.
 */
export async function verifyBundleRoot(root) {
    const manifest = await readManifestFrom(root);
    const files = await walkFiles(root);
    const layoutErrors = bundleLayoutErrors(files);
    if (layoutErrors.length > 0) throw new Error(`Bundle layout is invalid: ${layoutErrors.join('; ')}`);
    const sums = parseSums(await readFile(join(root, BUNDLE_LAYOUT.sums), 'utf8'));
    const sumPaths = new Set(sums.map((entry) => entry.path));
    const required = files.filter((path) => path !== BUNDLE_LAYOUT.sums);
    const missing = required.filter((path) => !sumPaths.has(path));
    if (missing.length > 0) throw new Error(`SHA256SUMS does not cover: ${missing.join(', ')}`);
    for (const entry of sums) {
        if (!files.includes(entry.path)) throw new Error(`SHA256SUMS lists a file that is not in the bundle: ${entry.path}`);
        if (await sha256File(join(root, entry.path)) !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.path}`);
    }
    for (const entry of payloadEntries(manifest)) {
        const actual = await sha256File(join(root, entry.path));
        if (actual !== entry.sha256) throw new Error(`Payload checksum mismatch for ${entry.path}`);
    }
    const manifestSha256 = await sha256File(join(root, BUNDLE_LAYOUT.manifest));
    const treeDigest = digestOfEntries(await Promise.all(files.map(async (path) => ({ path, sha256: await sha256File(join(root, path)) }))));
    const releaseId = computeReleaseId(manifest);
    return { manifest, releaseId, manifestSha256, treeDigest, files };
}

/** Verify the hapi-dsh and ext tarballs declare the identity the manifest promises. */
export async function verifyPayloadTarballs(root, { listTgz, readTgz }) {
    const manifest = await readManifestFrom(root);
    const problems = [];
    const hapi = listTgz(await readFile(join(root, manifest.payload.hapi.tarball)));
    if (!hapi.some((entry) => entry.path === 'package/package.json')) problems.push('payload/hapi-dsh.tgz has no package/package.json');
    else {
        const hapiEntries = readTgz(await readFile(join(root, manifest.payload.hapi.tarball)), { withData: true });
        const raw = readTarballFile(hapiEntries, 'package/package.json');
        const parsed = JSON.parse(raw);
        if (parsed.name !== 'hapi-dsh') problems.push(`payload/hapi-dsh.tgz contains ${String(parsed.name)}, not hapi-dsh`);
        if (parsed.version !== manifest.payload.hapi.version) problems.push(`payload/hapi-dsh.tgz version ${String(parsed.version)} does not match the manifest`);
    }
    for (const item of manifest.payload.dshExt) {
        const entries = listTgz(await readFile(join(root, item.tarball)));
        if (!entries.some((entry) => entry.path === 'package/package.json')) {
            problems.push(`${item.tarball} has no package/package.json`);
            continue;
        }
        const parsed = JSON.parse(readTarballFile(readTgz(await readFile(join(root, item.tarball)), { withData: true }), 'package/package.json'));
        if (parsed.name !== item.name) problems.push(`${item.tarball} contains ${String(parsed.name)}, not ${item.name}`);
        if (parsed.version !== item.version) problems.push(`${item.tarball} version ${String(parsed.version)} does not match ${item.version}`);
    }
    if (problems.length > 0) throw new Error(`Bundle payload identity is invalid: ${problems.join('; ')}`);
}

function readTarballFile(entries, path) {
    const entry = entries.find((item) => item.path === path);
    if (!entry?.data) throw new Error(`tar entry ${path} is missing`);
    return entry.data.toString('utf8');
}

/**
 * Paths a release directory generates after the bundle copy: the extracted
 * hapi-dsh payload, the directory-style ext fallback, and the pinned runtime
 * assembled on this machine. They are deliberately not covered by SHA256SUMS;
 * everything else must be.
 */
export const RELEASE_GENERATED_PREFIXES = Object.freeze(['package/', 'payload/dsh-ext/unpacked/', 'runtime/']);

export function isGeneratedReleasePath(path) {
    return RELEASE_GENERATED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

/** Verify an installed release directory (bundle copy + generated payloads). */
export async function verifyReleaseDirectory(root) {
    const manifest = await readManifestFrom(root);
    const files = await walkReleaseFiles(root);
    const sums = parseSums(await readFile(join(root, BUNDLE_LAYOUT.sums), 'utf8'));
    const sumPaths = new Set(sums.map((entry) => entry.path));
    const copied = files.filter((path) => !isGeneratedReleasePath(path));
    const missing = copied.filter((path) => !sumPaths.has(path) && path !== BUNDLE_LAYOUT.sums);
    if (missing.length > 0) throw new Error(`release directory contains unsummed files: ${missing.slice(0, 5).join(', ')}`);
    for (const entry of sums) {
        if (!files.includes(entry.path)) throw new Error(`SHA256SUMS lists a file that is not in the release: ${entry.path}`);
        if (await sha256File(join(root, entry.path)) !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.path}`);
    }
    for (const entry of payloadEntries(manifest)) {
        if (await sha256File(join(root, entry.path)) !== entry.sha256) throw new Error(`Payload checksum mismatch for ${entry.path}`);
    }
    const extracted = join(root, 'package', 'package.json');
    if (!(await lstat(extracted).then(() => true).catch(() => false))) {
        throw new Error('the release does not contain the extracted hapi-dsh payload');
    }
    const manifestSha256 = await sha256File(join(root, BUNDLE_LAYOUT.manifest));
    const treeDigest = digestOfEntries(await Promise.all(copied.filter((path) => path !== BUNDLE_LAYOUT.sums).map(async (path) => ({ path, sha256: await sha256File(join(root, path)) }))));
    const releaseId = computeReleaseId(manifest);
    if (releaseId !== manifest.releaseId) throw new Error('the release manifest releaseId is inconsistent');
    return { manifest, releaseId, manifestSha256, treeDigest, files };
}

/** Copy a verified bundle into its immutable content-addressed release directory. */
export async function prepareRelease({ bundleRoot, dshHome, verification }) {
    const directory = releaseDirectory(dshHome, verification.releaseId);
    const existing = await lstat(directory).then(() => true).catch((error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
    });
    if (existing) {
        const again = await verifyReleaseDirectory(directory);
        if (again.releaseId !== verification.releaseId || again.manifestSha256 !== verification.manifestSha256) {
            throw new Error(`Release ${releaseDirName(verification.releaseId)} exists with different content; immutable releases may not be rewritten`);
        }
        return { directory, reused: true, ...again };
    }
    const temporary = join(stateRoot(dshHome), 'tmp', `${releaseDirName(verification.releaseId)}.${process.pid}.${randomUUID()}`);
    await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
    try {
        await copyTree(bundleRoot, temporary);
        // The plugin manager needs a real package directory; the tarball stays in
        // payload/ so release integrity can still be checked against SHA256SUMS.
        await extractTgz(await readFile(join(temporary, BUNDLE_LAYOUT.hapiPayload)), temporary);
        await mkdir(releasesDirectory(dshHome), { recursive: true, mode: 0o700 });
        await rename(temporary, directory);
    } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        // A concurrent installer may have won the rename; reuse its identical copy.
        const raced = await lstat(directory).then(() => true).catch(() => false);
        if (!raced) throw error;
    }
    const verified = await verifyReleaseDirectory(directory);
    return { directory, reused: false, ...verified };
}

/* ------------------------------------------------------------------ */
/* Profile staging                                                     */
/* ------------------------------------------------------------------ */

export async function readProfileManifest(directory) {
    try {
        return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        if (error instanceof SyntaxError) throw new Error(`Profile manifest at ${dirname(join(directory, 'package.json'))} is not valid JSON`);
        throw error;
    }
}

export function existingOverrides(profileManifest) {
    const value = profileManifest?.pnpm?.overrides;
    if (value === undefined) return {};
    if (!isRecord(value)) throw new Error('Profile pnpm.overrides is not an object');
    return value;
}

/** Expected link dependency the official plugin manager writes for a bundle. */
export function linkDependencyName(role) {
    return role === 'runner' ? 'hapi-dsh-runner' : 'hapi-dsh';
}

export function linkTarget(releaseRoot, role) {
    // The Host plugin lives inside the pinned runtime so every @deepseek-ai/*
    // import resolves to the runtime's single package copies.
    return role === 'runner'
        ? join(releaseRoot, 'package/dist/runner')
        : join(releaseRoot, 'runtime/node_modules/hapi-dsh');
}

export function stagedOverrides({ current, manifest, profile, dshHome, releaseRoot, style, extractedExtDirectories, previousManaged }) {
    const managedBuild = buildManagedOverrides({ manifest, releaseRoot, profileDirectory: profileDirectory(dshHome, profile), style, extractedExtDirectories });
    const merged = mergeOverrides({ existing: existingOverrides(current), managed: managedBuild.overrides, previousManaged });
    if (merged.conflicts.length > 0) throw new Error(`Profile overrides conflict with hapi-dsh: ${describeConflicts(merged.conflicts)}`);
    return { managed: managedBuild.overrides, targets: managedBuild.targets, merged };
}

export function applyOverridesToManifest(profileManifest, overrides) {
    const next = structuredClone(profileManifest ?? {});
    if (Object.keys(overrides).length === 0) {
        if (isRecord(next.pnpm) && next.pnpm.overrides !== undefined) {
            delete next.pnpm.overrides;
            if (Object.keys(next.pnpm).length === 0) delete next.pnpm;
        }
        return next;
    }
    next.pnpm = { ...(isRecord(next.pnpm) ? next.pnpm : {}), overrides };
    return next;
}

export async function backupProfileFiles(dshHome, profile, releaseId) {
    const target = backupDirectory(dshHome, releaseId, profile);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const files = [];
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
        const source = join(profileDirectory(dshHome, profile), name);
        const copied = await copyFile(source, join(target, name)).then(() => true).catch((error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
        });
        if (copied) files.push(name);
    }
    return { directory: target, files };
}

export async function restoreProfileBackup({ backupDirectory: source, profileDirectory: target }) {
    const restored = [];
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
        const from = join(source, name);
        const exists = await lstat(from).then(() => true).catch((error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
        });
        if (!exists) continue;
        await copyFile(from, join(target, name));
        restored.push(name);
    }
    if (restored.length === 0) throw new Error('The rollback backup is empty; refusing to claim a restored profile');
    return restored;
}

/* ------------------------------------------------------------------ */
/* Resolution and identity checks                                      */
/* ------------------------------------------------------------------ */

/** Packages that must resolve to exactly one physical copy across a profile. */
export const SINGLETON_PACKAGES = Object.freeze([
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-client-modules',
    '@deepseek-ai/dsh-client-ui-chat',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-api-session-controller',
]);

async function readPackageIdentity(directory) {
    try {
        const parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        const { realpath } = await import('node:fs/promises');
        return { name: parsed.name, version: parsed.version, realPath: await realpath(directory) };
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
    }
}

/**
 * Resolve each ext package from the profile and check that the resolved copy
 * comes from this release (not the untouched registry package).
 */
export async function inspectExtResolution({ dshHome, profile, manifest, releaseRoot }) {
    const directory = profileDirectory(dshHome, profile);
    const releaseMarker = releaseDirName(computeReleaseId(manifest));
    const ext = [];
    for (const item of manifest.payload.dshExt) {
        const resolved = await readPackageIdentity(join(directory, 'node_modules', item.name));
        if (!resolved) {
            ext.push({ name: item.name, expectedVersion: item.version, resolved: false, problems: [`${item.name} is not installed in profile ${profile}`] });
            continue;
        }
        const problems = [];
        if (resolved.version !== item.version) problems.push(`${item.name} resolves to ${String(resolved.version)}, expected the extended ${item.version}`);
        const pathHint = resolved.realPath.split('\\').join('/');
        const fromRelease = pathHint.includes(releaseMarker) || pathHint.includes('dsh-ext') || pathHint.startsWith(resolve(releaseRoot).split('\\').join('/'));
        if (!fromRelease) problems.push(`${item.name} resolves outside the active release (${pathHint.includes('node_modules/.pnpm') ? 'pnpm registry copy' : 'unexpected path'})`);
        ext.push({ name: item.name, expectedVersion: item.version, version: resolved.version, realPath: resolved.realPath, resolved: true, problems });
    }
    return ext;
}

export async function inspectHapiLink({ dshHome, profile, releaseRoot, role }) {
    const directory = profileDirectory(dshHome, profile);
    const name = linkDependencyName(role);
    const expectedTarget = linkTarget(releaseRoot, role);
    const manifest = await readProfileManifest(directory);
    const dependency = manifest?.dependencies?.[name];
    if (typeof dependency !== 'string') return { name, ok: false, problems: [`profile ${profile} does not depend on ${name}`] };
    const spec = dependency.startsWith('link:') ? dependency.slice('link:'.length) : dependency;
    const resolvedSpec = resolve(directory, spec);
    const target = await lstat(expectedTarget).then(() => expectedTarget).catch(() => undefined);
    if (!target) return { name, ok: false, problems: [`release does not contain ${relative(releaseRoot, expectedTarget)}`] };
    const ok = resolve(resolvedSpec) === resolve(target);
    return { name, ok, spec: dependency, problems: ok ? [] : [`${name} links ${spec}, expected the active release ${expectedTarget}`] };
}

/**
 * Detect duplicate DSH singleton copies in a pnpm profile: the spec calls a
 * mixed original/extended load a hard failure, not a warning.
 */
export async function scanDshSingletons({ dshHome, profile }) {
    const directory = profileDirectory(dshHome, profile);
    const store = join(directory, 'node_modules', '.pnpm');
    let storeEntries;
    try {
        storeEntries = await readdir(store, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return { available: false, copies: {}, duplicates: [] };
        throw error;
    }
    const copies = {};
    for (const entry of storeEntries) {
        if (!entry.isDirectory()) continue;
        for (const name of SINGLETON_PACKAGES) {
            const identity = await readPackageIdentity(join(store, entry.name, 'node_modules', name));
            if (!identity) continue;
            copies[name] ??= [];
            if (!copies[name].some((item) => item.realPath === identity.realPath)) {
                copies[name].push({ version: identity.version, realPath: identity.realPath });
            }
        }
    }
    const duplicates = Object.entries(copies)
        .filter(([, items]) => items.length > 1)
        .map(([name, items]) => ({ name, copies: items }));
    return { available: true, copies, duplicates };
}

export async function readRuntimeSnapshot(dshHome) {
    let text;
    try {
        text = await readFile(runtimeFile(dshHome), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('runtime.json is not valid JSON');
    }
    if (!isRecord(parsed) || !['host', 'runner'].includes(parsed.role)) throw new Error('runtime.json does not name a host or runner role');
    const busySessions = Number.isInteger(parsed.busySessions) ? parsed.busySessions : 0;
    return {
        role: parsed.role,
        pid: Number.isInteger(parsed.pid) ? parsed.pid : undefined,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
        busySessions,
        identity: isRecord(parsed.identity) ? parsed.identity : undefined,
    };
}

/** Idle gate: a host with running ordinary sessions must not be restarted under them. */
export function idleVerdict(runtime, { role, pidAlive = () => true } = {}) {
    if (!runtime) return { wait: false, reason: 'no live Host/Runner snapshot is available' };
    if (runtime.role !== role) return { wait: false, reason: `runtime snapshot belongs to the ${runtime.role}, not the ${role}` };
    if (runtime.pid !== undefined && !pidAlive(runtime.pid)) return { wait: false, reason: `the recorded ${role} process is no longer running` };
    if (runtime.busySessions > 0) return { wait: true, reason: `${runtime.busySessions} ordinary DSH session(s) are running; waiting for idle` };
    return { wait: false, reason: `${role} is running without ordinary DSH sessions` };
}

export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

/**
 * Fixed 30s health gate. The probe returns undefined on success or an error
 * message on failure; the last failure is reported without retrying forever.
 */
export async function awaitHealthy(probe, { timeoutMs = HEALTH_TIMEOUT_MS, intervalMs = 1000, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
    const startedAt = now();
    let attempts = 0;
    let lastError;
    for (;;) {
        attempts += 1;
        try {
            const problem = await probe();
            if (problem === undefined || problem === null) return { ok: true, attempts, lastError: undefined, elapsedMs: now() - startedAt };
            lastError = problem instanceof Error ? problem.message : String(problem);
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        if (now() - startedAt >= timeoutMs) return { ok: false, attempts, lastError, elapsedMs: now() - startedAt, timedOut: true };
        await sleep(intervalMs);
    }
}

/**
 * True when the live profile is already exactly the requested release: same
 * active pointer, same managed overrides, and the link dependency still points
 * at this release directory. Re-installing that manifest must change nothing.
 */
export function isIdempotentReinstall({ state, dshHome, profile, role, releaseId, releaseRoot, currentProfile, managedOverrides }) {
    const current = state.profiles[profile];
    if (!current?.active || current.active.releaseId !== releaseId || current.active.role !== role) return false;
    if (!overridesEqual(current.managedOverrides ?? {}, managedOverrides)) return false;
    const live = existingOverrides(currentProfile);
    // Only the managed keys must match; every other override belongs to the user.
    if (!Object.entries(managedOverrides).every(([name, value]) => live[name] === value)) return false;
    const name = linkDependencyName(role);
    const dependency = currentProfile?.dependencies?.[name];
    if (typeof dependency !== 'string') return false;
    const spec = dependency.startsWith('link:') ? dependency.slice('link:'.length) : dependency;
    return resolve(profileDirectory(dshHome, profile), spec) === resolve(linkTarget(releaseRoot, role));
}

export { BUNDLE_LAYOUT, computeReleaseId, releaseDirName, releaseIdentity, sha256Bytes, assertTargetInside, buildManagedOverrides, mergeOverrides, overridesEqual, formatSums };
