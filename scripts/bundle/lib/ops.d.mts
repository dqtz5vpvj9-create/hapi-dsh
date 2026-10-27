import type { BundleManifest, RuntimeIdentity } from './manifest.mjs';
import type {
    BundleState, ExtResolution, ProfileReleaseState, RuntimeSnapshot, SingletonScan, BundleVerification,
} from './release.mjs';

export interface BundleCommand {
    executable: string;
    args: string[];
}

export interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export type CommandRunner = (command: BundleCommand, options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;

export interface ReinstallOptions {
    profileDirectory: string;
    pnpm: BundleCommand;
    run: CommandRunner;
    env: NodeJS.ProcessEnv;
    logger: (message: string) => void;
}

export interface InstallOptions {
    bundleRoot: string;
    dshHome: string;
    profile: string;
    role: 'host' | 'runner';
    style?: 'tarball' | 'directory';
    command?: BundleCommand;
    pnpm?: BundleCommand;
    run?: CommandRunner;
    env?: NodeJS.ProcessEnv;
    dryRun?: boolean;
    waitIdleTimeoutMs?: number;
    idlePollMs?: number;
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
    keepPrevious?: number;
    healthUrl?: string;
    healthProbe?: () => Promise<string | undefined | null | void>;
    runtimeProbe?: () => Promise<RuntimeSnapshot | undefined>;
    /** Test seam: replace the pinned-runtime assembly (defaults to the real builder). */
    runtimeBuilder?: (options: {
        run: CommandRunner; pnpm: BundleCommand; env: NodeJS.ProcessEnv; releaseRoot: string;
        manifest: { version?: string; release: { upstreamVersion: string; extRelease?: string };
            payload: { dshExt: Array<{ name: string; version: string; tarball: string }> } };
        logger?: (message: string) => void;
    }) => Promise<{ directory: string; dshBinary: string; dshVersion: string; packages: Array<{ name: string; version: string; sha256: string }> }>;
    pidAlive?: (pid: number) => boolean;
    nodeVersion?: string;
    pnpmVersion?: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    logger?: (message: string) => void;
    reinstall?: (options: ReinstallOptions) => Promise<void>;
}

export interface InstallResult {
    ok: boolean;
    state: string;
    releaseId: string;
    profile: string;
    role: string;
    changed?: boolean;
    idempotent?: boolean;
    dryRun?: boolean;
    waiting?: boolean;
    reason?: string;
    error?: string;
    releaseDirectory?: string;
    managedOverrides?: Record<string, string>;
    stagedProfile?: Record<string, unknown>;
    checks?: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; detail: string }>;
    plannedCommands?: Array<{ purpose: string; args: string[] }>;
    healthAttempts?: number;
    rolledBack?: boolean;
    oldActivePreserved?: boolean;
    retained?: string[];
    pruned?: string[];
    reverted?: { restored: string[]; reinstalled: boolean; warning?: string };
    restartRequired?: string;
}

export interface RollbackResult {
    ok: boolean;
    state: string;
    from?: string;
    to?: string;
    error?: string;
    releaseDirectory?: string;
    profile?: string;
    restored?: string[];
    note?: string;
}

export interface StatusResult {
    ok: boolean;
    dshHome: string;
    stateFile: string;
    profiles: Record<string, {
        role: 'host' | 'runner';
        active: { releaseId: string; directory: string; present: boolean } | null;
        previous: Array<{ releaseId: string; directory: string; present: boolean }>;
        managedOverrides: Record<string, string>;
    }>;
    attempt: BundleState['attempt'];
    runtime: RuntimeSnapshot | { error: string } | undefined;
    requestedProfile?: string;
}

export interface VerifyStoreResult {
    ok: boolean;
    releases: Array<{
        releaseId: string;
        directory: string;
        ok: boolean;
        error?: string;
        releaseIdMatches?: boolean;
        manifestSha256Matches?: boolean;
        treeDigestMatches?: boolean;
        treeDigest?: string;
    }>;
    missing: string[];
    state: BundleState;
}

export interface ReleaseInspection {
    installed: boolean;
    statePresent: boolean;
    profile: string;
    role?: 'host' | 'runner';
    state: BundleState;
    active?: {
        releaseId: string;
        directory: string;
        present: boolean;
        manifest?: BundleManifest;
        identity?: RuntimeIdentity;
        verificationError?: string;
    };
    previous: Array<{ releaseId: string; directory: string; present: boolean; treeDigest?: string; error?: string }>;
    manifestHash?: { recorded?: string; actual: string; releaseIdMatches: boolean; ok: boolean };
    integrity?: { treeDigest: string; recordedTreeDigest?: string; ok: boolean };
    licenses: string[];
    sourceOffer: string[];
    extCapabilities?: {
        declared: Record<string, number>;
        expected: Record<string, number>;
        packages: Array<{ name: string; version: string; declared: Record<string, number> | null }>;
    };
    extResolution?: ExtResolution[];
    link?: { name: string; ok: boolean; spec?: string; problems: string[] };
    singletons?: SingletonScan;
    profileOverrides?: Record<string, string>;
    managedOverrides: Record<string, string>;
    overridesMatch?: boolean;
    runtime?: RuntimeSnapshot | { error: string };
    runtimePackages?: {
        ok: boolean;
        directory?: string;
        dshBinary?: string;
        packages: Array<{ name: string; version: string; directory?: string }>;
        problems: string[];
    };
    runtimeResolution?: {
        ok: boolean;
        packages: Array<{ name: string; versions: string[]; split: boolean; shared: boolean; resolvedBy: number; paths: string[] }>;
        problems: string[];
        unresolved?: string[];
        coverage?: string[];
    };
    roles: Record<string, { role: 'host' | 'runner'; releaseId: string | null; identity?: RuntimeIdentity }>;
    manifestSha256?: string;
    releaseIdMatches?: boolean;
}

export function auditResolution(releaseRoot: string): Promise<{
    ok: boolean;
    packages: Array<{ name: string; versions: string[]; split: boolean; shared: boolean; resolvedBy: number; paths: string[] }>;
    problems: string[];
    unresolved: string[];
    coverage: string[];
}>;

export function defaultRun(command: BundleCommand, options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
export function acquireInstallLock(dshHome: string): Promise<() => Promise<void>>;
export function unpackExtDirectories(options: {
    dshHome: string;
    manifest: BundleManifest;
    releaseId: string;
    releaseRoot: string;
    logger?: (message: string) => void;
}): Promise<{ container: string; directories: Record<string, string> }>;
export function preActivationChecks(options: {
    manifest: BundleManifest;
    bundleRoot: string;
    releaseRoot?: string;
    command?: BundleCommand;
    run: CommandRunner;
    env: NodeJS.ProcessEnv;
    nodeVersion?: string;
    pnpmVersion?: string;
}): Promise<Array<{ name: string; status: 'pass' | 'fail'; detail: string }>>;
export function activateRelease(options: {
    dshHome: string;
    profile: string;
    role: 'host' | 'runner';
    releaseRoot: string;
    manifest: BundleManifest;
    style?: 'tarball' | 'directory';
    extractedExtDirectories?: { container?: string; directories: Record<string, string> };
    previousManaged: Record<string, string>;
    command: BundleCommand;
    run: CommandRunner;
    env: NodeJS.ProcessEnv;
    logger: (message: string) => void;
    pnpm?: BundleCommand;
    reinstall?: (options: ReinstallOptions) => Promise<void>;
    previousActive?: unknown;
}): Promise<{
    createdProfile: boolean;
    backup: { directory: string; files: string[] };
    managed: Record<string, string>;
    merged: { overrides: Record<string, string> };
    before: string;
    staged: Record<string, unknown>;
}>;
export function revertActivation(options: {
    dshHome: string;
    profile: string;
    releaseId: string;
    backup?: { directory: string; files: string[] };
    createdProfile: boolean;
    previousActive: unknown;
    pnpm?: BundleCommand;
    run: CommandRunner;
    env: NodeJS.ProcessEnv;
    reinstall?: (options: ReinstallOptions) => Promise<void>;
    logger: (message: string) => void;
}): Promise<{ restored: string[]; reinstalled: boolean; warning?: string }>;
export function reinstallProfile(options: ReinstallOptions): Promise<void>;
export function installRelease(options: InstallOptions): Promise<InstallResult>;
export function rollbackRelease(options: {
    dshHome: string;
    profile: string;
    toReleaseId?: string;
    pnpm?: BundleCommand;
    run?: CommandRunner;
    env?: NodeJS.ProcessEnv;
    logger?: (message: string) => void;
    reinstall?: (options: ReinstallOptions) => Promise<void>;
    command?: BundleCommand;
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}): Promise<RollbackResult>;
export function statusRelease(options: { dshHome: string; profile?: string }): Promise<StatusResult>;
export function verifyReleaseStore(options: { dshHome: string }): Promise<VerifyStoreResult>;
export function pruneReleaseStore(options: { dshHome: string; keepPrevious?: number; logger?: (message: string) => void }): Promise<{ ok: boolean; removed: string[]; retained: string[] }>;
export function inspectReleaseState(options: { dshHome: string; profile: string; runtime?: RuntimeSnapshot | { error: string } }): Promise<ReleaseInspection>;
