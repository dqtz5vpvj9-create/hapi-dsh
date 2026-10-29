import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DSH_VERSION, HAPI_REVISION, resolveHapiToken, type RuntimeConfig } from './config.ts';
import { findPackageRoot, resolveDshCommand, runCommand, runtimeEnvironment, verifyBundleArtifacts, verifyDshVersion, type Command, type CommandRunner } from './runtime.ts';
import { ops, redactBundleText } from './release.ts';

export interface DoctorCheck {
    name: string;
    status: 'pass' | 'fail' | 'warn' | 'skipped';
    detail: string;
}

export interface DoctorResult {
    ok: boolean;
    checks: DoctorCheck[];
    expectedUpstream: { dsh: string; hapiRevision: string };
}

export interface DoctorOptions {
    offline?: boolean;
    env?: NodeJS.ProcessEnv;
    command?: Command;
    run?: CommandRunner;
    fetch?: typeof globalThis.fetch;
    packageRoot?: string;
}

/** Validate only the schema needed for connectivity, without logging response bodies or credentials. */
async function requestJson(fetcher: typeof globalThis.fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
        response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch {
        throw new Error('HAPI request failed or timed out; check the configured URL, TLS, and Hub process');
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HAPI returned HTTP ${response.status}; check the Hub access token and namespace`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('HAPI returned an empty response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 8 * 1024 * 1024) {
                await reader.cancel();
                throw new Error('HAPI diagnostic response exceeds 8 MiB');
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('HAPI returned invalid JSON'); }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('HAPI returned an unexpected response schema');
    return value as Record<string, unknown>;
}

/** Authenticate against the pinned HAPI contract, then read both catalogs using its issued Web JWT. */
export async function checkHapi(config: RuntimeConfig, options: Pick<DoctorOptions, 'env' | 'fetch'> = {}): Promise<DoctorCheck[]> {
    if (!config.hapi) return [{ name: 'hapi', status: 'skipped', detail: 'No legacy HAPI source is configured; native DSH federation and direct sources require no HAPI token' }];
    const accessToken = resolveHapiToken(config, options.env);
    const fetcher = options.fetch ?? globalThis.fetch;
    const base = `${config.hapi.url}/`;
    const auth = await requestJson(fetcher, new URL('api/auth', base).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ accessToken }),
    });
    if (typeof auth.token !== 'string' || auth.token.length === 0 || /[\r\n]/.test(auth.token)) {
        throw new Error('HAPI authentication did not return a Web access token');
    }
    const checks: DoctorCheck[] = [{ name: 'hapi-auth', status: 'pass', detail: 'HAPI accepted the access token and issued a Web credential' }];
    const catalogs = await Promise.allSettled(['sessions', 'machines'].map(async (catalog): Promise<DoctorCheck> => {
        const result = await requestJson(fetcher, new URL(`api/${catalog}`, base).href, {
            headers: { authorization: `Bearer ${auth.token}`, accept: 'application/json' },
        });
        if (!Array.isArray(result[catalog])) throw new Error(`HAPI ${catalog} response has an unexpected schema`);
        const count = result[catalog].length;
        return { name: `hapi-${catalog}`, status: catalog === 'machines' && count === 0 ? 'warn' : 'pass',
            detail: catalog === 'machines' && count === 0
                ? 'Hub is reachable but no Runner is online in this namespace'
                : `${count} ${catalog} visible in this namespace` };
    }));
    for (let index = 0; index < catalogs.length; index++) {
        const result = catalogs[index]!;
        checks.push(result.status === 'fulfilled' ? result.value : {
            name: index === 0 ? 'hapi-sessions' : 'hapi-machines', status: 'fail', detail: safeError(result.reason),
        });
    }
    return checks;
}

function safeError(error: unknown): string {
    return error instanceof Error ? error.message : 'Diagnostic check failed';
}

/** True when the pinned pnpm release is on PATH; a mismatch is a warning, not an install failure. */
async function checkPnpm(config: RuntimeConfig, options: DoctorOptions): Promise<DoctorCheck> {
    const run = options.run ?? runCommand;
    try {
        const result = await run({ executable: 'pnpm', args: ['--version'] }, { env: options.env ?? process.env, timeoutMs: 15_000 });
        const reported = result.stdout.trim();
        if (result.exitCode !== 0 || reported === '') {
            return { name: 'pnpm', status: 'warn', detail: 'pnpm is not available on PATH; the official plugin manager and rollback reinstall require pnpm 11' };
        }
        if (reported === '11.28.5') return { name: 'pnpm', status: 'pass', detail: 'pnpm 11.28.5 (pinned prerequisite)' };
        const major = Number(reported.split('.')[0]);
        return {
            name: 'pnpm',
            status: major >= 11 ? 'warn' : 'fail',
            detail: `pnpm ${reported}; this package is pinned to pnpm 11.28.5`,
        };
    } catch {
        return { name: 'pnpm', status: 'warn', detail: 'pnpm could not be executed; the official plugin manager and rollback reinstall require pnpm 11' };
    }
}

/**
 * Bundle release checks. Everything here is read-only and reports status,
 * versions and redacted errors only: no credentials, no absolute paths.
 * A source (`link:`) installation has no release state, so these are skipped
 * instead of failing a working install.
 */
async function bundleChecks(config: RuntimeConfig, options: DoctorOptions): Promise<DoctorCheck[]> {
    const home = config.dsh.home;
    const redact = (text: string): string => redactBundleText(text, home);
    const checks: DoctorCheck[] = [await checkPnpm(config, options)];
    let inspection;
    try {
        inspection = await ops.inspectReleaseState({ dshHome: home, profile: config.dsh.profile });
    } catch (error) {
        checks.push({ name: 'bundle-state', status: 'fail', detail: redact(`Bundle release state cannot be read: ${safeError(error)}`) });
        return checks;
    }
    if (!inspection.installed) {
        checks.push({
            name: 'bundle-release',
            status: inspection.statePresent ? 'warn' : 'skipped',
            detail: inspection.statePresent
                ? `No bundle release is recorded for profile ${config.dsh.profile}; the profile may have been installed from source`
                : 'No hapi-dsh bundle release is installed; bundle integrity, ext and identity checks were not run',
        });
        return checks;
    }
    const active = inspection.active!;
    checks.push({
        name: 'manifest-hash',
        status: inspection.manifestHash?.ok ? 'pass' : 'fail',
        detail: inspection.active?.verificationError
            ? redact(`Active release cannot be verified: ${inspection.active.verificationError}`)
            : inspection.manifestHash?.ok
                ? `Release r-${active.releaseId.slice(0, 16)} matches its manifest hash and recorded tree digest`
                : 'Active release manifest hash or release id does not match the recorded release state',
    });
    const unmanaged = config.dsh.command !== undefined;
    checks.push({
        name: 'managed-launcher',
        status: unmanaged ? (process.env.HAPI_DSH_ALLOW_UNMANAGED === '1' ? 'warn' : 'fail') : 'pass',
        detail: unmanaged
            ? (process.env.HAPI_DSH_ALLOW_UNMANAGED === '1'
                ? 'An explicit dsh.command opt-out is active; this install is unmanaged and its runtime is not verified'
                : 'config.dsh.command bypasses the managed runtime; remove it or set HAPI_DSH_ALLOW_UNMANAGED=1')
            : 'No explicit launcher bypasses the verified runtime',
    });
    const previousProblems = inspection.previous.filter((entry) => entry.error !== undefined);
    checks.push({
        name: 'release-integrity',
        status: previousProblems.length > 0 ? 'fail' : inspection.previous.length >= 2 ? 'pass' : 'warn',
        detail: previousProblems.length > 0
            ? redact(`Previous release(s) unusable: ${previousProblems.map((entry) => `r-${entry.releaseId.slice(0, 16)}: ${entry.error}`).join('; ')}`)
            : `${inspection.previous.length} previous release(s) retained and verified; the distribution requirement is at least 2`,
    });
    const capabilities = inspection.extCapabilities;
    if (!capabilities) {
        checks.push({ name: 'ext-capabilities', status: 'fail', detail: 'The active release does not declare its extension capability set' });
    } else {
        const declaredKeys = Object.keys(capabilities.declared).sort();
        const expectedKeys = Object.keys(capabilities.expected).sort();
        const mismatch = declaredKeys.length !== expectedKeys.length
            || expectedKeys.some((name, index) => declaredKeys[index] !== name || capabilities.declared[name] !== 1);
        const packageProblems: string[] = [];
        const advertisedNames = new Set<string>();
        for (const item of capabilities.packages) {
            if (item.declared === null) continue;
            for (const [name, value] of Object.entries(item.declared)) {
                if (!(name in capabilities.expected)) packageProblems.push(`${item.name} declares unknown capability ${name}`);
                else if (!Number.isInteger(value) || value < 1) packageProblems.push(`${item.name} declares ${name}:${String(value)}`);
                else advertisedNames.add(name);
            }
        }
        const advertised = capabilities.packages.filter((item) => item.declared !== null).length;
        if (advertised > 0 && [...expectedKeys].some((name) => !advertisedNames.has(name))) {
            packageProblems.push(`the packaged ext modules do not collectively declare: ${expectedKeys.filter((name) => !advertisedNames.has(name)).join(', ')}`);
        }
        if (mismatch || packageProblems.length > 0) {
            checks.push({
                name: 'ext-capabilities',
                status: 'fail',
                detail: redact(packageProblems.length > 0
                    ? `The packaged ext modules do not expose the release capability set: ${packageProblems.join('; ')}`
                    : 'The active release does not expose exactly historySource:1, mountedChat:1 and windowCommit:1'),
            });
        } else if (inspection.active?.manifest?.fixture === true) {
            checks.push({ name: 'ext-capabilities', status: 'warn', detail: 'Capability set is complete in the manifest, but this bundle carries fixture placeholder payloads (not a real ext release)' });
        } else if (advertised === 0) {
            checks.push({ name: 'ext-capabilities', status: 'warn', detail: 'Capability set comes from the release manifest; no packaged ext module advertises its own capabilities' });
        } else {
            checks.push({ name: 'ext-capabilities', status: 'pass', detail: 'historySource:1, mountedChat:1 and windowCommit:1 are declared by the release and its ext packages' });
        }
    }
    const resolutionProblems = [...(inspection.extResolution ?? []).flatMap((item) => item.problems), ...(inspection.link?.problems ?? [])];
    checks.push({
        name: 'ext-resolution',
        status: resolutionProblems.length === 0 ? 'pass' : 'fail',
        detail: resolutionProblems.length === 0
            ? `${(inspection.extResolution ?? []).length} extended package(s) resolve from the active release, not from the registry original`
            : redact(resolutionProblems.join('; ')),
    });
    if (!inspection.singletons || inspection.singletons.available === false) {
        checks.push({ name: 'dsh-singletons', status: 'warn', detail: 'The profile has no pnpm virtual store yet; duplicate DSH copies cannot be checked' });
    } else {
        checks.push({
            name: 'dsh-singletons',
            status: inspection.singletons.duplicates.length === 0 ? 'pass' : 'fail',
            detail: inspection.singletons.duplicates.length === 0
                ? 'Every DSH singleton package resolves to exactly one physical copy'
                : redact(inspection.singletons.duplicates.map((duplicate) => `${duplicate.name}: ${duplicate.copies.length} copies`).join('; ')),
        });
    }
    if (inspection.runtimeResolution) {
        const resolution = inspection.runtimeResolution;
        const uncovered = resolution.unresolved ?? [];
        checks.push({
            name: 'runtime-resolution',
            status: resolution.ok ? (uncovered.length === 0 ? 'pass' : 'warn') : 'fail',
            detail: resolution.ok
                ? (uncovered.length === 0
                    ? 'Shared runtime singletons resolve to one version from every runtime entry'
                    : redact(`One version per resolved package, but these packages are not reachable from the audited entries: ${uncovered.join(', ')}`))
                : redact(resolution.problems.join('; ')),
        });
    } else {
        checks.push({ name: 'runtime-resolution', status: 'warn', detail: 'No pinned runtime is recorded for this release; cross-consumer singleton resolution was not audited' });
    }
    checks.push({
        name: 'profile-overrides',
        status: inspection.overridesMatch ? 'pass' : 'fail',
        detail: inspection.overridesMatch
            ? 'The profile pnpm overrides are exactly the ones recorded for the active release'
            : 'The profile pnpm overrides drifted from the active release; extend/remove them before upgrading',
    });
    const expectedIdentity = active.identity;
    const runtime = inspection.runtime;
    if (!expectedIdentity) {
        checks.push({ name: 'release-identity', status: 'fail', detail: 'The active release does not expose a release identity' });
    } else if (!runtime || 'error' in runtime) {
        checks.push({ name: 'release-identity', status: 'warn', detail: runtime && 'error' in runtime ? redact(`runtime.json cannot be read: ${runtime.error}`) : 'No Host/Runner runtime snapshot is present; start the Host/Runner with this release to verify the live identity' });
    } else if (!runtime.identity) {
        checks.push({ name: 'release-identity', status: 'warn', detail: 'The runtime snapshot does not carry a release identity yet' });
    } else {
        const problems = new Set<string>();
        for (const key of ['upstreamVersion', 'upstreamCommit', 'extRelease', 'patchSetSha256', 'packageSetSha256', 'compositionVersion', 'protocol'] as const) {
            if (runtime.identity[key] !== expectedIdentity[key]) problems.add(key);
        }
        for (const name of Object.keys(expectedIdentity.capabilities)) {
            if (runtime.identity.capabilities?.[name] !== expectedIdentity.capabilities[name]) problems.add(`capabilities.${name}`);
        }
        checks.push({
            name: 'release-identity',
            status: problems.size === 0 ? 'pass' : 'fail',
            detail: problems.size === 0
                ? `The live ${runtime.role} identity matches the active release`
                : redact(`The live ${runtime.role} identity differs from the active release in: ${[...problems].join(', ')}`),
        });
    }
    const hostRole = Object.values(inspection.roles).find((entry) => entry.role === 'host' && entry.identity);
    const runnerRole = Object.values(inspection.roles).find((entry) => entry.role === 'runner' && entry.identity);
    if (!hostRole || !runnerRole) {
        checks.push({ name: 'host-runner-identity', status: 'warn', detail: hostRole ? 'The Runner release identity is not recorded in this DSH home; compare it on the Runner machine' : 'No Host and Runner release identities are both recorded in this DSH home' });
    } else {
        const problems = new Set<string>();
        for (const key of ['upstreamVersion', 'upstreamCommit', 'extRelease', 'patchSetSha256', 'packageSetSha256', 'compositionVersion', 'protocol'] as const) {
            if (hostRole.identity![key] !== runnerRole.identity![key]) problems.add(key);
        }
        checks.push({
            name: 'host-runner-identity',
            status: problems.size === 0 ? 'pass' : 'fail',
            detail: problems.size === 0
                ? `Host and Runner use the same release identity (${hostRole.identity!.extRelease})`
                : redact(`Host and Runner identities differ in: ${[...problems].join(', ')}`),
        });
    }
    checks.push({
        name: 'data-format',
        status: inspection.active?.manifest?.release.protocol === 2 ? 'pass' : 'fail',
        detail: inspection.active?.manifest
            ? `Bundle protocol ${inspection.active.manifest.release.protocol}, composition ${inspection.active.manifest.release.compositionVersion}; data migration is disabled for this release`
            : 'The active release does not declare its protocol version',
    });
    checks.push({
        name: 'licenses',
        status: inspection.licenses.length > 0 && inspection.sourceOffer.length > 0 ? 'pass' : 'fail',
        detail: inspection.licenses.length > 0 && inspection.sourceOffer.length > 0
            ? `${inspection.licenses.length} license file(s) and ${inspection.sourceOffer.length} source-offer file(s) are present`
            : 'The active release is missing its license or source-offer material',
    });
    return checks;
}

/** These checks distinguish configuration, installed artifacts, and observed remote connectivity. */
export async function doctor(config: RuntimeConfig, configFile: string, options: DoctorOptions = {}): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [];
    const major = Number(process.versions.node.split('.')[0]);
    checks.push({ name: 'node', status: major >= 24 ? 'pass' : 'fail', detail: `Node ${process.versions.node}; this package requires Node 24 or later` });
    const env = runtimeEnvironment(config, configFile, options.env);
    const run = options.run ?? runCommand;
    let command: Command | undefined;
    try {
        command = options.command ?? await resolveDshCommand(config);
        await verifyDshVersion(command, env, run);
        checks.push({ name: 'dsh-version', status: 'pass', detail: `Official launcher reports ${DSH_VERSION}` });
    } catch (error) { command = undefined; checks.push({ name: 'dsh-version', status: 'fail', detail: safeError(error) }); }
    try {
        await verifyBundleArtifacts(options.packageRoot ?? await findPackageRoot());
        checks.push({ name: 'bundle-artifacts', status: 'pass', detail: 'Host entry, browser entry, and bundle patch are present' });
    } catch (error) { checks.push({ name: 'bundle-artifacts', status: 'fail', detail: safeError(error) }); }
    try {
        const manifest: { dsh?: { profile?: { bundles?: unknown } } } = JSON.parse(await readFile(join(config.dsh.home, 'profiles', config.dsh.profile, 'package.json'), 'utf8'));
        const bundles = manifest.dsh?.profile?.bundles;
        if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-web-app') || !bundles.includes('hapi-dsh')) {
            throw new Error('Profile must include the official Web bundle and hapi-dsh; run hapi-dsh install');
        }
        if (!command) throw new Error('Cannot inspect the composed profile until the DSH launcher is available');
        const result = await run({ ...command, args: [...command.args, '--profile', config.dsh.profile, '--dump-config'] }, { env, timeoutMs: 120_000 });
        if (result.exitCode !== 0 || !/^\s*-?\s*id:\s*["']?hapi-dsh["']?\s*$/m.test(result.stdout)) {
            throw new Error('Official profile composition did not include the hapi-dsh plugin row');
        }
        checks.push({ name: 'profile', status: 'pass', detail: `Custom profile ${config.dsh.profile} composes the hapi-dsh bundle` });
    } catch (error) {
        const detail = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'Custom DSH profile is missing; run hapi-dsh install' : safeError(error);
        checks.push({ name: 'profile', status: 'fail', detail });
    }
    checks.push(...await bundleChecks(config, options));
    if (options.offline) {
        checks.push({ name: 'hapi', status: 'skipped', detail: 'Hub authentication and Runner connectivity were not checked (--offline)' });
    } else {
        try { checks.push(...await checkHapi(config, options)); }
        catch (error) { checks.push({ name: 'hapi', status: 'fail', detail: safeError(error) }); }
    }
    return {
        ok: checks.every((check) => check.status !== 'fail'), checks,
        // The public HAPI API does not report a source commit. This is a requirement, not a detected version.
        expectedUpstream: { dsh: DSH_VERSION, hapiRevision: HAPI_REVISION },
    };
}
