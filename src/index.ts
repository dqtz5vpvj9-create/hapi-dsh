import type { Context } from '@deepseek-ai/cordis';
import S from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-modules';
import { readConfig, DSH_VERSION } from './cli/config.ts';
import { installSources } from './remote/service.ts';
import { WorkspaceShell } from './hub/workspace-shell.ts';
import { WorkspaceRepository } from './hub/workspaces.ts';
import { FederationHub } from './hub/federation.ts';
import { runtimeIdentity } from './runner/identity.ts';
import { AppServicesController } from './workspace/app-service.ts';
import { ShareService } from './workspace/share-service.ts';
import { AppNotificationHost } from './workspace/notification-host.ts';
import { applicationPushTransport } from './workspace/notification-vapid.ts';
import { createSourceAttentionClient } from './workspace/source-attention-client.ts';
import { SourceAliasService } from './workspace/source-alias-service.ts';
import { mountShareTarget } from './workspace/browser-share.ts';
import { mountBootstrapRoute } from './shared/bootstrap.ts';
import { deferWorkspaceEntry, workspaceBootInjections } from './shared/workspace-boot.ts';
import { stageWorkspaceBoot } from './shared/boot-graph.ts';
import { compressedStreamInjection, mountCompressedStream } from './shared/compressed-stream.ts';
import { mountPasswordLogin } from './shared/password-login.ts';
import { mountVersionedAssets } from './shared/versioned-assets.ts';
import { mountPluginEvents } from './shared/plugin-events.ts';
import { installSourceTranslation } from './workspace/source-translation.ts';

export const name = 'hapi-dsh';
export const inject = ['sessions', 'sessionPersistence', 'typert', 'webServer', 'connection', 'clientModules', 'appReady', 'remoteAccess'];
export interface Config { configFile: string }
export const Config: S<Config> = S.object({ configFile: S.string().required() });

/** Host composition. Optional source-built DSH reading extensions are pinned by the distribution. */
export async function apply(ctx: Context, input: Config): Promise<void> {
    const config = await readConfig(input.configFile);
    let appNotifications: AppNotificationHost | undefined;
    if (config.server.loginPasswordFile) ctx.effect(() => mountPasswordLogin({ webServer: ctx.webServer, connection: ctx.connection, onLogout: request => appNotifications?.logout(request) }, config.server.loginPasswordFile!), 'hapi-dsh: password login');
    const dataDirectory = join(config.dsh.home, 'profiles', config.dsh.profile, 'data', 'hapi-dsh');
    const federation = new FederationHub({ credentialsFile: config.federation?.credentialsFile ?? join(dataDirectory, 'machines.json'),
        identity: runtimeIdentity({ dshVersion: DSH_VERSION, dshHome: config.dsh.home, profile: config.dsh.profile }) });
    ctx.effect(() => () => federation.close(), 'hapi-dsh: Runner connections');
    ctx.effect(() => mountBootstrapRoute({
        webServer: ctx.webServer, clientModules: ctx.clientModules, connection: ctx.connection,
        appReady: ctx.get('appReady') as { onReady(callback: () => void): () => void },
    }), 'hapi-dsh: local pane plugin bootstrap');
    ctx.on('webserver/index-inject', table => {
        stageWorkspaceBoot(table, ctx.clientModules.graph());
        table.push(compressedStreamInjection);
        table.push(...workspaceBootInjections());
    });
    ctx.effect(() => ctx.webServer.tapIndex(deferWorkspaceEntry), 'hapi-dsh: first-paint workspace layout');
    ctx.effect(() => mountCompressedStream({ webServer: ctx.webServer, connection: ctx.connection }), 'hapi-dsh: compressed official streams');
    ctx.effect(() => mountVersionedAssets(ctx.webServer), 'hapi-dsh: versioned Web shell assets');
    await federation.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    ctx.effect(() => mountPluginEvents({ webServer: ctx.webServer, connection: ctx.connection,
        hasHost: id => federation.listMachines().some(host => host.id === id && host.online),
    }), 'hapi-dsh: multiplexed official plugin events');
    // The Host controller publishes one package face containing both namespaces.
    const gateway = installSources(ctx, config.sources ?? [], join(dataDirectory, 'sources'), config.sourceWorkspaces);
    installSourceTranslation(ctx, gateway, join(dataDirectory, 'application', 'translations.sqlite'));
    const appOrigin = new URL(config.server.publicUrl ?? `http://localhost:${config.server.port}`).origin;
    const appDirectory = join(dataDirectory, 'application');
    const pushTransport = await applicationPushTransport(appDirectory, appOrigin);
    const foreignAttention = createSourceAttentionClient(federation);
    appNotifications = new AppNotificationHost(ctx, { directory: appDirectory, origin: appOrigin, gateway, sources: config.sources ?? [],
        foreign: { machines: () => federation.listMachines(), subscribe: listener => federation.subscribe(listener),
            listSources: foreignAttention.listSources, feed: foreignAttention.feed },
        authorizeForeign: (_principal, source) => foreignAttention.authorize(source.hostId, source, appNotifications!.lifetime.signal),
        foreignRequestState: (target, signal) => foreignAttention.requestState(target.source.hostId, target, signal),
        ...(pushTransport ? { transport: pushTransport } : {}) });
    const appShares = new ShareService({ path: join(appDirectory, 'shares.sqlite') });
    ctx.effect(() => () => appShares.close(), 'hhpi: account source shares');
    new AppServicesController(ctx, { context: principal => appNotifications!.context(principal), notifications: appNotifications.service, shares: appShares,
        readStatePath: join(appDirectory, 'read-state.sqlite') });
    new SourceAliasService(ctx, { path: join(appDirectory, 'source-aliases.json'), context: principal => appNotifications!.context(principal),
        async locate(source, principal, signal) {
            if (source.hostId !== 'local') return foreignAttention.locate(source.hostId, source, signal);
            if (source.kind === 'hhpi') {
                const found = await gateway.resolve(source.sessionId, appNotifications!.access(principal), signal);
                return found.id === source.sessionId ? source : null;
            }
            if (source.kind !== 'local-dsh') return null;
            const id = SessionId(source.sessionId);
            return ctx.sessions.get(id) || await ctx.sessionPersistence.stat(id, { signal }) ? source : null;
        },
    });
    appNotifications.mount();
    ctx.effect(() => () => appNotifications!.close(), 'hhpi: application notifications');
    ctx.effect(() => mountShareTarget({ webServer: ctx.webServer }), 'hhpi: browser share target');
    new WorkspaceShell(ctx, federation, new WorkspaceRepository(join(dataDirectory, 'workspace.json')), JSON.stringify([config.dsh.home, config.dsh.profile]));
}
