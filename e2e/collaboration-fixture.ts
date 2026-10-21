/** Explicit original HAPI work-graph fixture; no real team agent is launched. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SourceWorkEvent, SourceWorkLink } from '../src/source-collaboration-types.ts';
export class CollaborationWireFixture {
    available = true;
    offline = false;
    readonly events = new Map<string, SourceWorkEvent>();
    readonly links: SourceWorkLink[] = [];
    readonly requests: Array<{ method: string; path: string; sourceId: string | null }> = [];
    handle(url: URL, request: IncomingMessage, response: ServerResponse): boolean {
        if (!url.pathname.startsWith('/api/work-graph/')) return false;
        this.requests.push({ method: request.method ?? 'GET', path: url.pathname, sourceId: url.searchParams.get('related_session_id') });
        const send = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.method !== 'GET') { send({ error: 'Fixture work ledger is read-only' }, 405); return true; }
        if (this.offline) { send({ error: 'Fixture ledger unavailable' }, 503); return true; }
        if (url.pathname === '/api/work-graph/events') {
            const source = url.searchParams.get('related_session_id'), limit = Number(url.searchParams.get('limit') ?? 100);
            send({ events: [...this.events.values()].filter(event => event.relatedSessionId === source).slice(0, limit) }); return true;
        }
        const match = /^\/api\/work-graph\/events\/([^/]+)(\/links)?$/.exec(url.pathname);
        const id = match ? decodeURIComponent(match[1]!) : '', event = this.events.get(id);
        if (!event) { send({ error: 'Unknown fixture event' }, 404); return true; }
        send(match?.[2] ? { links: this.links.filter(link => link.fromEventId === id || link.toEventId === id) } : { event }); return true;
    }
}
