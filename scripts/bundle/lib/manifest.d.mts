export const BUNDLE_SCHEMA_VERSION: 1;
export const BUNDLE_NAME: 'hapi-dsh-bundle';
export const BUNDLE_PROTOCOL: 2;
export const EXT_CAPABILITIES: readonly ['historySource', 'mountedChat', 'windowCommit'];
export const PINNED_UPSTREAM_VERSION: '0.2.1-rc.3';
export const PINNED_UPSTREAM_COMMIT: '1f81c047fc48fa190a683e469daa699857e9afe8';
export const MINIMUM_PNPM: '11.28.5';
export const BUNDLE_LAYOUT: {
    install: 'dist/install.mjs';
    lib: 'dist/lib';
    manifest: 'manifest.json';
    sums: 'SHA256SUMS';
    hapiPayload: 'payload/hapi-dsh.tgz';
    extPayload: 'payload/dsh-ext';
    licenses: 'LICENSES';
    sourceOffer: 'SOURCE-OFFER';
};

export interface ExtPayloadEntry {
    name: string;
    version: string;
    tarball: string;
    sha256: string;
    size: number;
}

export interface RuntimeIdentity {
    upstreamVersion: string;
    upstreamCommit: string;
    extRelease: string;
    patchSetSha256: string;
    packageSetSha256: string;
    capabilities: Record<string, number>;
    compositionVersion: string;
    protocol: number;
}

export interface BundleManifest {
    schemaVersion: number;
    name: string;
    version: string;
    createdAt: string;
    fixture?: boolean;
    release: {
        upstreamVersion: string;
        upstreamCommit: string;
        extRelease: string;
        patchSetSha256: string;
        packageSetSha256: string;
        compositionVersion: string;
        protocol: number;
        capabilities: Record<string, number>;
    };
    payload: {
        hapi: { tarball: string; sha256: string; size: number; version: string };
        dshExt: ExtPayloadEntry[];
    };
    minimums: { node: string; pnpm: string };
    licenses: string[];
    sourceOffer: string[];
    releaseId: string;
}

export function validateBundleManifest(input: unknown): BundleManifest;
export function payloadEntries(manifest: BundleManifest): Array<{ path: string; sha256: string; size: number }>;
export function packageSetSha256(packages: Array<{ name: string; version: string; sha256: string }>): string;
export function releaseIdentity(manifest: BundleManifest): RuntimeIdentity;
export function computeReleaseId(manifest: BundleManifest): string;
export function releaseDirName(releaseId: string): string;
export function identityMismatches(expected: RuntimeIdentity, observed: unknown): string[];
export function parseSums(text: string): Array<{ sha256: string; path: string }>;
export function formatSums(entries: Array<{ sha256: string; path: string }>): string;
export function summedFiles(files: Array<string | { path: string }>): string[];
export function bundleLayoutErrors(files: string[]): string[];
export function installerImportErrors(source: string, name?: string): string[];
