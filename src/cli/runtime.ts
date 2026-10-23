import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSH_VERSION, type RuntimeConfig, resolveHapiToken } from './config.ts';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { parseDocument } from 'yaml';
import { OFFICIAL_PROVIDERS, OFFICIAL_PROVIDER_PACKAGES, ROUTING_PROVIDERS, type OfficialProviderId } from '../shared/official-provider.ts';

export interface Command {
    executable: string;
    args: string[];
}

export interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** The official patch name is a guard, so verify the composed provider rows, not only the bundle marker. */
export function assertProfileProviders(dump: string): void {
    const document = parseDocument(dump, { logLevel: 'silent' });
    if (document.errors.length) throw new Error('The official DSH configuration dump is invalid');
    const rows: Array<{ id: unknown; name: unknown; disabled: boolean; isolate: unknown }> = [];
    const visit = (input: unknown, inheritedDisabled = false): void => {
        if (!Array.isArray(input)) return;
        for (const value of input) {
            if (!value || typeof value !== 'object') continue;
            const row = value as Record<string, unknown>;
            const disabled = inheritedDisabled || row.disabled === true;
            rows.push({ id: row.id, name: row.name, disabled, isolate: row.isolate });
            if (row.group) visit(row.config, disabled);
        }
    };
    visit(document.toJS());
    for (const name of Object.keys(OFFICIAL_PROVIDERS) as OfficialProviderId[]) {
        const service = OFFICIAL_PROVIDERS[name], routing = ROUTING_PROVIDERS[name];
        const original = rows.filter(row => row.id === name);
        const replacement = rows.filter(row => row.id === `hapi-dsh-${routing}`);
        const isolation = original[0]?.isolate;
        if (original.length !== 1 || original[0]!.name !== OFFICIAL_PROVIDER_PACKAGES[name] || original[0]!.disabled !== false
            || !isolation || typeof isolation !== 'object' || (isolation as Record<string, unknown>)[service] !== true
            || replacement.length !== 1 || replacement[0]!.name !== `hapi-dsh/${routing}` || replacement[0]!.disabled !== false) {
            throw new Error(`The official DSH profile did not activate the hapi-dsh ${name} provider; keep the original package root active in its private service isolation and insert the routing provider`);
        }
    }
}

export type CommandRunner = (command: Command, options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;

/** Capture bounded diagnostic output without invoking a shell. */
export const runCommand: CommandRunner = async (command, options) => new Promise((resolveResult, reject) => {
    const child = spawn(command.executable, command.args, {
        env: options.env,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
    });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (error: Error): void => {
        if (failure) return;
        failure = error;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
        killTimer.unref();
    };
    const timer = setTimeout(() => terminate(new Error('DSH command timed out')), options.timeoutMs ?? 30_000);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        if (failure) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) terminate(new Error('DSH diagnostic output exceeded 1 MiB'));
    });
    child.stderr.on('data', (chunk: string) => {
        if (failure) return;
        stderr += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) terminate(new Error('DSH diagnostic output exceeded 1 MiB'));
    });
    child.on('error', (error) => { failure = error; });
    child.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (failure) reject(failure);
        else resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
});

/** Prefer the exact DSH dependency shipped with this package over an unrelated global installation. */
export async function resolveDshCommand(config: Pick<RuntimeConfig, 'dsh'>, anchor: string = import.meta.url): Promise<Command> {
    if (config.dsh.command) return { executable: config.dsh.command, args: [...(config.dsh.args ?? [])] };
    const require = createRequire(anchor);
    let manifestPath: string;
    try {
        manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
    } catch {
        throw new Error(`The pinned @deepseek-ai/dsh@${DSH_VERSION} dependency is missing; install this package's dependencies`);
    }
    const manifest: { version?: unknown; bin?: { dsh?: unknown } } = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version !== DSH_VERSION || typeof manifest.bin?.dsh !== 'string') {
        throw new Error(`This package requires the official DSH ${DSH_VERSION} distribution`);
    }
    const binary = resolve(dirname(manifestPath), manifest.bin.dsh);
    await access(binary);
    return { executable: process.execPath, args: [binary] };
}

export function runtimeEnvironment(config: Pick<RuntimeConfig, 'dsh'>, configFile: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...env, DSH_HOME: config.dsh.home, HAPI_DSH_CONFIG_FILE: resolve(configFile) };
}

export async function verifyDshVersion(command: Command, env: NodeJS.ProcessEnv, run: CommandRunner = runCommand): Promise<void> {
    const result = await run({ ...command, args: [...command.args, '--version'] }, { env });
    if (result.exitCode !== 0 || result.stdout.trim() !== DSH_VERSION) {
        throw new Error(`DSH ${DSH_VERSION} is required; the configured executable did not report that exact version`);
    }
}

export async function findPackageRoot(anchor: string = import.meta.url): Promise<string> {
    let directory = dirname(fileURLToPath(anchor));
    for (;;) {
        try {
            const manifest: { name?: unknown } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
            if (manifest.name === 'hapi-dsh') return directory;
        } catch (error) {
            if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error('Cannot locate the installed hapi-dsh package');
        directory = parent;
    }
}

export const CLIENT_CHUNKS = ['client.voice.js', 'client.capture.js', 'client.native-panels.js', 'client.session-panels.js', 'client.administration.js'] as const;

export async function verifyBundleArtifacts(packageRoot: string, expectedName: 'hapi-dsh' | 'hapi-dsh-runner' = 'hapi-dsh'): Promise<void> {
    const manifest: {
        name?: unknown;
        main?: unknown;
        exports?: { './client'?: string | { default?: string } };
        dsh?: { bundle?: { patch?: string | string[] } };
    } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== expectedName || typeof manifest.main !== 'string') throw new Error(`Not a built ${expectedName} package`);
    const client = manifest.exports?.['./client'];
    const clientPath = typeof client === 'string' ? client : client?.default;
    const patch = manifest.dsh?.bundle?.patch;
    if (expectedName === 'hapi-dsh' && !clientPath || !patch) throw new Error('The package is missing its DSH Client or bundle declaration');
    if (expectedName === 'hapi-dsh-runner' && clientPath) throw new Error('The Runner bundle must be Host-only');
    const files = [manifest.main, ...(clientPath ? [clientPath, ...CLIENT_CHUNKS.map(name => join(dirname(clientPath), name))] : []),
        ...(Array.isArray(patch) ? patch : [patch])];
    for (const file of files) {
        const path = resolve(packageRoot, file);
        const relativePath = relative(resolve(packageRoot), path);
        if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\')) {
            throw new Error('Package artifact path escapes its directory');
        }
        try {
            const stat = await lstat(path);
            if (!stat.isFile()) throw new Error('not a regular file');
        } catch {
            throw new Error(`Missing built package artifact: ${file}. Run the package build before installing the bundle`);
        }
    }
}

/** Install through the official profile launcher and plugin manager without overwriting an existing profile. */
export async function installProfile(
    config: Pick<RuntimeConfig, 'dsh'>,
    configFile: string,
    packageRoot: string,
    options: { command?: Command; run?: CommandRunner; env?: NodeJS.ProcessEnv; bundleName?: 'hapi-dsh' | 'hapi-dsh-runner' } = {},
): Promise<void> {
    const bundleName = options.bundleName ?? 'hapi-dsh';
    await verifyBundleArtifacts(packageRoot, bundleName);
    const command = options.command ?? await resolveDshCommand(config);
    const run = options.run ?? runCommand;
    const env = runtimeEnvironment(config, configFile, options.env);
    if (bundleName === 'hapi-dsh-runner') {
        delete env.HAPI_DSH_CONFIG_FILE;
        env.HAPI_DSH_RUNNER_CONFIG_FILE = resolve(configFile);
    }
    await verifyDshVersion(command, env, run);
    const profiles = join(config.dsh.home, 'profiles');
    await mkdir(profiles, { recursive: true, mode: 0o700 });
    await withFileLock(join(profiles, `.${config.dsh.profile}.hapi-dsh-setup`), async () => {
        const profilePath = join(profiles, config.dsh.profile, 'package.json');
        const exists = await lstat(profilePath).then(() => true).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
        });
        if (!exists) {
            const directoryExists = await lstat(dirname(profilePath)).then(() => true).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return false;
                throw error;
            });
            if (directoryExists) throw new Error('The profile directory already exists without a manifest; choose a new profile name or repair it manually');
            const initialized = await run({ ...command, args: [...command.args, '--profile', config.dsh.profile, '--from-default-profile', 'web', '--dump-config'] }, { env, timeoutMs: 120_000 });
            if (initialized.exitCode !== 0) throw new Error('Official DSH profile initialization failed; the configuration was preserved for retry');
        } else {
            const manifest: { dsh?: { profile?: { bundles?: unknown } } } = JSON.parse(await readFile(profilePath, 'utf8'));
            const bundles = manifest.dsh?.profile?.bundles;
            if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-web-app')) {
                throw new Error('Existing profile is not based on the official Web profile; it was left unchanged');
            }
        }
        const installed = await run({ ...command, args: [...command.args, 'plugin', '--profile', config.dsh.profile, 'add', `link:${resolve(packageRoot)}`] }, { env, timeoutMs: 300_000 });
        if (installed.exitCode === 127 && installed.stderr.split(/\r?\n/).includes('dsh: pnpm was not found; install pnpm and make it available on PATH.')) {
            throw new Error('The official DSH plugin manager requires pnpm on PATH. Install pnpm 11.28.5, then retry installation; the existing profile was preserved');
        }
        if (installed.exitCode !== 0) throw new Error('Official DSH plugin installation failed; run dsh plugin for its installation diagnostics');
        const dump = await run({ ...command, args: [...command.args, '--profile', config.dsh.profile, '--dump-config'] }, { env, timeoutMs: 120_000 });
        if (dump.exitCode !== 0 || !new RegExp(`^\\s*-?\\s*id:\\s*["']?${bundleName}["']?\\s*$`, 'm').test(dump.stdout)) {
            throw new Error(`The resulting DSH profile does not contain the ${bundleName} plugin row`);
        }
        if (bundleName === 'hapi-dsh') assertProfileProviders(dump.stdout);
    });
}

export function startArguments(config: RuntimeConfig, noOpen: boolean): string[] {
    const args = ['--profile', config.dsh.profile, '--host', config.server.host, '--port', String(config.server.port)];
    if (config.server.publicUrl) args.push('--public-url', config.server.publicUrl);
    for (const authority of config.server.trustedHosts ?? []) args.push('--trusted-host', authority);
    if (config.server.tls) args.push('--tls-cert', config.server.tls.certFile, '--tls-key', config.server.tls.keyFile);
    if (noOpen) args.push('--no-open');
    return args;
}

/**
 * Read the official Web launcher's login line. The launch token is scoped to
 * one DSH process, so the persisted URL becomes stale as soon as the process
 * restarts; the launcher prints the current URL exactly once per boot.
 */
export function parseLaunchUrl(line: string): string | undefined {
    const match = /^\s*dsh web:\s*(https?:\/\/\S+)\s*$/.exec(line);
    if (!match) return undefined;
    try {
        const url = new URL(match[1]!);
        if (!url.searchParams.has('token')) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

/** Keep the current process's login URL beside the private config, readable only by the owner. */
export async function writeLaunchUrl(configFile: string, url: string): Promise<void> {
    const target = join(dirname(resolve(configFile)), 'launch-url');
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${url}\n`, { mode: 0o600 });
    try {
        await rename(temporary, target);
    } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
    }
}

/** DSH owns all application boot and teardown; this wrapper only forwards signals and exit status. */
export async function startProfile(config: RuntimeConfig, configFile: string, noOpen = false): Promise<number> {
    resolveHapiToken(config);
    const command = await resolveDshCommand(config);
    const env = runtimeEnvironment(config, configFile);
    await verifyDshVersion(command, env);
    await requireProfileBundle(config, 'hapi-dsh');
    return runProfileForeground(command, startArguments(config, noOpen), env, configFile);
}

/**
 * Run the Web profile while mirroring its output and persisting the current
 * launch URL. Piping stdout is what makes the URL observable; stderr stays a
 * direct pipe so launcher diagnostics keep their ordering.
 */
export async function runProfileForeground(command: Command, args: string[], env: NodeJS.ProcessEnv, configFile: string): Promise<number> {
    return new Promise((resolveExit, reject) => {
        const child = spawn(command.executable, [...command.args, ...args], {
            env, stdio: ['inherit', 'pipe', 'pipe'], shell: false, windowsHide: true,
        });
        let pending = '';
        let written: string | undefined;
        child.stdout?.on('data', (chunk: Buffer) => {
            process.stdout.write(chunk);
            pending += chunk.toString('utf8');
            for (;;) {
                const index = pending.indexOf('\n');
                if (index === -1) break;
                const line = pending.slice(0, index);
                pending = pending.slice(index + 1);
                const url = parseLaunchUrl(line);
                if (url !== undefined && url !== written) {
                    written = url;
                    void writeLaunchUrl(configFile, url).catch((error: unknown) => {
                        process.stderr.write(`hapi-dsh: could not persist the launch URL: ${error instanceof Error ? error.message : String(error)}\n`);
                    });
                }
            }
            // Launcher output is line-oriented; bound a hostile partial line.
            if (pending.length > 64 * 1024) pending = pending.slice(-4096);
        });
        child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(chunk); });
        const forwardInt = (): void => { child.kill('SIGINT'); };
        const forwardTerm = (): void => { child.kill('SIGTERM'); };
        process.on('SIGINT', forwardInt);
        process.on('SIGTERM', forwardTerm);
        const cleanup = (): void => {
            process.off('SIGINT', forwardInt);
            process.off('SIGTERM', forwardTerm);
        };
        child.on('error', (error) => { cleanup(); reject(error); });
        child.on('close', (code, signal) => {
            cleanup();
            resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
        });
    });
}

export async function requireProfileBundle(config: Pick<RuntimeConfig, 'dsh'>, bundleName: string): Promise<void> {
    const manifest = JSON.parse(await readFile(join(config.dsh.home, 'profiles', config.dsh.profile, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } };
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-web-app') || !bundles.includes(bundleName)) {
        throw new Error(`The custom Web profile does not include ${bundleName}; run its install command first`);
    }
}

export async function runForeground(command: Command, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise((resolveExit, reject) => {
        const child = spawn(command.executable, [...command.args, ...args], {
            env, stdio: 'inherit', shell: false, windowsHide: true,
        });
        const forwardInt = (): void => { child.kill('SIGINT'); };
        const forwardTerm = (): void => { child.kill('SIGTERM'); };
        process.on('SIGINT', forwardInt);
        process.on('SIGTERM', forwardTerm);
        const cleanup = (): void => {
            process.off('SIGINT', forwardInt);
            process.off('SIGTERM', forwardTerm);
        };
        child.on('error', (error) => { cleanup(); reject(error); });
        child.on('close', (code, signal) => {
            cleanup();
            resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
        });
    });
}
