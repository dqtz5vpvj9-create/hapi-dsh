import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DSH_VERSION } from '../cli/config.ts';
import { readRunnerConfig } from './config.ts';
import { RunnerClient } from './client.ts';
import { BOOTSTRAP_PATH } from './protocol.ts';

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

export const SAFE_GLOBALS = new Set(['__DSH_CONNECTION_RECOVERY__', '__DSH_DOCUMENT_PREVIEW_CONFIG__', '__DSH_SHORTCUTS_CONFIG__', '__DSH_MODELS_ONBOARDING__', '__DSH_CONTACT_CONFIG__']);

/** Public JSON already selected by official UI owners; bootstrap never executes or forwards injection scripts. */
export function bootstrapPayload(services: Pick<RunnerServices, 'webServer' | 'clientModules'>): { dshVersion: string; graph: unknown; globals: Record<string, unknown> } {
    const graph = services.clientModules.graph();
    if (graph.release?.version && graph.release.version !== DSH_VERSION) throw new Error('Runner DSH release does not match the pinned distribution');
    const globals: Record<string, unknown> = {};
    for (const row of services.webServer.collectIndexInjections()) {
        if (row.kind === 'global' && row.name && SAFE_GLOBALS.has(row.name)) globals[row.name] = row.value;
    }
    return { dshVersion: DSH_VERSION, graph, globals };
}

/** Ordinary Host plugin, composed and disposed by the official DSH launcher. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
    const path = config.configFile ?? process.env.HAPI_DSH_RUNNER_CONFIG_FILE;
    if (!path) throw new Error('HAPI_DSH_RUNNER_CONFIG_FILE is required for the Runner profile');
    const runtime = await readRunnerConfig(path);
    const services = Object.fromEntries(inject.map((service) => [service, ctx.get(service)])) as unknown as RunnerServices;
    let ready = false;
    let client: RunnerClient | undefined;
    const disposeRoute = services.webServer.register({ kind: 'exact', path: BOOTSTRAP_PATH, handler: (req, res) => {
        const rejection = services.connection.requestRejection(req);
        if (rejection) { res.writeHead(rejection); res.end(); return; }
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
        if (!ready) { res.writeHead(503); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(bootstrapPayload(services)));
    } });
    const disposeReady = services.appReady.onReady(() => {
        const payload = bootstrapPayload(services);
        ready = true;
        client = new RunnerClient({ config: runtime, origin: services.webServer.getOrigin(), dshVersion: payload.dshVersion,
            authenticatedUrl: (origin) => services.connection.authenticatedUrl(origin),
            status: (state) => { process.stdout.write(`hapi-dsh Runner ${runtime.machine.id}: ${state}\n`); } });
        client.start();
    });
    ctx.effect(() => async () => { ready = false; disposeReady(); disposeRoute(); await client?.stop(); });
}
