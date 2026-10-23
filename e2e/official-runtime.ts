import { cp, mkdtemp, mkdir, readFile, stat, writeFile, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig, writeConfig } from '../src/cli/config.ts';
import { installProfile, resolveDshCommand, runCommand, runtimeEnvironment, type Command } from '../src/cli/runtime.ts';
import { createRunnerConfig, writeRunnerConfig } from '../src/runner/config.ts';
import { addPairing } from '../src/hub/federation-credentials.ts';
import { HapiWireFixture } from './hapi-fixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Rpc = <T = unknown>(method: string, request?: unknown) => Promise<T>;

const timingEnabled = process.env.HAPI_DSH_E2E_TIMING === '1';
const timingStarted = Date.now();
function stage(label: string): void {
    if (timingEnabled) process.stderr.write(`[e2e ${((Date.now() - timingStarted) / 1000).toFixed(1)}s] ${label}\n`);
}
function cacheRoot(): string { return process.env.HAPI_DSH_E2E_CACHE ?? join(tmpdir(), 'hapi-dsh-e2e-cache'); }

interface E2eTemplate { key: string; root: string; hubHome: string; runnerHome: string; provider: string }

/** Installed profiles link to this repo. Client-only rebuilds need no reinstall. */
async function templateKey(): Promise<string> {
    const rows = ['hapi-dsh-e2e-template-v1'];
    const files = ['package.json', 'package-lock.json', 'dist/index.js', 'dist/runner/index.js', 'dist/runner/config.js', 'dist/runner/client.js', 'dist/runner/protocol.js', 'dist/runner/tunnel.js', 'dist/runner/package.json', 'dist/runner/cordis.patch.yml', 'e2e/provider-fixture.mjs'];
    for (const path of files) {
        try {
            const info = await stat(join(root, path));
            rows.push(`${path}:${Math.trunc(info.mtimeMs)}:${info.size}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            rows.push(`${path}:missing`);
        }
    }
    return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
}

/** Add the in-repo fixture provider to one profile through the official plugin manager. */
async function addFixtureProvider(profile: string, provider: string, command: Command, env: NodeJS.ProcessEnv): Promise<void> {
    const result = await runCommand({ ...command, args: [...command.args, 'plugin', '--profile', profile, 'add', `link:${provider}`] }, { env, timeoutMs: 120_000 });
    if (result.exitCode) throw new Error(`Fixture provider installation failed: ${result.stderr.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')}`);
}

/**
 * Prepare the two official profiles once per build and cache them. Each test
 * environment then copies the prepared profile tree instead of paying two
 * `dsh plugin add` pnpm installs and repeated version checks per spec file.
 */
async function ensureTemplate(): Promise<E2eTemplate> {
    const cache = cacheRoot();
    await mkdir(cache, { recursive: true });
    const key = await templateKey();
    const directory = join(cache, key);
    const template: E2eTemplate = { key, root: directory, hubHome: join(directory, 'hub-home'), runnerHome: join(directory, 'runner-home'), provider: join(directory, 'provider') };
    const marker = join(directory, '.ready');
    const ready = (): Promise<boolean> => readFile(marker, 'utf8').then(() => true, () => false);
    if (await ready()) return template;
    await withFileLock(join(cache, `.${key}.setup`), async () => {
        if (await ready()) return;
        stage('template: build');
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory, { recursive: true });
        // One provider package shared by every prepared profile; it only reads the repository.
        await mkdir(template.provider);
        await symlink(join(root, 'node_modules'), join(template.provider, 'node_modules'), 'junction');
        await writeFile(join(template.provider, 'index.mjs'), await readFile(join(root, 'e2e/provider-fixture.mjs')));
        await writeFile(join(template.provider, 'package.json'), JSON.stringify({ name: 'hapi-dsh-e2e-provider', version: '0.0.0', type: 'module',
            exports: { '.': './index.mjs', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
            dsh: { bundle: { patch: './cordis.patch.yml' } } }));
        await writeFile(join(template.provider, 'cordis.patch.yml'), '- insert:\n    - id: hapi-dsh-e2e-provider\n      name: hapi-dsh-e2e-provider\n');
        const command = await resolveDshCommand({ dsh: { home: template.hubHome } } as never);
        const hubConfig = createConfig('http://127.0.0.1:9', { DSH_HOME: template.hubHome });
        hubConfig.server.port = 0;
        hubConfig.hapi.token = 'template-access-token';
        hubConfig.hapi.id = 'e2e-template-hub';
        hubConfig.federation = { credentialsFile: join(directory, 'template-pairings.json') };
        const hubConfigFile = join(directory, 'template-hub.json');
        await writeConfig(hubConfigFile, hubConfig);
        await installProfile(hubConfig, hubConfigFile, root);
        await addFixtureProvider(hubConfig.dsh.profile, template.provider, command, runtimeEnvironment(hubConfig, hubConfigFile));
        const runner = createRunnerConfig('http://127.0.0.1:9', { id: 'template-runner', token: 'template-pair-token', dshHome: template.runnerHome });
        const runnerFile = join(directory, 'template-runner.json');
        await writeRunnerConfig(runnerFile, runner);
        await installProfile(runner, runnerFile, join(root, 'dist/runner'), { bundleName: 'hapi-dsh-runner' });
        const runnerEnv = { ...process.env, DSH_HOME: runner.dsh.home, HAPI_DSH_RUNNER_CONFIG_FILE: runnerFile };
        await addFixtureProvider(runner.dsh.profile, template.provider, command, runnerEnv);
        await writeFile(marker, JSON.stringify({ key, provider: template.provider }));
        stage('template: ready');
    });
    if (!(await ready())) throw new Error('The prepared official e2e profile was not written');
    return template;
}

/** Copy one prepared profile tree (pnpm symlinks preserved) into one environment home. */
async function materializeProfiles(templateHome: string, targetHome: string): Promise<void> {
    await mkdir(targetHome, { recursive: true });
    // Default copy resolve symlinks to absolute targets; verbatim would keep
    // template-relative links that break after the tree moves.
    await cp(join(templateHome, 'profiles'), join(targetHome, 'profiles'), { recursive: true, force: true });
}
export interface OfficialEnvironment {
    hapi: HapiWireFixture;
    launchUrl: string;
    origin: string;
    rpc: Rpc;
    remoteRpc?: Rpc;
    remoteSessionId?: string;
    directory: string;
    /** Sanitized local fixture process output for failed official-plugin activation diagnostics. */
    diagnostics(): string;
    close(): Promise<void>;
}
function sanitize(value: string, secrets: readonly string[] = []): string {
    let safe = value.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]');
    for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[redacted]');
    return safe;
}

async function rpcClient(launchUrl: string, prefix = ''): Promise<{ rpc: Rpc; cookie: string; origin: string }> {
    const initial = await fetch(launchUrl, { redirect: 'manual' });
    if (initial.status !== 303) throw new Error(`Official browser admission failed: ${initial.status}`);
    const cookie = initial.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    await initial.body?.cancel();
    const origin = new URL(launchUrl).origin;
    return { cookie, origin, rpc: <T>(method: string, request: unknown = {}): Promise<T> => invoke<T>(origin, cookie, prefix, method, request) };
}
async function invoke<T>(origin: string, cookie: string, prefix: string, method: string, request: unknown): Promise<T> {
    const response = await fetch(`${origin}${prefix}/api/${method}`, {
        method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `test-${crypto.randomUUID()}`, method,
            payload: { args: method === 'session/list' ? { _request: request } : method === 'hapi/catalog' || method === 'hapi/workspaceGet' ? {} : { request } } }),
    });
    const wire = await response.json() as { result?: { ok: boolean; value?: T; error?: unknown } };
    if (!wire.result?.ok) throw new Error(`Official RPC ${method} failed: ${JSON.stringify(wire)}`);
    return wire.result.value!;
}

export async function startOfficialEnvironment(remote = false, options: { companionUrl?: string } = {}): Promise<OfficialEnvironment> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-browser-'));
    const children: ChildProcess[] = [];
    const processOutput: Array<() => string> = [];
    const hapi = new HapiWireFixture();
    const close = async (): Promise<void> => {
        for (const child of [...children].reverse()) {
            if (child.exitCode !== null || child.signalCode !== null) continue;
            child.kill('SIGTERM');
            const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
            await once(child, 'close').catch(() => {}); clearTimeout(timeout);
        }
        await hapi.close();
        await rm(directory, { recursive: true, force: true });
    };
    try {
        await hapi.start();
        const config = createConfig(hapi.url, { DSH_HOME: join(directory, 'hub-home') });
        config.server.port = 0;
        config.hapi.token = hapi.accessToken;
        config.hapi.id = 'e2e-native-hub';
        if (options.companionUrl !== undefined) config.hapi.companionUrl = options.companionUrl;
        const credentialsFile = join(directory, 'pairings.json');
        config.federation = { credentialsFile };
        const pairToken = remote ? await addPairing(credentialsFile, 'runner-one', 'Remote Linux') : undefined;
        const configFile = join(directory, 'hub.json');
        await writeConfig(configFile, config);
        const template = await ensureTemplate();
        await materializeProfiles(template.hubHome, config.dsh.home);
        stage('hub: profile copied');
        const command = await resolveDshCommand(config);
        const start = async (runtime: Command, args: string[], env: NodeJS.ProcessEnv, runner = false): Promise<string> => {
            const child = spawn(runtime.executable, [...runtime.args, ...args], { env: { ...env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
            children.push(child);
            let output = '';
            processOutput.push(() => sanitize(output, [hapi.accessToken, ...(pairToken ? [pairToken] : [])]));
            const capture = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-100_000); };
            child.stdout!.on('data', capture); child.stderr!.on('data', capture);
            child.on('exit', (code, signal) => {
                output = (output + `\n[official fixture process exited: code=${code ?? 'none'}, signal=${signal ?? 'none'}]\n`).slice(-100_000);
            });
            const deadline = Date.now() + 60_000;
            for (;;) {
                const match = /dsh web: (https?:\/\/[^\s\u001b]+)/.exec(output);
                if (match?.[1]) return match[1];
                if (runner && /hapi-dsh Runner [^\r\n]+: connected(?:\r?\n|$)/.test(output)) return '';
                if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Official DSH did not start: ${sanitize(output)}`);
                await delay(100);
            }
        };
        const env = runtimeEnvironment(config, configFile);
        const launchUrl = await start(command, ['--profile', config.dsh.profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], env);
        stage('hub: started');
        const client = await rpcClient(launchUrl);
        const result: OfficialEnvironment = { hapi, launchUrl, origin: client.origin, rpc: client.rpc, directory, diagnostics: () => processOutput.map(read => read()).join('\n'), close };
        if (remote && pairToken) {
            const runner = createRunnerConfig(client.origin, { id: 'runner-one', token: pairToken, dshHome: join(directory, 'runner-home') });
            const runnerFile = join(directory, 'runner.json');
            await writeRunnerConfig(runnerFile, runner);
            await materializeProfiles(template.runnerHome, runner.dsh.home);
            const runnerEnv = { ...process.env, DSH_HOME: runner.dsh.home, HAPI_DSH_RUNNER_CONFIG_FILE: runnerFile };
            await start(command, ['--profile', runner.dsh.profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], runnerEnv, true);
            stage('runner: started');
            const deadline = Date.now() + 30_000;
            while (true) {
                const catalog = await client.rpc<{ hosts: Array<{ online: boolean }> }>('hapi/catalog');
                if (catalog.hosts.some(host => host.online)) break;
                if (Date.now() > deadline) throw new Error('Official remote Runner did not become online');
                await delay(100);
            }
            const remoteRpc: Rpc = (method, request = {}) => invoke(client.origin, client.cookie, '/hapi-dsh/machine/runner-one', method, request);
            const created = await remoteRpc<{ sessionId: string }>('session/create', { cwd: directory });
            await remoteRpc('session/selectModel', { sessionId: created.sessionId, provider: 'fixture', model: 'fixture-model' });
            await remoteRpc('session/rename', { sessionId: created.sessionId, title: 'DSH remote conversation' });
            await remoteRpc('session/prompt', { sessionId: created.sessionId, requestId: 'e2e-remote-seed-00001', mode: 'queue', content: [{ type: 'text', text: 'Remote DSH seed prompt' }] });
            result.remoteRpc = remoteRpc;
            result.remoteSessionId = created.sessionId;
        }
        return result;
    } catch (error) { await close(); throw error; }
}
