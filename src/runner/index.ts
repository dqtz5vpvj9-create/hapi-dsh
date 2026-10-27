import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRunnerConfig } from './config.ts';
import { RunnerClient } from './client.ts';
import { runtimeIdentity } from './identity.ts';
import { bootstrapPayload, mountBootstrapRoute } from '../shared/bootstrap.ts';
export { bootstrapPayload, SAFE_GLOBALS } from '../shared/bootstrap.ts';

export const name = 'hapi-dsh-runner';
export const inject = ['connection', 'webServer', 'clientModules', 'appReady'];
export interface Config { configFile?: string }

interface RunnerServices {
    connection: { requestRejection(req: IncomingMessage): number | undefined; authenticatedUrl(origin: string): string };
    webServer: { getOrigin(): string; collectIndexInjections(): Array<{ kind: string; name?: string; value?: unknown }>;
        register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void };
    clientModules: { graph(): { release?: { version: string }; [key: string]: unknown } };
    appReady: { onReady(callback: () => void): () => void };
}

/** Ordinary Host plugin, composed and disposed by the official DSH launcher. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
    const path = config.configFile ?? process.env.HAPI_DSH_RUNNER_CONFIG_FILE;
    if (!path) throw new Error('HAPI_DSH_RUNNER_CONFIG_FILE is required for the Runner profile');
    const runtime = await readRunnerConfig(path);
    const services = Object.fromEntries(inject.map((service) => [service, ctx.get(service)])) as unknown as RunnerServices;
    let client: RunnerClient | undefined;
    const disposeRoute = mountBootstrapRoute(services, () => {
        const payload = bootstrapPayload(services);
        client = new RunnerClient({ config: runtime, origin: services.webServer.getOrigin(), dshVersion: payload.dshVersion,
            identity: runtimeIdentity({ dshVersion: payload.dshVersion, dshHome: runtime.dsh.home, profile: runtime.dsh.profile }),
            authenticatedUrl: (origin) => services.connection.authenticatedUrl(origin),
            status: (state) => { process.stdout.write(`hapi-dsh Runner ${runtime.machine.id}: ${state}\n`); } });
        client.start();
    });
    ctx.effect(() => async () => { disposeRoute(); await client?.stop(); });
}
