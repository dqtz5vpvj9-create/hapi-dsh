/**
 * Bundle manifest schema, layout and identity helpers.
 *
 * This is the contract shared by `pack.mjs` (producer), `install.mjs`
 * (consumer) and `hapi-dsh doctor` (auditor). Only Node builtins are used so
 * the installer can validate a bundle before any package is installed.
 */
import { canonicalJson, digestOfEntries, sha256Bytes } from './digest.mjs';

export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_NAME = 'hapi-dsh-bundle';
export const BUNDLE_PROTOCOL = 2;
/** Capability names fixed by the distribution spec (section 4/5). */
export const EXT_CAPABILITIES = Object.freeze(['historySource', 'mountedChat', 'windowCommit']);
export const PINNED_UPSTREAM_VERSION = '0.2.1-rc.3';
export const PINNED_UPSTREAM_COMMIT = '1f81c047fc48fa190a683e469daa699857e9afe8';
export const MINIMUM_PNPM = '11.28.5';

export const BUNDLE_LAYOUT = Object.freeze({
    install: 'dist/install.mjs',
    lib: 'dist/lib',
    manifest: 'manifest.json',
    sums: 'SHA256SUMS',
    hapiPayload: 'payload/hapi-dsh.tgz',
    extPayload: 'payload/dsh-ext',
    licenses: 'LICENSES',
    sourceOffer: 'SOURCE-OFFER',
});

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(errors) {
    if (errors.length === 1) throw new Error(errors[0]);
    throw new Error(`invalid bundle manifest:\n- ${errors.join('\n- ')}`);
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(errors, value, name, pattern) {
    if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`${name} must be a nonempty string`);
        return;
    }
    if (pattern && !pattern.test(value)) errors.push(`${name} has an unexpected format: ${value}`);
}

/** Validate and return a normalised bundle manifest (throws on any schema error). */
export function validateBundleManifest(input) {
    const errors = [];
    if (!isRecord(input)) fail(['manifest must be a JSON object']);
    const manifest = input;
    if (manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${BUNDLE_SCHEMA_VERSION}`);
    if (manifest.name !== BUNDLE_NAME) errors.push(`name must be ${BUNDLE_NAME}`);
    checkString(errors, manifest.version, 'version', SEMVER);
    checkString(errors, manifest.createdAt, 'createdAt');

    const release = manifest.release;
    if (!isRecord(release)) errors.push('release must be an object');
    else {
        checkString(errors, release.upstreamVersion, 'release.upstreamVersion', SEMVER);
        if (release.upstreamVersion !== PINNED_UPSTREAM_VERSION) errors.push(`release.upstreamVersion must be the pinned ${PINNED_UPSTREAM_VERSION}`);
        checkString(errors, release.upstreamCommit, 'release.upstreamCommit', /^[a-f0-9]{40}$/);
        if (release.upstreamCommit !== PINNED_UPSTREAM_COMMIT) errors.push(`release.upstreamCommit must be the pinned ${PINNED_UPSTREAM_COMMIT}`);
        checkString(errors, release.extRelease, 'release.extRelease');
        checkString(errors, release.patchSetSha256, 'release.patchSetSha256', SHA256);
        checkString(errors, release.packageSetSha256, 'release.packageSetSha256', SHA256);
        checkString(errors, release.compositionVersion, 'release.compositionVersion');
        if (release.protocol !== BUNDLE_PROTOCOL) errors.push(`release.protocol must be ${BUNDLE_PROTOCOL}`);
        const capabilities = release.capabilities;
        if (!isRecord(capabilities)) errors.push('release.capabilities must be an object');
        else {
            const provided = Object.keys(capabilities).sort();
            const expected = [...EXT_CAPABILITIES].sort();
            if (canonicalJson(provided) !== canonicalJson(expected)) {
                errors.push(`release.capabilities must contain exactly ${EXT_CAPABILITIES.join(', ')}`);
            }
            for (const name of EXT_CAPABILITIES) {
                const value = capabilities[name];
                if (!Number.isInteger(value) || value < 1) errors.push(`release.capabilities.${name} must be an integer >= 1`);
            }
        }
    }

    const payload = manifest.payload;
    if (!isRecord(payload)) errors.push('payload must be an object');
    else {
        const hapi = payload.hapi;
        if (!isRecord(hapi)) errors.push('payload.hapi must be an object');
        else {
            checkString(errors, hapi.tarball, 'payload.hapi.tarball');
            checkString(errors, hapi.sha256, 'payload.hapi.sha256', SHA256);
            checkString(errors, hapi.version, 'payload.hapi.version', SEMVER);
            if (!Number.isInteger(hapi.size) || hapi.size <= 0) errors.push('payload.hapi.size must be a positive integer');
        }
        const ext = payload.dshExt;
        if (!Array.isArray(ext) || ext.length === 0) errors.push('payload.dshExt must be a nonempty array');
        else {
            const names = new Set();
            for (const [index, item] of ext.entries()) {
                const prefix = `payload.dshExt[${index}]`;
                if (!isRecord(item)) {
                    errors.push(`${prefix} must be an object`);
                    continue;
                }
                checkString(errors, item.name, `${prefix}.name`, /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
                checkString(errors, item.version, `${prefix}.version`, SEMVER);
                checkString(errors, item.tarball, `${prefix}.tarball`);
                checkString(errors, item.sha256, `${prefix}.sha256`, SHA256);
                if (!Number.isInteger(item.size) || item.size <= 0) errors.push(`${prefix}.size must be a positive integer`);
                if (typeof item.tarball === 'string' && !item.tarball.startsWith(`${BUNDLE_LAYOUT.extPayload}/`)) {
                    errors.push(`${prefix}.tarball must live under ${BUNDLE_LAYOUT.extPayload}/`);
                }
                if (typeof item.name === 'string') {
                    if (names.has(item.name)) errors.push(`payload.dshExt declares ${item.name} twice`);
                    names.add(item.name);
                }
            }
        }
    }

    const minimums = manifest.minimums;
    if (!isRecord(minimums)) errors.push('minimums must be an object');
    else {
        checkString(errors, minimums.node, 'minimums.node');
        checkString(errors, minimums.pnpm, 'minimums.pnpm');
    }
    if (!Array.isArray(manifest.licenses) || manifest.licenses.length === 0) errors.push('licenses must be a nonempty array');
    else for (const [index, item] of manifest.licenses.entries()) checkString(errors, item, `licenses[${index}]`);
    if (!Array.isArray(manifest.sourceOffer) || manifest.sourceOffer.length === 0) errors.push('sourceOffer must be a nonempty array');
    else for (const [index, item] of manifest.sourceOffer.entries()) checkString(errors, item, `sourceOffer[${index}]`);
    checkString(errors, manifest.releaseId, 'releaseId', SHA256);
    if (errors.length > 0) fail(errors);
    if (releaseIdentity(manifest).packageSetSha256 !== packageSetSha256(manifest.payload.dshExt)) {
        fail(['release.packageSetSha256 does not match the dsh-ext payload hashes declared by this manifest']);
    }
    if (computeReleaseId(manifest) !== manifest.releaseId) fail(['releaseId does not match the manifest identity and payload hashes']);
    return manifest;
}

export function payloadEntries(manifest) {
    const entries = [
        { path: manifest.payload.hapi.tarball, sha256: manifest.payload.hapi.sha256, size: manifest.payload.hapi.size },
        ...manifest.payload.dshExt.map((item) => ({ path: item.tarball, sha256: item.sha256, size: item.size })),
    ];
    return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function packageSetSha256(extPackages) {
    const entries = [...extPackages]
        .map((item) => ({ name: item.name, version: item.version, sha256: item.sha256 }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return sha256Bytes(canonicalJson(entries));
}

/** RuntimeIdentityV1 as fixed by the distribution spec. */
export function releaseIdentity(manifest) {
    return {
        upstreamVersion: manifest.release.upstreamVersion,
        upstreamCommit: manifest.release.upstreamCommit,
        extRelease: manifest.release.extRelease,
        patchSetSha256: manifest.release.patchSetSha256,
        packageSetSha256: manifest.release.packageSetSha256,
        capabilities: { ...manifest.release.capabilities },
        compositionVersion: manifest.release.compositionVersion,
        protocol: manifest.release.protocol,
    };
}

/** Content address of one release: identity plus every payload digest. */
export function computeReleaseId(manifest) {
    return sha256Bytes(canonicalJson({ identity: releaseIdentity(manifest), payload: payloadEntries(manifest) }));
}

export function releaseDirName(releaseId) {
    if (!SHA256.test(releaseId)) throw new Error('releaseId must be a sha256 hex digest');
    return `r-${releaseId.slice(0, 16)}`;
}

/** Identity comparison used by the Host/Runner strict-match gate and by doctor. */
export function identityMismatches(expected, observed) {
    const problems = [];
    if (!isRecord(observed)) return ['observed identity is missing'];
    for (const key of ['upstreamVersion', 'upstreamCommit', 'extRelease', 'patchSetSha256', 'packageSetSha256', 'compositionVersion', 'protocol']) {
        if (observed[key] !== expected[key]) problems.push(`${key}: expected ${String(expected[key])}, observed ${String(observed[key])}`);
    }
    const expectedCapabilities = expected.capabilities;
    const observedCapabilities = observed.capabilities;
    if (!isRecord(observedCapabilities)) problems.push('capabilities: missing');
    else {
        for (const name of Object.keys(expectedCapabilities)) {
            if (observedCapabilities[name] !== expectedCapabilities[name]) problems.push(`capabilities.${name}: expected ${String(expectedCapabilities[name])}, observed ${String(observedCapabilities[name])}`);
        }
    }
    return problems;
}

export function parseSums(text) {
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        if (!match) throw new Error('SHA256SUMS contains a malformed line');
        const path = match[2];
        if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new Error(`SHA256SUMS contains an unsafe path: ${path}`);
        entries.push({ sha256: match[1], path });
    }
    if (entries.length === 0) throw new Error('SHA256SUMS is empty');
    return entries;
}

export function formatSums(entries) {
    return [...entries]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map((entry) => `${entry.sha256}  ${entry.path}\n`)
        .join('');
}

/** Files whose digests belong in SHA256SUMS (everything except the sums file itself). */
export function summedFiles(files) {
    return [...files].map((file) => (typeof file === 'string' ? file : file.path)).filter((path) => path !== BUNDLE_LAYOUT.sums).sort();
}

/**
 * Validate the on-disk file list of a produced bundle. `files` are paths
 * relative to the bundle's `package/` root.
 */
export function bundleLayoutErrors(files) {
    const set = new Set(files);
    const errors = [];
    for (const required of [BUNDLE_LAYOUT.install, BUNDLE_LAYOUT.manifest, BUNDLE_LAYOUT.sums, BUNDLE_LAYOUT.hapiPayload]) {
        if (!set.has(required)) errors.push(`bundle is missing ${required}`);
    }
    if (!files.some((path) => path.startsWith(`${BUNDLE_LAYOUT.extPayload}/`) && path.endsWith('.tgz'))) {
        errors.push(`bundle is missing its ${BUNDLE_LAYOUT.extPayload}/*.tgz payload`);
    }
    if (!files.some((path) => path.startsWith(`${BUNDLE_LAYOUT.licenses}/`) && path !== `${BUNDLE_LAYOUT.licenses}/`)) {
        errors.push(`bundle is missing ${BUNDLE_LAYOUT.licenses}/`);
    }
    if (!files.some((path) => path.startsWith(`${BUNDLE_LAYOUT.sourceOffer}/`) && path !== `${BUNDLE_LAYOUT.sourceOffer}/`)) {
        errors.push(`bundle is missing ${BUNDLE_LAYOUT.sourceOffer}/`);
    }
    if (!files.some((path) => path.startsWith(`${BUNDLE_LAYOUT.lib}/`) && path.endsWith('.mjs'))) {
        errors.push(`bundle is missing ${BUNDLE_LAYOUT.lib}/*.mjs installer helpers`);
    }
    return errors;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The installer must run on a clean machine: only Node builtins and local modules. */
export function installerImportErrors(source, name = BUNDLE_LAYOUT.install) {
    const errors = [];
    for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined) continue;
        if (specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')) continue;
        errors.push(`${name} imports a non-builtin module: ${specifier}`);
    }
    return errors;
}
