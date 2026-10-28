/** Original HAPI notification HTTP/SSE contract; no external Push service is contacted. */
import { createECDH } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Visibility = 'visible' | 'hidden';
export class NotificationsWireFixture {
    readonly publicKey = createECDH('prime256v1').generateKeys().toString('base64url');
    readonly streams = new Map<string, Visibility>();
    readonly opened: Array<{ subscriptionId: string; visibility: Visibility }> = [];
    readonly visibilityUpdates: Array<{ subscriptionId: string; visibility: Visibility }> = [];
    readonly subscriptions: Array<{ endpoint: string; keys: { p256dh: string; auth: string } }> = [];
    readonly removals: string[] = [];
    pushConfigured = true;
    dropNextSubscribeReply = false;
    private sequence = 0;

    attach(url: URL, response: ServerResponse): string {
        const subscriptionId = `original-notification-subscription-${++this.sequence}`;
        const visibility = url.searchParams.get('visibility') === 'visible' ? 'visible' : 'hidden';
        this.streams.set(subscriptionId, visibility); this.opened.push({ subscriptionId, visibility });
        response.once('close', () => { this.streams.delete(subscriptionId); });
        return subscriptionId;
    }
    isVisible(): boolean { return [...this.streams.values()].some(value => value === 'visible'); }
    handle(url: URL, request: IncomingMessage, response: ServerResponse, body: unknown): boolean {
        const send = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (url.pathname === '/api/push/vapid-public-key' && request.method === 'GET') {
            if (!this.pushConfigured) send({ error: 'Push is not configured in this explicit fixture' }, 503);
            else send({ publicKey: this.publicKey });
            return true;
        }
        if (!body || typeof body !== 'object') return false;
        const value = body as Record<string, unknown>;
        if (url.pathname === '/api/visibility' && request.method === 'POST') {
            if (typeof value.subscriptionId !== 'string' || !this.streams.has(value.subscriptionId)) { send({ error: 'Unknown subscription' }, 404); return true; }
            if (value.visibility !== 'visible' && value.visibility !== 'hidden') { send({ error: 'Invalid visibility' }, 400); return true; }
            this.streams.set(value.subscriptionId, value.visibility); this.visibilityUpdates.push({ subscriptionId: value.subscriptionId, visibility: value.visibility });
            send({ ok: true }); return true;
        }
        if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
            const keys = value.keys as Record<string, unknown> | undefined;
            if (typeof value.endpoint !== 'string' || typeof keys?.p256dh !== 'string' || typeof keys.auth !== 'string') { send({ error: 'Invalid browser subscription' }, 400); return true; }
            this.subscriptions.push({ endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
            if (this.dropNextSubscribeReply) { this.dropNextSubscribeReply = false; response.destroy(); } else send({ ok: true });
            return true;
        }
        if (url.pathname === '/api/push/subscribe' && request.method === 'DELETE') {
            if (typeof value.endpoint !== 'string') { send({ error: 'Invalid endpoint' }, 400); return true; }
            this.removals.push(value.endpoint); send({ ok: true }); return true;
        }
        return false;
    }
}
