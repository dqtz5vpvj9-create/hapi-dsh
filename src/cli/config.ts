import { link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { replacePrivateFile } from '../shared/atomic-rename.ts';
import { isWildcardHost, normalizeBindAddress } from '@deepseek-ai/dsh-host-webserver';
import { parseSources } from '../remote/config.ts';
import type { DirectCodexConfig } from '../remote/protocol.ts';

export const DSH_VERSION = '0.2.1-rc.3';
export const HAPI_REVISION = '55166cf8d87814ccfb383b538a8e8c55283bed81';
export const CONFIG_VERSION = 1;

export interface RuntimeConfig {
    version: 1;
    dsh: {
        home: string;
        profile: string;
        command?: string;
        args?: string[];
    };
    hapi?: {
        id: string;
        url: string;
        tokenEnv: string;
        token?: string;
        /** Original HAPI Hub HTTPS origin reachable by the mobile Companion. */
        companionUrl?: string;
    };
    server: {
        host: string;
        port: number;
        publicUrl?: string;
        trustedHosts?: string[];
        tls?: { certFile: string; keyFile: string };
    };
    federation?: { credentialsFile: string };
    sources?: DirectCodexConfig[];
}

function record(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
    const extra = Object.keys(value).filter((key) => !allowed.includes(key));
    if (extra.length > 0) throw new Error(`${name} has unknown fields: ${extra.join(', ')}`);
}

function string(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
        throw new Error(`${name} must be a nonempty string`);
    }
    return value;
}

export function normalizeHttpUrl(value: unknown, name: string): string {
    let url: URL;
    try {
        url = new URL(string(value, name));
    } catch {
        throw new Error(`${name} must be an absolute HTTP or HTTPS URL`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(`${name} must use HTTP or HTTPS without credentials, a query, or a fragment`);
    }
    return url.toString().replace(/\/+$/, '');
}

/** Native Companion clients accept an origin, not a reverse-proxy path prefix. */
export function normalizeCompanionUrl(value: unknown): string {
    const normalized = normalizeHttpUrl(value, 'hapi.companionUrl');
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || url.pathname !== '/' || typeof value === 'string' && (value.includes('?') || value.includes('#'))) {
        throw new Error('hapi.companionUrl must be an HTTPS origin without a path prefix');
    }
    return url.origin;
}

/** Match the official bare host[:port] contract without silently broadening a port grant. */
function trustedAuthority(value: unknown): string {
    if (typeof value !== 'string' || value.includes('*')) throw new Error('server.trustedHosts must contain bare host[:port] authorities');
    try {
        const http = new URL(`http://${value}`);
        const https = new URL(`https://${value}`);
        const port = http.port || https.port;
        if (`${http.hostname}${port ? `:${port}` : ''}` === value.toLowerCase()) return value;
    } catch { /* The error deliberately does not echo possibly credential-bearing input. */ }
    throw new Error('server.trustedHosts must contain canonical bare host[:port] authorities');
}

/** Validate serialized operator configuration before it is used by the Host or CLI. */
export function parseConfig(input: unknown): RuntimeConfig {
    const config = record(input, 'configuration');
    keys(config, ['version', 'dsh', 'hapi', 'server', 'federation', 'sources'], 'configuration');
    if (config.version !== CONFIG_VERSION) throw new Error(`Unsupported configuration version; expected ${CONFIG_VERSION}`);
    const dsh = record(config.dsh, 'dsh');
    const hapi = config.hapi === undefined ? undefined : record(config.hapi, 'hapi');
    const server = record(config.server, 'server');
    keys(dsh, ['home', 'profile', 'command', 'args'], 'dsh');
    if (hapi) keys(hapi, ['id', 'url', 'tokenEnv', 'token', 'companionUrl'], 'hapi');
    keys(server, ['host', 'port', 'publicUrl', 'trustedHosts', 'tls'], 'server');
    const home = string(dsh.home, 'dsh.home');
    if (!isAbsolute(home)) throw new Error('dsh.home must be an absolute path');
    const profile = string(dsh.profile, 'dsh.profile');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('dsh.profile must use lowercase letters, digits, underscores, or hyphens');
    if (['web', 'headless', 'sdk', 'sdk-minimal', 'acp', 'desktop'].includes(profile)) {
        throw new Error('dsh.profile must name a dedicated custom profile, such as hapi');
    }
    const host = string(server.host, 'server.host');
    try {
        normalizeBindAddress(host);
        if (isWildcardHost(host)) throw new Error('wildcard');
    }
    catch {
        throw new Error('server.host must be one concrete local IP address; use 127.0.0.1 for local access');
    }
    if (!Number.isInteger(server.port) || Number(server.port) < 0 || Number(server.port) > 65535) {
        throw new Error('server.port must be an integer between 0 and 65535');
    }
    const result: RuntimeConfig = {
        version: CONFIG_VERSION,
        dsh: { home, profile },
        server: { host, port: Number(server.port) },
    };
    if (dsh.command !== undefined) result.dsh.command = string(dsh.command, 'dsh.command');
    if (dsh.args !== undefined) {
        if (!Array.isArray(dsh.args) || dsh.args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
            throw new Error('dsh.args must be an array of command arguments');
        }
        result.dsh.args = [...dsh.args];
    }
    if (hapi) {
        const tokenEnv = string(hapi.tokenEnv, 'hapi.tokenEnv');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('hapi.tokenEnv must be an environment variable name');
        const hubId = hapi.id === undefined ? randomUUID() : string(hapi.id, 'hapi.id');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(hubId)) throw new Error('hapi.id must be a stable identifier using letters, digits, dots, underscores, or hyphens');
        result.hapi = { id: hubId, url: normalizeHttpUrl(hapi.url, 'hapi.url'), tokenEnv };
        if (hapi.token !== undefined) result.hapi.token = string(hapi.token, 'hapi.token');
        if (hapi.companionUrl !== undefined) result.hapi.companionUrl = normalizeCompanionUrl(hapi.companionUrl);
    }
    if (config.sources !== undefined) result.sources = parseSources(config.sources);
    if (server.publicUrl !== undefined) result.server.publicUrl = normalizeHttpUrl(server.publicUrl, 'server.publicUrl');
    if (server.trustedHosts !== undefined) {
        if (!Array.isArray(server.trustedHosts) || server.trustedHosts.length > 32) throw new Error('server.trustedHosts must be an array of at most 32 authorities');
        result.server.trustedHosts = [...new Set(server.trustedHosts.map(trustedAuthority))];
    }
    if (server.tls !== undefined) {
        const tls = record(server.tls, 'server.tls');
        keys(tls, ['certFile', 'keyFile'], 'server.tls');
        const certFile = string(tls.certFile, 'server.tls.certFile');
        const keyFile = string(tls.keyFile, 'server.tls.keyFile');
        if (!isAbsolute(certFile) || !isAbsolute(keyFile)) throw new Error('TLS certificate and key paths must be absolute');
        result.server.tls = { certFile, keyFile };
    }
    if (config.federation !== undefined) {
        const federation = record(config.federation, 'federation');
        keys(federation, ['credentialsFile'], 'federation');
        const credentialsFile = string(federation.credentialsFile, 'federation.credentialsFile');
        if (!isAbsolute(credentialsFile)) throw new Error('federation.credentialsFile must be an absolute path');
        result.federation = { credentialsFile };
    }
    return result;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.HAPI_DSH_CONFIG_FILE) return resolve(env.HAPI_DSH_CONFIG_FILE);
    const base = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), '.config');
    return join(base, 'hapi-dsh', 'config.json');
}

export type HapiRuntimeConfig = RuntimeConfig & { hapi: NonNullable<RuntimeConfig['hapi']> };
export function createConfig(hapiUrl: string, env?: NodeJS.ProcessEnv): HapiRuntimeConfig;
export function createConfig(hapiUrl?: undefined, env?: NodeJS.ProcessEnv): RuntimeConfig;
export function createConfig(hapiUrl: string | undefined, env?: NodeJS.ProcessEnv): RuntimeConfig;
export function createConfig(hapiUrl?: string, env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
    return parseConfig({
        version: CONFIG_VERSION,
        dsh: { home: env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh'), profile: 'hapi' },
        ...(hapiUrl === undefined ? {} : { hapi: { id: randomUUID(), url: hapiUrl, tokenEnv: 'HAPI_DSH_TOKEN' } }),
        server: { host: '127.0.0.1', port: 3080 },
    });
}

/** Read a private regular file; credential-bearing configuration is never followed through a symlink. */
export async function readPrivateJson(path: string): Promise<unknown> {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Configuration must be a regular file, not a symlink');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev) {
            throw new Error('Configuration changed while it was being opened; retry with a regular file');
        }
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
            throw new Error('Configuration permissions are too broad; set the file mode to 0600');
        }
        if (stat.size > 64 * 1024) throw new Error('Configuration exceeds 64 KiB');
        let value: unknown;
        try {
            const text = await handle.readFile('utf8');
            if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Configuration exceeds 64 KiB');
            value = JSON.parse(text);
        } catch {
            throw new Error('Configuration is not valid JSON');
        }
        return value;
    } finally {
        await handle.close();
    }
}

/** Assign legacy configs a persistent random Hub identity before any session identity is derived. */
export async function readConfig(path: string): Promise<RuntimeConfig> {
    const document = await readPrivateJson(path);
    const config = parseConfig(document);
    const input = document as { hapi?: { id?: unknown } };
    if (input.hapi === undefined || input.hapi.id !== undefined) return config;
    return withFileLock(`${path}.migration`, async () => {
        // Re-read under the lock, so two starting processes cannot persist different identities.
        const current = await readPrivateJson(path);
        const result = parseConfig(current);
        if ((current as { hapi?: { id?: unknown } }).hapi?.id === undefined) await writeConfig(path, result, true);
        return result;
    });
}

/** Create a private config without replacing an existing file. Updates require an explicit replace request. */
export async function writeConfig(path: string, config: RuntimeConfig, replace = false): Promise<void> {
    const validated = parseConfig(config);
    await writePrivateJson(path, validated, replace);
}

/** Atomic private JSON writing shared by Hub pairing records and Runner configuration. */
export async function writePrivateJson(path: string, value: unknown, replace = false): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error('Configuration exceeds 64 KiB');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(serialized, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        if (replace) {
            const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return undefined;
                throw error;
            });
            if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
                throw new Error('Refusing to replace non-regular configuration');
            }
            await replacePrivateFile(temporary, path);
        } else {
            // Linking a completed file atomically excludes both overwrite and a partial configuration.
            await link(temporary, path);
        }
        if (process.platform !== 'win32') {
            // Persist the new directory entry as well as the file bytes. This
            // matters for stable Hub identities and credential revocation after
            // power loss; Windows does not support opening directories this way.
            const directory = await open(dirname(path), constants.O_RDONLY);
            try { await directory.sync(); }
            finally { await directory.close(); }
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

export function resolveHapiToken(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): string {
    if (!config.hapi) throw new Error('No HAPI source is configured; a HAPI token is not required for HHPI sources or federation.');
    const value = env[config.hapi.tokenEnv] ?? config.hapi.token;
    if (!value?.trim()) throw new Error(`Set ${config.hapi.tokenEnv} to the HAPI access token before starting`);
    if (value.includes('\0') || /[\r\n]/.test(value)) throw new Error('HAPI access token must be a single line');
    return value;
}

type PublicHapiConfig = Omit<NonNullable<RuntimeConfig['hapi']>, 'token'> & { credentialConfigured: boolean };
export function publicConfig(config: HapiRuntimeConfig): Omit<RuntimeConfig, 'hapi'> & { hapi: PublicHapiConfig };
export function publicConfig(config: RuntimeConfig): Omit<RuntimeConfig, 'hapi'> & { hapi?: PublicHapiConfig };
export function publicConfig(config: RuntimeConfig): Omit<RuntimeConfig, 'hapi'> & { hapi?: PublicHapiConfig } {
    const { hapi, ...common } = config;
    return {
        ...common,
        ...(hapi ? { hapi: { id: hapi.id, url: hapi.url, tokenEnv: hapi.tokenEnv,
            ...(hapi.companionUrl ? { companionUrl: hapi.companionUrl } : {}), credentialConfigured: Boolean(hapi.token) } } : {}),
    };
}
