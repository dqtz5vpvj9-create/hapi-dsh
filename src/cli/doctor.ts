import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DSH_VERSION, HAPI_REVISION, resolveHapiToken, type RuntimeConfig } from './config.ts';
import { findPackageRoot, resolveDshCommand, runCommand, runtimeEnvironment, verifyBundleArtifacts, verifyDshVersion, type Command, type CommandRunner } from './runtime.ts';

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
