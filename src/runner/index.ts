import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { join } from 'node:path';
import { installSources, registerSourceContract } from '../remote/service.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRunnerConfig } from './config.ts';
import { RunnerClient } from './client.ts';
import { runtimeIdentity } from './identity.ts';
import { bootstrapPayload, mountBootstrapRoute } from '../shared/bootstrap.ts';
import { mountSourceAttentionRoutes } from '../workspace/source-attention-route.ts';
import { NativeDshAttention } from '../workspace/native-dsh-attention.ts';
import { isSourceDisplayId } from '../shared/source-display-id.ts';
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access';
export { bootstrapPayload, SAFE_GLOBALS } from '../shared/bootstrap.ts';

export const name = 'hapi-dsh-runner';
export const inject = ['connection', 'webServer', 'clientModules', 'appReady', 'typert', 'remoteAccess', 'sessions', 'sessionPersistence'];
export interface Config { configFile?: string }

interface RunnerServices {
    connection: { readonly browserPeer: PeerScope; requestRejection(req: IncomingMessage): number | undefined; authenticatedUrl(origin: string): string };
    webServer: { getOrigin(): string; collectIndexInjections(peer: PeerScope): Array<{ kind: string; name?: string; value?: unknown }>;
        register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void };
    clientModules: { graph(): { release?: { version: string }; [key: string]: unknown } };
    appReady: { onReady(callback: () => void): () => void };
    remoteAccess: Pick<RemoteAccessService, 'decide'>;
}

/** Ordinary Host plugin, composed and disposed by the official DSH launcher. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
    const path = config.configFile ?? process.env.HAPI_DSH_RUNNER_CONFIG_FILE;
    if (!path) throw new Error('HAPI_DSH_RUNNER_CONFIG_FILE is required for the Runner profile');
    const runtime = await readRunnerConfig(path);
    const gateway = installSources(ctx, runtime.sources ?? [], join(runtime.dsh.home, 'profiles', runtime.dsh.profile, 'data', 'hapi-dsh', 'sources'), runtime.sourceWorkspaces);
    registerSourceContract(ctx);
    const services = Object.fromEntries(inject.map((service) => [service, ctx.get(service)])) as unknown as RunnerServices;
    const lifetime = new AbortController(), native = new NativeDshAttention(lifetime.signal);
    const stopEvents = ctx.on('session/event', (session, event) => { if (!isSourceDisplayId(session.id)) native.accept(session, event); });
    const stopDisposed = ctx.on('session/disposed', session => native.forget(session));
    const stopAttention = mountSourceAttentionRoutes(services, { machineId: runtime.machine.id, sources: runtime.sources ?? [], gateway, native, signal: lifetime.signal,
        nativeSessionExists: async (id, signal) => !!ctx.sessions.get(id as SessionId) || !!await ctx.sessionPersistence.stat(id as SessionId, { signal }),
    });
    ctx.effect(() => () => { lifetime.abort(); stopEvents(); stopDisposed(); stopAttention(); }, 'hhpi: Runner application attention owner');
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
