/**
 * Runtime identity exchanged by the Hub and every paired Runner before any
 * business frame is forwarded. It pins the upstream DSH revision, the ext
 * overlay release, and the capability set both sides must share.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Federation frames carry this protocol revision. */
export const RUNTIME_PROTOCOL = 2 as const;

export interface RuntimeIdentityV1 {
    readonly upstreamVersion: string;
    readonly upstreamCommit: string;
    readonly extRelease: string;
    readonly patchSetSha256: string;
    readonly packageSetSha256: string;
    readonly capabilities: Readonly<Record<string, number>>;
    readonly compositionVersion: string;
    readonly protocol: typeof RUNTIME_PROTOCOL;
}

/** Upstream commit recorded at build time; a missing file stays explicit. */
function upstreamCommitFromPackage(): string {
    try {
        const value = JSON.parse(readFileSync(new URL('../../UPSTREAMS.json', import.meta.url), 'utf8')) as { dsh?: { commit?: unknown } };
        return typeof value.dsh?.commit === 'string' ? value.dsh.commit : 'unknown';
    } catch {
        return 'unknown';
    }
}

interface BundleReleaseIdentity {
    extRelease: string;
    patchSetSha256: string;
    packageSetSha256: string;
    capabilities: Readonly<Record<string, number>>;
    compositionVersion: string;
}

/** Active bundle release identity, when the Host was installed from a bundle. */
function bundleIdentity(dshHome: string | undefined, profile: string | undefined): BundleReleaseIdentity | undefined {
    if (!dshHome) return undefined;
    try {
        const state = JSON.parse(readFileSync(join(dshHome, 'hapi-dsh', 'state.json'), 'utf8')) as {
            profiles?: Record<string, { active?: { releaseId?: string } }>;
            releases?: Record<string, { directory?: string }>;
        };
        const profiles = state.profiles ?? {};
        // Never borrow another profile's release identity.
        const entry = profile === undefined ? undefined : profiles[profile];
        const releaseId = entry?.active?.releaseId;
        const directory = releaseId === undefined ? undefined : state.releases?.[releaseId]?.directory;
        if (directory === undefined) return undefined;
        const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
            release?: {
                extRelease?: unknown; patchSetSha256?: unknown; packageSetSha256?: unknown;
                capabilities?: unknown; compositionVersion?: unknown;
            };
        };
        const release = manifest.release ?? {};
        const capabilities = typeof release.capabilities === 'object' && release.capabilities !== null
            ? Object.fromEntries(Object.entries(release.capabilities as Record<string, unknown>)
                .filter((entry): entry is [string, number] => typeof entry[1] === 'number')) : {};
        return {
            extRelease: typeof release.extRelease === 'string' ? release.extRelease : 'source',
            patchSetSha256: typeof release.patchSetSha256 === 'string' ? release.patchSetSha256 : '',
            packageSetSha256: typeof release.packageSetSha256 === 'string' ? release.packageSetSha256 : '',
            capabilities,
            compositionVersion: typeof release.compositionVersion === 'string' ? release.compositionVersion : '',
        };
    } catch {
        return undefined;
    }
}

/** Identity of this process; a source checkout reports `source` ext values. */
export function runtimeIdentity(input: { dshVersion: string; dshHome?: string; profile?: string }): RuntimeIdentityV1 {
    const bundle = bundleIdentity(input.dshHome, input.profile);
    return {
        upstreamVersion: input.dshVersion,
        upstreamCommit: upstreamCommitFromPackage(),
        extRelease: bundle?.extRelease ?? 'source',
        patchSetSha256: bundle?.patchSetSha256 ?? '',
        packageSetSha256: bundle?.packageSetSha256 ?? '',
        capabilities: bundle?.capabilities ?? {},
        compositionVersion: bundle?.compositionVersion ?? `${input.dshVersion}+source`,
        protocol: RUNTIME_PROTOCOL,
    };
}

/** Exact identity match; every field participates, including capability values. */
export function identityMatches(left: RuntimeIdentityV1 | undefined, right: RuntimeIdentityV1 | undefined): boolean {
    if (!left || !right) return false;
    if (left.protocol !== right.protocol || left.upstreamVersion !== right.upstreamVersion
        || left.upstreamCommit !== right.upstreamCommit || left.extRelease !== right.extRelease
        || left.patchSetSha256 !== right.patchSetSha256 || left.packageSetSha256 !== right.packageSetSha256
        || left.compositionVersion !== right.compositionVersion) return false;
    const leftKeys = Object.keys(left.capabilities).sort();
    const rightKeys = Object.keys(right.capabilities).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && left.capabilities[key] === right.capabilities[key]);
}

const identities = new WeakSet<object>();

/** Parser-side shape check for a received identity. */
export function validRuntimeIdentity(value: unknown): value is RuntimeIdentityV1 {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const identity = value as Record<string, unknown>;
    if (Object.keys(identity).some(key => !['upstreamVersion', 'upstreamCommit', 'extRelease', 'patchSetSha256',
        'packageSetSha256', 'capabilities', 'compositionVersion', 'protocol'].includes(key))) return false;
    if (identity.protocol !== RUNTIME_PROTOCOL) return false;
    for (const key of ['upstreamVersion', 'upstreamCommit', 'extRelease', 'patchSetSha256', 'packageSetSha256', 'compositionVersion'] as const) {
        const field = identity[key];
        if (typeof field !== 'string' || field.length > 200) return false;
    }
    const capabilities = identity.capabilities;
    if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) return false;
    for (const [key, cap] of Object.entries(capabilities)) {
        if (!/^[a-z][A-Za-z0-9-]{0,63}$/.test(key) || typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0 || cap > 1_000) return false;
    }
    identities.add(value as object);
    return true;
}
