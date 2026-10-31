import type { IncomingMessage, ServerResponse } from 'node:http';
import { DSH_VERSION } from '../cli/config.ts';
import { BOOTSTRAP_PATH } from '../runner/protocol.ts';
import { HAPI_DSH_BUILD_ID } from '../build-info.ts';

export interface BootstrapServices {
    connection: { requestRejection(req: IncomingMessage): number | undefined };
    webServer: {
        getOrigin?(): string;
        collectIndexInjections(): Array<{ kind: string; name?: string; value?: unknown }>;
        register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void;
    };
    clientModules: { graph(): { rev?: string; release?: { version: string } } };
    appReady: { onReady(callback: () => void): () => void };
}

export const SAFE_GLOBALS = new Set([
    '__DSH_CONNECTION_RECOVERY__', '__DSH_DOCUMENT_PREVIEW_CONFIG__', '__DSH_SHORTCUTS_CONFIG__',
    '__DSH_MODELS_ONBOARDING__', '__DSH_CONTACT_CONFIG__',
]);

/** Forward the official graph and public JSON config without executing injection scripts. */
export function bootstrapPayload(services: Pick<BootstrapServices, 'webServer' | 'clientModules'>): {
    dshVersion: string; hostBuildId: string; graph: unknown; globals: Record<string, unknown>;
} {
    const graph = services.clientModules.graph();
    if (graph.release?.version && graph.release.version !== DSH_VERSION) throw new Error('Host DSH release does not match the pinned distribution');
    const globals: Record<string, unknown> = {};
    for (const row of services.webServer.collectIndexInjections()) {
        if (row.kind === 'global' && row.name && SAFE_GLOBALS.has(row.name)) globals[row.name] = row.value;
    }
    return { dshVersion: DSH_VERSION, hostBuildId: HAPI_DSH_BUILD_ID, graph, globals };
}

/** Local panes and federated panes receive the same authenticated public boot contract. */
export function mountBootstrapRoute(services: BootstrapServices, onReady?: () => void): () => void {
    let ready = false;
    const removeRoute = services.webServer.register({ kind: 'exact', path: BOOTSTRAP_PATH, handler: (req, res) => {
        const rejection = services.connection.requestRejection(req);
        if (rejection) { res.writeHead(rejection); res.end(); return; }
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return; }
        if (!ready) { res.writeHead(503, { 'cache-control': 'no-store' }); res.end(); return; }
        try {
            const body = JSON.stringify(bootstrapPayload(services));
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(body);
        } catch {
            res.writeHead(503, { 'cache-control': 'no-store' }); res.end();
        }
    } });
    const removeReady = services.appReady.onReady(() => {
        bootstrapPayload(services);
        ready = true;
        onReady?.();
    });
    return () => { ready = false; removeReady(); removeRoute(); };
}
