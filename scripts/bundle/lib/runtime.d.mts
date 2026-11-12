import type { BundleManifest } from './manifest.mjs';
import type { BundleCommand, CommandRunner } from './ops.mjs';
import type * as path from 'node:path';

export interface RuntimeLockSource { releaseId: string; sha256: string; packageManager: string }
export interface RuntimeOptions {
    releaseRoot: string; manifest: BundleManifest; run: CommandRunner; pnpm: BundleCommand;
    env: NodeJS.ProcessEnv; pnpmVersion?: string; previousReleaseRoot?: string;
    logger?: (message: string) => void;
}
export interface RuntimeSeal {
    schemaVersion: number; upstreamVersion: string; extRelease: string;
    files: Record<string, string>; packageManager?: string; lockfileSource?: RuntimeLockSource;
    packages: Array<{ name: string; version: string }>;
}
export function reuseRuntimeLockfile(options: Pick<RuntimeOptions, 'releaseRoot' | 'manifest' | 'previousReleaseRoot' | 'pnpmVersion' | 'logger'>): Promise<RuntimeLockSource | undefined>;
export function prepareRuntime(options: RuntimeOptions): Promise<{ directory: string; dshBinary: string; dshVersion: string; packages: Array<{ name: string; version: string; sha256: string }> }>;
export function runtimeFilePath(directory: string, file: string, paths?: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>): string | undefined;
export function verifyRuntimeSeal(releaseRoot: string, manifest: BundleManifest): Promise<{ ok: boolean; problems: string[]; seal?: RuntimeSeal }>;
export function inspectRuntime(options: { releaseRoot: string; manifest: BundleManifest }): Promise<{ ok: boolean; directory: string; dshBinary?: string; packages: Array<{ name: string; version: string; directory: string }>; problems: string[] }>;
export const RESOLUTION_SINGLETONS: readonly string[];
export function auditRuntimeResolution(releaseRoot: string): Promise<{ ok: boolean; packages: Array<{ name: string; versions: string[]; split: boolean; shared: boolean; resolvedBy: number; paths: string[] }>; problems: string[]; unresolved: string[]; coverage: string[] }>;
