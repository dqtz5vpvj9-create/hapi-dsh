import type { IncomingMessage, ServerResponse } from 'node:http';

/** Explicit, per-Host cutover. Omission keeps that Host on its existing carrier. */
export interface RemoteCarrierConfig {
    serverUrl: string;
    hosts: Array<{ hostId: string; deviceId: string; identityKey: string }>;
}
export interface RemoteOwnerRuntime {
    registerOwnedClient(descriptor: unknown): Promise<{
        serverUrl: string; deviceId: string; identityKey: string; account: string; tokens: unknown;
    }>;
}
interface Services {
    webServer: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void };
    connection: { requestRejection(req: IncomingMessage): number | undefined };
    runtime(): RemoteOwnerRuntime | undefined;
}

/** Preserve HHPI admission; issue an independent Remote Client credential.
 * This is an owner HTTP boundary, never a source or encrypted-peer RPC. */
export function mountRemoteCarrier(services: Services, config: RemoteCarrierConfig | undefined): () => void {
    const reply = (res: ServerResponse, status: number, value: unknown) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(value));
    };
    const remove = ['describe', 'enroll'].map(action => services.webServer.register({
        kind: 'exact', path: `/hapi-dsh/remote/${action}`, handler(req, res) {
            const rejected = services.connection.requestRejection(req);
            if (rejected !== undefined) { reply(res, rejected, { code: 'AUTH_REQUIRED' }); return; }
            if (req.method !== 'POST') { reply(res, 405, { code: 'METHOD_NOT_ALLOWED' }); return; }
            // Native clients omit Origin; browser callers must be same-origin.
            if (req.headers.origin !== undefined) {
                try { if (new URL(req.headers.origin).host !== req.headers.host) throw new Error(); }
                catch { reply(res, 403, { code: 'ORIGIN_REJECTED' }); return; }
            }
            if (req.headers['sec-fetch-site'] === 'cross-site' ||
                req.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
                reply(res, 403, { code: 'ORIGIN_REJECTED' }); return;
            }
            if (action === 'describe') { reply(res, 200, config ? { v: 1, ...config } : { v: 1, hosts: [] }); return; }
            const runtime = services.runtime();
            if (!config || !runtime) { reply(res, 503, { code: 'REMOTE_NOT_CONFIGURED' }); return; }
            void (async () => {
                const chunks: Buffer[] = []; let length = 0;
                for await (const bytes of req) {
                    const chunk = Buffer.from(bytes); length += chunk.length;
                    if (length > 8192) { reply(res, 413, { code: 'REQUEST_TOO_LARGE' }); return; }
                    chunks.push(chunk);
                }
                let descriptor: unknown;
                try { descriptor = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                catch { reply(res, 400, { code: 'INVALID_MESSAGE' }); return; }
                const enrollment = await runtime.registerOwnedClient(descriptor);
                if (new URL(enrollment.serverUrl).origin !== new URL(config.serverUrl).origin) {
                    reply(res, 503, { code: 'REMOTE_SERVER_MISMATCH' }); return;
                }
                reply(res, 200, enrollment);
            })().catch(error => {
                // Never reflect a remote body/exception, which may contain credentials.
                const code = ['ACCOUNT_AUTH_REQUIRED', 'METHOD_NOT_ALLOWED', 'DEVICE_REVOKED',
                    'PEER_IDENTITY_MISMATCH', 'CONNECTION_FAILED'].includes(error?.code) ? error.code : 'REMOTE_ENROLLMENT_FAILED';
                reply(res, 502, { code });
            });
        },
    }));
    return () => { for (const dispose of remove) dispose(); };
}
