#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createConfig, defaultConfigPath, parseConfig, publicConfig, readConfig, writeConfig, type RuntimeConfig } from './config.ts';
import { doctor } from './doctor.ts';
import { bundleCommand } from './bundle.ts';
import { findPackageRoot, installProfile, startProfile } from './runtime.ts';
import { createInvitation, runnerCommand } from './federation.ts';
import { revokePairing } from '../hub/federation-credentials.ts';
import { login } from './login.ts';

export const HELP = `hapi-dsh — official DSH Web profile with the HAPI workspace plugin

Usage:
  hapi-dsh init --hapi-url URL [configuration options] [--config-only]
  hapi-dsh install [--config FILE]
  hapi-dsh login [--config FILE] [--stdin]
  hapi-dsh doctor [--config FILE] [--offline] [--json]
  hapi-dsh start [--config FILE] [--no-open]
  hapi-dsh config [--config FILE]
  hapi-dsh pair --name NAME --hub-url URL --output PRIVATE_FILE [--machine-id ID] [--config FILE]
  hapi-dsh revoke --machine-id ID [--config FILE]
  hapi-dsh runner init --pairing-file PRIVATE_FILE [--config FILE] [--dsh-home DIR] [--profile NAME] [--config-only]
  hapi-dsh runner install|start|config [--config FILE]
  hapi-dsh bundle status|verify|rollback|prune [--json]
  hapi-dsh bundle install|upgrade (--bundle-root DIR | --tgz FILE) [--role host|runner] [--dry-run]
  hapi-dsh --version

hub is an alias for start. Pairing invitations contain a credential and are written
with mode 0600; transfer them privately to the intended Runner machine.

Configuration options (init):
  --config FILE       Private JSON config; defaults to XDG_CONFIG_HOME/hapi-dsh/config.json
  --hapi-url URL      Existing HAPI Hub URL (required)
  --dsh-home DIR      Dedicated DSH home or existing DSH home
  --profile NAME      Custom DSH profile name (default: hapi)
  --host IP          Concrete listening IP (default: 127.0.0.1)
  --port NUMBER      Web port, including 0 for an available port (default: 3080)
  --public-url URL   Advertised Web URL for a configured reverse proxy
  --trusted-host HOST Bare host[:port] admitted by the official browser trust fence
  --tls-cert FILE    PEM certificate chain for the official DSH HTTPS listener
  --tls-key FILE     PEM private key; requires --tls-cert
  --token-env NAME   Environment variable holding the HAPI access token (default: HAPI_DSH_TOKEN)
  --dsh-command PATH Override the bundled DSH launcher; its exact version is checked
  --config-only      Create config without installing the DSH profile

login reads the HAPI access token without echoing it and saves it in the private
config. --stdin reads it from a pipe instead. Environment variables still take priority.
Credentials are never accepted as command-line arguments. init refuses
to replace an existing config. install preserves an existing Web profile and its plugins.
`;

type CommandName = 'init' | 'install' | 'login' | 'doctor' | 'start' | 'config' | 'pair' | 'revoke' | 'runner' | 'bundle' | 'help' | 'version';
type FlagName = 'config' | 'hapi-url' | 'dsh-home' | 'profile' | 'host' | 'port' | 'public-url' | 'trusted-host' | 'tls-cert' | 'tls-key' | 'token-env' | 'dsh-command' | 'config-only' | 'offline' | 'json' | 'no-open' | 'name' | 'hub-url' | 'output' | 'machine-id' | 'pairing-file' | 'stdin' | 'bundle-root' | 'tgz' | 'role' | 'style' | 'keep-previous' | 'dry-run';
export interface ParsedArguments { command: CommandName; action?: string; flags: Partial<Record<FlagName, string | true>> }
const valueFlags = new Set(['config', 'hapi-url', 'dsh-home', 'profile', 'host', 'port', 'public-url', 'trusted-host', 'tls-cert', 'tls-key', 'token-env', 'dsh-command', 'bundle-root', 'tgz', 'role', 'style', 'keep-previous']);
const booleanFlags = new Set(['config-only', 'offline', 'json', 'no-open', 'stdin', 'dry-run']);
const allowed: Record<Exclude<CommandName, 'help' | 'version'>, ReadonlySet<string>> = {
    init: new Set([...valueFlags, 'config-only']),
    install: new Set(['config']), doctor: new Set(['config', 'offline', 'json']),
    login: new Set(['config', 'stdin']),
    start: new Set(['config', 'no-open']), config: new Set(['config']),
    pair: new Set(['config', 'name', 'hub-url', 'output', 'machine-id']), revoke: new Set(['config', 'machine-id']),
    runner: new Set(['config']),
    bundle: new Set(['config', 'bundle-root', 'tgz', 'role', 'style', 'keep-previous', 'dry-run', 'json']),
};

export function parseArguments(argv: readonly string[]): ParsedArguments {
    if (argv.length === 1 && ['--version', '-V', 'version'].includes(argv[0]!)) return { command: 'version', flags: {} };
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return { command: 'help', flags: {} };
    const first = argv[0] === 'hub' ? 'start' : argv[0];
    if (!first || !Object.hasOwn(allowed, first)) throw new Error('Unknown command; run hapi-dsh --help');
    const command = first as Exclude<CommandName, 'help' | 'version'>;
    const action = command === 'runner' || command === 'bundle' ? argv[1] : undefined;
    if (command === 'runner' && !['init', 'install', 'start', 'config'].includes(action ?? '')) throw new Error('runner requires init, install, start, or config');
    if (command === 'bundle' && !['status', 'verify', 'install', 'upgrade', 'rollback', 'prune', 'help'].includes(action ?? '')) throw new Error('bundle requires status, verify, install, upgrade, rollback, prune, or help');
    const validFlags = command === 'runner' && action === 'init'
        ? new Set(['config', 'pairing-file', 'dsh-home', 'profile', 'port', 'dsh-command', 'config-only']) : allowed[command];
    const flags: ParsedArguments['flags'] = {};
    for (let index = command === 'runner' || command === 'bundle' ? 2 : 1; index < argv.length; index++) {
        const argument = argv[index]!;
        if (!argument.startsWith('--')) throw new Error('Unexpected positional argument; run hapi-dsh --help');
        const separator = argument.indexOf('=');
        const name = argument.slice(2, separator < 0 ? undefined : separator);
        if (/token|password|secret/i.test(name) && name !== 'token-env') {
            throw new Error('Credentials are not accepted in command-line arguments; use an environment variable or the private config');
        }
        if (!validFlags.has(name)) throw new Error('Unknown option for this command; run hapi-dsh --help');
        if (Object.hasOwn(flags, name)) throw new Error(`Duplicate option: --${name}`);
        if (booleanFlags.has(name)) {
            if (separator >= 0) throw new Error(`--${name} does not take a value`);
            flags[name as FlagName] = true;
        } else {
            const value = separator >= 0 ? argument.slice(separator + 1) : argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
            flags[name as FlagName] = value;
        }
    }
    return { command, flags, ...(action === undefined ? {} : { action }) };
}

function flagValue(flags: ParsedArguments['flags'], name: FlagName): string | undefined {
    const value = flags[name];
    return typeof value === 'string' ? value : undefined;
}

export function configFromArguments(flags: ParsedArguments['flags'], env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
    const url = flagValue(flags, 'hapi-url');
    if (!url) throw new Error('init requires --hapi-url pointing to the existing HAPI Hub');
    const config = createConfig(url, env);
    const home = flagValue(flags, 'dsh-home');
    if (home) config.dsh.home = resolve(home);
    const profile = flagValue(flags, 'profile');
    if (profile) config.dsh.profile = profile;
    const host = flagValue(flags, 'host');
    if (host) config.server.host = host;
    const port = flagValue(flags, 'port');
    if (port !== undefined) {
        if (!/^\d+$/.test(port)) throw new Error('--port must be an integer between 0 and 65535');
        config.server.port = Number(port);
    }
    const publicUrl = flagValue(flags, 'public-url');
    if (publicUrl) config.server.publicUrl = publicUrl;
    const authority = flagValue(flags, 'trusted-host');
    if (authority) config.server.trustedHosts = [authority];
    const cert = flagValue(flags, 'tls-cert');
    const key = flagValue(flags, 'tls-key');
    if (Boolean(cert) !== Boolean(key)) throw new Error('--tls-cert and --tls-key must be supplied together');
    if (cert && key) config.server.tls = { certFile: resolve(cert), keyFile: resolve(key) };
    const tokenEnv = flagValue(flags, 'token-env');
    if (tokenEnv) config.hapi.tokenEnv = tokenEnv;
    const command = flagValue(flags, 'dsh-command');
    if (command) config.dsh.command = command;
    return parseConfig(config);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const { command, flags, action } = parseArguments(argv);
    if (command === 'help') { process.stdout.write(HELP); return 0; }
    if (command === 'version') {
        const manifest = JSON.parse(await readFile(join(await findPackageRoot(), 'package.json'), 'utf8')) as { version: string };
        process.stdout.write(`${manifest.version}\n`);
        return 0;
    }
    if (command === 'runner') return runnerCommand(action!, flags);
    const configFile = resolve(flagValue(flags, 'config') ?? defaultConfigPath());
    if (command === 'init') {
        const config = configFromArguments(flags);
        config.federation = { credentialsFile: join(dirname(configFile), 'runner-pairings.json') };
        await writeConfig(configFile, config);
        process.stdout.write(`Private configuration created at ${configFile}\n`);
        if (!flags['config-only']) {
            await installProfile(config, configFile, await findPackageRoot());
            process.stdout.write(`Official DSH Web profile ${config.dsh.profile} is ready.\n`);
        }
        process.stdout.write(`Run hapi-dsh login, then hapi-dsh doctor and hapi-dsh start. Use --config ${JSON.stringify(configFile)} for this configuration.\n`);
        return 0;
    }
    const config = await readConfig(configFile);
    if (command === 'login') {
        await login(config, configFile, flags.stdin === true);
        process.stdout.write('HAPI access token saved. Run hapi-dsh doctor to check the connection.\n');
        if (process.env[config.hapi.tokenEnv]) process.stdout.write(`${config.hapi.tokenEnv} is set and takes priority over the saved token.\n`);
        return 0;
    }
    if (command === 'pair') {
        const name = flagValue(flags, 'name');
        const output = flagValue(flags, 'output');
        if (!name || !output) throw new Error('pair requires --name and --output for the private Runner invitation');
        const id = await createInvitation(config, configFile, resolve(output), { name,
            ...(flagValue(flags, 'machine-id') ? { id: flagValue(flags, 'machine-id')! } : {}),
            ...(flagValue(flags, 'hub-url') ? { hubUrl: flagValue(flags, 'hub-url')! } : {}) });
        process.stdout.write(`Machine ${id} paired. Private invitation created at ${resolve(output)}\n`);
        return 0;
    }
    if (command === 'revoke') {
        const id = flagValue(flags, 'machine-id');
        if (!id || !config.federation) throw new Error('revoke requires --machine-id and a configured pairing store');
        await revokePairing(config.federation.credentialsFile, id);
        process.stdout.write(`Machine ${id} pairing revoked. The running Hub reloads its pairing store automatically.\n`);
        return 0;
    }
    if (command === 'config') {
        process.stdout.write(`${JSON.stringify(publicConfig(config), null, 2)}\n`);
        return 0;
    }
    if (command === 'bundle') {
        return bundleCommand(action, flags, { config, configFile, json: flags.json === true });
    }
    if (command === 'install') {
        await installProfile(config, configFile, await findPackageRoot());
        process.stdout.write(`Official DSH Web profile ${config.dsh.profile} includes the built hapi-dsh bundle.\n`);
        return 0;
    }
    if (command === 'doctor') {
        const result = await doctor(config, configFile, { offline: flags.offline === true });
        if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else {
            for (const check of result.checks) process.stdout.write(`${check.status.toUpperCase().padEnd(7)} ${check.name}: ${check.detail}\n`);
            process.stdout.write(`Required HAPI source revision: ${result.expectedUpstream.hapiRevision} (not reported by the Hub API).\n`);
        }
        return result.ok ? 0 : 1;
    }
    return startProfile(config, configFile, flags['no-open'] === true);
}

const invokedPath = process.argv[1];
// npm's Unix bin is a symlink; Node resolves import.meta.url to the real file.
if (invokedPath && import.meta.url === pathToFileURL(await realpath(resolve(invokedPath))).href) {
    main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
        const message = (error as NodeJS.ErrnoException)?.code === 'EEXIST'
            ? 'Configuration already exists. Use install to retry setup, or select a different --config file.'
            : (error as NodeJS.ErrnoException)?.code === 'ENOENT'
                ? 'A required file is missing. Run init to create configuration, or build and install the package.'
                : error instanceof Error ? error.message : 'Command failed';
        process.stderr.write(`hapi-dsh: ${message}\n`);
        process.exitCode = 1;
    });
}
