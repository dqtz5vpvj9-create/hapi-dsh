import type { BundleManifest, RuntimeIdentity } from './manifest.mjs';

export interface ReleaseRef {
    releaseId: string;
    profile: string;
    role: 'host' | 'runner';
    activatedAt: string;
    manifestSha256: string;
    treeDigest: string;
    managedOverrides: Record<string, string>;
}

export interface ProfileReleaseState {
    role: 'host' | 'runner';
    active: ReleaseRef | null;
    previous: ReleaseRef[];
    managedOverrides: Record<string, string>;
}

export interface ReleaseAttempt {
    releaseId: string;
    role: 'host' | 'runner';
    profile: string;
    dryRun: boolean;
    state: string;
    startedAt: number;
    error: string | null;
    history: Array<{ state: string; at: number; detail?: string }>;
}

export interface BundleState {
    version: number;
    profiles: Record<string, ProfileReleaseState>;
    releases: Record<string, {
        releaseId: string;
        dirName: string;
        manifestSha256: string;
        treeDigest: string;
        identity: RuntimeIdentity;
        createdAt: string;
    }>;
    attempt: ReleaseAttempt | null;
    history: ReleaseAttempt[];
    updatedAt: string;
}

export interface RuntimeSnapshot {
    role: 'host' | 'runner';
    pid?: number;
    startedAt?: string;
    busySessions: number;
    identity?: RuntimeIdentity;
    error?: string;
}

export interface BundleVerification {
    manifest: BundleManifest;
    releaseId: string;
    manifestSha256: string;
    treeDigest: string;
    files: string[];
}

export interface PreparedRelease extends BundleVerification {
    directory: string;
    reused: boolean;
}

export interface StagedOverrides {
    managed: Record<string, string>;
    targets: Record<string, string>;
    merged: { overrides: Record<string, string>; conflicts: Array<{ key: string; existing: string; managed?: string }>; removed: string[] };
}

export interface ExtResolution {
    name: string;
    expectedVersion: string;
    version?: string;
    realPath?: string;
    resolved: boolean;
    problems: string[];
}

export interface SingletonScan {
    available: boolean;
    copies: Record<string, Array<{ version: string; realPath: string }>>;
    duplicates: Array<{ name: string; copies: Array<{ version: string; realPath: string }> }>;
}

export const STATE_VERSION: 1;
export const DEFAULT_KEEP_PREVIOUS: 2;
export const HEALTH_TIMEOUT_MS: 30000;
export const RELEASE_STATES: readonly string[];
export const FAILED_STATE: 'failed';
export const ROLLED_BACK_STATE: 'rolled-back';
export const SINGLETON_PACKAGES: readonly string[];

export function dshHomeFromEnv(env?: NodeJS.ProcessEnv): string;
export function stateRoot(dshHome: string): string;
export function stateFile(dshHome: string): string;
export function releasesDirectory(dshHome: string): string;
export function releaseDirectory(dshHome: string, releaseId: string): string;
export function backupsDirectory(dshHome: string): string;
export function backupDirectory(dshHome: string, releaseId: string, profile: string): string;
export function bundleCacheDirectory(dshHome: string): string;
export function profileDirectory(dshHome: string, profile: string): string;
export function runtimeFile(dshHome: string): string;
export function emptyState(): BundleState;
export function normalizeState(input: unknown): BundleState;
export function readBundleState(dshHome: string): Promise<BundleState>;
export function writeBundleState(dshHome: string, state: BundleState): Promise<BundleState>;
export function startAttempt(options: { releaseId: string; role: 'host' | 'runner'; profile: string; at?: number; dryRun?: boolean }): ReleaseAttempt;
export function transitionAttempt(attempt: ReleaseAttempt, next: string, options?: { at?: number; detail?: string }): ReleaseAttempt;
export function failAttempt(attempt: ReleaseAttempt, error: unknown, options?: { at?: number }): ReleaseAttempt;
export function activeRelease(state: BundleState, profile: string): ReleaseRef | null;
export function priorReleases(state: BundleState, profile: string): ReleaseRef[];
export function commitActivation(state: BundleState, profile: string, entry: Omit<ReleaseRef, 'profile' | 'manifestSha256' | 'treeDigest'> & {
    manifest: BundleManifest; manifestSha256: string; treeDigest: string; managedOverrides: Record<string, string>;
}): BundleState;
export function rollbackActivation(state: BundleState, profile: string, options?: { toReleaseId?: string }): { state: BundleState; from: ReleaseRef; to: ReleaseRef };
export function prunePlan(state: BundleState, options?: { keepPrevious?: number }): { keep: string[]; remove: string[] };
export function forgetReleases(state: BundleState, releaseIds: string[]): BundleState;
export function trimRetained(state: BundleState, options?: { keepPrevious?: number }): BundleState;
export function copyTree(source: string, destination: string): Promise<void>;
export function readManifestFrom(root: string): Promise<BundleManifest>;
export function verifyBundleRoot(root: string): Promise<BundleVerification>;
export function verifyPayloadTarballs(root: string, tools: {
    listTgz: (buffer: Buffer) => Array<{ path: string }>;
    readTgz: (buffer: Buffer, options?: { withData?: boolean }) => Array<{ path: string; data?: Buffer }>;
}): Promise<void>;
export const RELEASE_GENERATED_PREFIXES: readonly string[];
export function isGeneratedReleasePath(path: string): boolean;
export { releaseDirName, computeReleaseId, releaseIdentity } from './manifest.mjs';
export function verifyReleaseDirectory(root: string): Promise<BundleVerification>;
export function prepareRelease(options: { bundleRoot: string; dshHome: string; verification: BundleVerification }): Promise<PreparedRelease>;
export function readProfileManifest(directory: string): Promise<Record<string, unknown> | undefined>;
export function existingOverrides(profileManifest: Record<string, unknown> | undefined): Record<string, string>;
export function linkDependencyName(role: 'host' | 'runner'): string;
export function linkTarget(releaseRoot: string, role: 'host' | 'runner'): string;
export function stagedOverrides(options: {
    current: Record<string, unknown> | undefined;
    manifest: BundleManifest;
    profile: string;
    dshHome: string;
    releaseRoot: string;
    style?: 'tarball' | 'directory';
    extractedExtDirectories?: Record<string, string>;
    previousManaged: Record<string, string>;
}): StagedOverrides;
export function applyOverridesToManifest(profileManifest: Record<string, unknown> | undefined, overrides: Record<string, string>): Record<string, unknown>;
export function backupProfileFiles(dshHome: string, profile: string, releaseId: string): Promise<{ directory: string; files: string[] }>;
export function restoreProfileBackup(options: { backupDirectory: string; profileDirectory: string }): Promise<string[]>;
export function inspectExtResolution(options: { dshHome: string; profile: string; manifest: BundleManifest; releaseRoot: string }): Promise<ExtResolution[]>;
export function inspectHapiLink(options: { dshHome: string; profile: string; releaseRoot: string; role: 'host' | 'runner' }): Promise<{ name: string; ok: boolean; spec?: string; problems: string[] }>;
export function scanDshSingletons(options: { dshHome: string; profile: string }): Promise<SingletonScan>;
export function readRuntimeSnapshot(dshHome: string): Promise<RuntimeSnapshot | undefined>;
export function idleVerdict(runtime: RuntimeSnapshot | undefined, options: { role: 'host' | 'runner'; pidAlive?: (pid: number) => boolean }): { wait: boolean; reason: string };
export function isProcessAlive(pid: number): boolean;
export function awaitHealthy(probe: () => Promise<string | undefined | null | void>, options?: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; attempts: number; lastError?: string; elapsedMs: number; timedOut?: boolean }>;
export function sha256Bytes(bytes: Uint8Array): string;
export function formatSums(entries: Array<{ sha256: string; path: string }>): string;
export function buildManagedOverrides(options: {
    manifest: BundleManifest;
    releaseRoot: string;
    profileDirectory: string;
    style?: 'tarball' | 'directory';
    extractedExtDirectories?: Record<string, string>;
}): { overrides: Record<string, string>; targets: Record<string, string> };
export function mergeOverrides(options: {
    existing?: Record<string, string>;
    managed: Record<string, string>;
    previousManaged?: Record<string, string>;
}): { overrides: Record<string, string>; conflicts: Array<{ key: string; existing: string; managed?: string }>; removed: string[] };
export function overridesEqual(left?: Record<string, string>, right?: Record<string, string>): boolean;
export function assertTargetInside(target: string, releaseRoot: string, name: string): void;
export function isIdempotentReinstall(options: {
    state: BundleState;
    dshHome: string;
    profile: string;
    role: 'host' | 'runner';
    releaseId: string;
    releaseRoot: string;
    currentProfile: Record<string, unknown> | undefined;
    managedOverrides: Record<string, string>;
}): boolean;
