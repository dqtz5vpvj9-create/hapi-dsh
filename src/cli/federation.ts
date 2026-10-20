import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { addPairing, revokePairing } from '../hub/federation-credentials.ts';
import { createRunnerConfig, parseRunnerConfig, readRunnerConfig, runnerConfigPath, runnerToken, writeRunnerConfig } from '../runner/config.ts';
import { validMachineId } from '../runner/protocol.ts';
import { bindUrlHost } from '@deepseek-ai/dsh-host-webserver';
import { normalizeHttpUrl, readPrivateJson, writeConfig, writePrivateJson, type RuntimeConfig } from './config.ts';
import { findPackageRoot, installProfile, requireProfileBundle, resolveDshCommand, runForeground, verifyDshVersion } from './runtime.ts';

export interface RunnerInvitation { version: 1; machineId: string; machineName: string; hubUrl: string; token: string }

export async function readInvitation(path: string): Promise<RunnerInvitation> {
    const input = await readPrivateJson(path);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Invalid private Runner invitation');
    const value = input as Partial<RunnerInvitation>;
    if (Object.keys(value).some((key) => !['version', 'machineId', 'machineName', 'hubUrl', 'token'].includes(key)) || value.version !== 1
        || !validMachineId(value.machineId) || typeof value.machineName !== 'string' || value.machineName.length === 0 || value.machineName.length > 128
        || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error('Invalid private Runner invitation');
    return { version: 1, machineId: value.machineId, machineName: value.machineName, hubUrl: normalizeHttpUrl(value.hubUrl, 'invitation.hubUrl'), token: value.token };
}

export async function createInvitation(config: RuntimeConfig, configFile: string, outputFile: string, options: { name: string; id?: string; hubUrl?: string }): Promise<string> {
    const exists = await lstat(outputFile).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) throw new Error('Invitation output already exists; choose a new file');
    const id = options.id ?? randomUUID();
    const host = bindUrlHost(config.server.host);
    if (!options.hubUrl && !config.server.publicUrl && config.server.port === 0) throw new Error('Pairing needs --hub-url when the Hub uses an assigned port');
    if (!options.hubUrl && !config.server.publicUrl && !host) throw new Error('Pairing needs --hub-url when the Hub listener uses a scoped IPv6 address');
    const scheme = config.server.tls ? 'https' : 'http';
    const hubUrl = normalizeHttpUrl(options.hubUrl ?? config.server.publicUrl ?? `${scheme}://${host}:${config.server.port}`, 'hubUrl');
    if (!config.federation) {
        config.federation = { credentialsFile: join(dirname(configFile), 'runner-pairings.json') };
        await writeConfig(configFile, config, true);
    }
    const token = await addPairing(config.federation.credentialsFile, id, options.name);
    try {
        await writePrivateJson(outputFile, { version: 1, machineId: id, machineName: options.name, hubUrl, token } satisfies RunnerInvitation);
    } catch (error) {
        // A failed invitation write must not leave an unusable paired credential active.
        await revokePairing(config.federation.credentialsFile, id);
        throw error;
    }
    return id;
}

export async function runnerCommand(action: string, flags: Partial<Record<string, string | true>>): Promise<number> {
    const text = (key: string): string | undefined => typeof flags[key] === 'string' ? flags[key] : undefined;
    const configFile = resolve(text('config') ?? runnerConfigPath());
    if (action === 'init') {
        const invitationPath = text('pairing-file');
        if (!invitationPath) throw new Error('runner init requires --pairing-file pointing to the private invitation issued by the Hub');
        const invitation = await readInvitation(resolve(invitationPath));
        const config = createRunnerConfig(invitation.hubUrl, { id: invitation.machineId, name: invitation.machineName, token: invitation.token,
            ...(text('dsh-home') ? { dshHome: text('dsh-home')! } : {}) });
        const profile = text('profile');
        if (profile) config.dsh.profile = profile;
        const port = text('port');
        if (port !== undefined) {
            if (!/^\d+$/.test(port)) throw new Error('--port must be an integer');
            config.server.port = Number(port);
        }
        const command = text('dsh-command');
        if (command) config.dsh.command = command;
        await writeRunnerConfig(configFile, parseRunnerConfig(config));
        process.stdout.write(`Private Runner configuration created at ${configFile}\n`);
        if (!flags['config-only']) await installProfile(config, configFile, join(await findPackageRoot(), 'dist', 'runner'), { bundleName: 'hapi-dsh-runner' });
        process.stdout.write('Run hapi-dsh runner start with this config to connect the machine to its Hub.\n');
        return 0;
    }
    const config = await readRunnerConfig(configFile);
    if (action === 'config') {
        const { token: _token, ...hub } = config.hub;
        process.stdout.write(`${JSON.stringify({ ...config, hub: { ...hub, credentialConfigured: Boolean(config.hub.token) } }, null, 2)}\n`);
        return 0;
    }
    if (action === 'install') {
        await installProfile(config, configFile, join(await findPackageRoot(), 'dist', 'runner'), { bundleName: 'hapi-dsh-runner' });
        process.stdout.write(`Official DSH Web profile ${config.dsh.profile} includes the Host-only Runner bundle.\n`);
        return 0;
    }
    runnerToken(config);
    const command = await resolveDshCommand(config);
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: config.dsh.home, HAPI_DSH_RUNNER_CONFIG_FILE: configFile };
    delete env.HAPI_DSH_CONFIG_FILE;
    await verifyDshVersion(command, env);
    await requireProfileBundle(config, 'hapi-dsh-runner');
    return runForeground(command, ['--profile', config.dsh.profile, '--host', '127.0.0.1', '--port', String(config.server.port), '--no-open'], env);
}
