import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeHttpUrl, parseConfig, readPrivateJson, writePrivateJson, type RuntimeConfig } from '../cli/config.ts';
import { validMachineId } from './protocol.ts';

export interface RunnerConfig {
    version: 1;
    machine: { id: string; name: string };
    hub: { url: string; tokenEnv: string; token?: string };
    dsh: RuntimeConfig['dsh'];
    server: { host: '127.0.0.1'; port: number };
    sources?: RuntimeConfig['sources'];
}

export function parseRunnerConfig(value: unknown): RunnerConfig {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Runner configuration must be an object');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['version', 'machine', 'hub', 'dsh', 'server', 'sources'].includes(key))) throw new Error('Unknown Runner configuration field');
    if (input.version !== 1 || typeof input.machine !== 'object' || input.machine === null || typeof input.hub !== 'object' || input.hub === null) throw new Error('Invalid Runner configuration');
    const machine = input.machine as Record<string, unknown>;
    const hub = input.hub as Record<string, unknown>;
    if (Object.keys(machine).some((key) => !['id', 'name'].includes(key)) || Object.keys(hub).some((key) => !['url', 'token', 'tokenEnv'].includes(key))) throw new Error('Unknown Runner identity or Hub field');
    if (!validMachineId(machine.id) || typeof machine.name !== 'string' || machine.name.length === 0 || machine.name.length > 128) throw new Error('Runner requires a stable machine ID and display name');
    if (typeof input.server !== 'object' || input.server === null || Array.isArray(input.server)
        || Object.keys(input.server).some((key) => !['host', 'port'].includes(key))) throw new Error('Runner server configuration accepts only its loopback host and port');
    // The same official launch/profile validation applies to both Host compositions.
    const common = parseConfig({ version: 1, dsh: input.dsh, server: input.server, ...(input.sources === undefined ? {} : { sources: input.sources }) });
    if (common.sources?.some(source => source.machineId !== machine.id)) throw new Error('Runner sources must use its paired machine ID');
    if (typeof hub.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(hub.tokenEnv)) throw new Error('hub.tokenEnv must be an environment variable name');
    if (hub.token !== undefined && (typeof hub.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(hub.token))) throw new Error('Invalid Runner pairing token');
    if (common.server.host !== '127.0.0.1') throw new Error('The Runner-owned DSH listener must bind 127.0.0.1; the reverse connection provides remote access');
    return { version: 1, machine: { id: machine.id, name: machine.name },
        hub: { url: normalizeHttpUrl(hub.url, 'hub.url'), tokenEnv: hub.tokenEnv, ...(hub.token === undefined ? {} : { token: hub.token as string }) },
        dsh: common.dsh, server: { host: '127.0.0.1', port: common.server.port }, ...(common.sources === undefined ? {} : { sources: common.sources }) };
}

export function createRunnerConfig(hubUrl: string, options: { id?: string; name?: string; token?: string; dshHome?: string } = {}): RunnerConfig {
    return parseRunnerConfig({ version: 1, machine: { id: options.id ?? randomUUID(), name: options.name ?? hostname() },
        hub: { url: normalizeHttpUrl(hubUrl, 'hub.url'), tokenEnv: 'HAPI_DSH_RUNNER_TOKEN', ...(options.token === undefined ? {} : { token: options.token }) },
        dsh: { home: options.dshHome ? resolve(options.dshHome) : join(homedir(), '.dsh'), profile: 'hapi-runner' },
        server: { host: '127.0.0.1', port: 0 } });
}

export function runnerConfigPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.HAPI_DSH_RUNNER_CONFIG_FILE) return resolve(env.HAPI_DSH_RUNNER_CONFIG_FILE);
    return join(env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), '.config'), 'hapi-dsh', 'runner.json');
}

export async function readRunnerConfig(path: string): Promise<RunnerConfig> { return parseRunnerConfig(await readPrivateJson(path)); }
export async function writeRunnerConfig(path: string, config: RunnerConfig): Promise<void> {
    if (!isAbsolute(path)) throw new Error('Runner configuration path must be absolute');
    await writePrivateJson(path, parseRunnerConfig(config));
}

export function runnerToken(config: RunnerConfig, env: NodeJS.ProcessEnv = process.env): string {
    const token = env[config.hub.tokenEnv] ?? config.hub.token;
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`Set ${config.hub.tokenEnv} or use the private Runner config issued by hapi-dsh pair`);
    return token;
}
