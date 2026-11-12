/** Runner-owned read-only application carrier, independent of HHPI v1 and every Pane. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access';
import type { PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SourceGateway, SourceAccess } from '../remote/gateway.ts';
import { parseSourceSessionId } from '../remote/protocol.ts';
import { isSourceDisplayId } from '../shared/source-display-id.ts';
import { appNotificationTargetSchema, appSourceRouteSchema, type AppSourceRoute } from './app-service-types.ts';
import { sourceAttentionEventSchema, type NotificationCursor, type SourceAttentionSourceFeed } from './notification-events.ts';

export const SOURCE_ATTENTION_PATH = '/hapi-dsh/application/attention';
export const SOURCE_ATTENTION_MAX_BYTES = 1024 * 1024;
export const SOURCE_ATTENTION_POLL_MS = 20_000;
const id = z.string().min(1).max(2048).refine(value => !value.includes('\0'));
export const attentionSourceSchema = z.strictObject({ id, machineId: id, engine: id, routeKind: z.enum(['hhpi', 'federated-dsh']) });
export type AttentionSource = z.infer<typeof attentionSourceSchema>;
export const attentionCatalogSchema = z.strictObject({ sources: z.array(attentionSourceSchema).max(256) });
export const attentionCursorSchema = z.strictObject({ epoch: id, version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export const attentionBatchSchema = z.strictObject({ cursor: attentionCursorSchema, base: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reset: z.boolean(), replay: z.boolean(), events: z.array(z.strictObject({ sessionId: id, event: sourceAttentionEventSchema })).max(160) });
const pollSchema = z.strictObject({ source: attentionSourceSchema, cursor: attentionCursorSchema.optional(), waitMs: z.number().int().min(1).max(SOURCE_ATTENTION_POLL_MS).optional() });
const requestSchema = appNotificationTargetSchema.refine(value => value.kind === 'request');
export interface SourceAttentionRouteServices {
    connection: { readonly browserPeer: PeerScope; requestRejection(req: IncomingMessage): number | undefined };
    remoteAccess: Pick<RemoteAccessService, 'decide'>;
    webServer: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void };
}
export interface SourceAttentionRouteOptions {
    machineId: string; sources: readonly { id: string; machineId: string; engine: string }[];
    gateway: Pick<SourceGateway, 'attentionEvents' | 'resolve'>;
    native: SourceAttentionSourceFeed & { requestState(sessionId: string, requestId: string): 'pending' | 'settled' };
    signal: AbortSignal;
    nativeSessionExists?(sessionId: string, signal: AbortSignal): Promise<boolean>;
}
class RouteError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const failAccess = () => new RouteError(403, 'The original source or session is no longer authorized.');
function query(request: IncomingMessage, fields: readonly string[]): Record<string, unknown> {
    const url = new URL(request.url ?? '/', 'http://runner.local'), value: Record<string, unknown> = {};
    for (const [key, item] of url.searchParams) {
        if (!fields.includes(key) || Object.hasOwn(value, key)) throw new RouteError(400, 'Invalid source attention query.');
        try { value[key] = JSON.parse(item); } catch { throw new RouteError(400, 'Invalid source attention query.'); }
    }
    return value;
}
function send(response: ServerResponse, status: number, value?: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    const data = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    if (data && data.length > SOURCE_ATTENTION_MAX_BYTES) throw new RouteError(413, 'The source attention response exceeded its bound.');
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(data);
}
export function mountSourceAttentionRoutes(services: SourceAttentionRouteServices, options: SourceAttentionRouteOptions): () => void {
    const lifetime = new AbortController(), signal = AbortSignal.any([options.signal, lifetime.signal]);
    const configured = new Map(options.sources.filter(source => source.engine === 'codex').map(source => [source.id, source]));
    const native: AttentionSource = { id: 'native-dsh', machineId: options.machineId, engine: 'dsh', routeKind: 'federated-dsh' };
    const sourceAccess = (principal: Principal): SourceAccess => resource => !signal.aborted && services.remoteAccess.decide({ principal,
        action: resource.kind === 'source' ? 'hhpi/nativeEvents' : 'hhpi/resolve',
        resources: [resource.kind === 'source' ? { kind: 'hhpiSource', id: resource.id } : { kind: 'session', id: resource.id as SessionId }],
    }).kind === 'allow';
    const sessionAccess = (principal: Principal, source: AppSourceRoute): boolean => !signal.aborted && services.remoteAccess.decide({ principal,
        action: source.kind === 'hhpi' ? 'hhpi/resolve' : 'session/page', resources: [{ kind: 'session', id: source.sessionId as SessionId }],
    }).kind === 'allow';
    const checkDescriptor = (source: AttentionSource, principal: Principal): void => {
        signal.throwIfAborted();
        if (source.routeKind === 'federated-dsh') {
            if (source.id !== native.id || source.machineId !== native.machineId || source.engine !== native.engine) throw new RouteError(404, 'The original native DSH source is unavailable.');
        } else {
            const expected = configured.get(source.id);
            if (!expected || expected.machineId !== source.machineId || expected.engine !== source.engine) throw new RouteError(404, 'The original configured source is unavailable.');
            if (!sourceAccess(principal)({ kind: 'source', id: source.id })) throw failAccess();
        }
    };
    const authorize = async (source: AppSourceRoute, principal: Principal, current: AbortSignal): Promise<void> => {
        current.throwIfAborted();
        if (source.hostId !== 'local' || source.kind === 'federated-dsh' || !sessionAccess(principal, source)) throw failAccess();
        if (source.kind === 'hhpi') {
            checkDescriptor({ id: source.identity.sourceId, machineId: source.identity.machineId, engine: source.identity.engine, routeKind: 'hhpi' }, principal);
            await options.gateway.resolve(source.sessionId, sourceAccess(principal), current);
            checkDescriptor({ id: source.identity.sourceId, machineId: source.identity.machineId, engine: source.identity.engine, routeKind: 'hhpi' }, principal);
        } else if (isSourceDisplayId(source.sessionId)) throw failAccess();
        current.throwIfAborted(); if (!sessionAccess(principal, source)) throw failAccess();
    };
    const register = (name: 'catalog' | 'poll' | 'authorize' | 'locate' | 'request') => services.webServer.register({ kind: 'exact', path: `${SOURCE_ATTENTION_PATH}/${name}`, async handler(request, response) {
        const closed = new AbortController(), current = AbortSignal.any([signal, closed.signal]);
        const close = () => { if (!response.writableEnded) closed.abort(new Error('The attention reader disconnected.')); };
        response.once('close', close);
        const checkConnection = () => { current.throwIfAborted(); const rejection = services.connection.requestRejection(request); if (rejection) throw new RouteError(rejection, 'Authenticated Runner access is required.'); };
        try {
            checkConnection();
            if (request.method !== 'GET') throw new RouteError(405, 'Source attention endpoints are read-only.');
            const principal = services.connection.browserPeer.principal;
            if (name === 'catalog') {
                if (new URL(request.url ?? '/', 'http://runner.local').search) throw new RouteError(400, 'The attention catalog has no query.');
                const sources: AttentionSource[] = [native, ...[...configured.values()].filter(source => sourceAccess(principal)({ kind: 'source', id: source.id }))
                    .map(source => ({ id: source.id, machineId: source.machineId, engine: source.engine, routeKind: 'hhpi' as const }))];
                checkConnection(); send(response, 200, attentionCatalogSchema.parse({ sources })); return;
            }
            if (name === 'authorize' || name === 'locate') {
                const source = appSourceRouteSchema.parse(query(request, ['source']).source);
                await authorize(source, principal, current);
                if (name === 'locate' && source.kind === 'local-dsh'
                    && !await options.nativeSessionExists?.(source.sessionId, current)) throw new RouteError(404, 'The original native session is unavailable.');
                await authorize(source, principal, current); checkConnection();
                send(response, 200, name === 'locate' ? { source } : { allowed: true }); return;
            }
            if (name === 'request') {
                const target = requestSchema.parse(query(request, ['target']).target);
                if (target.kind !== 'request') throw new RouteError(400, 'An exact original request target is required.');
                await authorize(target.source, principal, current);
                const state = target.source.kind === 'hhpi'
                    ? (await options.gateway.resolve(target.source.sessionId, sourceAccess(principal), current)).pendingRequests.some(request => request.id === target.requestId) ? 'pending' : 'settled'
                    : options.native.requestState(target.source.sessionId, target.requestId);
                await authorize(target.source, principal, current); checkConnection(); send(response, 200, { state }); return;
            }
            const value = pollSchema.parse(query(request, ['source', 'cursor', 'waitMs'])); checkDescriptor(value.source, principal);
            const timeout = new AbortController(), active = AbortSignal.any([current, timeout.signal]);
            const timer = setTimeout(() => timeout.abort(new DOMException('The bounded attention poll completed.', 'TimeoutError')), value.waitMs ?? SOURCE_ATTENTION_POLL_MS);
            timer.unref();
            const feed = value.source.routeKind === 'hhpi' ? { attentionEvents: (cursor: NotificationCursor | undefined, signal: AbortSignal) => options.gateway.attentionEvents(value.source.id, cursor, sourceAccess(principal), signal) } : options.native;
            const iterator = feed.attentionEvents(value.cursor, active)[Symbol.asyncIterator]();
            try {
                const result = await iterator.next(); checkConnection(); checkDescriptor(value.source, principal);
                if (result.done) throw new RouteError(503, 'The original source attention stream ended.');
                const batch = attentionBatchSchema.parse(result.value), events = batch.events.filter(item => {
                    if (value.source.routeKind === 'hhpi') {
                        const identity = parseSourceSessionId(item.sessionId);
                        if (identity.machineId !== value.source.machineId || identity.sourceId !== value.source.id || identity.engine !== value.source.engine || item.event.position.kind === 'dsh') throw new RouteError(502, 'An attention event did not match its exact source.');
                        return sourceAccess(principal)({ kind: 'session', id: item.sessionId });
                    }
                    if (isSourceDisplayId(item.sessionId) || item.event.position.kind !== 'dsh') throw new RouteError(502, 'An attention event did not match its native DSH source.');
                    return sessionAccess(principal, { kind: 'local-dsh', hostId: 'local', sessionId: item.sessionId });
                });
                checkConnection(); checkDescriptor(value.source, principal); send(response, 200, { ...batch, events });
            } catch (error) {
                if (timeout.signal.aborted && !current.aborted) {
                    if (value.cursor === undefined) throw new RouteError(503, 'The source did not admit its initial attention cursor.');
                    checkConnection(); checkDescriptor(value.source, principal); send(response, 204);
                }
                else throw error;
            } finally { clearTimeout(timer); timeout.abort(); await iterator.return?.(); }
        } catch (error) {
            if (!closed.signal.aborted) send(response, error instanceof RouteError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503,
                { error: error instanceof RouteError ? error.message : 'The original source attention service is unavailable.' });
        } finally { response.off('close', close); closed.abort(); }
    } });
    const stops = (['catalog', 'poll', 'authorize', 'locate', 'request'] as const).map(register);
    return () => { lifetime.abort(); for (const stop of stops.reverse()) stop(); };
}
