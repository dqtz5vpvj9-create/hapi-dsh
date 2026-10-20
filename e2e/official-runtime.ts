import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfig, writeConfig } from '../src/cli/config.ts';
import { installProfile, resolveDshCommand, runCommand, runtimeEnvironment, type Command } from '../src/cli/runtime.ts';
import { createRunnerConfig, writeRunnerConfig } from '../src/runner/config.ts';
import { addPairing } from '../src/hub/federation-credentials.ts';
import { HapiWireFixture } from './hapi-fixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Rpc = <T = unknown>(method: string, request?: unknown) => Promise<T>;
export interface OfficialEnvironment {
    hapi: HapiWireFixture;
    launchUrl: string;
    origin: string;
    rpc: Rpc;
    remoteRpc?: Rpc;
    remoteSessionId?: string;
    directory: string;
    close(): Promise<void>;
}
function sanitize(value: string): string { return value.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'); }

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

export async function startOfficialEnvironment(remote = false): Promise<OfficialEnvironment> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-browser-'));
    const children: ChildProcess[] = [];
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
        const credentialsFile = join(directory, 'pairings.json');
        config.federation = { credentialsFile };
        const pairToken = remote ? await addPairing(credentialsFile, 'runner-one', 'Remote Linux') : undefined;
        const configFile = join(directory, 'hub.json');
        await writeConfig(configFile, config);
        await installProfile(config, configFile, root);
        const command = await resolveDshCommand(config);
        const provider = join(directory, 'provider');
        await mkdir(provider);
        await symlink(join(root, 'node_modules'), join(provider, 'node_modules'), 'junction');
        await writeFile(join(provider, 'index.mjs'), await readFile(join(root, 'e2e/provider-fixture.mjs')));
        await writeFile(join(provider, 'package.json'), JSON.stringify({ name: 'hapi-dsh-e2e-provider', version: '0.0.0', type: 'module',
            exports: { '.': './index.mjs', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
            dsh: { bundle: { patch: './cordis.patch.yml' } } }));
        await writeFile(join(provider, 'cordis.patch.yml'), '- insert:\n    - id: hapi-dsh-e2e-provider\n      name: hapi-dsh-e2e-provider\n');
        const addProvider = async (profile: string, env: NodeJS.ProcessEnv): Promise<void> => {
            const result = await runCommand({ ...command, args: [...command.args, 'plugin', '--profile', profile, 'add', `link:${provider}`] }, { env, timeoutMs: 120_000 });
            if (result.exitCode) throw new Error(`Fixture provider installation failed: ${sanitize(result.stderr)}`);
        };
        const start = async (runtime: Command, args: string[], env: NodeJS.ProcessEnv, runner = false): Promise<string> => {
            const child = spawn(runtime.executable, [...runtime.args, ...args], { env: { ...env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
            children.push(child);
            let output = '';
            const capture = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-100_000); };
            child.stdout!.on('data', capture); child.stderr!.on('data', capture);
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
        await addProvider(config.dsh.profile, env);
        const launchUrl = await start(command, ['--profile', config.dsh.profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], env);
        const client = await rpcClient(launchUrl);
        const result: OfficialEnvironment = { hapi, launchUrl, origin: client.origin, rpc: client.rpc, directory, close };
        if (remote && pairToken) {
            const runner = createRunnerConfig(client.origin, { id: 'runner-one', token: pairToken, dshHome: join(directory, 'runner-home') });
            const runnerFile = join(directory, 'runner.json');
            await writeRunnerConfig(runnerFile, runner);
            await installProfile(runner, runnerFile, join(root, 'dist/runner'), { bundleName: 'hapi-dsh-runner' });
            const runnerEnv = { ...process.env, DSH_HOME: runner.dsh.home, HAPI_DSH_RUNNER_CONFIG_FILE: runnerFile };
            await addProvider(runner.dsh.profile, runnerEnv);
            await start(command, ['--profile', runner.dsh.profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], runnerEnv, true);
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
