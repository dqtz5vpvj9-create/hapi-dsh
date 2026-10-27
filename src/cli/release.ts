/**
 * Typed accessor for the bundle library under `scripts/bundle/lib`.
 *
 * The installer itself has to run before hapi-dsh exists, so the single
 * implementation lives in plain ESM with Node-builtin imports only. This module
 * gives the CLI, doctor and the test suite the same implementation with types,
 * instead of a second copy that could drift.
 */
import * as ops from '../../scripts/bundle/lib/ops.mjs';
import * as release from '../../scripts/bundle/lib/release.mjs';
import * as manifest from '../../scripts/bundle/lib/manifest.mjs';
import * as tar from '../../scripts/bundle/lib/tar.mjs';
import * as digest from '../../scripts/bundle/lib/digest.mjs';

export { ops, release, manifest, tar, digest };

export type { BundleManifest, ExtPayloadEntry, RuntimeIdentity } from '../../scripts/bundle/lib/manifest.mjs';
export type {
    BundleState, BundleVerification, ExtResolution, PreparedRelease, ProfileReleaseState, ReleaseAttempt, ReleaseRef,
    RuntimeSnapshot, SingletonScan, StagedOverrides,
} from '../../scripts/bundle/lib/release.mjs';
export type {
    BundleCommand, CommandResult, CommandRunner, InstallOptions, InstallResult, ReleaseInspection, ReinstallOptions,
    RollbackResult, StatusResult, VerifyStoreResult,
} from '../../scripts/bundle/lib/ops.mjs';
export type { TarReadEntry, TarWriteEntry } from '../../scripts/bundle/lib/tar.mjs';

/**
 * Doctor output is status, version and redacted error only: no credentials and
 * no absolute user paths. `home` is replaced with the literal `<dsh-home>`.
 */
export function redactBundleText(text: string, home: string): string {
    let result = text;
    if (home) result = result.split(home).join('<dsh-home>');
    result = result.replace(/(?:token|secret|password)=[^\s&"'`]+/gi, (match) => `${match.slice(0, match.indexOf('='))}=<redacted>`);
    result = result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
    return result;
}
